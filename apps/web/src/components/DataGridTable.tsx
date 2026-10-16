import { useMemo, useRef } from "react";
import { createColumnHelper, flexRender, getCoreRowModel, useReactTable } from "@tanstack/react-table";
import { useVirtualizer } from "@tanstack/react-virtual";
import { Button, Input, Tooltip } from "@heroui/react";
import type { ColumnInfo, SqlValue } from "@sqlitend/shared";
import { cellText, type PendingUpdate, type RowRecord } from "../data-sql";
import { useLongPress } from "../hooks/useLongPress";
import { CopyIcon, SortAscIcon, SortDescIcon, TrashIcon } from "./icons";

export interface EditingCell {
  rowKey: string;
  col: string;
  draft: string;
}
export interface SelectedCell {
  rowKey: string;
  col: string;
}

interface Props {
  columns: ColumnInfo[];
  rows: RowRecord[];
  isEditable: boolean;
  sortCol?: string;
  sortDir: "asc" | "desc";
  onSort: (col: string) => void;
  getRowKey: (row: RowRecord, idx: number) => string;
  editingCell: EditingCell | null;
  setEditingCell: (cell: EditingCell | null) => void;
  onCommitEdit: (row: RowRecord, rowKey: string, col: ColumnInfo, draft: string) => void;
  selectedCell: SelectedCell | null;
  onSelectCell: (cell: SelectedCell, value: SqlValue) => void;
  pendingUpdates: Record<string, PendingUpdate>;
  pendingDeletes: Record<string, RowRecord>;
  onToggleDelete: (row: RowRecord, rowKey: string) => void;
  onCopyRowJson: (row: RowRecord) => void;
  onCopyRowCsv: (row: RowRecord) => void;
}

const ROW_HEIGHT = 44;
const COL_MIN_PX = 150;
const ACTIONS_PX = 136;
const colHelper = createColumnHelper<RowRecord>();

interface CellProps {
  value: SqlValue;
  isDirty: boolean;
  isSelected: boolean;
  isEditing: boolean;
  draft: string;
  label: string;
  onStartEdit: () => void;
  onSelect: () => void;
  onDraft: (v: string) => void;
  onCommit: () => void;
  onCancel: () => void;
}

function GridCell({ value, isDirty, isSelected, isEditing, draft, label, onStartEdit, onSelect, onDraft, onCommit, onCancel }: CellProps) {
  const press = useLongPress(onStartEdit);
  return (
    <div
      role="cell"
      aria-label={label}
      className={`flex min-w-0 items-center border-b border-separator px-2 text-sm ${
        isDirty ? "bg-warning-soft" : ""
      } ${isSelected ? "outline outline-2 -outline-offset-2 outline-accent" : ""}`}
      onClick={onSelect}
      onDoubleClick={onStartEdit}
      {...press}
    >
      {isEditing ? (
        <Input
          autoFocus
          aria-label={`Edit ${label}`}
          value={draft}
          className="min-h-9 w-full"
          onChange={(e) => onDraft(e.target.value)}
          onBlur={onCommit}
          onKeyDown={(e) => {
            if (e.key === "Enter") onCommit();
            else if (e.key === "Escape") onCancel();
          }}
        />
      ) : value === null || value === undefined ? (
        <span className="rounded bg-default px-1 text-xs text-muted">NULL</span>
      ) : (
        <span className="truncate" title={String(value)}>
          {String(value)}
        </span>
      )}
    </div>
  );
}

/**
 * Virtualised grid for one page of table rows (@tanstack/react-table for the model,
 * @tanstack/react-virtual for the window), so 500-row pages of wide tables stay smooth.
 */
export function DataGridTable({
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
  selectedCell,
  onSelectCell,
  pendingUpdates,
  pendingDeletes,
  onToggleDelete,
  onCopyRowJson,
  onCopyRowCsv,
}: Props) {
  const parentRef = useRef<HTMLDivElement | null>(null);

  const tableColumns = useMemo(
    () => columns.map((c) => colHelper.accessor((row) => row[c.name] ?? null, { id: c.name, header: () => c.name })),
    [columns],
  );
  const table = useReactTable({ data: rows, columns: tableColumns, getCoreRowModel: getCoreRowModel() });
  const tableRows = table.getRowModel().rows;

  const rowVirtualizer = useVirtualizer({
    count: tableRows.length,
    getScrollElement: () => parentRef.current,
    estimateSize: () => ROW_HEIGHT,
    overscan: 14,
  });

  if (rows.length === 0) {
    return <p className="m-0 rounded-xl border border-separator bg-surface p-6 text-center text-sm text-muted">No rows in this result page.</p>;
  }

  const template = `repeat(${columns.length}, minmax(${COL_MIN_PX}px, 1fr)) ${ACTIONS_PX}px`;
  const minWidth = columns.length * COL_MIN_PX + ACTIONS_PX;

  return (
    <div ref={parentRef} className="relative max-h-[540px] overflow-auto rounded-xl border border-separator bg-surface" data-testid="data-grid-scroll">
      <div role="table" aria-label="Table rows" aria-rowcount={rows.length + 1} style={{ minWidth }}>
        <div role="rowgroup" className="sticky top-0 z-10 bg-surface-secondary">
          {table.getHeaderGroups().map((hg) => (
            <div key={hg.id} role="row" className="grid" style={{ gridTemplateColumns: template }}>
              {hg.headers.map((header) => {
                const meta = columns.find((c) => c.name === header.id);
                const sorted = sortCol === header.id;
                return (
                  <div
                    key={header.id}
                    role="columnheader"
                    aria-sort={sorted ? (sortDir === "asc" ? "ascending" : "descending") : "none"}
                    className="min-w-0 border-b border-separator"
                  >
                    <button
                      type="button"
                      onClick={() => onSort(header.id)}
                      title="Click to sort"
                      className="flex min-h-11 w-full min-w-0 items-center gap-1 px-2 text-left text-xs font-semibold"
                    >
                      <span className="truncate">{flexRender(header.column.columnDef.header, header.getContext())}</span>
                      {meta && meta.pk > 0 && <span className="rounded bg-accent-soft px-1 text-[10px] text-accent-soft-foreground">PK</span>}
                      {meta?.type && <span className="truncate font-normal text-muted">{meta.type}</span>}
                      {sorted && (sortDir === "asc" ? <SortAscIcon size={14} /> : <SortDescIcon size={14} />)}
                    </button>
                  </div>
                );
              })}
              <div role="columnheader" className="sticky right-0 flex items-center border-b border-separator bg-surface-secondary px-2 text-xs font-semibold">
                Actions
              </div>
            </div>
          ))}
        </div>
        <div role="rowgroup" className="relative" style={{ height: rowVirtualizer.getTotalSize() }}>
          {rowVirtualizer.getVirtualItems().map((vr) => {
            const raw = tableRows[vr.index]!.original;
            const rowKey = getRowKey(raw, vr.index);
            const isDeleted = !!pendingDeletes[rowKey];
            const updates = pendingUpdates[rowKey]?.values ?? {};
            return (
              <div
                key={rowKey}
                role="row"
                aria-rowindex={vr.index + 2}
                className={`group absolute left-0 top-0 grid w-full ${isDeleted ? "bg-danger-soft line-through opacity-70" : "hover:bg-surface-hover"}`}
                style={{ height: vr.size, transform: `translateY(${vr.start}px)`, gridTemplateColumns: template }}
              >
                {columns.map((c) => {
                  const dirty = c.name in updates;
                  const value = dirty ? updates[c.name]! : (raw[c.name] ?? null);
                  const editing = editingCell?.rowKey === rowKey && editingCell.col === c.name;
                  return (
                    <GridCell
                      key={c.name}
                      value={value}
                      label={c.name}
                      isDirty={dirty}
                      isSelected={selectedCell?.rowKey === rowKey && selectedCell.col === c.name}
                      isEditing={editing}
                      draft={editing ? editingCell.draft : ""}
                      onSelect={() => onSelectCell({ rowKey, col: c.name }, value)}
                      onStartEdit={() => {
                        onSelectCell({ rowKey, col: c.name }, value);
                        if (isEditable) setEditingCell({ rowKey, col: c.name, draft: cellText(value) });
                      }}
                      onDraft={(draft) => setEditingCell({ rowKey, col: c.name, draft })}
                      onCommit={() => editingCell && onCommitEdit(raw, rowKey, c, editingCell.draft)}
                      onCancel={() => setEditingCell(null)}
                    />
                  );
                })}
                <div role="cell" className="sticky right-0 flex items-center gap-1 border-b border-separator bg-surface px-1">
                  <Tooltip>
                    <Button isIconOnly size="sm" variant="ghost" aria-label="Copy row as JSON" onPress={() => onCopyRowJson(raw)}>
                      <CopyIcon size={16} />
                    </Button>
                    <Tooltip.Content>Copy row as JSON</Tooltip.Content>
                  </Tooltip>
                  <Button size="sm" variant="ghost" aria-label="Copy row as CSV" onPress={() => onCopyRowCsv(raw)}>
                    CSV
                  </Button>
                  {isEditable && (
                    <Tooltip>
                      <Button
                        isIconOnly
                        size="sm"
                        variant="ghost"
                        aria-label={isDeleted ? "Undo staged delete" : "Stage row delete"}
                        onPress={() => onToggleDelete(raw, rowKey)}
                      >
                        <TrashIcon size={16} />
                      </Button>
                      <Tooltip.Content>{isDeleted ? "Undo staged delete" : "Stage row delete"}</Tooltip.Content>
                    </Tooltip>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}
