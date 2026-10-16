import { useRef, useState } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import type { SqlValue } from "@sqlitend/shared";

interface Props {
  columns: string[];
  rows: SqlValue[][];
}

function toCsvCell(v: SqlValue): string {
  if (v === null || v === undefined) return "";
  const s = String(v);
  if (/[",\r\n]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
  return s;
}

export function VirtualResultTable({ columns, rows }: Props) {
  const parentRef = useRef<HTMLDivElement | null>(null);
  const [copiedMsg, setCopiedMsg] = useState<string | null>(null);

  const rowVirtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => parentRef.current,
    estimateSize: () => 36,
    overscan: 12,
  });

  const colVirtualizer = useVirtualizer({
    horizontal: true,
    count: columns.length,
    getScrollElement: () => parentRef.current,
    estimateSize: () => 180,
    overscan: 5,
  });

  const flashCopied = (msg: string) => {
    setCopiedMsg(msg);
    setTimeout(() => setCopiedMsg(null), 1600);
  };

  const copyAsJson = () => {
    const objs = rows.map((r) => {
      const o: Record<string, SqlValue> = {};
      columns.forEach((c, idx) => {
        o[c] = r[idx] ?? null;
      });
      return o;
    });
    void navigator.clipboard?.writeText(JSON.stringify(objs, null, 2));
    flashCopied("Copied JSON");
  };

  const exportCsv = () => {
    const header = columns.map(toCsvCell).join(",");
    const body = rows.map((r) => columns.map((_, idx) => toCsvCell(r[idx] ?? null)).join(",")).join("\n");
    const blob = new Blob([`${header}\n${body}`], { type: "text/csv;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `query-result-${Date.now()}.csv`;
    a.click();
    URL.revokeObjectURL(url);
    flashCopied("Downloaded CSV");
  };

  const virtualRows = rowVirtualizer.getVirtualItems();
  const virtualCols = colVirtualizer.getVirtualItems();
  const totalWidth = colVirtualizer.getTotalSize();
  const totalHeight = rowVirtualizer.getTotalSize();

  return (
    <div className="virtual-result-wrapper">
      <div className="result-export-bar">
        <span className="muted small">
          Showing {rows.length.toLocaleString()} row{rows.length === 1 ? "" : "s"} × {columns.length} col{columns.length === 1 ? "" : "s"}
        </span>
        <div className="result-export-actions">
          {copiedMsg && <span className="copied-pill">{copiedMsg}</span>}
          <button type="button" className="btn ghost small" onClick={copyAsJson}>
            Copy JSON
          </button>
          <button type="button" className="btn ghost small" onClick={exportCsv}>
            Export CSV
          </button>
        </div>
      </div>

      <div ref={parentRef} className="virtual-grid-viewport" style={{ maxHeight: "420px" }}>
        <div
          className="virtual-grid-header"
          style={{ width: `${Math.max(totalWidth, 100)}px` }}
        >
          {virtualCols.map((vc) => (
            <div
              key={vc.key}
              className="virtual-grid-th"
              style={{
                width: `${vc.size}px`,
                transform: `translateX(${vc.start}px)`,
              }}
            >
              {columns[vc.index]}
            </div>
          ))}
        </div>

        <div
          className="virtual-grid-body"
          style={{
            height: `${totalHeight}px`,
            width: `${Math.max(totalWidth, 100)}px`,
          }}
        >
          {virtualRows.map((vr) => {
            const row = rows[vr.index]!;
            return (
              <div
                key={vr.key}
                className="virtual-grid-tr"
                style={{
                  height: `${vr.size}px`,
                  transform: `translateY(${vr.start}px)`,
                }}
              >
                {virtualCols.map((vc) => {
                  const val = row[vc.index] ?? null;
                  return (
                    <div
                      key={vc.key}
                      className={`virtual-grid-td ${val === null ? "cell-null" : ""}`}
                      style={{
                        width: `${vc.size}px`,
                        transform: `translateX(${vc.start}px)`,
                      }}
                      title={val === null ? "NULL" : String(val)}
                      onDoubleClick={() => {
                        void navigator.clipboard?.writeText(val === null ? "NULL" : String(val));
                        flashCopied("Copied cell");
                      }}
                    >
                      {val === null ? <span className="null-badge">NULL</span> : String(val)}
                    </div>
                  );
                })}
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}
