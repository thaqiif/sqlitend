import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { Server } from "bun";
import type { DatabaseRow } from "../../src/db/repos/databases.ts";
import {
  checkToken,
  createGatewayHandler,
  jtiFromAuthorization,
  keyFromHost,
  lookupByKey,
  maxSlugLength,
  parseHostTemplate,
  publicKeyFor,
  renderHost,
} from "../../src/gateway/gateway.ts";
import { loadConfig } from "../../src/config.ts";
import { mintToken } from "../../src/auth/tokens.ts";
import { createSignatureVerifier } from "../../src/auth/verify.ts";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const tpl = parseHostTemplate("{db}-libsql.cloudsby.me");

describe("host template", () => {
  test("parses and renders a one-level hostname", () => {
    expect(renderHost(tpl, "bots-prod")).toBe("bots-prod-libsql.cloudsby.me");
    expect(maxSlugLength(tpl)).toBe(63 - "-libsql".length);
  });

  test.each([
    ["no placeholder", "libsql.cloudsby.me"],
    ["placeholder twice", "{db}-{db}.cloudsby.me"],
    ["placeholder not in first label", "libsql.{db}.cloudsby.me"],
    ["no zone after the label", "{db}-libsql"],
    ["bad characters", "{db}_libsql.cloudsby.me"],
  ])("rejects %s", (_why, raw) => {
    expect(() => parseHostTemplate(raw)).toThrow();
  });

  test("config fails at boot on a bad template or a port without template", () => {
    expect(() => loadConfig({ SQLITEND_GATEWAY_PORT: "6080" })).toThrow(/TEMPLATE/);
    expect(() => loadConfig({ SQLITEND_GATEWAY_PORT: "6080", SQLITEND_GATEWAY_HOST_TEMPLATE: "sql.{db}.x.me" })).toThrow();
    const c = loadConfig({ SQLITEND_GATEWAY_PORT: "6080", SQLITEND_GATEWAY_HOST_TEMPLATE: "{db}-libsql.cloudsby.me" });
    expect(c.gatewayHost).toBe("127.0.0.1");
    expect(loadConfig({}).gatewayHostTemplate).toBeNull();
  });
});

describe("keyFromHost", () => {
  test.each([
    ["bots-prod-libsql.cloudsby.me", "bots-prod"],
    ["BOTS-PROD-libsql.CloudsBy.me:443", "bots-prod"],
    ["bots-prod-libsql.cloudsby.me.", "bots-prod"],
    ["3f1c2e9a-0b7d-4c1e-9a2b-1234567890ab-libsql.cloudsby.me", "3f1c2e9a-0b7d-4c1e-9a2b-1234567890ab"],
  ])("%s -> %s", (host, key) => expect(keyFromHost(tpl, host)).toBe(key));

  test.each([
    [null],
    ["cloudsby.me"],
    ["-libsql.cloudsby.me"],
    ["a.b-libsql.cloudsby.me"],
    ["bots-libsql.cloudsby.me.evil.com"],
    ["bots-libsql.evilcloudsby.me"],
    ["-bots-libsql.cloudsby.me"],
    [`${"a".repeat(57)}-libsql.cloudsby.me`],
  ])("rejects %s", (host) => expect(keyFromHost(tpl, host)).toBeNull());
});

function row(over: Partial<DatabaseRow>): DatabaseRow {
  return {
    id: crypto.randomUUID(), workspace_id: crypto.randomUUID(), slug: "bots-prod", name: "Bots", status: "running",
    pid: 1, start_time: 0, port: null, grpc_port: null, data_dir: "/x", auth_key: null, auto_start: 1,
    sqld_version: null, failed_reason: null, dns_hostname: null, dns_record_id: null, dns_status: null, dns_error: null,
    created_at: 0, ...over,
  };
}

describe("publicKeyFor", () => {
  test("slug when it fits a label, id otherwise", () => {
    expect(publicKeyFor(tpl, { id: "i", slug: "short" })).toBe("short");
    expect(publicKeyFor(tpl, { id: "i", slug: "a".repeat(57) })).toBe("i");
  });
});

describe("lookupByKey", () => {
  test("id or slug", () => {
    const r = row({});
    const repo = { getById: (id: string) => (id === r.id ? r : null), getBySlug: (s: string) => (s === r.slug ? r : null) };
    expect(lookupByKey(r.id, repo)).toBe(r);
    expect(lookupByKey("bots-prod", repo)).toBe(r);
    expect(lookupByKey("nope", repo)).toBeNull();
  });
});

describe("gateway proxy (real upstream)", () => {
  let upstream: Server<undefined>;
  const seenHeaders: Headers[] = [];
  const seen: { method: string; path: string; auth: string | null; host: string | null; body: string }[] = [];

  beforeAll(() => {
    upstream = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      async fetch(req) {
        const u = new URL(req.url);
        seenHeaders.push(req.headers);
        seen.push({ method: req.method, path: u.pathname + u.search, auth: req.headers.get("authorization"), host: req.headers.get("host"), body: await req.text() });
        if (u.pathname === "/v2/pipeline") {
          return Response.json({ results: [{ type: "ok" }] }, { headers: { "x-sqld": "1" } });
        }
        return new Response("no", { status: 404 });
      },
    });
  });
  afterAll(() => upstream.stop(true));

  const dbs: DatabaseRow[] = [];
  const handler = () =>
    createGatewayHandler({
      template: tpl,
      findDatabase: (k) => lookupByKey(k, {
        getById: (id) => dbs.find((d) => d.id === id) ?? null,
        getBySlug: (s) => dbs.find((d) => d.slug === s) ?? null,
      }),
      upstreamHost: "127.0.0.1",
      maxBodyBytes: 1024,
    });

  const req = (host: string, init: RequestInit & { path?: string } = {}) =>
    new Request(`http://gateway${init.path ?? "/v2/pipeline"}`, { ...init, headers: { host, ...(init.headers as Record<string, string>) } });

  test("forwards method, path, query, body and auth; relays status + headers", async () => {
    dbs.push(row({ slug: "bots-prod", port: upstream.port }));
    const res = await handler()(req("bots-prod-libsql.cloudsby.me", {
      method: "POST",
      path: "/v2/pipeline?x=1",
      body: '{"requests":[]}',
      headers: { authorization: "Bearer jwt", "content-type": "application/json" },
    }));
    expect(res.status).toBe(200);
    expect(res.headers.get("x-sqld")).toBe("1");
    expect(await res.json()).toEqual({ results: [{ type: "ok" }] });
    const last = seen.at(-1)!;
    expect(last).toMatchObject({ method: "POST", path: "/v2/pipeline?x=1", auth: "Bearer jwt", body: '{"requests":[]}' });
    expect(last.host).toBe(`127.0.0.1:${upstream.port}`);
  });

  test("strips headers named in Connection", async () => {
    await handler()(req("bots-prod-libsql.cloudsby.me", { method: "POST", body: "{}", headers: { connection: "x-secret", "x-secret": "1" } }));
    expect(seenHeaders.at(-1)!.get("x-secret")).toBeNull();
  });

  test("504 when upstream exceeds the timeout", async () => {
    const slow = createGatewayHandler({
      template: tpl, findDatabase: () => row({ port: upstream.port }), upstreamHost: "127.0.0.1", maxBodyBytes: 1024,
      upstreamTimeoutMs: 50, fetchImpl: ((_u: string, init: RequestInit) => new Promise((_r, rej) => init.signal!.addEventListener("abort", () => rej(init.signal!.reason)))) as unknown as typeof fetch,
    });
    expect((await slow(req("bots-prod-libsql.cloudsby.me", { method: "POST", body: "{}" }))).status).toBe(504);
  });

  test("routes by id as well as slug", async () => {
    const r = row({ slug: "other", port: upstream.port });
    dbs.push(r);
    const res = await handler()(req(`${r.id}-libsql.cloudsby.me`, { method: "POST", body: "{}" }));
    expect(res.status).toBe(200);
  });

  test("uniform 404 for foreign hosts and unknown databases", async () => {
    for (const host of ["evil.com", "missing-libsql.cloudsby.me"]) {
      const res = await handler()(req(host));
      expect(res.status).toBe(404);
      expect(await res.text()).toBe("not found");
    }
  });

  test("stopped db is indistinguishable from unknown; 413 over the cap; 501 upgrade for any host; 502 upstream down", async () => {
    dbs.push(row({ slug: "stopped", status: "stopped", port: upstream.port }));
    const stopped = await handler()(req("stopped-libsql.cloudsby.me"));
    expect(stopped.status).toBe(404);
    expect(await stopped.text()).toBe("not found");
    expect((await handler()(req("missing-libsql.cloudsby.me", { headers: { upgrade: "websocket" } }))).status).toBe(501);

    const big = await handler()(req("bots-prod-libsql.cloudsby.me", { method: "POST", body: "x".repeat(2048), headers: { "content-length": "2048" } }));
    expect(big.status).toBe(413);

    const ws = await handler()(req("bots-prod-libsql.cloudsby.me", { headers: { upgrade: "websocket" } }));
    expect(ws.status).toBe(501);

    dbs.push(row({ slug: "dead", port: 1 }));
    expect((await handler()(req("dead-libsql.cloudsby.me", { method: "POST", body: "{}" }))).status).toBe(502);
  });
});

describe("gateway token allowlist", () => {
  const jwt = (payload: object) =>
    `Bearer ${Buffer.from('{"alg":"EdDSA"}').toString("base64url")}.${Buffer.from(JSON.stringify(payload)).toString("base64url")}.sig`;
  const NOW = 1_800_000_000_000;
  const recs = new Map<string, { database_id: string; expires_at: number; revoked_at: number | null }>();
  const lookup = (jti: string) => recs.get(jti) ?? null;

  test("jtiFromAuthorization", () => {
    expect(jtiFromAuthorization(null)).toBeNull();
    expect(jtiFromAuthorization("Basic abc")).toBe("malformed");
    expect(jtiFromAuthorization("Bearer not-a-jwt")).toBe("malformed");
    expect(jtiFromAuthorization(jwt({ sub: "x" }))).toBe("malformed");
    expect(jtiFromAuthorization(`Bearer a.${"!!"}.c`)).toBe("malformed");
    expect(jtiFromAuthorization(jwt({ jti: "j1" }))).toBe("j1");
  });

  test.each([
    ["missing", null, "db1"],
    ["malformed", "Bearer x", "db1"],
    ["unknown", "nope", "db1"],
    ["wrong_database", "live", "db2"],
    ["revoked", "rev", "db1"],
    ["expired", "old", "db1"],
  ])("denies %s", (reason, jti, dbId) => {
    recs.set("live", { database_id: "db1", expires_at: NOW + 1, revoked_at: null });
    recs.set("rev", { database_id: "db1", expires_at: NOW + 1000, revoked_at: NOW - 5 });
    recs.set("old", { database_id: "db1", expires_at: NOW, revoked_at: null });
    const header = jti === null ? null : jti.startsWith("Bearer") ? jti : jwt({ jti });
    expect(checkToken(header, dbId, lookup, NOW)).toEqual({ ok: false, reason: reason as never });
  });

  test("accepts a live token bound to the database", () => {
    recs.set("live", { database_id: "db1", expires_at: NOW + 1, revoked_at: null });
    expect(checkToken(jwt({ jti: "live" }), "db1", lookup, NOW)).toEqual({ ok: true, jti: "live" });
  });

  test("handler: denied tokens get the uniform 404 and never reach upstream; accepted ones do + onUsed fires", async () => {
    const r = row({ slug: "guarded", port: 9 });
    let upstreamCalls = 0;
    let lastUpstream: { url: string; headers: Headers } | null = null;
    const used: string[] = [];
    recs.set("ok", { database_id: r.id, expires_at: NOW + 60_000, revoked_at: null });
    recs.set("gone", { database_id: r.id, expires_at: NOW + 60_000, revoked_at: NOW - 1 });
    const h = createGatewayHandler({
      template: tpl,
      findDatabase: () => r,
      upstreamHost: "127.0.0.1",
      maxBodyBytes: 1024,
      now: () => NOW,
      tokens: {
        lookup,
        verifySignature: async (_db, jwt) => (jwt.endsWith(".sig") ? true : "bad_signature"),
        onUsed: (jti) => used.push(jti),
      },
      fetchImpl: (async (url: string, init: RequestInit) => {
        upstreamCalls++;
        lastUpstream = { url, headers: new Headers(init.headers) };
        return new Response("{}");
      }) as unknown as typeof fetch,
    });
    const call = (auth?: string) =>
      h(new Request("http://g/v2/pipeline", { method: "POST", body: "{}", headers: { host: "guarded-libsql.cloudsby.me", ...(auth ? { authorization: auth } : {}) } }));
    for (const auth of [undefined, jwt({ jti: "gone" }), jwt({ jti: "nope" })]) {
      const res = await call(auth);
      expect(res.status).toBe(404);
      expect(await res.text()).toBe("not found");
    }
    expect(upstreamCalls).toBe(0);
    expect((await call(jwt({ jti: "ok" }))).status).toBe(200);
    expect(upstreamCalls).toBe(1);
    expect(used).toEqual(["ok"]);

    // Lowercase scheme accepted; forged signature refused.
    expect((await call(jwt({ jti: "ok" }).replace("Bearer", "bearer"))).status).toBe(200);
    expect((await call(jwt({ jti: "ok" }).replace(/\.sig$/, ".forged"))).status).toBe(404);

    // Only the checked Authorization reaches sqld: no query string, no other auth-ish headers.
    await h(new Request("http://g/v2/pipeline?jwt=revoked-token", {
      method: "POST", body: "{}",
      headers: { host: "guarded-libsql.cloudsby.me", authorization: jwt({ jti: "ok" }), "x-proxy-authorization": "Bearer other", "x-auth-token": "t", "content-type": "application/json" },
    }));
    expect(lastUpstream!.url).toBe("http://127.0.0.1:9/v2/pipeline");
    expect(lastUpstream!.headers.get("x-proxy-authorization")).toBeNull();
    expect(lastUpstream!.headers.get("x-auth-token")).toBeNull();
    expect(lastUpstream!.headers.get("authorization")).toBe(jwt({ jti: "ok" }));
    expect(lastUpstream!.headers.get("content-type")).toBe("application/json");
  });

  test("real verifier: accepts a token minted for the db, rejects other db's token, no_key without a key", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "sqlitend-verify-"));
    try {
      const a = await mintToken({ dataRoot: root, dbSlug: "a", dbId: "db-a", scope: "full" }, 1);
      const b = await mintToken({ dataRoot: root, dbSlug: "b", dbId: "db-b", scope: "full" }, 1);
      const verify = createSignatureVerifier(root);
      expect(await verify("db-a", a.token)).toBe(true);
      expect(await verify("db-a", b.token)).toBe("bad_signature");
      const [h0, p0] = a.token.split(".");
      expect(await verify("db-a", `${h0}.${p0}.`)).toBe("bad_signature"); // alg-none style strip
      expect(await verify("db-missing", a.token)).toBe("no_key");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
