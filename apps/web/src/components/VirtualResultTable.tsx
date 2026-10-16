import { useRef, useState } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import { Button, Chip } from "@heroui/react";
import type { SqlValue } from "@sqlitend/shared";
import { copyText, downloadCsv, toCsv } from "../csv";

interface Props {
  columns: string[];
  rows: SqlValue[][];
}

const ROW_HEIGHT = 36;
const COL_WIDTH = 180;

/** Row- and column-virtualised result grid for the SQL console (up to 10,000 rows x any width). */
export function VirtualResultTable({ columns, rows }: Props) {
  const parentRef = useRef<HTMLDivElement | null>(null);
  const [flash, setFlash] = useState<string | null>(null);

  const rowVirtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => parentRef.current,
    estimateSize: () => ROW_HEIGHT,
    overscan: 12,
  });
  const colVirtualizer = useVirtualizer({
    horizontal: true,
    count: columns.length,
    getScrollElement: () => parentRef.current,
    estimateSize: () => COL_WIDTH,
    overscan: 5,
  });

  const notify = (msg: string) => {
    setFlash(msg);
    setTimeout(() => setFlash(null), 1600);
  };

  const copyJson = async () => {
    const objs = rows.map((r) => Object.fromEntries(columns.map((c, i) => [c, r[i] ?? null])));
    notify((await copyText(JSON.stringify(objs, null, 2))) ? "Copied JSON" : "Clipboard unavailable");
  };
  const exportCsv = () => {
    downloadCsv(`query-result-${Date.now()}.csv`, toCsv(columns, rows));
    notify("Downloaded CSV");
  };

  const totalWidth = Math.max(colVirtualizer.getTotalSize(), 100);
  const virtualCols = colVirtualizer.getVirtualItems();

  return (
    <div className="flex min-w-0 flex-col gap-2">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className="text-xs text-muted">
          {rows.length.toLocaleString()} row{rows.length === 1 ? "" : "s"} x {columns.length} column{columns.length === 1 ? "" : "s"}
        </span>
        <div className="flex items-center gap-2">
          {flash && (
            <Chip color="success" variant="soft" size="sm" role="status">
              {flash}
            </Chip>
          )}
          <Button size="sm" variant="secondary" onPress={() => void copyJson()}>
            Copy JSON
          </Button>
          <Button size="sm" variant="secondary" onPress={exportCsv}>
            Export CSV
          </Button>
        </div>
      </div>

      <div
        ref={parentRef}
        className="relative max-h-[420px] overflow-auto rounded-xl border border-separator bg-surface"
        data-testid="result-scroll"
      >
        <div role="table" aria-label="Query result" aria-rowcount={rows.length + 1}>
          <div role="rowgroup" className="sticky top-0 z-10 h-9 bg-surface-secondary" style={{ width: totalWidth }}>
            <div role="row" className="relative h-9">
              {virtualCols.map((vc) => (
                <div
                  key={vc.key}
                  role="columnheader"
                  className="absolute left-0 top-0 flex h-9 items-center truncate border-b border-separator px-2 text-xs font-semibold"
                  style={{ width: vc.size, transform: `translateX(${vc.start}px)` }}
                >
                  {columns[vc.index]}
                </div>
              ))}
            </div>
          </div>
          <div role="rowgroup" className="relative" style={{ height: rowVirtualizer.getTotalSize(), width: totalWidth }}>
            {rowVirtualizer.getVirtualItems().map((vr) => {
              const row = rows[vr.index]!;
              return (
                <div
                  key={vr.key}
                  role="row"
                  aria-rowindex={vr.index + 2}
                  className="absolute left-0 top-0 hover:bg-surface-hover"
                  style={{ height: vr.size, width: totalWidth, transform: `translateY(${vr.start}px)` }}
                >
                  {virtualCols.map((vc) => {
                    const val = row[vc.index] ?? null;
                    return (
                      <div
                        key={vc.key}
                        role="cell"
                        className="absolute left-0 top-0 flex h-full items-center truncate border-b border-separator px-2 text-sm"
                        style={{ width: vc.size, transform: `translateX(${vc.start}px)` }}
                        title={val === null ? "NULL" : String(val)}
                        onDoubleClick={async () => notify((await copyText(val === null ? "NULL" : String(val))) ? "Copied cell" : "Clipboard unavailable")}
                      >
                        {val === null ? <span className="rounded bg-default px-1 text-xs text-muted">NULL</span> : String(val)}
                      </div>
                    );
                  })}
                </div>
              );
            })}
          </div>
        </div>
      </div>
    </div>
  );
}
