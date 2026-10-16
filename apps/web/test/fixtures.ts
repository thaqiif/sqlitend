import type { TableSchemaItem } from "@sqlitend/shared";

export const USERS: TableSchemaItem = {
  name: "users",
  type: "table",
  sql: 'CREATE TABLE "users" (id INTEGER PRIMARY KEY, name TEXT NOT NULL, team_id INTEGER REFERENCES teams(id), note TEXT)',
  withoutRowid: false,
  rowCountEstimate: 3,
  columns: [
    { cid: 0, name: "id", type: "INTEGER", notnull: false, defaultValue: null, pk: 1 },
    { cid: 1, name: "name", type: "TEXT", notnull: true, defaultValue: null, pk: 0 },
    { cid: 2, name: "team_id", type: "INTEGER", notnull: false, defaultValue: null, pk: 0 },
    { cid: 3, name: "note", type: "TEXT", notnull: false, defaultValue: "'n/a'", pk: 0 },
  ],
  primaryKey: ["id"],
  indexes: [{ name: "idx_users_name", unique: true, origin: "c", partial: false, columns: ["name"], sql: null }],
  foreignKeys: [{ id: 0, seq: 0, table: "teams", from: "team_id", to: "id", onUpdate: "NO ACTION", onDelete: "CASCADE" }],
};

export const TEAMS: TableSchemaItem = {
  ...USERS,
  name: "teams",
  sql: null,
  indexes: [],
  foreignKeys: [],
  columns: [USERS.columns[0]!, USERS.columns[1]!],
};

export const USER_ROWS = [
  { id: 1, name: "Alice", team_id: 10, note: null },
  { id: 2, name: "Bob", team_id: 10, note: "hi" },
  { id: 3, name: "Cleo", team_id: null, note: null },
];

export function rowsResponse(rows: Record<string, string | number | boolean | null>[] = USER_ROWS, table: TableSchemaItem = USERS, over = {}) {
  return {
    table: table.name,
    columns: table.columns,
    primaryKey: table.primaryKey,
    hasRowid: true,
    rows,
    total: rows.length,
    hasMore: false,
    nextOffset: null,
    durationMs: 2,
    ...over,
  };
}
