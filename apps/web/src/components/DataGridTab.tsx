import { useCallback, useMemo, useRef, useState, type FormEvent } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Button, Card, Chip, Input, Label, Modal as HeroModal, TextField } from "@heroui/react";
import type { ColumnInfo, FilterOp, SqlValue, TableFilter, TableSchemaItem } from "@sqlitend/shared";
import { api } from "../api/client";
import { copyText, downloadCsv, toCsv } from "../csv";
import { buildPreviewSql, cellText, coerceEditedValue, type PendingUpdate, type RowRecord } from "../data-sql";
import { useMediaQuery } from "../hooks/useMediaQuery";
import { DataGridTable, type EditingCell, type SelectedCell } from "./DataGridTable";
import { ErrorAlert } from "./ErrorAlert";
import { Modal } from "./Modal";
import { RowCards } from "./RowCards";
import { SimpleSelect } from "./SimpleSelect";

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
const PAGE_SIZES = [50, 100, 250, 500].map((n) => ({ id: String(n), label: `${n} / page` }));
const PHONE_QUERY = "(max-width: 599px)";

/**
 * Entry point. Every hook here runs before the empty-state return, and everything stateful lives in
 * TableView, which is keyed by table name: switching tables remounts it (fresh page, sort, filters
 * and staged edits) and no hook can ever sit after an early return (React #310).
 */
export function DataGridTab({ dbId, tables, selectedTable, onSelectTable, onOpenSqlTab }: Props) {
  const activeTable = useMemo(
    () => tables.find((t) => t.name === selectedTable) ?? tables[0] ?? null,
    [tables, selectedTable],
  );

  if (!activeTable) {
    return (
      <Card className="items-center gap-2 p-6 text-center">
        <p className="m-0 font-medium">No tables found in this database.</p>
        <p className="m-0 text-sm text-muted">Create a table in the SQL tab to start browsing and editing data.</p>
        {onOpenSqlTab && (
          <Button variant="primary" className="mt-2 min-h-11" onPress={onOpenSqlTab}>
            Open SQL Console
          </Button>
        )}
      </Card>
    );
  }
  return <TableView key={activeTable.name} dbId={dbId} table={activeTable} tables={tables} onSelectTable={onSelectTable} />;
}

function TableView({
  dbId,
  table,
  tables,
  onSelectTable,
}: {
  dbId: string;
  table: TableSchemaItem;
  tables: TableSchemaItem[];
  onSelectTable: (name: string) => void;
}) {
  const queryClient = useQueryClient();
  const isPhone = useMediaQuery(PHONE_QUERY);

  const [limit, setLimit] = useState(100);
  const [offset, setOffset] = useState(0);
  const [sortCol, setSortCol] = useState<string | undefined>(undefined);
  const [sortDir, setSortDir] = useState<"asc" | "desc">("asc");
  const [filters, setFilters] = useState<TableFilter[]>([]);

  const [draftCol, setDraftCol] = useState<string>(table.columns[0]?.name ?? "");
  const [draftOp, setDraftOp] = useState<FilterOp>("=");
  const [draftVal, setDraftVal] = useState("");

  const [editingCell, setEditingCell] = useState<EditingCell | null>(null);
  const [selectedCell, setSelectedCell] = useState<(SelectedCell & { value: SqlValue }) | null>(null);
  const [pendingUpdates, setPendingUpdates] = useState<Record<string, PendingUpdate>>({});
  const [pendingDeletes, setPendingDeletes] = useState<Record<string, RowRecord>>({});
  const [pendingInserts, setPendingInserts] = useState<RowRecord[]>([]);

  const [showReview, setShowReview] = useState(false);
  const [showAddRow, setShowAddRow] = useState(false);
  const [newRowDraft, setNewRowDraft] = useState<Record<string, string>>({});
  const [detail, setDetail] = useState<{ rowKey: string; row: RowRecord } | null>(null);
  const [applying, setApplying] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const [toast, setToast] = useState<string | null>(null);
  const toastTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const rowsQuery = useQuery({
    queryKey: ["tableRows", dbId, table.name, limit, offset, sortCol, sortDir, filters],
    queryFn: () => api.getTableRows(dbId, table.name, { limit, offset, sort: sortCol, dir: sortDir, filters }),
  });

  const flashToast = useCallback((msg: string) => {
    setToast(msg);
    if (toastTimer.current) clearTimeout(toastTimer.current);
    toastTimer.current = setTimeout(() => setToast(null), 1800);
  }, []);

  const data = rowsQuery.data;
  const columns: ColumnInfo[] = data?.columns ?? table.columns;
  const pkCols: string[] = data?.primaryKey ?? table.primaryKey;
  const rows = data?.rows ?? [];
  const isEditable = table.type === "table" && pkCols.length > 0;

  const getRowPk = (row: RowRecord): RowRecord => Object.fromEntries(pkCols.map((k) => [k, row[k] ?? null]));
  const getRowKey = (row: RowRecord, idx: number): string =>
    pkCols.length === 0 ? `idx:${offset + idx}` : pkCols.map((k) => `${k}=${String(row[k] ?? "NULL")}`).join("|");

  const commitEdit = (row: RowRecord, rowKey: string, col: ColumnInfo, rawDraft: string) => {
    setEditingCell(null);
    const coerced = coerceEditedValue(rawDraft, col.type);
    const original = row[col.name] ?? null;
    setPendingUpdates((prev) => {
      const existing = prev[rowKey] ?? { pk: getRowPk(row), values: {} };
      const values = { ...existing.values };
      if (coerced === original) delete values[col.name];
      else values[col.name] = coerced;
      const next = { ...prev };
      if (Object.keys(values).length === 0) delete next[rowKey];
      else next[rowKey] = { pk: existing.pk, values };
      return next;
    });
  };

  const toggleDelete = (row: RowRecord, rowKey: string) =>
    setPendingDeletes((prev) => {
      const next = { ...prev };
      if (next[rowKey]) delete next[rowKey];
      else next[rowKey] = getRowPk(row);
      return next;
    });

  const handleSort = (col: string) => {
    if (sortCol !== col) {
      setSortCol(col);
      setSortDir("asc");
    } else if (sortDir === "asc") {
      setSortDir("desc");
    } else {
      setSortCol(undefined);
      setSortDir("asc");
    }
    setOffset(0);
  };

  const addFilter = (e: FormEvent) => {
    e.preventDefault();
    const col = draftCol || columns[0]?.name;
    if (!col) return;
    let value: SqlValue | SqlValue[] | undefined;
    if (FILTER_OPS.find((o) => o.value === draftOp)!.needsValue) {
      value =
        draftOp === "in"
          ? draftVal.split(",").map((s) => s.trim()).filter(Boolean)
          : coerceEditedValue(draftVal, columns.find((c) => c.name === col)?.type ?? "TEXT");
    }
    setFilters((prev) => [...prev, { col, op: draftOp, ...(value !== undefined ? { value } : {}) }]);
    setDraftVal("");
    setOffset(0);
  };

  const stageNewRow = (e: FormEvent) => {
    e.preventDefault();
    const row: RowRecord = {};
    for (const c of columns) {
      const raw = newRowDraft[c.name];
      if (raw !== undefined && raw !== "") row[c.name] = coerceEditedValue(raw, c.type);
    }
    setPendingInserts((prev) => [...prev, row]);
    setNewRowDraft({});
    setShowAddRow(false);
  };

  const pendingCount = Object.keys(pendingUpdates).length + Object.keys(pendingDeletes).length + pendingInserts.length;
  const previewSql = buildPreviewSql(
    table.name,
    pendingInserts,
    Object.values(pendingUpdates),
    Object.values(pendingDeletes),
  );
  const discardAll = () => {
    setPendingInserts([]);
    setPendingUpdates({});
    setPendingDeletes({});
  };

  const applyChanges = async () => {
    setApplying(true);
    setActionError(null);
    try {
      const updates = Object.values(pendingUpdates);
      const pks = Object.values(pendingDeletes);
      if (pendingInserts.length > 0) await api.insertTableRows(dbId, table.name, { rows: pendingInserts });
      if (updates.length > 0) await api.updateTableRows(dbId, table.name, { updates });
      if (pks.length > 0) await api.deleteTableRows(dbId, table.name, { pks });
      discardAll();
      setShowReview(false);
      await queryClient.invalidateQueries({ queryKey: ["tableRows", dbId, table.name] });
      await queryClient.invalidateQueries({ queryKey: ["schema", dbId] });
      flashToast("Changes applied");
    } catch (err) {
      setActionError(err instanceof Error ? err.message : "Could not apply the changes");
    } finally {
      setApplying(false);
    }
  };

  const copy = async (text: string, what: string) => {
    flashToast((await copyText(text)) ? `Copied ${what}` : "Clipboard unavailable");
  };
  const rowAsCsv = (row: RowRecord) =>
    toCsv(columns.map((c) => c.name), [columns.map((c) => row[c.name] ?? null)]);

  return (
    <div className="flex min-w-0 flex-col gap-3">
      <div className="flex flex-wrap items-end gap-2">
        <SimpleSelect
          label="Table"
          value={table.name}
          onChange={onSelectTable}
          options={tables.map((t) => ({
            id: t.name,
            label: `${t.name} (${t.type === "view" ? "view" : `${t.rowCountEstimate ?? 0} rows`})`,
          }))}
          className="w-full sm:w-72"
        />
        {isEditable && (
          <Button
            variant="secondary"
            className="min-h-11"
            onPress={() => {
              setNewRowDraft({});
              setShowAddRow(true);
            }}
          >
            Add row
          </Button>
        )}
        <Button
          variant="secondary"
          className="min-h-11"
          onPress={() => {
            downloadCsv(
              `${table.name}.csv`,
              toCsv(columns.map((c) => c.name), rows.map((r) => columns.map((c) => r[c.name] ?? null))),
            );
            flashToast("Exported CSV");
          }}
        >
          Export CSV
        </Button>
        <Button variant="ghost" className="min-h-11" onPress={() => void rowsQuery.refetch()}>
          Refresh
        </Button>
        {toast && (
          <Chip color="success" variant="soft" role="status">
            {toast}
          </Chip>
        )}
      </div>

      <form onSubmit={addFilter} className="flex flex-wrap items-end gap-2" aria-label="Add filter">
        <SimpleSelect
          label="Filter column"
          hideLabel
          value={draftCol || columns[0]?.name || ""}
          onChange={setDraftCol}
          options={columns.map((c) => ({ id: c.name, label: c.name }))}
          className="w-40"
        />
        <SimpleSelect
          label="Filter operator"
          hideLabel
          value={draftOp}
          onChange={(v) => setDraftOp(v as FilterOp)}
          options={FILTER_OPS.map((o) => ({ id: o.value, label: o.label }))}
          className="w-36"
        />
        {FILTER_OPS.find((o) => o.value === draftOp)?.needsValue && (
          <TextField aria-label="Filter value" value={draftVal} onChange={setDraftVal} className="min-w-0 flex-1 basis-40">
            <Input placeholder={draftOp === "in" ? "val1, val2" : "Value"} className="min-h-11" />
          </TextField>
        )}
        <Button type="submit" variant="secondary" className="min-h-11">
          Add filter
        </Button>
      </form>

      {filters.length > 0 && (
        <div className="flex flex-wrap items-center gap-2" aria-label="Active filters" role="group">
          {filters.map((f, i) => (
            <Chip key={i} variant="soft" color="accent" className="gap-1">
              <code>
                {f.col} {f.op} {f.value !== undefined ? JSON.stringify(f.value) : ""}
              </code>
              <button
                type="button"
                className="min-h-6 min-w-6 rounded-full px-1 leading-none"
                aria-label={`Remove filter ${f.col} ${f.op}`}
                onClick={() => {
                  setFilters((prev) => prev.filter((_, j) => j !== i));
                  setOffset(0);
                }}
              >
                x
              </button>
            </Chip>
          ))}
          <Button size="sm" variant="ghost" onPress={() => setFilters([])}>
            Clear all
          </Button>
        </div>
      )}

      {actionError && !showReview && <ErrorAlert>{actionError}</ErrorAlert>}

      {rowsQuery.isLoading ? (
        <div className="h-48 animate-pulse rounded-xl bg-default" aria-label="Loading rows" role="status" />
      ) : rowsQuery.isError ? (
        <ErrorAlert>{(rowsQuery.error as Error).message}</ErrorAlert>
      ) : (
        <>
          {isPhone ? (
            <RowCards
              columns={columns}
              rows={rows}
              pkCols={pkCols}
              offset={offset}
              getRowKey={getRowKey}
              pendingUpdates={pendingUpdates}
              pendingDeletes={pendingDeletes}
              onOpen={(rowKey, row) => setDetail({ rowKey, row })}
            />
          ) : (
            <>
              <DataGridTable
                columns={columns}
                rows={rows}
                isEditable={isEditable}
                sortCol={sortCol}
                sortDir={sortDir}
                onSort={handleSort}
                getRowKey={getRowKey}
                editingCell={editingCell}
                setEditingCell={setEditingCell}
                onCommitEdit={commitEdit}
                selectedCell={selectedCell}
                onSelectCell={(cell, value) => setSelectedCell({ ...cell, value })}
                pendingUpdates={pendingUpdates}
                pendingDeletes={pendingDeletes}
                onToggleDelete={toggleDelete}
                onCopyRowJson={(row) => void copy(JSON.stringify(row, null, 2), "row JSON")}
                onCopyRowCsv={(row) => void copy(rowAsCsv(row), "row CSV")}
              />
              {selectedCell && (
                <div className="flex flex-wrap items-center gap-2 text-sm" aria-label="Selected cell">
                  <span className="min-w-0 max-w-full truncate text-muted">
                    Cell <code>{selectedCell.col}</code> = <code>{cellText(selectedCell.value)}</code>
                  </span>
                  <Button size="sm" variant="secondary" onPress={() => void copy(cellText(selectedCell.value), "cell")}>
                    Copy cell
                  </Button>
                  <Button
                    size="sm"
                    variant="secondary"
                    onPress={() => void copy(JSON.stringify({ [selectedCell.col]: selectedCell.value }), "cell JSON")}
                  >
                    Cell as JSON
                  </Button>
                  <Button
                    size="sm"
                    variant="secondary"
                    onPress={() => void copy(toCsv([selectedCell.col], [[selectedCell.value]]), "cell CSV")}
                  >
                    Cell as CSV
                  </Button>
                </div>
              )}
            </>
          )}

          <div className="flex flex-wrap items-center justify-between gap-2">
            <p className="m-0 text-xs text-muted">
              Showing{" "}
              <strong>
                {rows.length === 0 ? 0 : offset + 1}-{offset + rows.length}
              </strong>
              {data?.total != null && (
                <>
                  {" "}
                  of <strong>{data.total.toLocaleString()}</strong>
                </>
              )}{" "}
              rows - {data?.durationMs ?? 0} ms
              {isEditable && !isPhone && " - double-click (or long-press) a cell to edit"}
            </p>
            <div className="flex items-center gap-2">
              <SimpleSelect
                label="Rows per page"
                hideLabel
                value={String(limit)}
                onChange={(v) => {
                  setLimit(Number(v));
                  setOffset(0);
                }}
                options={PAGE_SIZES}
                className="w-36"
              />
              <Button variant="secondary" className="min-h-11" isDisabled={offset === 0} onPress={() => setOffset(Math.max(0, offset - limit))}>
                Prev
              </Button>
              <Button variant="secondary" className="min-h-11" isDisabled={!data?.hasMore} onPress={() => setOffset(offset + limit)}>
                Next
              </Button>
            </div>
          </div>
        </>
      )}

      {pendingCount > 0 && (
        <div
          role="region"
          aria-label="Staged changes"
          className="sticky bottom-[calc(4.5rem+env(safe-area-inset-bottom))] z-20 flex flex-wrap items-center justify-between gap-2 rounded-xl border border-warning bg-surface p-3 shadow-lg sm:bottom-3"
        >
          <Chip color="warning" variant="soft">
            {pendingCount} staged change{pendingCount === 1 ? "" : "s"}
          </Chip>
          <div className="flex gap-2">
            <Button variant="ghost" className="min-h-11" onPress={discardAll}>
              Discard
            </Button>
            <Button variant="primary" className="min-h-11" onPress={() => setShowReview(true)}>
              Review &amp; apply
            </Button>
          </div>
        </div>
      )}

      {detail && (
        <RecordSheet
          columns={columns}
          row={detail.row}
          pending={pendingUpdates[detail.rowKey]?.values ?? {}}
          isEditable={isEditable}
          isStagedDelete={!!pendingDeletes[detail.rowKey]}
          onClose={() => setDetail(null)}
          onCopyJson={() => void copy(JSON.stringify(detail.row, null, 2), "row JSON")}
          onToggleDelete={() => {
            toggleDelete(detail.row, detail.rowKey);
            setDetail(null);
          }}
          onSave={(edits) => {
            for (const [col, draft] of Object.entries(edits)) {
              commitEdit(detail.row, detail.rowKey, columns.find((c) => c.name === col)!, draft);
            }
            setDetail(null);
          }}
        />
      )}

      {showAddRow && (
        <Modal ariaLabel="Insert new row" onClose={() => setShowAddRow(false)}>
          <form onSubmit={stageNewRow}>
            <HeroModal.Header>
              <HeroModal.Heading>Add row to {table.name}</HeroModal.Heading>
            </HeroModal.Header>
            <HeroModal.Body className="flex flex-col gap-3 p-1">
              {columns.map((c) => (
                <TextField
                  key={c.name}
                  fullWidth
                  value={newRowDraft[c.name] ?? ""}
                  onChange={(v) => setNewRowDraft((prev) => ({ ...prev, [c.name]: v }))}
                >
                  <Label>
                    {c.name}{" "}
                    <span className="font-normal text-muted">
                      ({c.type || "ANY"}
                      {c.pk > 0 ? ", PK" : ""}
                      {c.defaultValue !== null ? `, default ${c.defaultValue}` : ""})
                    </span>
                  </Label>
                  <Input
                    className="min-h-11"
                    placeholder={c.defaultValue !== null ? `Default: ${c.defaultValue}` : c.notnull ? "Required" : "Blank for NULL/default"}
                  />
                </TextField>
              ))}
            </HeroModal.Body>
            <HeroModal.Footer>
              <Button variant="ghost" className="min-h-11" onPress={() => setShowAddRow(false)}>
                Cancel
              </Button>
              <Button type="submit" variant="primary" className="min-h-11">
                Stage row
              </Button>
            </HeroModal.Footer>
          </form>
        </Modal>
      )}

      {showReview && (
        <Modal ariaLabel="Review pending SQL changes" onClose={() => setShowReview(false)} size="lg">
          <HeroModal.Header>
            <HeroModal.Heading>Review &amp; apply changes</HeroModal.Heading>
          </HeroModal.Header>
          <HeroModal.Body className="flex flex-col gap-3 p-1">
            <p className="m-0 text-sm text-muted">
              {pendingCount} change{pendingCount === 1 ? "" : "s"} will be sent to the database: inserts, then updates, then deletes. Nothing
              is written until you commit.
            </p>
            <pre
              aria-label="Generated SQL"
              className="m-0 max-h-64 overflow-auto whitespace-pre-wrap break-words rounded-lg bg-surface-secondary p-3 font-mono text-xs"
            >
              {previewSql}
            </pre>
            {actionError && <ErrorAlert>{actionError}</ErrorAlert>}
          </HeroModal.Body>
          <HeroModal.Footer>
            <Button variant="ghost" className="min-h-11" onPress={() => setShowReview(false)} isDisabled={applying}>
              Cancel
            </Button>
            <Button variant="primary" className="min-h-11" onPress={() => void applyChanges()} isDisabled={applying}>
              {applying ? "Applying..." : "Commit changes"}
            </Button>
          </HeroModal.Footer>
        </Modal>
      )}
    </div>
  );
}

/** Phone full-record sheet: edit any column, then "Stage changes" (or stage the row for deletion). */
function RecordSheet({
  columns,
  row,
  pending,
  isEditable,
  isStagedDelete,
  onClose,
  onCopyJson,
  onToggleDelete,
  onSave,
}: {
  columns: ColumnInfo[];
  row: RowRecord;
  pending: RowRecord;
  isEditable: boolean;
  isStagedDelete: boolean;
  onClose: () => void;
  onCopyJson: () => void;
  onToggleDelete: () => void;
  onSave: (edits: Record<string, string>) => void;
}) {
  const initial = Object.fromEntries(columns.map((c) => [c.name, cellText(c.name in pending ? pending[c.name] : row[c.name])]));
  const [draft, setDraft] = useState<Record<string, string>>(initial);
  const edits = Object.fromEntries(Object.entries(draft).filter(([k, v]) => v !== initial[k]));

  return (
    <Modal ariaLabel="Record details" onClose={onClose}>
      <HeroModal.Header>
        <HeroModal.Heading>Record</HeroModal.Heading>
      </HeroModal.Header>
      <HeroModal.Body className="flex flex-col gap-3 p-1">
        {columns.map((c) => (
          <TextField key={c.name} fullWidth isDisabled={!isEditable} value={draft[c.name] ?? ""} onChange={(v) => setDraft((p) => ({ ...p, [c.name]: v }))}>
            <Label>
              {c.name}{" "}
              <span className="font-normal text-muted">
                ({c.type || "ANY"}
                {c.pk > 0 ? ", PK" : ""})
              </span>
            </Label>
            <Input className="min-h-11" />
          </TextField>
        ))}
      </HeroModal.Body>
      <HeroModal.Footer className="flex-wrap">
        <Button variant="ghost" className="min-h-11" onPress={onCopyJson}>
          Copy JSON
        </Button>
        {isEditable && (
          <Button variant="danger-soft" className="min-h-11" onPress={onToggleDelete}>
            {isStagedDelete ? "Unstage delete" : "Stage delete"}
          </Button>
        )}
        <Button variant="secondary" className="min-h-11" onPress={onClose}>
          Close
        </Button>
        {isEditable && (
          <Button variant="primary" className="min-h-11" isDisabled={Object.keys(edits).length === 0} onPress={() => onSave(edits)}>
            Stage changes
          </Button>
        )}
      </HeroModal.Footer>
    </Modal>
  );
}
