import { describe, expect, test } from "bun:test";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { Database, Workspace } from "@sqlitend/shared";
import { DatabasesPage } from "../src/pages/DatabasesPage";
import { mockFetch } from "./fetch-mock";

const WS: Workspace = { id: "w1", slug: "prod", name: "Production", protected: true, createdAt: 1 };
const db = (over: Partial<Database>): Database =>
  ({
    id: "d1",
    workspaceId: "w1",
    name: "analytics",
    slug: "analytics-ab12",
    status: "running",
    port: 8101,
    publicUrl: null,
    sqldVersion: "sqld 0.24.32 (abc 2025-02-14)",
    ...over,
  }) as Database;

function routes(dbs: Database[]) {
  return mockFetch((c) => {
    if (c.url.startsWith("/api/databases?workspaceId=")) return { json: dbs };
    if (c.url === "/api/backups") return { json: [] };
    if (c.url.endsWith("/metrics")) return { json: { status: "running", cpuPct: 1.5, memoryBytes: 52_428_800, diskBytes: 2048, uptimeSec: 60 } };
    return undefined;
  });
}

function renderPage(over: Partial<Parameters<typeof DatabasesPage>[0]> = {}) {
  const props = {
    workspaces: [WS],
    selectedWorkspaceId: "w1",
    onSelectWorkspace: () => {},
    onOpenDatabase: () => {},
    onCreateWorkspace: async () => {},
    onDeleteWorkspace: async () => {},
    ...over,
  };
  return render(<DatabasesPage {...props} />);
}

describe("DatabasesPage", () => {
  test("lists databases from the API with status, endpoint, version and live metrics", async () => {
    routes([db({}), db({ id: "d2", name: "ledger", slug: "ledger", status: "crashed", port: 8102, sqldVersion: null })]);
    renderPage();
    const list = await screen.findByRole("region", { name: "Databases" });
    expect(await within(list).findByRole("heading", { name: "analytics" })).toBeTruthy();
    expect(within(list).getByRole("heading", { name: "ledger" })).toBeTruthy();
    expect(within(list).getByText("running")).toBeTruthy();
    expect(within(list).getByText("crashed")).toBeTruthy();
    expect(within(list).getByText("127.0.0.1:8101")).toBeTruthy();
    expect(within(list).getByText("sqld 0.24.32")).toBeTruthy();
    expect(within(list).getByText("analytics-ab12")).toBeTruthy(); // slug shown when it differs from the name
    await waitFor(() => expect(within(list).getAllByText("1.5%").length).toBe(2));
  });

  test("delete never appears in a list row; it lives only in the workspace Danger Zone", async () => {
    routes([db({})]);
    const user = userEvent.setup();
    renderPage();
    const list = await screen.findByRole("region", { name: "Databases" });
    await within(list).findByRole("heading", { name: "analytics" });
    expect(within(list).queryByRole("button", { name: /delete|purge|trash/i })).toBeNull();
    await user.click(screen.getByRole("button", { name: "Workspace Settings" }));
    const zone = await screen.findByRole("region", { name: "Danger zone" });
    const del = within(zone).getByRole("button", { name: /Delete Workspace/ }) as HTMLButtonElement;
    expect(del.disabled).toBe(true); // protected + not empty
    expect(within(zone).getByText(/contains 1 database/)).toBeTruthy();
  });

  test("clicking a database name opens it", async () => {
    routes([db({})]);
    const opened: string[] = [];
    const user = userEvent.setup();
    renderPage({ onOpenDatabase: (id: string) => opened.push(id) });
    await user.click(await screen.findByRole("button", { name: /analytics/ }));
    expect(opened).toEqual(["d1"]);
  });

  test("empty workspace offers to create the first database", async () => {
    routes([]);
    renderPage();
    expect(await screen.findByText("No databases in this workspace.")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Create your first database" })).toBeTruthy();
  });

  test("a failing list call shows the error", async () => {
    mockFetch((c) =>
      c.url.startsWith("/api/databases?") ? { status: 500, json: { error: { code: "boom", message: "db list exploded" } } } : undefined,
    );
    renderPage();
    expect((await screen.findByRole("alert")).textContent).toContain("db list exploded");
  });

  test("no workspaces: sidebar offers to create one and New database is disabled", async () => {
    routes([]);
    renderPage({ workspaces: [], selectedWorkspaceId: null });
    await screen.findByText("No databases in this workspace.");
    expect(screen.getByRole("button", { name: "Create one" })).toBeTruthy();
    expect((screen.getByRole("button", { name: "+ New database" }) as HTMLButtonElement).disabled).toBe(true);
  });
});
