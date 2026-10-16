import { describe, expect, test } from "bun:test";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { StructureTab } from "../src/components/StructureTab";
import { TEAMS, USERS } from "./fixtures";

function renderTab(over: Partial<Parameters<typeof StructureTab>[0]> = {}) {
  const props = { tables: [USERS, TEAMS], selectedTable: "users", onSelectTable: () => {}, onRefresh: () => {}, ...over };
  return render(<StructureTab {...props} />);
}

describe("StructureTab", () => {
  test("renders columns with type, constraints and defaults", () => {
    renderTab();
    const cols = within(screen.getByRole("table", { name: "Columns" }));
    const rows = cols.getAllByRole("row").slice(1);
    expect(rows.length).toBe(4);
    expect(rows[0]!.textContent).toContain("id");
    expect(rows[0]!.textContent).toContain("INTEGER");
    expect(rows[0]!.textContent).toContain("PK");
    expect(rows[1]!.textContent).toContain("NOT NULL");
    expect(rows[2]!.textContent).toContain("FK to teams.id");
    expect(rows[3]!.textContent).toContain("'n/a'");
    expect(screen.getByRole("heading", { name: /users/ }).textContent).toContain("table");
    expect(screen.getByText("Columns (4)")).toBeTruthy();
  });

  test("renders indexes and foreign keys", () => {
    renderTab();
    const idx = within(screen.getByRole("table", { name: "Indexes" })).getAllByRole("row")[1]!;
    expect(idx.textContent).toContain("idx_users_name");
    expect(idx.textContent).toContain("UNIQUE");
    expect(idx.textContent).toContain("CREATE INDEX");
    const fk = within(screen.getByRole("table", { name: "Foreign keys" })).getAllByRole("row")[1]!;
    expect(fk.textContent).toContain("team_id");
    expect(fk.textContent).toContain("teams(id)");
    expect(fk.textContent).toContain("CASCADE");
  });

  test("shows the CREATE statement and copies it", async () => {
    const user = userEvent.setup();
    const written: string[] = [];
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText: async (t: string) => void written.push(t) } });
    renderTab();
    expect(screen.getByText(/CREATE TABLE "users"/)).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "Copy DDL" }));
    expect(written[0]).toBe(USERS.sql!);
    expect(await screen.findByRole("button", { name: "Copied" })).toBeTruthy();
  });

  test("hides sections a table does not have, labels views and composite keys", () => {
    renderTab({
      tables: [TEAMS, { ...USERS, name: "v_users", type: "view", withoutRowid: true, primaryKey: ["id", "name"], columns: USERS.columns.map((c, i) => (i < 2 ? { ...c, pk: i + 1 } : c)) }],
      selectedTable: "teams",
    });
    expect(screen.queryByRole("table", { name: "Indexes" })).toBeNull();
    expect(screen.queryByRole("table", { name: "Foreign keys" })).toBeNull();
    expect(screen.queryByRole("region", { name: "CREATE statement" })).toBeNull();
  });

  test("falls back to the first table, shows composite PK numbers, and reports selection and refresh", async () => {
    const picked: string[] = [];
    let refreshed = 0;
    const user = userEvent.setup();
    const composite = { ...USERS, name: "v", type: "view" as const, withoutRowid: true, primaryKey: ["id", "name"], columns: USERS.columns.map((c, i) => (i < 2 ? { ...c, pk: i + 1 } : c)) };
    renderTab({ tables: [composite, TEAMS], selectedTable: "missing", onSelectTable: (n) => picked.push(n), onRefresh: () => refreshed++ });
    expect(screen.getByRole("heading", { name: /v/ }).textContent).toContain("view, WITHOUT ROWID");
    expect(screen.getByText("PK #1")).toBeTruthy();
    expect(screen.getByText("PK #2")).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "Refresh schema" }));
    expect(refreshed).toBe(1);
    await user.click(screen.getByRole("button", { name: /Table or view/ }));
    await user.click(await screen.findByRole("option", { name: /teams/ }));
    expect(picked).toEqual(["teams"]);
  });

  test("an empty schema explains how to create a table", () => {
    renderTab({ tables: [], selectedTable: null });
    expect(screen.getByText("This database has no user tables or views yet.")).toBeTruthy();
  });
});
