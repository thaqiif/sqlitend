import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { useQuery } from "@tanstack/react-query";
import uPlot from "uplot";
import "uplot/dist/uPlot.min.css";
import type {
  Metrics,
  MetricsHistoryPoint,
  MetricsRange,
  StabilityBadge,
} from "@sqlitend/shared";
import { api } from "../api/client";
import { Card, Chip, Tabs } from "@heroui/react";
import { MetricTiles, Tile } from "./MetricTiles";
import { PlainTable, TD } from "./PlainTable";
import { stabilityTone } from "./status-tones";
import { fullTime, relTime } from "../format";

interface Props {
  dbId: string;
  dbStatus: string;
  liveMetrics: Metrics | null;
  metricsPolling: boolean;
  metricsDegraded: boolean;
}

function fmtBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const kb = bytes / 1024;
  if (kb < 1024) return `${kb.toFixed(1)} KB`;
  const mb = kb / 1024;
  if (mb < 1024) return `${mb.toFixed(1)} MB`;
  return `${(mb / 1024).toFixed(2)} GB`;
}

function fmtGrowth(bytesPerHour: number | null): string {
  if (bytesPerHour === null) return "—";
  if (bytesPerHour === 0) return "0 B/hr";
  const sign = bytesPerHour > 0 ? "+" : "-";
  return `${sign}${fmtBytes(Math.abs(bytesPerHour))}/hr`;
}

const RANGES: MetricsRange[] = ["1h", "24h", "7d"];

interface ChartSeries {
  label: string;
  color: string;
  values: (number | null)[];
}
interface ChartSpec {
  title: string;
  series: ChartSeries[];
}

/** Changes whenever the app theme (class / data-theme on <html>) changes, so charts can re-read colours. */
function useThemeVersion(): string {
  return useSyncExternalStore(
    (notify) => {
      const mo = new MutationObserver(notify);
      mo.observe(document.documentElement, { attributes: true, attributeFilter: ["class", "data-theme"] });
      return () => mo.disconnect();
    },
    () => document.documentElement.getAttribute("data-theme") ?? "",
    () => "",
  );
}

export default function MetricsTab({ dbId, dbStatus, liveMetrics, metricsPolling, metricsDegraded }: Props) {
  const [range, setRange] = useState<MetricsRange>("1h");

  const historyQuery = useQuery({
    queryKey: ["metricsHistory", dbId, range],
    queryFn: () => api.getMetricsHistory(dbId, range),
    refetchInterval: 5000,
  });
  const storageQuery = useQuery({
    queryKey: ["storageStats", dbId],
    queryFn: () => api.getStorageStats(dbId),
    enabled: dbStatus === "running",
    refetchInterval: 15000,
  });

  const history = historyQuery.data;
  const stability: StabilityBadge | undefined = history?.stability;
  const storage = storageQuery.data;

  // Stable identities: UPlotChart rebuilds its plot when these change, not on every poll render.
  const points: MetricsHistoryPoint[] = useMemo(() => history?.points ?? [], [history]);
  const timestamps = useMemo(() => points.map((p) => Math.floor(p.t / 1000)), [points]);
  const charts: ChartSpec[] = useMemo(
    () => [
      { title: "CPU (%)", series: [{ label: "CPU %", color: "#4f8cff", values: points.map((p) => p.cpuPct ?? 0) }] },
      {
        title: "Memory RSS (MB)",
        series: [{ label: "RSS MB", color: "#3fb950", values: points.map((p) => Number((p.memoryBytes / (1024 * 1024)).toFixed(2))) }],
      },
      {
        title: "Disk & WAL size (KB)",
        series: [
          { label: "Disk KB", color: "#d29922", values: points.map((p) => Number((p.diskBytes / 1024).toFixed(1))) },
          { label: "WAL KB", color: "#e5534b", values: points.map((p) => Number((p.walBytes / 1024).toFixed(1))) },
        ],
      },
      {
        title: "Query latency p50 / p95 (ms)",
        series: [
          { label: "p50 ms", color: "#4f8cff", values: points.map((p) => p.p50Ms ?? 0) },
          { label: "p95 ms", color: "#e5534b", values: points.map((p) => p.p95Ms ?? 0) },
        ],
      },
    ],
    [points],
  );

  return (
    <div className="flex min-w-0 flex-col gap-3">
      {stability && (
        <Card aria-label="Stability" className="gap-2 p-4">
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
            <Chip color={stabilityTone(stability.level)} variant="soft">
              {stability.label}
            </Chip>
            <strong className="text-sm">24h availability: {stability.availabilityPct24h.toFixed(2)}%</strong>
            <span className="text-xs text-muted">
              {stability.crashes24h} crash{stability.crashes24h === 1 ? "" : "es"} in 24h ({stability.totalCrashes} total, {stability.restartCount} total
              restart{stability.restartCount === 1 ? "" : "s"})
            </span>
          </div>
          <p className="m-0 text-xs text-muted">Rule: {stability.rule}</p>
          {stability.lastCrashAt && (
            <p className="m-0 text-xs text-muted">
              Last crash <span title={fullTime(stability.lastCrashAt)}>{relTime(stability.lastCrashAt)}</span>
              {stability.lastCrashReason ? `: ${stability.lastCrashReason}` : ""}
            </p>
          )}
        </Card>
      )}

      <Card className="gap-3 p-4">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h3 className="m-0 text-base font-semibold">Live resources &amp; query telemetry</h3>
          <span className={`text-xs text-muted ${metricsPolling ? "animate-pulse" : ""}`}>
            {metricsDegraded ? "Metrics unavailable" : liveMetrics ? `Sampled ${new Date(liveMetrics.sampledAt).toLocaleTimeString()}` : "Awaiting sample..."}
          </span>
        </div>
        <MetricTiles metrics={liveMetrics} />
        {history && (
          <div className="grid grid-cols-1 gap-2 min-[480px]:grid-cols-2 md:grid-cols-4">
            <Tile label="Query latency (p50 / p95 / p99)">
              <span className="text-base">
                {history.latency.p50Ms !== null ? `${history.latency.p50Ms} / ${history.latency.p95Ms} / ${history.latency.p99Ms} ms` : "n/a"}
              </span>
            </Tile>
            <Tile label="Total queries / errors">
              <span className="text-base">
                {history.latency.totalQueries.toLocaleString()} ({history.latency.errorRatePct}% err)
              </span>
            </Tile>
            <Tile label="WAL file size">
              <span className="text-base">{fmtBytes(points.at(-1)?.walBytes ?? storage?.walBytes ?? 0)}</span>
            </Tile>
            <Tile label="Disk growth rate">
              <span className="text-base">{fmtGrowth(history.diskGrowthBytesPerHour)}</span>
            </Tile>
          </div>
        )}
      </Card>

      <Card className="gap-3 p-4">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h3 className="m-0 text-base font-semibold">Historical time series</h3>
          <Tabs selectedKey={range} onSelectionChange={(k) => setRange(String(k) as MetricsRange)}>
            <Tabs.ListContainer>
              <Tabs.List aria-label="Time range">
                {RANGES.map((r) => (
                  <Tabs.Tab key={r} id={r} className="min-h-11 min-w-12 whitespace-nowrap">
                    {r}
                    <Tabs.Indicator />
                  </Tabs.Tab>
                ))}
              </Tabs.List>
            </Tabs.ListContainer>
          </Tabs>
        </div>
        {points.length === 0 ? (
          <p className="m-0 text-sm text-muted">Collecting time-series samples...</p>
        ) : (
          <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
            {charts.map((c) => (
              <UPlotChart key={c.title} title={c.title} timestamps={timestamps} series={c.series} />
            ))}
          </div>
        )}
      </Card>

      {storage && (
        <Card className="gap-3 p-4">
          <h3 className="m-0 text-base font-semibold">SQLite page &amp; table storage</h3>
          <div className="grid grid-cols-1 gap-2 min-[480px]:grid-cols-3">
            <Tile label="Page count x size">
              <span className="text-base">
                {storage.pageCount.toLocaleString()} x {storage.pageSize} B
              </span>
            </Tile>
            <Tile label="Freelist pages">
              <span className="text-base">
                {storage.freelistCount.toLocaleString()} ({fmtBytes(storage.freelistCount * storage.pageSize)})
              </span>
            </Tile>
            <Tile label="Total DB directory">
              <span className="text-base">{fmtBytes(storage.diskBytes)}</span>
            </Tile>
          </div>
          {storage.tableRowCounts.length > 0 && (
            <PlainTable label="Row counts" head={["Table", "Exact row count"]}>
              {storage.tableRowCounts.map((t) => (
                <tr key={t.name}>
                  <td className={TD}>
                    <code>{t.name}</code>
                  </td>
                  <td className={`${TD} tabular-nums`}>{t.count.toLocaleString()}</td>
                </tr>
              ))}
            </PlainTable>
          )}
        </Card>
      )}
    </div>
  );
}

function cssVar(name: string, fallback: string): string {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim() || fallback;
}

function UPlotChart({ title, timestamps, series }: { title: string; timestamps: number[]; series: ChartSeries[] }) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const theme = useThemeVersion();

  useEffect(() => {
    const el = hostRef.current;
    if (!el || timestamps.length === 0) return;

    const axisColor = cssVar("--muted", "#888");
    const gridColor = cssVar("--separator", "rgba(128,128,128,0.2)");
    const width = () => Math.max(200, el.clientWidth);
    const axis = { stroke: axisColor, grid: { stroke: gridColor }, ticks: { stroke: gridColor } };
    const plot = new uPlot(
      {
        width: width(),
        height: 160,
        legend: { show: true },
        axes: [axis, { ...axis, size: 60 }],
        series: [{}, ...series.map((s) => ({ label: s.label, stroke: s.color, width: 2, fill: `${s.color}18` }))],
      },
      [timestamps, ...series.map((s) => s.values)] as uPlot.AlignedData,
      el,
    );

    const ro = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(() => plot.setSize({ width: width(), height: 160 }));
    ro?.observe(el);
    return () => {
      ro?.disconnect();
      plot.destroy();
    };
    // `theme` is not read inside; a change of it must rebuild the plot with the new colours.
  }, [timestamps, series, theme]);

  return (
    <div className="min-w-0">
      <h4 className="m-0 mb-1 text-sm font-semibold">{title}</h4>
      <div ref={hostRef} className="min-w-0 overflow-hidden" data-testid="uplot-host" />
    </div>
  );
}
