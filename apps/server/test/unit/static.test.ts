import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createStaticHandler, isAllowedHost } from "../../src/http/static.ts";

const dirs: string[] = [];
function dist(): string {
  const d = mkdtempSync(path.join(tmpdir(), "sqlitend-static-"));
  dirs.push(d);
  writeFileSync(path.join(d, "index.html"), "<!doctype html><title>sqlitend</title><p>hi</p>");
  mkdirSync(path.join(d, "assets"));
  writeFileSync(path.join(d, "assets", "app.js"), "console.log('hi');");
  return d;
}

afterAll(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

describe("static handler", () => {
  test("serves index.html at /", () => {
    const serve = createStaticHandler(dist());
    const res = serve("/");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/html");
    expect(res.headers.get("x-frame-options")).toBe("DENY");
  });

  test("serves a real asset with the right mime type", () => {
    const serve = createStaticHandler(dist());
    const res = serve("/assets/app.js");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/javascript");
  });

  test("rejects path traversal (never leaks files outside the dist)", async () => {
    const serve = createStaticHandler(dist());
    const res = serve("/../../etc/passwd");
    // The traversal is normalized away and falls back to the SPA index.html,
    // NOT to the file being traversed into.
    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body).not.toContain("root:");
  });

  test("unknown routes fall back to index.html", async () => {
    const serve = createStaticHandler(dist());
    const res = serve("/some/client/route");
    expect(res.status).toBe(200);
    expect(await res.text()).toContain("sqlitend");
  });
});

describe("isAllowedHost (DNS-rebinding guard)", () => {
  test("loopback aliases are always allowed", () => {
    for (const h of ["127.0.0.1:6100", "localhost:6100", "[::1]:6100"]) {
      expect(isAllowedHost(h, 6100, "0.0.0.0")).toBe(true);
      expect(isAllowedHost(h, 6100, "127.0.0.1")).toBe(true);
    }
  });

  test("public IP literal works when bound to 0.0.0.0 but not when loopback-only", () => {
    // Direct-address access (Tailscale/LAN IP, IPv4 and IPv6) must pass when
    // the listener is public…
    expect(isAllowedHost("100.97.250.76:6100", 6100, "0.0.0.0")).toBe(true);
    expect(isAllowedHost("[2001:db8::1]:6100", 6100, "0.0.0.0")).toBe(true);
    // …but if the operator restricted the bind, the same request is refused.
    expect(isAllowedHost("100.97.250.76:6100", 6100, "127.0.0.1")).toBe(false);
  });

  test("DNS hostnames never pass, even when bound publicly (rebinding protection)", () => {
    expect(isAllowedHost("evil.example:6100", 6100, "0.0.0.0")).toBe(false);
    expect(isAllowedHost("sqlitend.test:6100", 6100, "0.0.0.0")).toBe(false);
    expect(isAllowedHost("evil.example:6100", 6100, "sqlitend.test")).toBe(false);
  });

  test("the configured bind hostname is allowed as itself", () => {
    expect(isAllowedHost("sqlitend.test:6100", 6100, "sqlitend.test")).toBe(true);
  });

  test("malformed/octet-overflow IPv4 literals are not IP literals", () => {
    expect(isAllowedHost("999.1.1.1:6100", 6100, "0.0.0.0")).toBe(false);
    expect(isAllowedHost("1.2.3:6100", 6100, "0.0.0.0")).toBe(false);
    expect(isAllowedHost("not-an-ip:6100", 6100, "0.0.0.0")).toBe(false);
  });
});
