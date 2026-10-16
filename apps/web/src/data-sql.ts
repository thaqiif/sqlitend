import type { SqlValue } from "@sqlitend/shared";

export type RowRecord = Record<string, SqlValue>;
export interface PendingUpdate {
  pk: RowRecord;
  values: RowRecord;
}

export function quoteIdent(ident: string): string {
  return `"${ident.replace(/"/g, '""')}"`;
}

export function sqlLiteral(val: SqlValue | undefined): string {
  if (val === null || val === undefined) return "NULL";
  if (typeof val === "number") return Number.isFinite(val) ? String(val) : "NULL";
  if (typeof val === "boolean") return val ? "1" : "0";
  return `'${String(val).replace(/'/g, "''")}'`;
}

/** Turns text typed into a cell into a typed value; the literal text NULL means SQL NULL. */
export function coerceEditedValue(raw: string, colType: string): SqlValue {
  if (raw === "NULL") return null;
  const upper = colType.toUpperCase();
  if (/INT/.test(upper)) {
    const n = Number(raw);
    if (raw.trim() !== "" && Number.isInteger(n)) return n;
  } else if (/REAL|FLOA|DOUB|NUM|DEC/.test(upper)) {
    const n = Number(raw);
    if (raw.trim() !== "" && Number.isFinite(n)) return n;
  }
  return raw;
}

const where = (pk: RowRecord): string =>
  Object.entries(pk)
    .map(([k, v]) => (v === null ? `${quoteIdent(k)} IS NULL` : `${quoteIdent(k)} = ${sqlLiteral(v)}`))
    .join(" AND ");

/** The SQL the staged changes amount to, shown in "Review & apply" before anything is committed. */
export function buildPreviewSql(
  table: string,
  inserts: RowRecord[],
  updates: PendingUpdate[],
  deletes: RowRecord[],
): string {
  const lines: string[] = [];
  const qTbl = quoteIdent(table);
  for (const ins of inserts) {
    const keys = Object.keys(ins);
    lines.push(
      keys.length === 0
        ? `INSERT INTO ${qTbl} DEFAULT VALUES;`
        : `INSERT INTO ${qTbl} (${keys.map(quoteIdent).join(", ")}) VALUES (${keys.map((k) => sqlLiteral(ins[k])).join(", ")});`,
    );
  }
  for (const u of updates) {
    const setPart = Object.entries(u.values)
      .map(([k, v]) => `${quoteIdent(k)} = ${sqlLiteral(v)}`)
      .join(", ");
    lines.push(`UPDATE ${qTbl} SET ${setPart} WHERE ${where(u.pk)};`);
  }
  for (const pk of deletes) lines.push(`DELETE FROM ${qTbl} WHERE ${where(pk)};`);
  return lines.join("\n");
}

export function cellText(v: SqlValue | undefined): string {
  return v === null || v === undefined ? "NULL" : String(v);
}
