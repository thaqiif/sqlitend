import { afterEach, describe, expect, jest, spyOn, test } from "bun:test";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { DatabaseDetail, type DbSubTab } from "../src/pages/DatabaseDetail";
import { mockFetch, type Call } from "./fetch-mock";
import { TEAMS, USERS, rowsResponse } from "./fixtures";
import { installFakeLayout, installMatchMedia } from "./layout";

installFakeLayout();
installMatchMedia(false);

const DB = (over: Record<string, unknown> = {}) => ({
  id: "d1",
  workspaceId: "w1",
  name: "analytics",
  slug: "analytics-ab12",
  status: "running",
  protected: true,
  port: 8101,
  failedReason: null,
  dns: { hostname: null, status: null, error: null },
  ...over,
});
const TOKEN = (over: Record<string, unknown> = {}) => ({
  jti: "11111111-1111-1111-1111-111111111111",
  databaseId: "d1",
  scope: "full",
  createdAt: Date.now() - 86_400_000,
  expiresAt: Date.now() + 90 * 86_400_000,
  name: "worker-prod",
  revokedAt: null,
  lastUsedAt: null,
  copyable: true,
  ...over,
});
const CONNECTION = { httpUrl: "http://127.0.0.1:8101", hranaUrl: "ws://127.0.0.1:8101", grpcUrl: "http://127.0.0.1:5001", publicUrl: "https://analytics.example.com", dbName: "analytics" };
const BACKUP = {
  enabled: true, state: "ok", replicaUrl: "s3://bucket/analytics", txidDb: "10", txidReplica: "10", lastSyncAt: 1_700_000_000_000, lastSnapshotAt: null,
  behindSince: null, lastError: null, lastErrorAt: null, restarts: 0,
  verify: { health: "ok", lastAt: 1_700_000_000_000, lastOutcome: "ok", lastDetail: null, lastOkAt: 1_700_000_000_000, restoredBytes: 1 },
};

let db = DB();
function api(over: (c: Call) => ReturnType<Parameters<typeof mockFetch>[0]> = () => undefined) {
  return mockFetch((c) => {
    const custom = over(c);
    if (custom) return custom;
    const u = c.url;
    if (u === "/api/databases/d1" && c.method === "GET") return { json: db };
    if (u === "/api/databases/d1/schema") return { json: { tables: [USERS, TEAMS], refreshedAt: 1 } };
    if (u.includes("/tables/users/rows")) return { json: rowsResponse() };
    if (u === "/api/databases/d1/metrics") return { json: { databaseId: "d1", status: "running", cpuPct: 1, memoryBytes: 1048576, diskBytes: 1024, uptimeSec: 60, sampledAt: 1 } };
    if (u === "/api/databases/d1/connection") return { json: CONNECTION };
    if (u === "/api/databases/d1/tokens" && c.method === "GET") return { json: [TOKEN()] };
    if (u === "/api/databases/d1/backup") return { json: BACKUP };
    if (u === "/api/databases/d1/delete-preview") return { json: { id: "d1", slug: "analytics-ab12", name: "analytics", protected: false, diskBytes: 2048, tableCount: 2, totalRows: 10, lastWriteAt: null } };
    if (u.includes("/metrics/history")) return { json: { range: "1h", points: [], diskGrowthBytesPerHour: null, stability: { level: "healthy", label: "Stable", rule: "r", availabilityPct24h: 100, crashes24h: 0, totalCrashes: 0, restartCount: 0, lastCrashAt: null, lastCrashReason: null }, latency: { p50Ms: null, p95Ms: null, p99Ms: null, totalQueries: 0, totalErrors: 0, errorRatePct: 0 } } };
    if (u === "/api/databases/d1/storage") return { json: { pageCount: 1, pageSize: 4096, freelistCount: 0, walBytes: 0, diskBytes: 1, tableRowCounts: [] } };
    return undefined;
  });
}

function renderDetail(props: Partial<Parameters<typeof DatabaseDetail>[0]> = {}) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <DatabaseDetail databaseId="d1" onBack={() => {}} {...props} />
    </QueryClientProvider>,
  );
}
const openSettings = async (user: ReturnType<typeof userEvent.setup>) => {
  await user.click(await screen.findByRole("tab", { name: "Settings" }));
  return screen.findByRole("region", { name: "Danger zone" });
};

afterEach(() => {
  db = DB();
});

describe("DatabaseDetail", () => {
  test("shows the database header and the five tabs, with the Data tab (and its table) first", async () => {
    api();
    renderDetail();
    expect(await screen.findByRole("heading", { name: "analytics" })).toBeTruthy();
    expect(screen.getByText("analytics-ab12")).toBeTruthy();
    expect(screen.getByText("running")).toBeTruthy();
    await waitFor(() => expect(screen.getAllByRole("tab").map((t) => t.textContent)).toEqual(["Data (2)", "SQL", "Structure", "Metrics", "Settings"]));
    expect(screen.getByRole("tab", { name: /Data/ }).getAttribute("aria-selected")).toBe("true");
    expect(await screen.findByText("Alice")).toBeTruthy();
  });

  test("tabs switch panels and report the change (controlled by the router in the app)", async () => {
    api();
    const seen: DbSubTab[] = [];
    const user = userEvent.setup();
    renderDetail({ onTabChange: (t) => seen.push(t) });
    await screen.findByText("Alice");
    await user.click(screen.getByRole("tab", { name: "Structure" }));
    expect(await screen.findByRole("table", { name: "Columns" })).toBeTruthy();
    await user.click(screen.getByRole("tab", { name: "SQL" }));
    expect(await screen.findByRole("textbox", { name: "SQL editor" })).toBeTruthy(); // lazy chunk loaded
    await user.click(screen.getByRole("tab", { name: "Metrics" }));
    expect(await screen.findByText("Live resources & query telemetry")).toBeTruthy();
    expect(seen).toEqual(["structure", "sql", "metrics"]);
  });

  test("the first table is selected once the schema loads and the selection is reported", async () => {
    api();
    const picked: string[] = [];
    renderDetail({ selectedTable: null, onSelectTable: (t) => picked.push(t) });
    await waitFor(() => expect(picked).toEqual(["users"]));
  });

  test("the protection switch calls the API and unlocks Move to Trash", async () => {
    const { calls } = api((c) => (c.url === "/api/databases/d1/protection" ? { json: (db = DB({ protected: false })) } : undefined));
    const user = userEvent.setup();
    renderDetail();
    const zone = await openSettings(user);
    const toggle = within(zone).getByRole("switch", { name: "Delete protection" }) as HTMLInputElement;
    expect(toggle.checked).toBe(true);
    expect((within(zone).getByRole("button", { name: "Move to Trash" }) as HTMLButtonElement).disabled).toBe(true);
    await user.click(toggle);
    await waitFor(() => expect(calls.some((c) => c.url === "/api/databases/d1/protection" && c.method === "PATCH")).toBe(true));
    expect(calls.find((c) => c.method === "PATCH")!.body).toEqual({ protected: false });
    await waitFor(() => expect((within(zone).getByRole("button", { name: "Move to Trash" }) as HTMLButtonElement).disabled).toBe(false));
    expect(within(zone).getByText("Unprotected")).toBeTruthy();
  });

  test("a failing protection change shows the error", async () => {
    api((c) => (c.url.endsWith("/protection") ? { status: 500, json: { error: { code: "x", message: "disk full" } } } : undefined));
    const user = userEvent.setup();
    renderDetail();
    const zone = await openSettings(user);
    await user.click(within(zone).getByRole("switch", { name: "Delete protection" }));
    expect((await screen.findByRole("alert")).textContent).toContain("disk full");
  });

  test("delete exists only in the Danger zone, which is the last thing on the page", async () => {
    db = DB({ protected: false });
    api();
    const user = userEvent.setup();
    renderDetail();
    await screen.findByText("Alice");
    // No other tab offers any delete/trash control of the database.
    for (const name of [/^Data/, "SQL", "Structure", "Metrics"]) {
      const tab = screen.getByRole("tab", { name });
      await user.click(tab);
      await waitFor(() => expect(tab.getAttribute("aria-selected")).toBe("true"));
      expect(screen.queryAllByText(/Trash/).length).toBe(0);
    }
    const zone = await openSettings(user);
    const trash = screen.getAllByText("Move to Trash", { selector: "button" });
    expect(trash.length).toBe(1);
    expect(zone.contains(trash[0]!)).toBe(true);
    const panel = zone.parentElement!;
    expect(panel.lastElementChild).toBe(zone);
  });

  test("Move to Trash previews the impact and deletes only after the exact slug and the delay", async () => {
    db = DB({ protected: false });
    jest.useFakeTimers();
    try {
      const { calls } = api((c) => (c.method === "DELETE" ? { status: 204 } : undefined));
      const back: string[] = [];
      const user = userEvent.setup({ advanceTimers: jest.advanceTimersByTime });
      renderDetail({ onBack: () => back.push("back") });
      await act(async () => {});
      await user.click(await screen.findByRole("tab", { name: "Settings" }));
      await user.click(await screen.findByRole("button", { name: "Move to Trash" }));
      const dialog = await screen.findByRole("dialog", { name: 'Move "analytics" to Trash' });
      expect(within(dialog).getByText("2.0 KB")).toBeTruthy();
      const confirm = () => within(dialog).getByRole("button", { name: /^Move to Trash/ }) as HTMLButtonElement;
      fireEvent.change(within(dialog).getByPlaceholderText("analytics-ab12"), { target: { value: "analytics-ab12" } });
      expect(confirm().disabled).toBe(true); // still counting down
      act(() => void jest.advanceTimersByTime(6000));
      expect(confirm().disabled).toBe(false);
      await act(async () => {
        fireEvent.submit(dialog.querySelector("form")!);
      });
      await waitFor(() => expect(back).toEqual(["back"]));
      expect(calls.find((c) => c.method === "DELETE")!.body).toEqual({ confirm: "analytics-ab12" });
    } finally {
      jest.useRealTimers();
    }
  });

  test("a stopped database gets a Start prompt instead of data, and Start calls the API", async () => {
    db = DB({ status: "stopped" });
    const { calls } = api((c) => (c.url === "/api/databases/d1/start" ? { json: (db = DB({ status: "running" })) } : undefined));
    const user = userEvent.setup();
    renderDetail();
    expect(await screen.findByText(/Database is currently/)).toBeTruthy();
    expect(calls.some((c) => c.url.endsWith("/schema"))).toBe(false); // schema is only loaded for running databases
    await user.click(screen.getByRole("button", { name: "Start database" }));
    await waitFor(() => expect(calls.some((c) => c.url === "/api/databases/d1/start" && c.method === "POST")).toBe(true));
    expect(await screen.findByText("Alice")).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "Stop" }));
    await waitFor(() => expect(calls.some((c) => c.url === "/api/databases/d1/stop")).toBe(true));
  });

  test("a failed database shows why", async () => {
    db = DB({ status: "failed", failedReason: "port in use" });
    api();
    renderDetail();
    expect((await screen.findByText("Start failed: port in use")).closest('[role="alert"]')).toBeTruthy();
  });

  test("a load error shows a message and Back works", async () => {
    mockFetch((c) => (c.url === "/api/databases/d1" ? { status: 404, json: { error: { code: "not_found", message: "no such database" } } } : undefined));
    const back: string[] = [];
    renderDetail({ onBack: () => back.push("b") });
    expect((await screen.findByRole("alert")).textContent).toContain("no such database");
    await userEvent.setup().click(screen.getByRole("button", { name: /Back/ }));
    expect(back).toEqual(["b"]);
  });

  test("the Explorer button opens the drawer", async () => {
    api();
    const opened: string[] = [];
    renderDetail({ onOpenExplorerDrawer: () => opened.push("x") });
    await userEvent.setup().click(await screen.findByRole("button", { name: /Explorer/ }));
    expect(opened).toEqual(["x"]);
  });
});

describe("DatabaseDetail settings", () => {
  test("connection details, backup status and tokens are shown", async () => {
    api();
    const user = userEvent.setup();
    renderDetail();
    await openSettings(user);
    expect(await screen.findByText("https://analytics.example.com")).toBeTruthy();
    expect(screen.getByText(/LIBSQL_URL=https:\/\/analytics\.example\.com/)).toBeTruthy();
    expect(await screen.findByText("s3://bucket/analytics")).toBeTruthy();
    expect(screen.getByText("restore-verify ok")).toBeTruthy();
    const tokens = screen.getByLabelText("Tokens");
    expect(within(tokens).getByText("worker-prod")).toBeTruthy();
    expect(within(tokens).getByText("active")).toBeTruthy();
  });

  test("generating a token posts the name and lifetime, then reveals the token once", async () => {
    const { calls } = api((c) =>
      c.url === "/api/databases/d1/tokens" && c.method === "POST" ? { json: { ...TOKEN({ name: "ci" }), token: "SECRET-JWT", dbSlug: "analytics-ab12" } } : undefined,
    );
    const user = userEvent.setup();
    renderDetail();
    await openSettings(user);
    await user.click(await screen.findByRole("button", { name: "Generate token" }));
    const form = await screen.findByRole("dialog", { name: "Generate token" });
    await user.type(within(form).getByRole("textbox", { name: "Name" }), "ci");
    await user.type(within(form).getByRole("spinbutton", { name: /Lifetime/ }), "48");
    await user.click(within(form).getByRole("button", { name: "Generate" }));
    await waitFor(() => expect(calls.find((c) => c.url.endsWith("/tokens") && c.method === "POST")?.body).toEqual({ name: "ci", expiresInHours: 48 }));
    const reveal = await screen.findByRole("dialog", { name: "Generated token" });
    expect(within(reveal).getByText("SECRET-JWT")).toBeTruthy();
  });

  test("rotate prefills the name and lifetime; an API error stays in the dialog", async () => {
    api((c) => (c.url.endsWith("/tokens") && c.method === "POST" ? { status: 400, json: { error: { code: "bad", message: "name taken" } } } : undefined));
    const user = userEvent.setup();
    renderDetail();
    await openSettings(user);
    await user.click(await screen.findByRole("button", { name: "Rotate" }));
    const form = await screen.findByRole("dialog", { name: "Generate token" });
    expect((within(form).getByRole("textbox", { name: "Name" }) as HTMLInputElement).value).toBe("worker-prod");
    expect(Number((within(form).getByRole("spinbutton") as HTMLInputElement).value)).toBe(2184);
    await user.click(within(form).getByRole("button", { name: "Generate" }));
    expect((await within(form).findByRole("alert")).textContent).toContain("name taken");
  });

  test("revoke asks first, then calls the API and refreshes the list; copy reveals the token to the clipboard", async () => {
    let revoked = false;
    const { calls } = api((c) => {
      if (c.url.endsWith("/tokens") && c.method === "GET") return { json: [TOKEN({ revokedAt: revoked ? 1 : null })] };
      if (c.url.includes("/reveal")) return { json: { jti: "x", token: "JWT-VALUE" } };
      if (c.method === "DELETE" && c.url.includes("/tokens/")) {
        revoked = true;
        return { json: TOKEN({ revokedAt: 1 }) };
      }
      return undefined;
    });
    const user = userEvent.setup();
    const written: string[] = [];
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText: async (t: string) => void written.push(t) } });
    renderDetail();
    await openSettings(user);
    await user.click(await screen.findByRole("button", { name: "Copy" }));
    await waitFor(() => expect(written).toEqual(["JWT-VALUE"]));

    const confirm = spyOn(window, "confirm");
    confirm.mockReturnValueOnce(false);
    await user.click(screen.getByRole("button", { name: "Revoke" }));
    expect(calls.some((c) => c.method === "DELETE")).toBe(false);
    confirm.mockReturnValueOnce(true);
    await user.click(screen.getByRole("button", { name: "Revoke" }));
    expect(await screen.findByText("revoked")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Revoke" })).toBeNull();
    confirm.mockRestore();
  });

  test("an unreadable token falls back to a prompt, and a not-copyable token says so", async () => {
    api((c) => {
      if (c.url.endsWith("/tokens") && c.method === "GET") return { json: [TOKEN(), TOKEN({ jti: "22222222-2222-2222-2222-222222222222", name: null, copyable: false })] };
      if (c.url.includes("/reveal")) return { json: { jti: "x", token: "JWT-VALUE" } };
      return undefined;
    });
    const user = userEvent.setup();
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: undefined });
    const prompt = spyOn(window, "prompt").mockReturnValue(null);
    renderDetail();
    await openSettings(user);
    await user.click(await screen.findByRole("button", { name: "Copy" }));
    await waitFor(() => expect(prompt).toHaveBeenCalledWith("Copy the token:", "JWT-VALUE"));
    expect(screen.getByText("not copyable")).toBeTruthy();
    expect(screen.getByText("unnamed")).toBeTruthy();
    prompt.mockRestore();
  });

  test("copying a connection value shows Copied", async () => {
    api();
    const user = userEvent.setup();
    const written: string[] = [];
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText: async (t: string) => void written.push(t) } });
    renderDetail();
    await openSettings(user);
    await user.click(await screen.findByRole("button", { name: "Copy URL" }));
    expect(written).toEqual(["https://analytics.example.com"]);
    expect(await screen.findByRole("button", { name: "Copy URL" })).toHaveProperty("textContent", "Copied");
  });

  test("without a gateway only the local HTTP endpoint is offered, with a hint", async () => {
    api((c) => (c.url.endsWith("/connection") ? { json: { ...CONNECTION, publicUrl: null } } : undefined));
    const user = userEvent.setup();
    renderDetail();
    await openSettings(user);
    expect(await screen.findByText(/No public hostname/)).toBeTruthy();
    expect(screen.getAllByRole("button", { name: "Copy HTTP" }).length).toBe(2); // primary + server-local list
  });

  test("a DNS problem is shown with a retry that calls the sync endpoint", async () => {
    db = DB({ dns: { hostname: "analytics.example.com", status: "error", error: "zone not found" } });
    const { calls } = api((c) => (c.url.endsWith("/dns/sync") ? { json: (db = DB({ dns: { hostname: "analytics.example.com", status: "active", error: null } })) } : undefined));
    const user = userEvent.setup();
    renderDetail();
    await openSettings(user);
    expect(await screen.findByText(/zone not found/)).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "Retry DNS" }));
    await waitFor(() => expect(calls.some((c) => c.url.endsWith("/dns/sync") && c.method === "POST")).toBe(true));
    expect(await screen.findByText("DNS active")).toBeTruthy();
  });

  test("a database without backups says so; with backups, Verify now and Restore are offered", async () => {
    api((c) => (c.url.endsWith("/backup") ? { json: { ...BACKUP, enabled: false, state: "disabled" } } : undefined));
    const user = userEvent.setup();
    const first = renderDetail();
    await openSettings(user);
    expect((await screen.findByText(/Not backed up/)).closest('[role="alert"]')).toBeTruthy();
    first.unmount();

    const { calls } = api((c) => (c.url.endsWith("/backup/verify") ? { json: { ...BACKUP, verify: { ...BACKUP.verify, health: "stale" } } } : undefined));
    renderDetail();
    await openSettings(user);
    await user.click(await screen.findByRole("button", { name: "Verify now" }));
    await waitFor(() => expect(calls.some((c) => c.url.endsWith("/backup/verify") && c.method === "POST")).toBe(true));
    expect(await screen.findByText("restore-verify stale")).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "Restore as new database" }));
    expect(await screen.findByRole("dialog")).toBeTruthy();
  });

  test("a backup error is shown with its time", async () => {
    api((c) => (c.url.endsWith("/backup") ? { json: { ...BACKUP, state: "error", lastError: "S3 403", lastErrorAt: 1_700_000_000_000, verify: null } } : undefined));
    const user = userEvent.setup();
    renderDetail();
    await openSettings(user);
    expect((await screen.findByText(/S3 403/)).closest('[role="alert"]')).toBeTruthy();
  });
});
