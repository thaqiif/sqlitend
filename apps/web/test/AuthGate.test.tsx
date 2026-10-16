import { describe, expect, test } from "bun:test";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { AuthGate } from "../src/AuthGate";
import { UNAUTHENTICATED_EVENT } from "../src/api/client";
import { mockFetch } from "./fetch-mock";

const SYSTEM = {
  version: "0.1.4",
  sqldVersion: null,
  sqldOk: true,
  sqldReason: null,
  sqldBinarySha256: null,
  publicHost: "127.0.0.1",
  counts: { workspaces: 0, databases: 0 },
};

function renderGate() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <AuthGate />
    </QueryClientProvider>,
  );
}

const session = (authenticated: boolean, setupRequired = false) => ({ json: { authenticated, setupRequired } });

describe("AuthGate + LoginPage", () => {
  test("unauthenticated session shows the sign-in form", async () => {
    mockFetch((c) => (c.url === "/api/auth/session" ? session(false) : undefined));
    renderGate();
    expect(await screen.findByLabelText(/Password or Admin Token/)).toBeTruthy();
    expect(screen.getByRole("button", { name: "Sign in" })).toBeTruthy();
  });

  test("password / admin-token login posts it, then shows the app shell", async () => {
    let loggedIn = false;
    const { calls } = mockFetch((c) => {
      if (c.url === "/api/auth/session") return session(loggedIn);
      if (c.url === "/api/auth/login") {
        loggedIn = true;
        return { json: { authenticated: true } };
      }
      if (c.url === "/api/workspaces") return { json: [] };
      if (c.url === "/api/system") return { json: SYSTEM };
      return undefined;
    });
    const user = userEvent.setup();
    renderGate();
    await user.type(await screen.findByLabelText(/Password or Admin Token/), "sk_admin_token");
    await user.click(screen.getByRole("button", { name: "Sign in" }));
    const login = calls.find((c) => c.url === "/api/auth/login")!;
    expect(login.method).toBe("POST");
    expect(login.body).toEqual({ password: "sk_admin_token" });
    expect(login.headers["x-sqlitend-csrf"]).toBe("1");
    expect(await screen.findByRole("navigation", { name: "Main" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Log out" })).toBeTruthy();
  });

  test("totp_required switches to the authenticator step and sends the code", async () => {
    const { calls } = mockFetch((c) => {
      if (c.url === "/api/auth/session") return session(false);
      if (c.url === "/api/auth/login") {
        const body = c.body as { totp?: string };
        return body.totp
          ? { json: { authenticated: true } }
          : { status: 401, json: { error: { code: "totp_required", message: "code needed" } } };
      }
      if (c.url === "/api/workspaces") return { json: [] };
      return undefined;
    });
    const user = userEvent.setup();
    renderGate();
    await user.type(await screen.findByLabelText(/Password or Admin Token/), "hunter2");
    await user.click(screen.getByRole("button", { name: "Sign in" }));
    const code = await screen.findByLabelText(/Authenticator code/);
    expect(screen.queryByRole("alert")).toBeNull(); // totp_required is a step, not an error
    expect((screen.getByLabelText(/Password or Admin Token/) as HTMLInputElement).disabled).toBe(true);
    await user.type(code, "12a3456"); // non-digits are stripped
    expect((code as HTMLInputElement).value).toBe("123456");
    await user.click(screen.getByRole("button", { name: "Verify" }));
    await waitFor(() => expect(calls.filter((c) => c.url === "/api/auth/login")).toHaveLength(2));
    expect(calls.filter((c) => c.url === "/api/auth/login")[1]!.body).toEqual({ password: "hunter2", totp: "123456" });
  });

  test("a rejected login shows the server message and stays on the form", async () => {
    mockFetch((c) => {
      if (c.url === "/api/auth/session") return session(false);
      if (c.url === "/api/auth/login") return { status: 401, json: { error: { code: "bad_credentials", message: "Wrong password" } } };
      return undefined;
    });
    const user = userEvent.setup();
    renderGate();
    await user.type(await screen.findByLabelText(/Password or Admin Token/), "nope");
    await user.click(screen.getByRole("button", { name: "Sign in" }));
    expect((await screen.findByRole("alert")).textContent).toContain("Wrong password");
    expect(screen.queryByLabelText(/Authenticator code/)).toBeNull();
  });

  test("setupRequired shows how to set a password", async () => {
    mockFetch((c) => (c.url === "/api/auth/session" ? session(false, true) : undefined));
    renderGate();
    expect(await screen.findByText("Set an admin password")).toBeTruthy();
    expect(screen.getByText("sqlitend set-password")).toBeTruthy();
  });

  test("a 401 from any call drops an open session back to login", async () => {
    mockFetch((c) => {
      if (c.url === "/api/auth/session") return session(true);
      if (c.url === "/api/workspaces") return { json: [] };
      if (c.url === "/api/system") return { json: SYSTEM };
      return undefined;
    });
    renderGate();
    await screen.findByRole("navigation", { name: "Main" });
    act(() => {
      window.dispatchEvent(new Event(UNAUTHENTICATED_EVENT));
    });
    expect(await screen.findByLabelText(/Password or Admin Token/)).toBeTruthy();
  });

  test("auth routes missing (404, SQLITEND_AUTH=off) opens the app without a logout button", async () => {
    mockFetch((c) => {
      if (c.url === "/api/workspaces") return { json: [] };
      if (c.url === "/api/system") return { json: SYSTEM };
      return undefined;
    });
    renderGate();
    await screen.findByRole("navigation", { name: "Main" });
    expect(screen.queryByRole("button", { name: "Log out" })).toBeNull();
  });

  test("an unreachable server shows an error instead of the form", async () => {
    globalThis.fetch = (async () => {
      throw new Error("Server unreachable");
    }) as unknown as typeof fetch;
    renderGate();
    expect((await screen.findByRole("alert")).textContent).toContain("Server unreachable");
  });
});
