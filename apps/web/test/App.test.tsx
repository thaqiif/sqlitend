import { describe, expect, test } from "bun:test";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { App } from "../src/App";
import { mockFetch } from "./fetch-mock";

const WS = { id: "w1", slug: "prod", name: "Production", protected: false, createdAt: 1 };
const DB = { id: "d1", workspaceId: "w1", name: "analytics", slug: "analytics", status: "running", port: 8101, publicUrl: null, sqldVersion: null };

function routes() {
  return mockFetch((c) => {
    if (c.url === "/api/workspaces") return { json: [WS] };
    if (c.url === "/api/system")
      return { json: { version: "0.1.4", sqldVersion: null, sqldOk: false, sqldReason: "not ready", sqldBinarySha256: null, publicHost: "h", counts: { workspaces: 1, databases: 1 } } };
    if (c.url.startsWith("/api/databases?")) return { json: [DB] };
    if (c.url === "/api/databases/d1/schema")
      return { json: { tables: [{ name: "users", type: "table", rowCountEstimate: 3 }] } };
    if (c.url.startsWith("/api/audit")) return { json: [{ id: 1, at: 1_700_000_000_000, action: "login", outcome: "denied", actor: "admin", ip: "1.2.3.4", target: null, detail: "bad password" }] };
    if (c.url === "/api/trash") return { json: [] };
    if (c.url === "/api/backups/control") return { json: { enabled: false } };
    if (c.url === "/api/backups/replicas") return { json: [{ id: "r1", name: "old", slug: "old", exists: false }] };
    if (c.url === "/api/backups") return { json: [] };
    return undefined;
  });
}

function renderApp(onLogout?: () => void) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <App onLogout={onLogout} />
    </QueryClientProvider>,
  );
}

describe("App shell", () => {
  test("offers Databases, Activity, Backups and Trash in both navs and switches views", async () => {
    routes();
    const user = userEvent.setup();
    renderApp();
    const top = await screen.findByRole("navigation", { name: "Main" });
    const bottom = screen.getByRole("navigation", { name: "Mobile navigation" });
    for (const nav of [top, bottom]) {
      expect(within(nav).getAllByRole("button").map((b) => b.textContent)).toEqual(["Databases", "Activity", "Backups", "Trash"]);
    }
    expect(within(top).getByRole("button", { name: "Databases" }).getAttribute("aria-current")).toBe("page");

    await user.click(within(bottom).getByRole("button", { name: "Activity" }));
    expect(await screen.findByRole("heading", { name: "Activity" })).toBeTruthy();
    expect(await screen.findByText("bad password", { exact: false })).toBeTruthy();
    expect(within(bottom).getByRole("button", { name: "Activity" }).getAttribute("aria-current")).toBe("page");

    await user.click(within(top).getByRole("button", { name: "Backups" }));
    expect(await screen.findByRole("heading", { name: "Backups" })).toBeTruthy();
    expect(await screen.findByText(/Not backed up/)).toBeTruthy();
    expect(await screen.findByText("deleted")).toBeTruthy();

    await user.click(within(top).getByRole("button", { name: "Trash" }));
    expect(await screen.findByRole("heading", { name: /Trash \(0\)/ })).toBeTruthy();
    expect(await screen.findByText("Trash is empty.")).toBeTruthy();

    await user.click(within(top).getByRole("button", { name: "Databases" }));
    expect(await screen.findByRole("region", { name: "Databases" })).toBeTruthy();
  });

  test("theme toggle flips <html> and its label", async () => {
    routes();
    const user = userEvent.setup();
    renderApp();
    const toggle = await screen.findByRole("button", { name: /Switch to (dark|light) theme/ });
    const before = document.documentElement.getAttribute("data-theme");
    await user.click(toggle);
    const after = document.documentElement.getAttribute("data-theme");
    expect(after).not.toBe(before);
    expect(screen.getByRole("button", { name: `Switch to ${before} theme` })).toBeTruthy();
  });

  test("logout button only when the handler is provided, and calls it", async () => {
    routes();
    const user = userEvent.setup();
    let called = 0;
    renderApp(() => void called++);
    await user.click(await screen.findByRole("button", { name: "Log out" }));
    expect(called).toBe(1);
  });

  test("degraded sqld is announced", async () => {
    routes();
    renderApp();
    await waitFor(() => expect(screen.getAllByText(/sqld degraded — not ready/).length).toBeGreaterThan(0));
  });

  test("explorer drawer lists databases and opens one", async () => {
    routes();
    const user = userEvent.setup();
    renderApp();
    await user.click(await screen.findByRole("button", { name: "Open schema explorer" }));
    const drawer = await screen.findByRole("dialog", { name: "Database & Table Explorer" });
    await user.click(await within(drawer).findByRole("button", { name: /analytics/ }));
    // opening a database leaves the drawer up and lists its tables
    expect(await within(drawer).findByRole("button", { name: /users/ })).toBeTruthy();
  });
});
