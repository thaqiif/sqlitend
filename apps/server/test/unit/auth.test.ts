import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { Database } from "bun:sqlite";
import { migrate, openDb } from "../../src/db/metadata.ts";
import { AuthRepo } from "../../src/db/repos/auth.ts";
import { DatabasesRepo } from "../../src/db/repos/databases.ts";
import { TokensRepo } from "../../src/db/repos/tokens.ts";
import { WorkspacesRepo } from "../../src/db/repos/workspaces.ts";
import { AuthService, SESSION_COOKIE } from "../../src/auth/session.ts";
import { base32Encode, totpAt, verifyTotp } from "../../src/auth/totp.ts";
import { createRoutes } from "../../src/http/routes.ts";
import { CSRF_HEADER } from "../../src/http/auth-routes.ts";
import { loadConfig } from "../../src/config.ts";
import { clientIp } from "../../src/http/client-ip.ts";
import type { Supervisor } from "../../src/supervisor/supervisor.ts";
import type { Sampler } from "../../src/metrics/sampler.ts";

describe("totp (RFC 6238 SHA-1 vectors, last 6 digits)", () => {
  const secret = base32Encode(Buffer.from("12345678901234567890"));
  test.each([
    [59_000, "287082"],
    [1_111_111_109_000, "081804"],
    [1_234_567_890_000, "005924"],
    [2_000_000_000_000, "279037"],
  ])("t=%d -> %s", (t, code) => expect(totpAt(secret, t)).toBe(code));

  test("verify accepts ±1 step, rejects others and junk", () => {
    const t = 1_234_567_890_000;
    expect(verifyTotp(secret, totpAt(secret, t - 30_000), t)).toBe(true);
    expect(verifyTotp(secret, totpAt(secret, t + 30_000), t)).toBe(true);
    expect(verifyTotp(secret, totpAt(secret, t - 90_000), t)).toBe(false);
    expect(verifyTotp(secret, "12345", t)).toBe(false);
    expect(verifyTotp(secret, "abcdef", t)).toBe(false);
  });
});

let dir: string;
let db: Database;
let repo: AuthRepo;
let clock: number;
const PASSWORD = "correct horse battery staple";

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), "sqlitend-auth-"));
  db = openDb(path.join(dir, "metadata.sqlite"));
  migrate(db);
  repo = new AuthRepo(db);
  clock = 1_800_000_000_000;
});
afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

function makeApp(service = new AuthService(repo, { now: () => clock })) {
  const app = createRoutes({
    config: loadConfig({}, { dataRoot: dir }),
    workspaces: new WorkspacesRepo(db),
    databases: new DatabasesRepo(db),
    tokens: new TokensRepo(db),
    supervisor: { portAllocator: {} } as unknown as Supervisor,
    sampler: {} as unknown as Sampler,
    sqldOk: true,
    sqldVersion: "fake",
    version: "test",
    auth: { service, repo },
  });
  const send = (method: string, p: string, o: { body?: unknown; cookie?: string; csrf?: boolean; ip?: string } = {}) =>
    app.request(
      p,
      {
        method,
        headers: {
          ...(o.body !== undefined ? { "content-type": "application/json" } : {}),
          ...(o.csrf === false ? {} : { [CSRF_HEADER]: "1" }),
          ...(o.cookie ? { cookie: `${SESSION_COOKIE}=${o.cookie}` } : {}),
        },
        body: o.body === undefined ? undefined : JSON.stringify(o.body),
      },
      { ip: o.ip ?? "10.0.0.1" },
    );
  const login = async (body: Record<string, string>, ip?: string) => {
    const res = await send("POST", "/api/auth/login", { body, ip });
    const cookie = /sqlitend_session=([^;]+)/.exec(res.headers.get("set-cookie") ?? "")?.[1];
    return { res, cookie };
  };
  return { send, login, service };
}

const setPassword = async () => repo.setPassword(await Bun.password.hash(PASSWORD), clock);

describe("control-plane auth", () => {
  test("before setup: protected API is 503 setup_required; session reports it", async () => {
    const { send, login } = makeApp();
    const r = await send("GET", "/api/workspaces");
    expect(r.status).toBe(503);
    expect(((await r.json()) as { error: { code: string } }).error.code).toBe("setup_required");
    expect(await (await send("GET", "/api/auth/session")).json()).toMatchObject({ setupRequired: true, authenticated: false });
    expect((await login({ password: "anything" })).res.status).toBe(503);
  });

  test("login sets a hardened cookie; API needs it; only the hash is stored", async () => {
    await setPassword();
    const { send, login } = makeApp();
    expect((await send("GET", "/api/workspaces")).status).toBe(401);

    const { res, cookie } = await login({ password: PASSWORD });
    expect(res.status).toBe(200);
    const sc = res.headers.get("set-cookie")!;
    expect(sc).toContain("HttpOnly");
    expect(sc).toContain("SameSite=Strict");
    expect(sc).toContain("Path=/");
    expect((await send("GET", "/api/workspaces", { cookie })).status).toBe(200);
    expect(await (await send("GET", "/api/auth/session", { cookie })).json()).toMatchObject({ authenticated: true });

    const stored = db.query("SELECT id_hash FROM sessions").all() as { id_hash: string }[];
    expect(stored).toHaveLength(1);
    expect(stored[0]!.id_hash).not.toBe(cookie);
    expect(stored[0]!.id_hash).toMatch(/^[0-9a-f]{64}$/);
  });

  test("wrong password is 401 and audited as denied", async () => {
    await setPassword();
    const { login } = makeApp();
    const { res } = await login({ password: "nope" });
    expect(res.status).toBe(401);
    expect(repo.listAudit(10)[0]).toMatchObject({ action: "auth.login", outcome: "denied", detail: "invalid", ip: "10.0.0.1" });
  });

  test("mutating calls need the CSRF header, even with a valid session", async () => {
    await setPassword();
    const { send, login } = makeApp();
    const { cookie } = await login({ password: PASSWORD });
    const r = await send("POST", "/api/workspaces", { body: { name: "x" }, cookie, csrf: false });
    expect(r.status).toBe(403);
    expect((await send("POST", "/api/auth/login", { body: { password: PASSWORD }, csrf: false })).status).toBe(403);
  });

  test("throttling: 5 failures per IP lock that IP (even the right password), not others", async () => {
    await setPassword();
    const { login } = makeApp();
    for (let i = 0; i < 5; i++) expect((await login({ password: "bad" })).res.status).toBe(401);
    const locked = await login({ password: PASSWORD });
    expect(locked.res.status).toBe(429);
    expect(Number(locked.res.headers.get("retry-after"))).toBeGreaterThan(0);
    expect((await login({ password: PASSWORD }, "10.0.0.2")).res.status).toBe(200);
    clock += 16 * 60_000;
    expect((await login({ password: PASSWORD })).res.status).toBe(200);
  });

  test("TOTP: required, wrong code fails, right code logs in", async () => {
    await setPassword();
    const secret = base32Encode(Buffer.from("12345678901234567890"));
    repo.setTotpSecret(secret);
    const { login } = makeApp();
    const first = await login({ password: PASSWORD });
    expect(first.res.status).toBe(401);
    expect(((await first.res.json()) as { error: { code: string } }).error.code).toBe("totp_required");
    expect((await login({ password: PASSWORD, totp: "000000" })).res.status).toBe(401);
    const ok = await login({ password: PASSWORD, totp: totpAt(secret, clock) });
    expect(ok.res.status).toBe(200);
  });

  test("sessions: idle timeout, absolute limit, logout, and password change end them", async () => {
    await setPassword();
    const service = new AuthService(repo, { now: () => clock, idleMs: 3_600_000, absoluteMs: 3 * 3_600_000 });
    const { send, login } = makeApp(service);

    let { cookie } = await login({ password: PASSWORD });
    clock += 3_600_001;
    expect((await send("GET", "/api/workspaces", { cookie })).status).toBe(401); // idle

    ({ cookie } = await login({ password: PASSWORD }));
    for (let i = 0; i < 4; i++) {
      clock += 50 * 60_000;
      if (i < 3) expect((await send("GET", "/api/workspaces", { cookie })).status).toBe(200);
    }
    expect((await send("GET", "/api/workspaces", { cookie })).status).toBe(401); // absolute (3h)

    ({ cookie } = await login({ password: PASSWORD }));
    expect((await send("POST", "/api/auth/logout", { cookie })).status).toBe(204);
    expect((await send("GET", "/api/workspaces", { cookie })).status).toBe(401);

    ({ cookie } = await login({ password: PASSWORD }));
    repo.setPassword(await Bun.password.hash("another long password"), clock);
    expect((await send("GET", "/api/workspaces", { cookie })).status).toBe(401);
  });

  test("audit: mutating calls recorded with actor, ip, target and outcome; readable via API", async () => {
    await setPassword();
    const { send, login } = makeApp();
    const { cookie } = await login({ password: PASSWORD });
    const ws = (await (await send("POST", "/api/workspaces", { body: { name: "Bots" }, cookie, ip: "100.64.0.9" })).json()) as { id: string };
    await send("DELETE", `/api/workspaces/${ws.id}`, { cookie, ip: "100.64.0.9" });
    await send("DELETE", `/api/workspaces/${ws.id}`, { cookie, ip: "100.64.0.9" }); // 404 now
    const rows = (await (await send("GET", "/api/audit?limit=10", { cookie })).json()) as { action: string; outcome: string; actor: string; ip: string; target: string | null }[];
    expect(rows.slice(0, 4).map((r) => [r.action, r.outcome])).toEqual([
      ["workspace.delete", "error"],
      ["workspace.delete", "ok"],
      ["workspace.create", "ok"],
      ["auth.login", "ok"],
    ]);
    expect(rows[1]).toMatchObject({ actor: "admin", ip: "100.64.0.9", target: ws.id });
  });
});

describe("review regressions", () => {
  test("a parallel burst cannot outrun the per-IP throttle", async () => {
    await setPassword();
    const { login } = makeApp(new AuthService(repo, { now: () => clock, maxInFlight: 100 }));
    const results = await Promise.all(Array.from({ length: 20 }, () => login({ password: "bad" })));
    const statuses = results.map((r) => r.res.status);
    expect(statuses.filter((x) => x === 401)).toHaveLength(5);
    expect(statuses.filter((x) => x === 429)).toHaveLength(15);
  });

  test("in-flight cap: concurrent verifies beyond the cap are refused", async () => {
    await setPassword();
    const { login } = makeApp(new AuthService(repo, { now: () => clock, maxInFlight: 2 }));
    const statuses = await Promise.all(Array.from({ length: 6 }, (_, i) => login({ password: "bad" }, `10.1.0.${i}`))).then((r) => r.map((x) => x.res.status));
    expect(statuses.filter((x) => x === 401)).toHaveLength(2);
    expect(statuses.filter((x) => x === 429)).toHaveLength(4);
  });

  test("global failures slow logins down but never lock the operator out", async () => {
    await setPassword();
    const service = new AuthService(repo, { now: () => clock, globalFailures: 3, slowDelayMs: 50 });
    const { login } = makeApp(service);
    for (let i = 0; i < 4; i++) await login({ password: "bad" }, `10.2.0.${i}`);
    const t0 = performance.now();
    const ok = await login({ password: PASSWORD }, "10.9.9.9");
    expect(ok.res.status).toBe(200);
    expect(performance.now() - t0).toBeGreaterThanOrEqual(45);
  });

  test("a TOTP code works once", async () => {
    await setPassword();
    const secret = base32Encode(Buffer.from("12345678901234567890"));
    repo.setTotpSecret(secret);
    const { login } = makeApp();
    const code = totpAt(secret, clock);
    expect((await login({ password: PASSWORD, totp: code })).res.status).toBe(200);
    expect((await login({ password: PASSWORD, totp: code })).res.status).toBe(401);
    clock += 30_000;
    expect((await login({ password: PASSWORD, totp: totpAt(secret, clock) })).res.status).toBe(200);
  });

  test("cookieSecure=on forces Secure over plain HTTP; x-forwarded-proto is ignored", async () => {
    await setPassword();
    const service = new AuthService(repo, { now: () => clock });
    const plainApp = makeApp(service);
    const r1 = await plainApp.send("POST", "/api/auth/login", { body: { password: PASSWORD } });
    expect(r1.headers.get("set-cookie")).not.toContain("Secure");
    const app = createRoutes({
      config: loadConfig({}, { dataRoot: dir }), workspaces: new WorkspacesRepo(db), databases: new DatabasesRepo(db),
      tokens: new TokensRepo(db), supervisor: {} as unknown as Supervisor, sampler: {} as unknown as Sampler,
      sqldOk: true, sqldVersion: "f", version: "t", auth: { service, repo, cookieSecure: "on" },
    });
    const r2 = await app.request("/api/auth/login", { method: "POST", headers: { [CSRF_HEADER]: "1", "content-type": "application/json" }, body: JSON.stringify({ password: PASSWORD }) }, { ip: "1.1.1.1" });
    expect(r2.headers.get("set-cookie")).toContain("Secure");
  });
});

describe("clientIp", () => {
  const req = (h: Record<string, string>) => new Request("http://x/", { headers: h });
  test("honours forwarded headers only from loopback peers and only when trusted", () => {
    expect(clientIp(req({ "cf-connecting-ip": "203.0.113.7" }), "127.0.0.1", "cloudflare")).toBe("203.0.113.7");
    expect(clientIp(req({ "cf-connecting-ip": "203.0.113.7" }), "198.51.100.1", "cloudflare")).toBe("198.51.100.1");
    expect(clientIp(req({ "cf-connecting-ip": "203.0.113.7" }), "127.0.0.1", "off")).toBe("127.0.0.1");
    expect(clientIp(req({ "x-forwarded-for": "1.2.3.4, 203.0.113.9" }), "::1", "xff")).toBe("203.0.113.9");
    expect(clientIp(req({ "cf-connecting-ip": "<script>" }), "127.0.0.1", "cloudflare")).toBe("127.0.0.1");
  });
});

describe("config", () => {
  test("SQLITEND_AUTH defaults on; off only on loopback", () => {
    expect(loadConfig({}).authEnabled).toBe(true);
    expect(loadConfig({ SQLITEND_AUTH: "off", SQLITEND_HOST: "127.0.0.1" }).authEnabled).toBe(false);
    expect(() => loadConfig({ SQLITEND_AUTH: "off" })).toThrow(/loopback/);
    expect(() => loadConfig({ SQLITEND_AUTH: "maybe" })).toThrow(/on\|off/);
  });
});
