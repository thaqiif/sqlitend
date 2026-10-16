import { describe, expect, test } from "bun:test";
import { ApiError, UNAUTHENTICATED_EVENT, api } from "../src/api/client";
import { mockFetch } from "./fetch-mock";

describe("api client", () => {
  test("every request carries the CSRF header and same-origin credentials", async () => {
    let creds: RequestCredentials | undefined;
    const { calls } = mockFetch(() => ({ json: [] }));
    const orig = globalThis.fetch;
    globalThis.fetch = ((i: RequestInfo | URL, init?: RequestInit) => {
      creds = init?.credentials;
      return orig(i, init);
    }) as typeof fetch;
    await api.listWorkspaces();
    expect(calls[0]!.url).toBe("/api/workspaces");
    expect(calls[0]!.headers["x-sqlitend-csrf"]).toBe("1");
    expect(creds).toBe("same-origin");
  });

  test("JSON content type only when there is a body", async () => {
    const { calls } = mockFetch(() => ({ json: { authenticated: true } }));
    await api.getSession();
    await api.login("pw");
    expect(calls[0]!.headers["content-type"]).toBeUndefined();
    expect(calls[1]!.headers["content-type"]).toBe("application/json");
    expect(calls[1]!.body).toEqual({ password: "pw" });
  });

  test("login sends totp only when given", async () => {
    const { calls } = mockFetch(() => ({ json: { authenticated: true } }));
    await api.login("pw", "123456");
    expect(calls[0]!.body).toEqual({ password: "pw", totp: "123456" });
  });

  test("204 resolves to undefined without parsing a body", async () => {
    mockFetch(() => ({ status: 204 }));
    expect(await api.logout()).toBeUndefined();
  });

  test("error bodies map to ApiError with status, code, message and detail", async () => {
    mockFetch(() => ({ status: 423, json: { error: { code: "protected", message: "Delete protection is on", detail: "ws" } } }));
    const err = await api.deleteWorkspace("w1", "slug").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApiError);
    const e = err as ApiError;
    expect(e.status).toBe(423);
    expect(e.code).toBe("protected");
    expect(e.message).toBe("Delete protection is on");
    expect(e.detail).toBe("ws");
  });

  test("a non-JSON failure still yields a generic ApiError", async () => {
    mockFetch(() => new Response("<html>bad gateway</html>", { status: 502, statusText: "Bad Gateway" }));
    const e = (await api.listWorkspaces().catch((x: unknown) => x)) as ApiError;
    expect(e).toBeInstanceOf(ApiError);
    expect(e.status).toBe(502);
    expect(e.code).toBe("request_failed");
    expect(e.message).toContain("502");
  });

  test("401 unauthenticated fires the session-lost event; other 401 codes do not", async () => {
    let fired = 0;
    const on = () => fired++;
    window.addEventListener(UNAUTHENTICATED_EVENT, on);
    mockFetch(() => ({ status: 401, json: { error: { code: "unauthenticated", message: "no session" } } }));
    await api.listWorkspaces().catch(() => {});
    expect(fired).toBe(1);
    mockFetch(() => ({ status: 401, json: { error: { code: "bad_credentials", message: "wrong password" } } }));
    await api.login("x").catch(() => {});
    expect(fired).toBe(1);
    window.removeEventListener(UNAUTHENTICATED_EVENT, on);
  });

  test("path segments are URL-encoded", async () => {
    const { calls } = mockFetch(() => ({ json: {} }));
    await api.getDatabase("a/b c");
    expect(calls[0]!.url).toBe("/api/databases/a%2Fb%20c");
  });
});
