import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createStaticHandler } from "../../src/http/static.ts";

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
