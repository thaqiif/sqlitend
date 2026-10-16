import { describe, expect, test } from "bun:test";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { TableSchemaItem } from "@sqlitend/shared";
import { DataGridTab } from "../src/components/DataGridTab";
import { buildPreviewSql, coerceEditedValue, quoteIdent, sqlLiteral } from "../src/data-sql";
import { mockFetch, type Call } from "./fetch-mock";
import { TEAMS, USERS, rowsResponse } from "./fixtures";
import { installFakeLayout, installMatchMedia } from "./layout";

function view(tables: TableSchemaItem[], selected: string | null = "users", onSelect: (n: string) => void = () => {}) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const ui = (t: TableSchemaItem[], s: string | null) => (
    <QueryClientProvider client={client}>
      <DataGridTab dbId="d1" tables={t} selectedTable={s} onSelectTable={onSelect} onOpenSqlTab={() => {}} />
    </QueryClientProvider>
  );
  const r = render(ui(tables, selected));
  return { ...r, rerenderWith: (t: TableSchemaItem[], s: string | null) => r.rerender(ui(t, s)) };
}

const rowsCalls = (calls: Call[]) => calls.filter((c) => c.method === "GET" && c.url.includes("/tables/users/rows"));
const lastRowsUrl = (calls: Call[]) => new URL(rowsCalls(calls).at(-1)!.url, "http://x");

function usersApi(over: (c: Call) => ReturnType<Parameters<typeof mockFetch>[0]> = () => undefined) {
  return mockFetch((c) => {
    const custom = over(c);
    if (custom) return custom;
    if (c.method === "GET" && c.url.includes("/tables/users/rows")) return { json: rowsResponse() };
    if (c.method === "GET" && c.url.includes("/tables/teams/rows")) return { json: rowsResponse([{ id: 10, name: "core" }], TEAMS) };
    if (c.method === "PATCH" || c.method === "POST" || c.method === "DELETE") return { json: { affected: 1 } };
    return undefined;
  });
}

describe("DataGridTab: hooks order (React #310)", () => {
  test("renders with no tables, then rerenders with a table, without throwing", async () => {
    usersApi();
    const { rerenderWith } = view([], null);
    expect(screen.getByText("No tables found in this database.")).toBeTruthy();
    expect(() => rerenderWith([USERS], "users")).not.toThrow();
    expect(await screen.findByRole("table", { name: "Table rows" })).toBeTruthy();
    expect(() => rerenderWith([], null)).not.toThrow();
    expect(screen.getByText("No tables found in this database.")).toBeTruthy();
    expect(() => rerenderWith([USERS, TEAMS], "teams")).not.toThrow();
  });

  test("the empty state offers the SQL console", async () => {
    const opened: string[] = [];
    const client = new QueryClient();
    render(
      <QueryClientProvider client={client}>
        <DataGridTab dbId="d1" tables={[]} selectedTable={null} onSelectTable={() => {}} onOpenSqlTab={() => opened.push("sql")} />
      </QueryClientProvider>,
    );
    await userEvent.setup().click(screen.getByRole("button", { name: "Open SQL Console" }));
    expect(opened).toEqual(["sql"]);
  });
});

describe("DataGridTab: desktop grid", () => {
  installFakeLayout();
  installMatchMedia(false);

  test("renders rows virtualised, and clicking a header sorts asc, then desc, then clears", async () => {
    const { calls } = usersApi();
    const user = userEvent.setup();
    view([USERS]);
    const grid = await screen.findByRole("table", { name: "Table rows" });
    expect(await within(grid).findByText("Alice")).toBeTruthy();
    expect(within(grid).getAllByRole("columnheader").map((h) => h.getAttribute("aria-sort"))).toContain("none");

    await user.click(within(grid).getByRole("button", { name: /^name/ }));
    await waitFor(() => expect(lastRowsUrl(calls).searchParams.get("sort")).toBe("name"));
    expect(lastRowsUrl(calls).searchParams.get("dir")).toBe("asc");

    await user.click(within(screen.getByRole("table", { name: "Table rows" })).getByRole("button", { name: /^name/ }));
    await waitFor(() => expect(lastRowsUrl(calls).searchParams.get("dir")).toBe("desc"));
    expect(screen.getByRole("columnheader", { name: /name/ }).getAttribute("aria-sort")).toBe("descending");

    await user.click(within(screen.getByRole("table", { name: "Table rows" })).getByRole("button", { name: /^name/ }));
    await waitFor(() => expect(lastRowsUrl(calls).searchParams.has("sort")).toBe(false));
  });

  test("adding a filter sends it in `filters` and shows a chip that can be removed", async () => {
    const { calls } = usersApi();
    const user = userEvent.setup();
    view([USERS]);
    await screen.findByText("Alice");
    await user.type(screen.getByLabelText("Filter value"), "Bob");
    await user.click(screen.getByRole("button", { name: "Add filter" }));
    await waitFor(() => {
      const f = lastRowsUrl(calls).searchParams.get("filters");
      expect(f && JSON.parse(f)).toEqual([{ col: "id", op: "=", value: "Bob" }]);
    });
    const chips = screen.getByRole("group", { name: "Active filters" });
    expect(chips.textContent).toContain("id = \"Bob\"");

    await user.click(within(chips).getByRole("button", { name: /Remove filter/ }));
    await waitFor(() => expect(lastRowsUrl(calls).searchParams.has("filters")).toBe(false));
    expect(screen.queryByRole("group", { name: "Active filters" })).toBeNull();
  });

  test("inline edit stages an UPDATE, Review shows the SQL, applying PATCHes the rows endpoint", async () => {
    const { calls } = usersApi();
    const user = userEvent.setup();
    view([USERS]);
    const aliceCell = await screen.findByText("Alice");
    await user.dblClick(aliceCell);
    const input = await screen.findByRole("textbox", { name: "Edit name" });
    await user.clear(input);
    await user.type(input, "Alicia{Enter}");

    const tray = await screen.findByRole("region", { name: "Staged changes" });
    expect(tray.textContent).toContain("1 staged change");
    expect(screen.getByText("Alicia")).toBeTruthy();
    await user.click(within(tray).getByRole("button", { name: /Review/ }));

    const dialog = await screen.findByRole("dialog", { name: "Review pending SQL changes" });
    expect(within(dialog).getByLabelText("Generated SQL").textContent).toBe(`UPDATE "users" SET "name" = 'Alicia' WHERE "id" = 1;`);
    expect(calls.some((c) => c.method === "PATCH")).toBe(false); // nothing is written before the commit
    await user.click(within(dialog).getByRole("button", { name: "Commit changes" }));

    await waitFor(() => expect(calls.some((c) => c.method === "PATCH")).toBe(true));
    const patch = calls.find((c) => c.method === "PATCH")!;
    expect(patch.url).toBe("/api/databases/d1/tables/users/rows");
    expect(patch.body).toEqual({ updates: [{ pk: { id: 1 }, values: { name: "Alicia" } }] });
    await waitFor(() => expect(screen.queryByRole("region", { name: "Staged changes" })).toBeNull());
  });

  test("Escape cancels an edit and editing back to the original value stages nothing", async () => {
    usersApi();
    const user = userEvent.setup();
    view([USERS]);
    await user.dblClick(await screen.findByText("Bob"));
    await user.type(await screen.findByRole("textbox", { name: "Edit name" }), "x{Escape}");
    expect(screen.queryByRole("textbox", { name: "Edit name" })).toBeNull();
    expect(screen.queryByRole("region", { name: "Staged changes" })).toBeNull();

    await user.dblClick(within(screen.getByRole("table", { name: "Table rows" })).getByText("Bob"));
    await user.type(await screen.findByRole("textbox", { name: "Edit name" }), "{Enter}"); // unchanged
    expect(screen.queryByRole("region", { name: "Staged changes" })).toBeNull();
  });

  test("a long-press (touch) on a cell starts editing", async () => {
    usersApi();
    view([USERS]);
    const cell = (await screen.findByText("Cleo")).closest('[role="cell"]')!;
    fireEvent.pointerDown(cell, { pointerType: "touch", clientX: 5, clientY: 5 });
    await act(async () => void (await new Promise((r) => setTimeout(r, 600))));
    expect(await screen.findByRole("textbox", { name: "Edit name" })).toBeTruthy();
  });

  test("a touch that moves is not a long-press", async () => {
    usersApi();
    view([USERS]);
    const cell = (await screen.findByText("Cleo")).closest('[role="cell"]')!;
    fireEvent.pointerDown(cell, { pointerType: "touch", clientX: 5, clientY: 5 });
    fireEvent.pointerMove(cell, { pointerType: "touch", clientX: 80, clientY: 5 });
    await act(async () => void (await new Promise((r) => setTimeout(r, 600))));
    expect(screen.queryByRole("textbox", { name: "Edit name" })).toBeNull();
  });

  test("a staged delete is listed in Review as DELETE and sent as a DELETE call; Undo unstages", async () => {
    const { calls } = usersApi();
    const user = userEvent.setup();
    view([USERS]);
    await screen.findByText("Bob");
    const bobRow = screen.getByText("Bob").closest('[role="row"]') as HTMLElement;
    await user.click(within(bobRow).getByRole("button", { name: "Stage row delete" }));
    expect(within(bobRow).getByRole("button", { name: "Undo staged delete" })).toBeTruthy();
    await user.click(within(bobRow).getByRole("button", { name: "Undo staged delete" }));
    expect(screen.queryByRole("region", { name: "Staged changes" })).toBeNull();

    await user.click(within(bobRow).getByRole("button", { name: "Stage row delete" }));
    await user.click(within(await screen.findByRole("region", { name: "Staged changes" })).getByRole("button", { name: /Review/ }));
    const dialog = await screen.findByRole("dialog", { name: "Review pending SQL changes" });
    expect(within(dialog).getByLabelText("Generated SQL").textContent).toBe(`DELETE FROM "users" WHERE "id" = 2;`);
    await user.click(within(dialog).getByRole("button", { name: "Commit changes" }));
    await waitFor(() => expect(calls.some((c) => c.method === "DELETE")).toBe(true));
    expect(calls.find((c) => c.method === "DELETE")!.body).toEqual({ pks: [{ id: 2 }] });
  });

  test("add row stages an INSERT and applies it with POST; Discard clears staged changes", async () => {
    const { calls } = usersApi();
    const user = userEvent.setup();
    view([USERS]);
    await screen.findByText("Alice");
    await user.click(screen.getByRole("button", { name: "Add row" }));
    const dialog = await screen.findByRole("dialog", { name: "Insert new row" });
    await user.type(within(dialog).getByRole("textbox", { name: /^id/ }), "9");
    await user.type(within(dialog).getByRole("textbox", { name: /^name/ }), "Zed");
    await user.click(within(dialog).getByRole("button", { name: "Stage row" }));

    const tray = await screen.findByRole("region", { name: "Staged changes" });
    await user.click(within(tray).getByRole("button", { name: "Discard" }));
    expect(screen.queryByRole("region", { name: "Staged changes" })).toBeNull();

    await user.click(screen.getByRole("button", { name: "Add row" }));
    const dialog2 = await screen.findByRole("dialog", { name: "Insert new row" });
    await user.type(within(dialog2).getByRole("textbox", { name: /^name/ }), "Zed");
    await user.click(within(dialog2).getByRole("button", { name: "Stage row" }));
    await user.click(within(await screen.findByRole("region", { name: "Staged changes" })).getByRole("button", { name: /Review/ }));
    const review = await screen.findByRole("dialog", { name: "Review pending SQL changes" });
    expect(within(review).getByLabelText("Generated SQL").textContent).toBe(`INSERT INTO "users" ("name") VALUES ('Zed');`);
    await user.click(within(review).getByRole("button", { name: "Commit changes" }));
    await waitFor(() => expect(calls.some((c) => c.method === "POST")).toBe(true));
    expect(calls.find((c) => c.method === "POST")!.body).toEqual({ rows: [{ name: "Zed" }] });
  });

  test("an API error while applying is shown in the Review dialog and nothing is cleared", async () => {
    usersApi((c) => (c.method === "PATCH" ? { status: 409, json: { error: { code: "conflict", message: "UNIQUE constraint failed" } } } : undefined));
    const user = userEvent.setup();
    view([USERS]);
    await user.dblClick(await screen.findByText("Bob"));
    await user.type(await screen.findByRole("textbox", { name: "Edit name" }), "!{Enter}");
    await user.click(within(await screen.findByRole("region", { name: "Staged changes" })).getByRole("button", { name: /Review/ }));
    const dialog = await screen.findByRole("dialog", { name: "Review pending SQL changes" });
    await user.click(within(dialog).getByRole("button", { name: "Commit changes" }));
    expect((await within(dialog).findByRole("alert")).textContent).toContain("UNIQUE constraint failed");
    expect(screen.getByRole("region", { name: "Staged changes" })).toBeTruthy();
  });

  test("copies a cell and a row (JSON and CSV) to the clipboard", async () => {
    usersApi();
    const written: string[] = [];
    const user = userEvent.setup(); // user-event installs its own clipboard stub, so replace it afterwards
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText: async (t: string) => void written.push(t) } });
    view([USERS]);
    const alice = (await screen.findByText("Alice")).closest('[role="row"]') as HTMLElement;
    await user.click(within(alice).getByRole("button", { name: "Copy row as JSON" }));
    await user.click(within(alice).getByRole("button", { name: "Copy row as CSV" }));
    await user.click(within(alice).getByText("Alice"));
    const bar = await screen.findByLabelText("Selected cell");
    await user.click(within(bar).getByRole("button", { name: "Copy cell" }));
    await user.click(within(bar).getByRole("button", { name: "Cell as JSON" }));
    await user.click(within(bar).getByRole("button", { name: "Cell as CSV" }));
    await waitFor(() => expect(written.length).toBe(5));
    expect(JSON.parse(written[0]!)).toEqual({ id: 1, name: "Alice", team_id: 10, note: null });
    expect(written[1]).toBe("id,name,team_id,note\n1,Alice,10,");
    expect(written.slice(2)).toEqual(["Alice", '{"name":"Alice"}', "name\nAlice"]);
  });

  test("copy shows a message instead of throwing when the clipboard is unavailable", async () => {
    usersApi();
    const user = userEvent.setup();
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: undefined });
    view([USERS]);
    const alice = (await screen.findByText("Alice")).closest('[role="row"]') as HTMLElement;
    await user.click(within(alice).getByRole("button", { name: "Copy row as JSON" }));
    expect(await screen.findByText("Clipboard unavailable")).toBeTruthy();
  });

  test("Export CSV downloads the current page", async () => {
    usersApi();
    const blobs: Blob[] = [];
    const origCreate = URL.createObjectURL;
    URL.createObjectURL = (b: Blob | MediaSource) => (blobs.push(b as Blob), "blob:x");
    URL.revokeObjectURL = () => {};
    const clicked: string[] = [];
    const origClick = HTMLAnchorElement.prototype.click;
    HTMLAnchorElement.prototype.click = function (this: HTMLAnchorElement) {
      clicked.push(this.download);
    };
    try {
      const user = userEvent.setup();
      view([USERS]);
      await screen.findByText("Alice");
      await user.click(screen.getByRole("button", { name: "Export CSV" }));
      expect(clicked).toEqual(["users.csv"]);
      expect(await blobs[0]!.text()).toBe("id,name,team_id,note\n1,Alice,10,\n2,Bob,10,hi\n3,Cleo,,");
    } finally {
      URL.createObjectURL = origCreate;
      HTMLAnchorElement.prototype.click = origClick;
    }
  });

  test("paging: Next uses the offset, Prev goes back, and page size changes the limit", async () => {
    const { calls } = usersApi((c) =>
      c.method === "GET" && c.url.includes("/tables/users/rows") ? { json: rowsResponse(undefined, USERS, { hasMore: true, total: 250 }) } : undefined,
    );
    const user = userEvent.setup();
    view([USERS]);
    await screen.findByText("Alice");
    expect((screen.getByRole("button", { name: "Prev" }) as HTMLButtonElement).disabled).toBe(true);
    await user.click(screen.getByRole("button", { name: "Next" }));
    await waitFor(() => expect(lastRowsUrl(calls).searchParams.get("offset")).toBe("100"));
    await user.click(screen.getByRole("button", { name: "Prev" }));
    await waitFor(() => expect(lastRowsUrl(calls).searchParams.get("offset")).toBe("0"));
    await user.click(screen.getByRole("button", { name: /Rows per page/ }));
    await user.click(await screen.findByRole("option", { name: "250 / page" }));
    await waitFor(() => expect(lastRowsUrl(calls).searchParams.get("limit")).toBe("250"));
  });

  test("choosing another table calls onSelectTable and remounts with that table's rows", async () => {
    usersApi();
    const picked: string[] = [];
    const { rerenderWith } = view([USERS, TEAMS], "users", (n) => picked.push(n));
    await screen.findByText("Alice");
    await userEvent.setup().click(screen.getByRole("button", { name: /Table/ }));
    await userEvent.setup().click(await screen.findByRole("option", { name: /teams/ }));
    expect(picked).toEqual(["teams"]);
    rerenderWith([USERS, TEAMS], "teams");
    expect(await screen.findByText("core")).toBeTruthy();
  });

  test("a view is read-only: no Add row, no delete buttons", async () => {
    mockFetch((c) => (c.url.includes("/rows") ? { json: rowsResponse() } : undefined));
    view([{ ...USERS, type: "view" }]);
    await screen.findByText("Alice");
    expect(screen.queryByRole("button", { name: "Add row" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Stage row delete" })).toBeNull();
  });

  test("shows the API error when rows fail to load and empty pages", async () => {
    mockFetch(() => ({ status: 500, json: { error: { code: "boom", message: "database is locked" } } }));
    view([USERS]);
    expect((await screen.findByRole("alert")).textContent).toContain("database is locked");
  });

  test("an empty result page says so", async () => {
    mockFetch((c) => (c.url.includes("/rows") ? { json: rowsResponse([]) } : undefined));
    view([USERS]);
    expect(await screen.findByText("No rows in this result page.")).toBeTruthy();
  });
});

describe("DataGridTab: phone layout (< 600px)", () => {
  installFakeLayout();
  installMatchMedia(true);

  test("renders cards with the PK and three more columns instead of the grid; tapping opens the full record", async () => {
    const { calls } = usersApi();
    const user = userEvent.setup();
    view([USERS]);
    const list = await screen.findByRole("list", { name: "Rows" });
    expect(screen.queryByRole("table", { name: "Table rows" })).toBeNull();
    const cards = within(list).getAllByRole("listitem");
    expect(cards.length).toBe(3);
    expect(cards[0]!.textContent).toContain("id: 1");
    for (const col of ["name", "team_id", "note"]) expect(within(cards[0]!).getByText(col)).toBeTruthy();
    expect(within(cards[0]!).getByText("Alice")).toBeTruthy();

    await user.click(within(cards[1]!).getByRole("button"));
    const sheet = await screen.findByRole("dialog", { name: "Record details" });
    const name = within(sheet).getByRole("textbox", { name: /^name/ });
    expect((name as HTMLInputElement).value).toBe("Bob");
    await user.clear(name);
    await user.type(name, "Robert");
    await user.click(within(sheet).getByRole("button", { name: "Stage changes" }));
    expect(await screen.findByRole("region", { name: "Staged changes" })).toBeTruthy();
    expect(within(screen.getByRole("list", { name: "Rows" })).getByText("Robert")).toBeTruthy();
    expect(calls.some((c) => c.method === "PATCH")).toBe(false);
  });

  test("the record sheet can stage and unstage a delete", async () => {
    usersApi();
    const user = userEvent.setup();
    view([USERS]);
    const list = await screen.findByRole("list", { name: "Rows" });
    await user.click(within(within(list).getAllByRole("listitem")[2]!).getByRole("button"));
    await user.click(within(await screen.findByRole("dialog", { name: "Record details" })).getByRole("button", { name: "Stage delete" }));
    expect(await screen.findByText("staged delete")).toBeTruthy();
    await user.click(within(within(screen.getByRole("list", { name: "Rows" })).getAllByRole("listitem")[2]!).getByRole("button"));
    await user.click(within(await screen.findByRole("dialog", { name: "Record details" })).getByRole("button", { name: "Unstage delete" }));
    await waitFor(() => expect(screen.queryByText("staged delete")).toBeNull());
  });

  test("an empty page shows the empty message", async () => {
    mockFetch((c) => (c.url.includes("/rows") ? { json: rowsResponse([]) } : undefined));
    view([USERS]);
    expect(await screen.findByText("No rows match the current query.")).toBeTruthy();
  });
});

describe("data-sql helpers", () => {
  test("quote and literal escaping", () => {
    expect(quoteIdent('we"ird')).toBe('"we""ird"');
    expect(sqlLiteral("o'k")).toBe("'o''k'");
    expect(sqlLiteral(null)).toBe("NULL");
    expect(sqlLiteral(true)).toBe("1");
    expect(sqlLiteral(Infinity)).toBe("NULL");
    expect(sqlLiteral(4)).toBe("4");
  });
  test("coerceEditedValue follows the column type", () => {
    expect(coerceEditedValue("12", "INTEGER")).toBe(12);
    expect(coerceEditedValue("1.5", "INTEGER")).toBe("1.5");
    expect(coerceEditedValue("1.5", "REAL")).toBe(1.5);
    expect(coerceEditedValue("", "INTEGER")).toBe("");
    expect(coerceEditedValue("NULL", "TEXT")).toBeNull();
    expect(coerceEditedValue("7", "TEXT")).toBe("7");
  });
  test("buildPreviewSql handles NULL keys, DEFAULT VALUES and composite keys", () => {
    expect(buildPreviewSql("t", [{}], [], [])).toBe('INSERT INTO "t" DEFAULT VALUES;');
    expect(buildPreviewSql("t", [], [{ pk: { a: 1, b: null }, values: { c: "x" } }], [{ a: 2, b: "q" }])).toBe(
      `UPDATE "t" SET "c" = 'x' WHERE "a" = 1 AND "b" IS NULL;\nDELETE FROM "t" WHERE "a" = 2 AND "b" = 'q';`,
    );
  });
});
