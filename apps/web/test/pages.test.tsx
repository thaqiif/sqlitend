import { describe, expect, jest, test } from "bun:test";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { TokenIssued, TrashItem } from "@sqlitend/shared";
import { App } from "../src/App";
import { TrashPage } from "../src/pages/TrashPage";
import { BackupsPage } from "../src/pages/BackupsPage";
import { TokenReveal } from "../src/components/TokenReveal";
import { mockFetch } from "./fetch-mock";

const ITEM: TrashItem = {
  id: "t1",
  name: "ledger",
  slug: "ledger-x1",
  workspaceName: "Production",
  diskBytes: 3 * 1024 * 1024,
  trashedAt: Date.now() - 3_600_000,
  expiresAt: Date.now() + 86_400_000 * 30,
} as TrashItem;

describe("TrashPage", () => {
  test("lists trashed databases and restores one", async () => {
    const restored: string[] = [];
    const { calls } = mockFetch((c) => {
      if (c.url === "/api/trash") return { json: [ITEM] };
      if (c.url === "/api/trash/t1/restore") return { json: { id: "d-restored" } };
      return undefined;
    });
    const user = userEvent.setup();
    render(<TrashPage onRestored={(id) => restored.push(id)} />);
    expect(await screen.findByText("ledger")).toBeTruthy();
    expect(screen.getByText("ledger-x1")).toBeTruthy();
    expect(screen.getByText("3.00 MB")).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "Restore" }));
    await waitFor(() => expect(restored).toEqual(["d-restored"]));
    expect(calls.some((c) => c.method === "POST" && c.url === "/api/trash/t1/restore")).toBe(true);
  });

  test("a failed restore shows the error", async () => {
    mockFetch((c) =>
      c.url === "/api/trash"
        ? { json: [ITEM] }
        : { status: 409, json: { error: { code: "conflict", message: "Name taken in workspace" } } },
    );
    const user = userEvent.setup();
    render(<TrashPage onRestored={() => {}} />);
    await user.click(await screen.findByRole("button", { name: "Restore" }));
    expect((await screen.findByRole("alert")).textContent).toContain("Name taken in workspace");
  });

  test("Purge Forever needs the exact slug and the 5 s delay, then sends the confirmation", async () => {
    jest.useFakeTimers();
    try {
      const { calls } = mockFetch((c) => {
        if (c.url === "/api/trash") return { json: [ITEM] };
        if (c.url === "/api/trash/t1" && c.method === "DELETE") return { status: 204 };
        return undefined;
      });
      render(<TrashPage onRestored={() => {}} />);
      await act(async () => {});
      fireEvent.click(await screen.findByRole("button", { name: /Purge Forever/ }));
      const dialog = await screen.findByRole("dialog", { name: /Permanently Purge/ });
      const button = () => within(dialog).getByRole("button", { name: /^Purge Forever/ }) as HTMLButtonElement;
      expect(within(dialog).getByText("3.00 MB")).toBeTruthy(); // size is shown before confirming
      fireEvent.change(within(dialog).getByPlaceholderText("ledger-x1"), { target: { value: "ledger" } });
      act(() => void jest.advanceTimersByTime(6000));
      expect(button().disabled).toBe(true); // partial slug
      fireEvent.change(within(dialog).getByPlaceholderText("ledger-x1"), { target: { value: "ledger-x1" } });
      expect(button().disabled).toBe(false);
      await act(async () => {
        fireEvent.submit(dialog.querySelector("form")!);
      });
      await waitFor(() => expect(calls.some((c) => c.method === "DELETE")).toBe(true));
      expect(calls.find((c) => c.method === "DELETE")!.body).toEqual({ confirm: "ledger-x1" });
    } finally {
      jest.useRealTimers();
    }
  });

  test("empty trash", async () => {
    mockFetch((c) => (c.url === "/api/trash" ? { json: [] } : undefined));
    render(<TrashPage onRestored={() => {}} />);
    expect(await screen.findByText("Trash is empty.")).toBeTruthy();
  });
});

describe("BackupsPage", () => {
  test("control-plane backup button runs a backup and shows the result", async () => {
    let enabledState = { enabled: true, lastOkAt: null, lastKey: null, lastError: null } as Record<string, unknown>;
    mockFetch((c) => {
      if (c.url === "/api/backups/control" && c.method === "GET") return { json: enabledState };
      if (c.url === "/api/backups/control" && c.method === "POST") {
        enabledState = { enabled: true, lastOkAt: 1_700_000_000_000, lastKey: "control/2026.enc", lastError: null };
        return { json: enabledState };
      }
      if (c.url === "/api/backups/replicas") return { json: [{ id: "r1", name: "analytics", slug: "analytics-1", exists: true, workspaceId: "w1" }] };
      return undefined;
    });
    const user = userEvent.setup();
    render(<BackupsPage workspaces={[]} onOpenDatabase={() => {}} />);
    expect(await screen.findByText("Last backup never", { exact: false })).toBeTruthy();
    expect(await screen.findByText("live")).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "Back up now" }));
    expect(await screen.findByText("2026.enc", { exact: false })).toBeTruthy();
  });

  test("a failing control backup surfaces the error; Restore opens the restore dialog", async () => {
    mockFetch((c) => {
      if (c.url === "/api/backups/control" && c.method === "GET") return { json: { enabled: true, lastOkAt: null, lastKey: null, lastError: null } };
      if (c.url === "/api/backups/control") return { status: 500, json: { error: { code: "s3", message: "S3 unreachable" } } };
      if (c.url === "/api/backups/replicas") return { json: [{ id: "r1", name: "analytics", slug: "analytics-1", exists: true }] };
      return undefined;
    });
    const user = userEvent.setup();
    render(
      <BackupsPage workspaces={[{ id: "w1", slug: "p", name: "Prod", protected: false, createdAt: 1 }]} onOpenDatabase={() => {}} />,
    );
    await user.click(await screen.findByRole("button", { name: "Back up now" }));
    expect((await screen.findByRole("alert")).textContent).toContain("S3 unreachable");
    await user.click(screen.getByRole("button", { name: "Restore…" }));
    expect(await screen.findByRole("dialog", { name: "Restore backup" })).toBeTruthy();
  });
});

describe("BackupsPage list", () => {
  test("deleted replicas sort first, then by name; unknown manifests are labelled", async () => {
    mockFetch((c) => {
      if (c.url === "/api/backups/control") return { json: { enabled: false } };
      if (c.url === "/api/backups/replicas")
        return {
          json: [
            { id: "a", name: "zeta", slug: "zeta", exists: true },
            { id: "b", name: "alpha", slug: "alpha", exists: true },
            { id: "c", name: null, slug: null, exists: false },
          ],
        };
      return undefined;
    });
    render(<BackupsPage workspaces={[]} onOpenDatabase={() => {}} />);
    const list = await screen.findByRole("list", { name: "Replicas" });
    const items = within(list).getAllByRole("listitem");
    expect(items[0]!.textContent).toContain("unknown (no manifest)");
    expect(items[0]!.textContent).toContain("deleted");
    expect(items[1]!.textContent).toContain("alpha");
    expect(items[2]!.textContent).toContain("zeta");
  });

  test("a failing replica listing shows the error", async () => {
    mockFetch((c) =>
      c.url === "/api/backups/replicas" ? { status: 500, json: { error: { code: "s3", message: "bucket gone" } } } : { json: { enabled: false } },
    );
    render(<BackupsPage workspaces={[]} onOpenDatabase={() => {}} />);
    expect(await screen.findByText("bucket gone")).toBeTruthy();
  });
});

describe("TokenReveal copy", () => {
  const token = { token: "eyJ.secret", scope: "read-only", dbSlug: "analytics" } as unknown as TokenIssued;

  test("Copy writes the secret to the clipboard and confirms", async () => {
    const written: string[] = [];
    const user = userEvent.setup(); // installs its own clipboard stub, so override afterwards
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText: async (t: string) => void written.push(t) },
    });
    render(<TokenReveal token={token} onDismiss={() => {}} />);
    await user.click(await screen.findByRole("button", { name: "Copy" }));
    expect(written).toEqual(["eyJ.secret"]);
    expect(await screen.findByRole("button", { name: "Copied" })).toBeTruthy();
  });

  test("an unavailable clipboard leaves the secret visible instead of throwing", async () => {
    const user = userEvent.setup();
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText: async () => Promise.reject(new Error("denied")) },
    });
    render(<TokenReveal token={token} onDismiss={() => {}} />);
    await user.click(await screen.findByRole("button", { name: "Copy" }));
    expect(screen.getByTestId("token-secret").textContent).toBe("eyJ.secret");
    expect(screen.getByRole("button", { name: "Copy" })).toBeTruthy();
  });
});

describe("App explorer + navigation callbacks", () => {
  function routes() {
    return mockFetch((c) => {
      if (c.url === "/api/workspaces")
        return { json: [{ id: "w1", slug: "prod", name: "Production", protected: false, createdAt: 1 }, { id: "w2", slug: "stg", name: "Staging", protected: false, createdAt: 2 }] };
      if (c.url === "/api/system") return { json: { version: "1", sqldVersion: null, sqldOk: true, sqldReason: null, sqldBinarySha256: null, publicHost: "h", counts: { workspaces: 2, databases: 1 } } };
      if (c.url.startsWith("/api/databases?")) return { json: [{ id: "d1", workspaceId: "w1", name: "analytics", slug: "analytics", status: "running", port: 1, publicUrl: null, sqldVersion: null }] };
      if (c.url === "/api/databases/d1/schema") return { json: { tables: [{ name: "users", type: "table", rowCountEstimate: 3 }, { name: "v_users", type: "view", rowCountEstimate: null }] } };
      if (c.url === "/api/trash") return { json: [ITEM] };
      if (c.url === "/api/trash/t1/restore") return { json: { id: "d1" } };
      return undefined;
    });
  }
  function renderApp() {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    return render(
      <QueryClientProvider client={client}>
        <App />
      </QueryClientProvider>,
    );
  }

  test("explorer: picking a table closes the drawer; a workspace can be chosen", async () => {
    routes();
    const user = userEvent.setup();
    renderApp();
    await user.click(await screen.findByRole("button", { name: "Open schema explorer" }));
    const drawer = await screen.findByRole("dialog", { name: "Database & Table Explorer" });
    await user.click(await within(drawer).findByRole("button", { name: /analytics/ }));
    await user.click(await within(drawer).findByRole("button", { name: /v_users/ }));
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Database & Table Explorer" })).toBeNull());
  });

  test("explorer: workspace select offers every workspace", async () => {
    routes();
    const user = userEvent.setup();
    renderApp();
    await user.click(await screen.findByRole("button", { name: "Open schema explorer" }));
    const drawer = await screen.findByRole("dialog", { name: "Database & Table Explorer" });
    await user.click(within(drawer).getByRole("button", { name: /Workspace/ }));
    const options = await screen.findAllByRole("option");
    expect(options.map((o) => o.textContent)).toEqual(expect.arrayContaining([expect.stringContaining("Staging"), expect.stringContaining("Production")]));
    await user.click(options.find((o) => o.textContent?.includes("Staging"))!);
  });

  test("restoring from Trash navigates to the restored database", async () => {
    routes();
    const user = userEvent.setup();
    renderApp();
    const bottom = await screen.findByRole("navigation", { name: "Mobile navigation" });
    await user.click(within(bottom).getByRole("button", { name: "Trash" }));
    await user.click(await screen.findByRole("button", { name: "Restore" }));
    await waitFor(() => expect(screen.queryByRole("heading", { name: /^Trash/ })).toBeNull());
    expect(within(bottom).getByRole("button", { name: "Databases" }).getAttribute("aria-current")).toBe("page");
  });
});
