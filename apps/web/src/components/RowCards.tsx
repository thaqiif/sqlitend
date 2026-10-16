import { Card } from "@heroui/react";
import type { ColumnInfo } from "@sqlitend/shared";
import type { PendingUpdate, RowRecord } from "../data-sql";

interface Props {
  columns: ColumnInfo[];
  rows: RowRecord[];
  pkCols: string[];
  offset: number;
  getRowKey: (row: RowRecord, idx: number) => string;
  pendingUpdates: Record<string, PendingUpdate>;
  pendingDeletes: Record<string, RowRecord>;
  onOpen: (rowKey: string, row: RowRecord) => void;
}

const PREVIEW_COLUMNS = 3;

/** Phone layout (< 600px): one card per row showing the PK and three more columns; tap opens the full record. */
export function RowCards({ columns, rows, pkCols, offset, getRowKey, pendingUpdates, pendingDeletes, onOpen }: Props) {
  if (rows.length === 0) {
    return <p className="m-0 rounded-xl border border-separator bg-surface p-6 text-center text-sm text-muted">No rows match the current query.</p>;
  }
  const preview = columns.filter((c) => !pkCols.includes(c.name)).slice(0, PREVIEW_COLUMNS);
  return (
    <ul className="m-0 flex list-none flex-col gap-2 p-0" aria-label="Rows">
      {rows.map((row, idx) => {
        const rowKey = getRowKey(row, idx);
        const deleted = !!pendingDeletes[rowKey];
        const updated = pendingUpdates[rowKey]?.values ?? {};
        return (
          <li key={rowKey}>
            <Card className={`p-0 ${deleted ? "bg-danger-soft opacity-70" : ""}`}>
              <button type="button" className="flex min-h-11 w-full flex-col gap-2 rounded-xl p-3 text-left" onClick={() => onOpen(rowKey, row)}>
                <span className="flex items-center justify-between gap-2">
                  <code className={`truncate text-sm font-semibold ${deleted ? "line-through" : ""}`}>
                    {pkCols.length > 0 ? pkCols.map((k) => `${k}: ${String(row[k] ?? "NULL")}`).join(", ") : `Row #${offset + idx + 1}`}
                  </code>
                  <span className="shrink-0 text-xs text-muted">{deleted ? "staged delete" : "Tap to open"}</span>
                </span>
                <dl className="m-0 grid grid-cols-[minmax(0,6rem)_minmax(0,1fr)] gap-x-3 gap-y-1 text-sm">
                  {preview.map((c) => {
                    const dirty = c.name in updated;
                    const val = dirty ? updated[c.name] : row[c.name];
                    return (
                      <div key={c.name} className="contents">
                        <dt className="truncate text-muted">{c.name}</dt>
                        <dd className={`m-0 truncate ${dirty ? "font-semibold text-warning" : ""}`}>
                          {val === null || val === undefined ? <span className="rounded bg-default px-1 text-xs text-muted">NULL</span> : String(val)}
                        </dd>
                      </div>
                    );
                  })}
                </dl>
              </button>
            </Card>
          </li>
        );
      })}
    </ul>
  );
}
