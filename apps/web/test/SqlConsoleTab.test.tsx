import { afterEach, describe, expect, test } from "bun:test";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import SqlConsoleTab from "../src/components/SqlConsoleTab";
import { VirtualResultTable } from "../src/components/VirtualResultTable";
import { mockFetch, type Call } from "./fetch-mock";
import { USERS } from "./fixtures";
import { installFakeLayout } from "./layout";

installFakeLayout();

const stmt = (over: Record<string, unknown> = {}) => ({
  index: 0,
  statement: "SELECT 1",
  status: "ok",
  error: null,
  columns: ["n"],
  rows: [[1]],
  rowsAffected: 0,
  lastInsertRowid: null,
  durationMs: 1.5,
  truncated: false,
  ...over,
});

const queryCalls = (calls: Call[]) => calls.filter((c) => c.url === "/api/databases/d1/query");
const draft = (sql: string) => localStorage.setItem("sqlitend:sql-draft:d1", JSON.stringify(sql));

function renderTab(changed: () => void = () => {}) {
  return render(<SqlConsoleTab dbId="d1" tables={[USERS]} onSchemaMayHaveChanged={changed} />);
}

describe("SqlConsoleTab", () => {
  test("starts from a SELECT on the first table, runs read-only by default and shows the result grid", async () => {
    const { calls } = mockFetch((c) =>
      c.url === "/api/databases/d1/query" ? { json: { results: [stmt({ columns: ["id", "name"], rows: [[1, "Alice"], [2, null]] })], totalDurationMs: 3 } } : undefined,
    );
    const user = userEvent.setup();
    renderTab();
    await user.click(screen.getByRole("button", { name: /Run/ }));
    const results = await screen.findByLabelText("Query results");
    expect(await within(results).findByText("Alice")).toBeTruthy();
    expect(within(results).getByText("NULL")).toBeTruthy();
    expect(within(results).getByText(/Total/).textContent).toContain("3 ms");
    const call = queryCalls(calls)[0]!;
    expect(call.body).toMatchObject({ sql: 'SELECT * FROM "users" LIMIT 100;', readOnly: true, limit: 1000 });
    expect(screen.getByRole("switch", { name: "Allow writes" })).toBeTruthy();
  });

  test("Allow writes sends readOnly false and refreshes the schema after a write", async () => {
    draft("INSERT INTO users (name) VALUES ('x');");
    const { calls } = mockFetch(() => ({ json: { results: [stmt({ columns: [], rows: [], rowsAffected: 1, lastInsertRowid: "7" })], totalDurationMs: 2 } }));
    let changed = 0;
    const user = userEvent.setup();
    renderTab(() => changed++);
    await user.click(screen.getByRole("switch", { name: "Allow writes" }));
    expect(screen.getByText("Writes enabled")).toBeTruthy();
    await user.click(screen.getByRole("button", { name: /Run/ }));
    expect(await screen.findByText(/last insert rowid: 7/)).toBeTruthy();
    expect(queryCalls(calls)[0]!.body).toMatchObject({ readOnly: false });
    expect(changed).toBe(1);
  });

  test("DELETE without WHERE asks for an extra confirm; Cancel sends nothing, Execute anyway sends it", async () => {
    draft("DELETE FROM users;");
    const { calls } = mockFetch(() => ({ json: { results: [stmt({ columns: [], rows: [], rowsAffected: 3 })], totalDurationMs: 2 } }));
    const user = userEvent.setup();
    renderTab();
    await user.click(screen.getByRole("switch", { name: "Allow writes" }));
    await user.click(screen.getByRole("button", { name: /Run/ }));
    const dialog = await screen.findByRole("dialog", { name: "Confirm destructive SQL" });
    expect(within(dialog).getByText("DELETE FROM users;")).toBeTruthy();
    expect(queryCalls(calls).length).toBe(0);
    await user.click(within(dialog).getByRole("button", { name: "Cancel" }));
    expect(queryCalls(calls).length).toBe(0);

    await user.click(screen.getByRole("button", { name: /Run/ }));
    await user.click(within(await screen.findByRole("dialog", { name: "Confirm destructive SQL" })).getByRole("button", { name: "Execute anyway" }));
    await waitFor(() => expect(queryCalls(calls).length).toBe(1));
    expect(queryCalls(calls)[0]!.body).toMatchObject({ sql: "DELETE FROM users;", readOnly: false });
  });

  test("DELETE with a WHERE, and any SQL while read-only, run without the extra confirm; DROP and UPDATE-without-WHERE do ask", async () => {
    const { calls } = mockFetch(() => ({ json: { results: [stmt({ columns: [], rows: [], rowsAffected: 1 })], totalDurationMs: 1 } }));
    const user = userEvent.setup();
    draft("DELETE FROM users WHERE id = 1;");
    const first = renderTab();
    await user.click(screen.getByRole("switch", { name: "Allow writes" }));
    await user.click(screen.getByRole("button", { name: /Run/ }));
    await waitFor(() => expect(queryCalls(calls).length).toBe(1));
    expect(screen.queryByRole("dialog")).toBeNull();
    first.unmount();

    draft("DELETE FROM users;");
    const second = renderTab(); // read-only: the server rejects writes, so no confirm is needed
    await user.click(screen.getByRole("button", { name: /Run/ }));
    await waitFor(() => expect(queryCalls(calls).length).toBe(2));
    expect(queryCalls(calls)[1]!.body).toMatchObject({ readOnly: true });
    second.unmount();

    for (const risky of ["DROP TABLE users;", "UPDATE users SET name = 'x';", "TRUNCATE users;"]) {
      draft(risky);
      const r = renderTab();
      await user.click(screen.getByRole("switch", { name: "Allow writes" }));
      await user.click(screen.getByRole("button", { name: /Run/ }));
      expect(await screen.findByRole("dialog", { name: "Confirm destructive SQL" })).toBeTruthy();
      r.unmount();
    }
  });

  test("an error with failedStatementIndex shows ok, error and not executed per statement and focuses the failed one", async () => {
    mockFetch(() => ({
      status: 400,
      json: {
        error: { code: "sql_error", message: "statement 2 failed", detail: "no such table: nope" },
        failedStatementIndex: 1,
        totalDurationMs: 4.2,
        results: [
          stmt({ statement: "SELECT 1" }),
          stmt({ index: 1, statement: "SELECT * FROM nope", status: "error", error: "no such table: nope", columns: [], rows: [] }),
          stmt({ index: 2, statement: "SELECT 3", status: "not_executed", columns: [], rows: [], durationMs: 0 }),
        ],
      },
    }));
    const user = userEvent.setup();
    renderTab();
    await user.click(screen.getByRole("button", { name: /Run/ }));

    const tabs = await screen.findAllByRole("tab");
    expect(tabs.map((t) => t.textContent)).toEqual(["Stmt 11 rows", "Stmt 2error", "Stmt 3not executed"]);
    expect(tabs[1]!.getAttribute("aria-selected")).toBe("true");
    const top = screen.getAllByRole("alert").map((a) => a.textContent).join(" | ");
    expect(top).toContain("SQL error");
    expect(top).toContain("statement 2 failed: no such table: nope");
    const failed = within(screen.getByLabelText("Query results"));
    expect(failed.getByText("Statement 2 failed")).toBeTruthy();
    expect(failed.getByText("SELECT * FROM nope")).toBeTruthy();

    await user.click(tabs[2]!);
    expect(await failed.findByText("Not executed")).toBeTruthy();
    expect(failed.getByText(/Statement 3 did not run because statement 2 failed/)).toBeTruthy();
    expect(failed.getByText("SELECT 3")).toBeTruthy();

    await user.click(tabs[0]!);
    expect(await failed.findByText("1")).toBeTruthy(); // statement 1 result still viewable
  });

  test("a 408 timeout says the query may still be running", async () => {
    mockFetch(() => ({ status: 408, json: { error: { code: "query_timeout", message: "query timed out after 15000ms" } } }));
    const user = userEvent.setup();
    renderTab();
    await user.click(screen.getByRole("button", { name: /Run/ }));
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("Query timed out");
    expect(alert.textContent).toContain("may still be running");
    await user.click(within(alert).getByRole("button", { name: "Dismiss" }));
    expect(screen.queryByRole("alert")).toBeNull();
  });

  test("history is stored per database (last 50), listed with ok/failed, and reloads the SQL when clicked", async () => {
    let n = 0;
    const seeded = Array.from({ length: 50 }, (_, i) => ({ id: `s${i}`, sql: `SELECT ${i}`, at: 1, durationMs: 1, ok: true }));
    localStorage.setItem("sqlitend:sql-history:d1", JSON.stringify(seeded));
    mockFetch(() => (++n === 1 ? { json: { results: [stmt()], totalDurationMs: 1 } } : { status: 400, json: { error: { code: "sql_error", message: "boom" } } }));
    const user = userEvent.setup();
    renderTab();
    expect(screen.getByRole("button", { name: "History (50)" })).toBeTruthy();
    await user.click(screen.getByRole("button", { name: /Run/ }));
    await screen.findByLabelText("Query results");
    const stored = JSON.parse(localStorage.getItem("sqlitend:sql-history:d1")!);
    expect(stored.length).toBe(50);
    expect(stored[0].sql).toBe('SELECT * FROM "users" LIMIT 100;');
    expect(stored.at(-1).sql).toBe("SELECT 48");

    await user.click(screen.getByRole("button", { name: "History (50)" }));
    const panel = await screen.findByLabelText("Query history");
    await user.click(within(panel).getAllByRole("button", { name: /SELECT 5\b/ })[0]!);
    expect(screen.queryByLabelText("Query history")).not.toBeNull();
    await user.click(screen.getByRole("button", { name: /Run/ }));
    await waitFor(() => expect(JSON.parse(localStorage.getItem("sqlitend:sql-history:d1")!)[0].ok).toBe(false));
    expect(within(screen.getByLabelText("Query history")).getByText("failed")).toBeTruthy();
  });

  describe("when localStorage throws", () => {
    const get = Storage.prototype.getItem;
    const set = Storage.prototype.setItem;
    afterEach(() => {
      Storage.prototype.getItem = get;
      Storage.prototype.setItem = set;
    });

    test("the console still renders and runs; history and snippets live in memory", async () => {
      Storage.prototype.getItem = () => {
        throw new Error("SecurityError");
      };
      Storage.prototype.setItem = () => {
        throw new Error("QuotaExceededError");
      };
      mockFetch(() => ({ json: { results: [stmt()], totalDurationMs: 1 } }));
      const user = userEvent.setup();
      renderTab();
      expect(screen.getByRole("button", { name: "History (0)" })).toBeTruthy();
      await user.click(screen.getByRole("button", { name: /Run/ }));
      await screen.findByLabelText("Query results");
      expect(screen.getByRole("button", { name: "History (1)" })).toBeTruthy();
      await user.type(screen.getByLabelText("Snippet title"), "mine");
      await user.click(screen.getByRole("button", { name: "Save snippet" }));
      expect(await screen.findByText("mine")).toBeTruthy();
      expect(screen.getByRole("button", { name: "Snippets (1)" })).toBeTruthy();
    });
  });

  test("snippets: save with a title, load into the editor, remove", async () => {
    mockFetch(() => undefined);
    const user = userEvent.setup();
    renderTab();
    await user.type(screen.getByLabelText("Snippet title"), "all users");
    await user.click(screen.getByRole("button", { name: "Save snippet" }));
    const panel = await screen.findByLabelText("Saved snippets");
    expect(within(panel).getByText("all users")).toBeTruthy();
    expect(JSON.parse(localStorage.getItem("sqlitend:sql-snippets:d1")!)[0]).toMatchObject({ title: "all users", sql: 'SELECT * FROM "users" LIMIT 100;' });
    await user.click(within(panel).getByRole("button", { name: "Remove snippet all users" }));
    expect(within(screen.getByLabelText("Saved snippets")).getByText(/Save frequent queries/)).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "Snippets (0)" }));
    expect(screen.queryByLabelText("Saved snippets")).toBeNull();
  });

  test("Ctrl+Enter inside the editor runs the SQL", async () => {
    const { calls } = mockFetch(() => ({ json: { results: [stmt()], totalDurationMs: 1 } }));
    renderTab();
    const editor = await screen.findByRole("textbox", { name: "SQL editor" });
    expect(editor.textContent).toContain('SELECT * FROM "users" LIMIT 100;');
    fireEvent.keyDown(editor, { key: "Enter", code: "Enter", ctrlKey: true });
    await waitFor(() => expect(queryCalls(calls).length).toBe(1));
  });

  test("the row cap and a truncated result are shown", async () => {
    const { calls } = mockFetch(() => ({ json: { results: [stmt({ truncated: true })], totalDurationMs: 1 } }));
    const user = userEvent.setup();
    renderTab();
    await user.click(screen.getByRole("button", { name: /Row cap/ }));
    await user.click(await screen.findByRole("option", { name: "100 rows" }));
    await user.click(screen.getByRole("button", { name: /Run/ }));
    expect(await screen.findByText("Truncated at 100 rows")).toBeTruthy();
    expect(queryCalls(calls)[0]!.body).toMatchObject({ limit: 100 });
  });
});

describe("VirtualResultTable", () => {
  test("renders header and cells, copies JSON and exports CSV", async () => {
    const user = userEvent.setup();
    const written: string[] = [];
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText: async (t: string) => void written.push(t) } });
    const blobs: Blob[] = [];
    URL.createObjectURL = (b: Blob | MediaSource) => (blobs.push(b as Blob), "blob:x");
    URL.revokeObjectURL = () => {};
    const orig = HTMLAnchorElement.prototype.click;
    HTMLAnchorElement.prototype.click = () => {};
    try {
      render(<VirtualResultTable columns={["a", "b"]} rows={[[1, 'x,"y"'], [null, "z"]]} />);
      const table = screen.getByRole("table", { name: "Query result" });
      expect(within(table).getAllByRole("columnheader").map((h) => h.textContent)).toEqual(["a", "b"]);
      expect(within(table).getByText('x,"y"')).toBeTruthy();
      expect(screen.getByText(/2 rows x 2 columns/)).toBeTruthy();
      await user.click(screen.getByRole("button", { name: "Copy JSON" }));
      expect(JSON.parse(written[0]!)).toEqual([{ a: 1, b: 'x,"y"' }, { a: null, b: "z" }]);
      await user.click(screen.getByRole("button", { name: "Export CSV" }));
      expect(await blobs[0]!.text()).toBe('a,b\n1,"x,""y"""\n,z');
      expect(await screen.findByText("Downloaded CSV")).toBeTruthy();
      await user.dblClick(within(table).getByText("z"));
      expect(await screen.findByText("Copied cell")).toBeTruthy();
      expect(written.at(-1)).toBe("z");
    } finally {
      HTMLAnchorElement.prototype.click = orig;
    }
  });

  test("shows a clipboard message instead of throwing when copy is unavailable", async () => {
    render(<VirtualResultTable columns={["a"]} rows={[[1]]} />);
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: undefined });
    fireEvent.click(screen.getByRole("button", { name: "Copy JSON" }));
    expect(await screen.findByText("Clipboard unavailable")).toBeTruthy();
  });
});
