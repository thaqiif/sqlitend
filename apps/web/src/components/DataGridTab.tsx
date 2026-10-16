import { useEffect, useMemo, useRef, useState } from "react";
import {
  createColumnHelper,
  flexRender,
  getCoreRowModel,
  useReactTable,
} from "@tanstack/react-table";
import { useVirtualizer } from "@tanstack/react-virtual";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import type {
  ColumnInfo,
  FilterOp,
  SqlValue,
  TableFilter,
  TableSchemaItem,
} from "@sqlitend/shared";
import { api, ApiError } from "../api/client";
import { Modal } from "./Modal";

interface Props {
  dbId: string;
  tables: TableSchemaItem[];
  selectedTable: string | null;
  onSelectTable: (name: string) => void;
  onOpenSqlTab?: () => void;
}

const FILTER_OPS: { value: FilterOp; label: string; needsValue: boolean }[] = [
  { value: "=", label: "=", needsValue: true },
  { value: "!=", label: "!=", needsValue: true },
  { value: "<", label: "<", needsValue: true },
  { value: "<=", label: "<=", needsValue: true },
  { value: ">", label: ">", needsValue: true },
  { value: ">=", label: ">=", needsValue: true },
  { value: "like", label: "LIKE", needsValue: true },
  { value: "in", label: "IN (a,b)", needsValue: true },
  { value: "isnull", label: "IS NULL", needsValue: false },
  { value: "notnull", label: "IS NOT NULL", needsValue: false },
];

function quoteIdent(ident: string): string {
  return `"${ident.replace(/"/g, '""')}"`;
}

function sqlLiteral(val: SqlValue): string {
  if (val === null || val === undefined) return "NULL";
  if (typeof val === "number") return Number.isFinite(val) ? String(val) : "NULL";
  if (typeof val === "boolean") return val ? "1" : "0";
  return `'${String(val).replace(/'/g, "''")}'`;
}

function coerceEditedValue(raw: string, colType: string): SqlValue {
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

function toCsvCell(v: SqlValue): string {
  if (v === null || v === undefined) return "";
  const s = String(v);
  if (/[",\r\n]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
  return s;
}

export function DataGridTab({
  dbId,
  tables,
  selectedTable,
  onSelectTable,
  onOpenSqlTab,
}: Props) {
  const queryClient = useQueryClient();
  const activeTable = useMemo(
    () => tables.find((t) => t.name === selectedTable) ?? tables[0] ?? null,
    [tables, selectedTable],
  );

  const [limit, setLimit] = useState(100);
  const [offset, setOffset] = useState(0);
  const [sortCol, setSortCol] = useState<string | undefined>(undefined);
  const [sortDir, setSortDir] = useState<"asc" | "desc">("asc");
  const [filters, setFilters] = useState<TableFilter[]>([]);

  // Filter composer state
  const [draftFilterCol, setDraftFilterCol] = useState<string>("");
  const [draftFilterOp, setDraftFilterOp] = useState<FilterOp>("=");
  const [draftFilterVal, setDraftFilterVal] = useState<string>("");

  // Inline editing & Pending Changes state
  const [editingCell, setEditingCell] = useState<{ rowKey: string; col: string; draft: string } | null>(null);
  const [pendingUpdates, setPendingUpdates] = useState<
    Record<string, { pk: Record<string, SqlValue>; values: Record<string, SqlValue> }>
  >({});
  const [pendingDeletes, setPendingDeletes] = useState<Record<string, Record<string, SqlValue>>>({});
  const [pendingInserts, setPendingInserts] = useState<Record<string, SqlValue>[]>([]);

  // Modals / Sheets
  const [showReviewModal, setShowReviewModal] = useState(false);
  const [showAddRowModal, setShowAddRowModal] = useState(false);
  const [newRowDraft, setNewRowDraft] = useState<Record<string, string>>({});
  const [mobileDetailRow, setMobileDetailRow] = useState<{ rowKey: string; row: Record<string, SqlValue> } | null>(null);
  const [applying, setApplying] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const [toast, setToast] = useState<string | null>(null);

  // Reset pagination/filters/pending edits when switching tables
  useEffect(() => {
    setOffset(0);
    setSortCol(undefined);
    setSortDir("asc");
    setFilters([]);
    setPendingUpdates({});
    setPendingDeletes({});
    setPendingInserts([]);
    setEditingCell(null);
    setMobileDetailRow(null);
    if (activeTable?.columns[0]) {
      setDraftFilterCol(activeTable.columns[0].name);
    }
  }, [activeTable?.name]);

  const rowsQuery = useQuery({
    queryKey: ["tableRows", dbId, activeTable?.name, limit, offset, sortCol, sortDir, filters],
    queryFn: () =>
      api.getTableRows(dbId, activeTable!.name, {
        limit,
        offset,
        sort: sortCol,
        dir: sortDir,
        filters,
      }),
    enabled: !!activeTable,
  });

  const flashToast = (msg: string) => {
    setToast(msg);
    setTimeout(() => setToast(null), 1800);
  };

  if (!activeTable) {
    return (
      <section className="panel empty-state">
        <p>No tables found in this database.</p>
        <p className="muted small">Create a table in the SQL tab to start browsing and editing data.</p>
        {onOpenSqlTab && (
          <button type="button" className="btn primary" onClick={onOpenSqlTab}>
            Open SQL Console
          </button>
        )}
      </section>
    );
  }

  const data = rowsQuery.data;
  const columns: ColumnInfo[] = data?.columns ?? activeTable.columns;
  const pkCols: string[] = data?.primaryKey ?? activeTable.primaryKey;
  const isEditable = activeTable.type === "table" && pkCols.length > 0;

  const getRowPkObject = (row: Record<string, SqlValue>): Record<string, SqlValue> => {
    const pk: Record<string, SqlValue> = {};
    for (const k of pkCols) {
      pk[k] = row[k] ?? null;
    }
    return pk;
  };

  const getRowKey = (row: Record<string, SqlValue>, idx: number): string => {
    if (pkCols.length === 0) return `idx:${idx}`;
    return pkCols.map((k) => `${k}=${String(row[k] ?? "NULL")}`).join("|");
  };

  const commitInlineEdit = (row: Record<string, SqlValue>, rowKey: string, col: ColumnInfo, rawDraft: string) => {
    setEditingCell(null);
    const coerced = coerceEditedValue(rawDraft, col.type);
    const original = row[col.name] ?? null;

    setPendingUpdates((prev) => {
      const existing = prev[rowKey] ?? { pk: getRowPkObject(row), values: {} };
      const nextValues = { ...existing.values };
      if (coerced === original) {
        delete nextValues[col.name];
      } else {
        nextValues[col.name] = coerced;
      }
      const copy = { ...prev };
      if (Object.keys(nextValues).length === 0) {
        delete copy[rowKey];
      } else {
        copy[rowKey] = { pk: existing.pk, values: nextValues };
      }
      return copy;
    });
  };

  const toggleDeleteRow = (row: Record<string, SqlValue>, rowKey: string) => {
    setPendingDeletes((prev) => {
      const copy = { ...prev };
      if (copy[rowKey]) {
        delete copy[rowKey];
      } else {
        copy[rowKey] = getRowPkObject(row);
      }
      return copy;
    });
  };

  const handleSortHeader = (colName: string) => {
    if (sortCol !== colName) {
      setSortCol(colName);
      setSortDir("asc");
    } else if (sortDir === "asc") {
      setSortDir("desc");
    } else {
      setSortCol(undefined);
      setSortDir("asc");
    }
    setOffset(0);
  };

  const handleAddFilter = (e: React.FormEvent) => {
    e.preventDefault();
    const col = draftFilterCol || columns[0]?.name;
    if (!col) return;
    const opMeta = FILTER_OPS.find((o) => o.value === draftFilterOp)!;
    let value: SqlValue | SqlValue[] | undefined = undefined;
    if (opMeta.needsValue) {
      if (draftFilterOp === "in") {
        value = draftFilterVal
          .split(",")
          .map((s) => s.trim())
          .filter(Boolean);
      } else {
        const colMeta = columns.find((c) => c.name === col);
        value = coerceEditedValue(draftFilterVal, colMeta?.type ?? "TEXT");
      }
    }
    setFilters((prev) => [...prev, { col, op: draftFilterOp, ...(value !== undefined ? { value } : {}) }]);
    setDraftFilterVal("");
    setOffset(0);
  };

  const handleStageNewRow = (e: React.FormEvent) => {
    e.preventDefault();
    const rowObj: Record<string, SqlValue> = {};
    for (const c of columns) {
      const raw = newRowDraft[c.name];
      if (raw !== undefined && raw !== "") {
        rowObj[c.name] = coerceEditedValue(raw, c.type);
      }
    }
    setPendingInserts((prev) => [...prev, rowObj]);
    setNewRowDraft({});
    setShowAddRowModal(false);
  };

  const pendingCount =
    Object.keys(pendingUpdates).length + Object.keys(pendingDeletes).length + pendingInserts.length;

  // Plain computation, not useMemo: this runs after the early return above,
  // and a hook here changes the hook count between renders (React #310).
  const generatedSqlPreview = (() => {
    const lines: string[] = [];
    const qTbl = quoteIdent(activeTable.name);
    for (const ins of pendingInserts) {
      const keys = Object.keys(ins);
      if (keys.length === 0) {
        lines.push(`INSERT INTO ${qTbl} DEFAULT VALUES;`);
      } else {
        lines.push(
          `INSERT INTO ${qTbl} (${keys.map(quoteIdent).join(", ")}) VALUES (${keys.map((k) => sqlLiteral(ins[k] ?? null)).join(", ")});`,
        );
      }
    }
    for (const u of Object.values(pendingUpdates)) {
      const setPart = Object.entries(u.values)
        .map(([k, v]) => `${quoteIdent(k)} = ${sqlLiteral(v)}`)
        .join(", ");
      const wherePart = Object.entries(u.pk)
        .map(([k, v]) => (v === null ? `${quoteIdent(k)} IS NULL` : `${quoteIdent(k)} = ${sqlLiteral(v)}`))
        .join(" AND ");
      lines.push(`UPDATE ${qTbl} SET ${setPart} WHERE ${wherePart};`);
    }
    for (const pk of Object.values(pendingDeletes)) {
      const wherePart = Object.entries(pk)
        .map(([k, v]) => (v === null ? `${quoteIdent(k)} IS NULL` : `${quoteIdent(k)} = ${sqlLiteral(v)}`))
        .join(" AND ");
      lines.push(`DELETE FROM ${qTbl} WHERE ${wherePart};`);
    }
    return lines.join("\n");
  })();

  const applyPendingChanges = async () => {
    setApplying(true);
    setActionError(null);
    try {
      if (pendingInserts.length > 0) {
        await api.insertTableRows(dbId, activeTable.name, { rows: pendingInserts });
      }
      const updatesArr = Object.values(pendingUpdates);
      if (updatesArr.length > 0) {
        await api.updateTableRows(dbId, activeTable.name, { updates: updatesArr });
      }
      const deletesArr = Object.values(pendingDeletes);
      if (deletesArr.length > 0) {
        await api.deleteTableRows(dbId, activeTable.name, { pks: deletesArr });
      }
      setPendingInserts([]);
      setPendingUpdates({});
      setPendingDeletes({});
      setShowReviewModal(false);
      await queryClient.invalidateQueries({ queryKey: ["tableRows", dbId, activeTable.name] });
      await queryClient.invalidateQueries({ queryKey: ["schema", dbId] });
      flashToast("Changes applied");
    } catch (err) {
      setActionError(err instanceof ApiError ? err.message : (err as Error).message);
    } finally {
      setApplying(false);
    }
  };

  const exportTableCsv = () => {
    const rows = data?.rows ?? [];
    const header = columns.map((c) => toCsvCell(c.name)).join(",");
    const body = rows.map((r) => columns.map((c) => toCsvCell(r[c.name] ?? null)).join(",")).join("\n");
    const blob = new Blob([`${header}\n${body}`], { type: "text/csv;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `${activeTable.name}.csv`;
    a.click();
    URL.revokeObjectURL(url);
    flashToast("Exported CSV");
  };

  const copyRowAsJson = (row: Record<string, SqlValue>) => {
    void navigator.clipboard?.writeText(JSON.stringify(row, null, 2));
    flashToast("Copied row JSON");
  };

  return (
    <div className="data-grid-layout">
      {/* Table switcher bar + top actions */}
      <div className="data-toolbar">
        <div className="data-toolbar-left">
          <label className="table-select-label">
            <span className="muted small">Table</span>
            <select
              value={activeTable.name}
              onChange={(e) => onSelectTable(e.target.value)}
              aria-label="Select table or view"
            >
              {tables.map((t) => (
                <option key={t.name} value={t.name}>
                  {t.name} ({t.type === "view" ? "view" : `${t.rowCountEstimate ?? 0} rows`})
                </option>
              ))}
            </select>
          </label>

          {isEditable && (
            <button
              type="button"
              className="btn ghost small"
              onClick={() => {
                setNewRowDraft({});
                setShowAddRowModal(true);
              }}
            >
              + Add Row
            </button>
          )}

          <button type="button" className="btn ghost small" onClick={exportTableCsv}>
            Export CSV
          </button>
          <button
            type="button"
            className="btn ghost small"
            onClick={() => void rowsQuery.refetch()}
          >
            Refresh
          </button>
        </div>

        <div className="data-toolbar-right">
          {toast && <span className="copied-pill">{toast}</span>}
          {pendingCount > 0 && (
            <div className="pending-changes-bar">
              <span className="badge-warn">{pendingCount} staged change{pendingCount === 1 ? "" : "s"}</span>
              <button
                type="button"
                className="btn ghost small"
                onClick={() => {
                  setPendingInserts([]);
                  setPendingUpdates({});
                  setPendingDeletes({});
                }}
              >
                Discard
              </button>
              <button
                type="button"
                className="btn primary small"
                onClick={() => setShowReviewModal(true)}
              >
                Review &amp; Apply
              </button>
            </div>
          )}
        </div>
      </div>

      {/* Filter Bar */}
      <div className="filter-bar">
        <form className="filter-composer" onSubmit={handleAddFilter}>
          <select
            value={draftFilterCol || columns[0]?.name || ""}
            onChange={(e) => setDraftFilterCol(e.target.value)}
            aria-label="Filter column"
          >
            {columns.map((c) => (
              <option key={c.name} value={c.name}>
                {c.name}
              </option>
            ))}
          </select>
          <select
            value={draftFilterOp}
            onChange={(e) => setDraftFilterOp(e.target.value as FilterOp)}
            aria-label="Filter operator"
          >
            {FILTER_OPS.map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </select>
          {FILTER_OPS.find((o) => o.value === draftFilterOp)?.needsValue && (
            <input
              type="text"
              placeholder={draftFilterOp === "in" ? "val1, val2" : "Value…"}
              value={draftFilterVal}
              onChange={(e) => setDraftFilterVal(e.target.value)}
              className="input-compact"
            />
          )}
          <button type="submit" className="btn ghost small">
            + Filter
          </button>
        </form>

        {filters.length > 0 && (
          <div className="filter-chips">
            {filters.map((f, idx) => (
              <span key={idx} className="filter-chip">
                <code>
                  {f.col} {f.op} {f.value !== undefined ? JSON.stringify(f.value) : ""}
                </code>
                <button
                  type="button"
                  onClick={() => setFilters((prev) => prev.filter((_, i) => i !== idx))}
                  aria-label="Remove filter"
                >
                  ×
                </button>
              </span>
            ))}
            <button
              type="button"
              className="btn ghost small"
              onClick={() => setFilters([])}
            >
              Clear all
            </button>
          </div>
        )}
      </div>

      {actionError && (
        <div className="error-banner" role="alert">
          <span>{actionError}</span>
          <button type="button" className="btn ghost small" onClick={() => setActionError(null)}>
            Dismiss
          </button>
        </div>
      )}

      {rowsQuery.isLoading ? (
        <section className="panel">
          <div className="skeleton-line" style={{ width: "40%", height: "20px", marginBottom: "12px" }} />
          <div className="skeleton-line" style={{ width: "100%", height: "36px", marginBottom: "8px" }} />
          <div className="skeleton-line" style={{ width: "100%", height: "36px", marginBottom: "8px" }} />
          <div className="skeleton-line" style={{ width: "100%", height: "36px" }} />
        </section>
      ) : rowsQuery.isError ? (
        <div className="error-banner" role="alert">
          <span>{(rowsQuery.error as Error).message}</span>
        </div>
      ) : (
        <>
          {/* Desktop / Tablet Virtualized Grid (>= 600px) */}
          <div className="desktop-data-grid">
            <DesktopVirtualDataGrid
              columns={columns}
              rows={data?.rows ?? []}
              isEditable={isEditable}
              sortCol={sortCol}
              sortDir={sortDir}
              onSort={handleSortHeader}
              getRowKey={getRowKey}
              editingCell={editingCell}
              setEditingCell={setEditingCell}
              onCommitEdit={commitInlineEdit}
              pendingUpdates={pendingUpdates}
              pendingDeletes={pendingDeletes}
              onToggleDelete={toggleDeleteRow}
              onCopyRowJson={copyRowAsJson}
              onFlashToast={flashToast}
            />
          </div>

          {/* Mobile Row Cards (< 600px) */}
          <div className="mobile-row-cards">
            {(data?.rows ?? []).length === 0 ? (
              <section className="panel empty-state compact">
                <p className="muted">No rows match the current query.</p>
              </section>
            ) : (
              (data?.rows ?? []).map((row, idx) => {
                const rowKey = getRowKey(row, idx);
                const isDeleted = !!pendingDeletes[rowKey];
                const updated = pendingUpdates[rowKey]?.values ?? {};
                const previewCols = columns.slice(0, 4);
                return (
                  <article
                    key={rowKey}
                    className={`mobile-row-card ${isDeleted ? "row-staged-delete" : ""}`}
                    onClick={() => setMobileDetailRow({ rowKey, row })}
                  >
                    <div className="mobile-row-card-head">
                      <code className="pk-pill">
                        {pkCols.length > 0
                          ? pkCols.map((k) => `${k}: ${String(row[k] ?? "NULL")}`).join(", ")
                          : `Row #${offset + idx + 1}`}
                      </code>
                      <span className="muted small">Tap to inspect / edit →</span>
                    </div>
                    <dl className="mobile-row-dl">
                      {previewCols.map((c) => {
                        const val = c.name in updated ? updated[c.name] : row[c.name];
                        const isDirty = c.name in updated;
                        return (
                          <div key={c.name} className="mobile-row-kv">
                            <dt>{c.name}</dt>
                            <dd className={isDirty ? "cell-dirty" : val === null ? "cell-null" : ""}>
                              {val === null ? <span className="null-badge">NULL</span> : String(val)}
                            </dd>
                          </div>
                        );
                      })}
                    </dl>
                  </article>
                );
              })
            )}
          </div>

          {/* Pagination Footer */}
          <div className="pagination-bar">
            <div className="pagination-meta muted small">
              Showing{" "}
              <strong>
                {(data?.rows.length ?? 0) === 0 ? 0 : offset + 1}–{offset + (data?.rows.length ?? 0)}
              </strong>
              {data?.total !== null && data?.total !== undefined && (
                <>
                  {" "}of <strong>{data.total.toLocaleString()}</strong>
                </>
              )}{" "}
              rows · {data?.durationMs ?? 0} ms
              {isEditable && <span className="hide-mobile"> · Double-click any cell to edit</span>}
            </div>
            <div className="pagination-controls">
              <select
                value={limit}
                onChange={(e) => {
                  setLimit(Number(e.target.value));
                  setOffset(0);
                }}
                aria-label="Rows per page"
              >
                <option value={50}>50 / page</option>
                <option value={100}>100 / page</option>
                <option value={250}>250 / page</option>
                <option value={500}>500 / page</option>
              </select>
              <button
                type="button"
                className="btn ghost small"
                disabled={offset === 0}
                onClick={() => setOffset(Math.max(0, offset - limit))}
              >
                ← Prev
              </button>
              <button
                type="button"
                className="btn ghost small"
                disabled={!data?.hasMore}
                onClick={() => setOffset(offset + limit)}
              >
                Next →
              </button>
            </div>
          </div>
        </>
      )}

      {/* Mobile Full-Record Sheet */}
      {mobileDetailRow && (
        <Modal
          ariaLabel="Record details"
          onClose={() => setMobileDetailRow(null)}
        >
          <div className="panel-head">
            <h2>Record Detail</h2>
            <button
              type="button"
              className="btn ghost small"
              onClick={() => copyRowAsJson(mobileDetailRow.row)}
            >
              Copy JSON
            </button>
          </div>
          <div className="record-sheet-fields">
            {columns.map((c) => {
              const rowKey = mobileDetailRow.rowKey;
              const currentVal =
                pendingUpdates[rowKey]?.values && c.name in pendingUpdates[rowKey]!.values
                  ? pendingUpdates[rowKey]!.values[c.name]
                  : mobileDetailRow.row[c.name];
              return (
                <label key={c.name} className="field">
                  <span>
                    <code>{c.name}</code> <span className="muted small">({c.type || "ANY"})</span>
                    {c.pk > 0 && <span className="pk-badge" style={{ marginLeft: "6px" }}>PK</span>}
                  </span>
                  <input
                    type="text"
                    disabled={!isEditable}
                    value={currentVal === null || currentVal === undefined ? "NULL" : String(currentVal)}
                    onChange={(e) =>
                      commitInlineEdit(mobileDetailRow.row, rowKey, c, e.target.value)
                    }
                  />
                </label>
              );
            })}
          </div>
          <div className="modal-actions">
            {isEditable && (
              <button
                type="button"
                className="btn danger"
                onClick={() => {
                  toggleDeleteRow(mobileDetailRow.row, mobileDetailRow.rowKey);
                  setMobileDetailRow(null);
                }}
              >
                {pendingDeletes[mobileDetailRow.rowKey] ? "Unstage Delete" : "Stage Delete"}
              </button>
            )}
            <button type="button" className="btn primary" onClick={() => setMobileDetailRow(null)}>
              Done
            </button>
          </div>
        </Modal>
      )}

      {/* Add Row Modal */}
      {showAddRowModal && (
        <Modal ariaLabel="Insert new row" onClose={() => setShowAddRowModal(false)}>
          <h2>Add Row to {activeTable.name}</h2>
          <form onSubmit={handleStageNewRow} className="record-sheet-fields">
            {columns.map((c) => (
              <label key={c.name} className="field">
                <span>
                  <code>{c.name}</code>{" "}
                  <span className="muted small">
                    ({c.type || "ANY"}
                    {c.pk > 0 ? ", PK" : ""}
                    {c.defaultValue !== null ? `, default ${c.defaultValue}` : ""})
                  </span>
                </span>
                <input
                  type="text"
                  placeholder={c.defaultValue !== null ? `Default: ${c.defaultValue}` : c.notnull ? "Required" : "Leave blank for NULL/default"}
                  value={newRowDraft[c.name] ?? ""}
                  onChange={(e) =>
                    setNewRowDraft((prev) => ({ ...prev, [c.name]: e.target.value }))
                  }
                />
              </label>
            ))}
            <div className="modal-actions">
              <button type="button" className="btn ghost" onClick={() => setShowAddRowModal(false)}>
                Cancel
              </button>
              <button type="submit" className="btn primary">
                Stage Row
              </button>
            </div>
          </form>
        </Modal>
      )}

      {/* Pending Changes SQL Review Modal */}
      {showReviewModal && (
        <Modal ariaLabel="Review pending SQL changes" onClose={() => setShowReviewModal(false)}>
          <h2>Review &amp; Apply Changes</h2>
          <p className="muted small">
            The following {pendingCount} change{pendingCount === 1 ? "" : "s"} will be executed inside a single atomic SQLite transaction:
          </p>
          <pre className="code-block" style={{ maxHeight: "260px", overflowY: "auto" }}>
            {generatedSqlPreview}
          </pre>
          {actionError && <p className="error-text">{actionError}</p>}
          <div className="modal-actions">
            <button
              type="button"
              className="btn ghost"
              onClick={() => setShowReviewModal(false)}
              disabled={applying}
            >
              Cancel
            </button>
            <button
              type="button"
              className="btn primary"
              onClick={() => void applyPendingChanges()}
              disabled={applying}
            >
              {applying ? "Applying…" : "Commit Transaction"}
            </button>
          </div>
        </Modal>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Virtualized Desktop Data Grid (@tanstack/react-table + @tanstack/react-virtual)
// ---------------------------------------------------------------------------

const colHelper = createColumnHelper<Record<string, SqlValue>>();

function DesktopVirtualDataGrid({
  columns,
  rows,
  isEditable,
  sortCol,
  sortDir,
  onSort,
  getRowKey,
  editingCell,
  setEditingCell,
  onCommitEdit,
  pendingUpdates,
  pendingDeletes,
  onToggleDelete,
  onCopyRowJson,
  onFlashToast,
}: {
  columns: ColumnInfo[];
  rows: Record<string, SqlValue>[];
  isEditable: boolean;
  sortCol?: string;
  sortDir: "asc" | "desc";
  onSort: (col: string) => void;
  getRowKey: (row: Record<string, SqlValue>, idx: number) => string;
  editingCell: { rowKey: string; col: string; draft: string } | null;
  setEditingCell: (val: { rowKey: string; col: string; draft: string } | null) => void;
  onCommitEdit: (row: Record<string, SqlValue>, rowKey: string, col: ColumnInfo, draft: string) => void;
  pendingUpdates: Record<string, { pk: Record<string, SqlValue>; values: Record<string, SqlValue> }>;
  pendingDeletes: Record<string, Record<string, SqlValue>>;
  onToggleDelete: (row: Record<string, SqlValue>, rowKey: string) => void;
  onCopyRowJson: (row: Record<string, SqlValue>) => void;
  onFlashToast: (msg: string) => void;
}) {
  const parentRef = useRef<HTMLDivElement | null>(null);

  const tableColumns = useMemo(
    () =>
      columns.map((c) =>
        colHelper.accessor((row) => row[c.name] ?? null, {
          id: c.name,
          header: () => c.name,
        }),
      ),
    [columns],
  );

  const table = useReactTable({
    data: rows,
    columns: tableColumns,
    getCoreRowModel: getCoreRowModel(),
  });

  const tableRows = table.getRowModel().rows;

  const rowVirtualizer = useVirtualizer({
    count: tableRows.length,
    getScrollElement: () => parentRef.current,
    estimateSize: () => 38,
    overscan: 14,
  });

  if (rows.length === 0) {
    return (
      <section className="panel empty-state compact">
        <p className="muted">No rows in this result page.</p>
      </section>
    );
  }

  const virtualRows = rowVirtualizer.getVirtualItems();
  const totalHeight = rowVirtualizer.getTotalSize();

  return (
    <div ref={parentRef} className="virtual-table-container" style={{ maxHeight: "540px" }}>
      <table className="data-grid-table">
        <thead>
          {table.getHeaderGroups().map((hg) => (
            <tr key={hg.id}>
              {hg.headers.map((header) => {
                const colMeta = columns.find((c) => c.name === header.id);
                const isSorted = sortCol === header.id;
                return (
                  <th
                    key={header.id}
                    onClick={() => onSort(header.id)}
                    className="sortable-th"
                    title="Click to sort"
                  >
                    <div className="th-inner">
                      <span>{flexRender(header.column.columnDef.header, header.getContext())}</span>
                      {colMeta && colMeta.pk > 0 && <span className="pk-badge">PK</span>}
                      {colMeta?.type && <span className="type-hint">{colMeta.type}</span>}
                      {isSorted && <span className="sort-arrow">{sortDir === "asc" ? "▲" : "▼"}</span>}
                    </div>
                  </th>
                );
              })}
              <th className="actions-th">Actions</th>
            </tr>
          ))}
        </thead>
        <tbody style={{ height: `${totalHeight}px`, position: "relative" }}>
          {virtualRows.map((vr) => {
            const tr = tableRows[vr.index]!;
            const rawRow = tr.original;
            const rowKey = getRowKey(rawRow, vr.index);
            const isDeleted = !!pendingDeletes[rowKey];
            const rowUpdates = pendingUpdates[rowKey]?.values ?? {};

            return (
              <tr
                key={rowKey}
                className={`data-grid-tr ${isDeleted ? "row-staged-delete" : ""}`}
                style={{
                  position: "absolute",
                  top: 0,
                  left: 0,
                  width: "100%",
                  height: `${vr.size}px`,
                  transform: `translateY(${vr.start}px)`,
                  display: "table",
                  tableLayout: "fixed",
                }}
              >
                {columns.map((c) => {
                  const isDirty = c.name in rowUpdates;
                  const val = isDirty ? rowUpdates[c.name] : rawRow[c.name];
                  const isEditing =
                    editingCell?.rowKey === rowKey && editingCell?.col === c.name;

                  return (
                    <td
                      key={c.name}
                      className={`data-grid-td ${isDirty ? "cell-dirty" : ""} ${val === null ? "cell-null" : ""}`}
                      onDoubleClick={() => {
                        if (!isEditable) {
                          void navigator.clipboard?.writeText(val === null ? "NULL" : String(val));
                          onFlashToast("Copied cell");
                          return;
                        }
                        setEditingCell({
                          rowKey,
                          col: c.name,
                          draft: val === null || val === undefined ? "NULL" : String(val),
                        });
                      }}
                    >
                      {isEditing ? (
                        <input
                          type="text"
                          autoFocus
                          className="inline-cell-input"
                          value={editingCell.draft}
                          onChange={(e) =>
                            setEditingCell({ ...editingCell, draft: e.target.value })
                          }
                          onBlur={() => onCommitEdit(rawRow, rowKey, c, editingCell.draft)}
                          onKeyDown={(e) => {
                            if (e.key === "Enter") {
                              onCommitEdit(rawRow, rowKey, c, editingCell.draft);
                            } else if (e.key === "Escape") {
                              setEditingCell(null);
                            }
                          }}
                        />
                      ) : val === null || val === undefined ? (
                        <span className="null-badge">NULL</span>
                      ) : (
                        <span className="cell-text" title={String(val)}>
                          {String(val)}
                        </span>
                      )}
                    </td>
                  );
                })}
                <td className="actions-td">
                  <button
                    type="button"
                    className="btn ghost small"
                    onClick={() => onCopyRowJson(rawRow)}
                    title="Copy row as JSON"
                  >
                    JSON
                  </button>
                  {isEditable && (
                    <button
                      type="button"
                      className="btn ghost small"
                      onClick={() => onToggleDelete(rawRow, rowKey)}
                      title={isDeleted ? "Undo delete" : "Stage row deletion"}
                    >
                      {isDeleted ? "Undo" : "Del"}
                    </button>
                  )}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
