import { describe, expect, jest, test } from "bun:test";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { TokenIssued, Workspace } from "@sqlitend/shared";
import { DatabasesPage } from "../src/pages/DatabasesPage";
import { Modal } from "../src/components/Modal";
import { TokenReveal } from "../src/components/TokenReveal";
import { RestoreDialog } from "../src/components/RestoreDialog";
import { MetricTiles } from "../src/components/MetricTiles";
import { mockFetch } from "./fetch-mock";

const WS: Workspace = { id: "w1", slug: "prod", name: "Production", protected: false, createdAt: 1 };

function renderPage(onCreateWorkspace = jest.fn(async (_n: string) => {})) {
  render(
    <DatabasesPage
      workspaces={[WS]}
      selectedWorkspaceId="w1"
      onSelectWorkspace={() => {}}
      onOpenDatabase={() => {}}
      onCreateWorkspace={onCreateWorkspace}
      onDeleteWorkspace={async () => {}}
    />,
  );
  return { onCreateWorkspace };
}

describe("create dialogs", () => {
  test("create database posts the trimmed name to the selected workspace and closes", async () => {
    const { calls } = mockFetch((c) => {
      if (c.url.startsWith("/api/databases?")) return { json: [] };
      if (c.url === "/api/workspaces/w1/databases") return { json: { id: "d9" } };
      if (c.url === "/api/backups") return { json: [] };
      return undefined;
    });
    const user = userEvent.setup();
    renderPage();
    await user.click(await screen.findByRole("button", { name: "+ New database" }));
    const dialog = await screen.findByRole("dialog", { name: "Create database" });
    const create = within(dialog).getByRole("button", { name: "Create" }) as HTMLButtonElement;
    expect(create.disabled).toBe(true); // empty name
    await user.type(within(dialog).getByLabelText("Name"), "  analytics  ");
    expect(create.disabled).toBe(false);
    await user.click(create);
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Create database" })).toBeNull());
    const post = calls.find((c) => c.method === "POST")!;
    expect(post.url).toBe("/api/workspaces/w1/databases");
    expect(post.body).toEqual({ name: "analytics" });
  });

  test("create database shows the server error and stays open", async () => {
    mockFetch((c) => {
      if (c.url.startsWith("/api/databases?")) return { json: [] };
      if (c.url === "/api/workspaces/w1/databases") return { status: 409, json: { error: { code: "conflict", message: "Name already taken" } } };
      return undefined;
    });
    const user = userEvent.setup();
    renderPage();
    await user.click(await screen.findByRole("button", { name: "+ New database" }));
    const dialog = await screen.findByRole("dialog", { name: "Create database" });
    await user.type(within(dialog).getByLabelText("Name"), "dup");
    await user.click(within(dialog).getByRole("button", { name: "Create" }));
    expect((await within(dialog).findByRole("alert")).textContent).toContain("Name already taken");
  });

  test("create workspace hands the trimmed name to the caller; Cancel closes without calling it", async () => {
    mockFetch((c) => (c.url.startsWith("/api/databases?") ? { json: [] } : undefined));
    const user = userEvent.setup();
    const { onCreateWorkspace } = renderPage();
    await user.click(screen.getByRole("button", { name: "+ New" }));
    let dialog = await screen.findByRole("dialog", { name: "Create workspace" });
    await user.click(within(dialog).getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(onCreateWorkspace).not.toHaveBeenCalled();

    await user.click(screen.getByRole("button", { name: "+ New" }));
    dialog = await screen.findByRole("dialog", { name: "Create workspace" });
    await user.type(within(dialog).getByLabelText("Name"), " Staging ");
    await user.click(within(dialog).getByRole("button", { name: "Create" }));
    await waitFor(() => expect(onCreateWorkspace).toHaveBeenCalledWith("Staging"));
  });
});

describe("workspace protection", () => {
  test("toggling Delete protection calls the protection endpoint", async () => {
    const { calls } = mockFetch((c) => {
      if (c.url.startsWith("/api/databases?")) return { json: [] };
      if (c.url === "/api/workspaces/w1/protection") return { json: { ...WS, protected: true } };
      return undefined;
    });
    const user = userEvent.setup();
    renderPage();
    await user.click(screen.getByRole("button", { name: "Workspace Settings" }));
    const zone = await screen.findByRole("region", { name: "Danger zone" });
    const del = within(zone).getByRole("button", { name: /Delete Workspace/ }) as HTMLButtonElement;
    expect(del.disabled).toBe(false); // unprotected + empty
    await user.click(within(zone).getByRole("switch", { name: "Delete protection" }));
    await waitFor(() => expect(calls.some((c) => c.url === "/api/workspaces/w1/protection")).toBe(true));
    expect(calls.find((c) => c.url === "/api/workspaces/w1/protection")!.body).toEqual({ protected: true });
  });
});

describe("TokenReveal", () => {
  const token = { token: "eyJ.secret", scope: "read-write", dbSlug: "analytics" } as unknown as TokenIssued;

  test("the secret is not dismissed by Escape or a backdrop click, only by 'I saved it'", async () => {
    const onDismiss = jest.fn();
    const user = userEvent.setup();
    render(<TokenReveal token={token} onDismiss={onDismiss} />);
    expect((await screen.findByTestId("token-secret")).textContent).toBe("eyJ.secret");
    await user.keyboard("{Escape}");
    await user.pointer({ target: document.body, keys: "[MouseLeft]" });
    expect(onDismiss).not.toHaveBeenCalled();
    await user.click(screen.getByRole("button", { name: "I saved it" }));
    expect(onDismiss).toHaveBeenCalledTimes(1);
  });
});

describe("Modal", () => {
  test("Escape closes a dismissible modal; dismissOnEscape={false} keeps it open", async () => {
    const onClose = jest.fn();
    const user = userEvent.setup();
    const { unmount } = render(<Modal ariaLabel="Plain" onClose={onClose}><p>hi</p></Modal>);
    await screen.findByRole("dialog", { name: "Plain" });
    await user.keyboard("{Escape}");
    expect(onClose).toHaveBeenCalledTimes(1);
    unmount();
    const onClose2 = jest.fn();
    render(<Modal ariaLabel="Sticky" onClose={onClose2} dismissOnEscape={false}><p>hi</p></Modal>);
    await screen.findByRole("dialog", { name: "Sticky" });
    await user.keyboard("{Escape}");
    expect(onClose2).not.toHaveBeenCalled();
  });
});

describe("RestoreDialog", () => {
  test("restores into a NEW database in the chosen workspace and reports it", async () => {
    const { calls } = mockFetch((c) => (c.url === "/api/backups/src1/restore" ? { json: { id: "newdb" } } : undefined));
    const onStarted = jest.fn();
    const user = userEvent.setup();
    render(
      <RestoreDialog sourceId="src1" sourceLabel="analytics" workspaces={[WS]} onClose={() => {}} onStarted={onStarted} />,
    );
    const dialog = await screen.findByRole("dialog", { name: "Restore backup" });
    expect((within(dialog).getByLabelText(/New database name/) as HTMLInputElement).value).toBe("analytics-restored");
    await user.click(within(dialog).getByRole("button", { name: "Restore" }));
    await waitFor(() => expect(onStarted).toHaveBeenCalledWith({ id: "newdb" }));
    expect(calls[0]!.body).toEqual({ name: "analytics-restored", workspaceId: "w1" });
  });
});

describe("MetricTiles", () => {
  test("renders dashes without metrics and formatted values with them", () => {
    const { rerender } = render(<MetricTiles metrics={null} />);
    expect(screen.getAllByText("—").length).toBe(5);
    rerender(
      <MetricTiles
        metrics={{ status: "running", cpuPct: 12.34, memoryBytes: 104_857_600, diskBytes: 2_147_483_648, uptimeSec: 90_000 } as never}
      />,
    );
    expect(screen.getByText("12.3%")).toBeTruthy();
    expect(screen.getByText("100 MB")).toBeTruthy();
    expect(screen.getByText("2.0 GB")).toBeTruthy();
    expect(screen.getByText("1d 1h")).toBeTruthy();
    expect(screen.getByText("running")).toBeTruthy();
  });
});
