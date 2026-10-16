import { useEffect, useRef, useState } from "react";
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
import { MetricTiles } from "./MetricTiles";
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

export default function MetricsTab({
  dbId,
  dbStatus,
  liveMetrics,
  metricsPolling,
  metricsDegraded,
}: Props) {
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
  const points: MetricsHistoryPoint[] = history?.points ?? [];
  const storage = storageQuery.data;

  return (
    <div className="metrics-tab-layout">
      {/* Stability Banner & Rule Explanation */}
      {stability && (
        <section className={`panel stability-banner stability-${stability.level}`}>
          <div className="stability-head">
            <div className="stability-title-row">
              <span className={`stability-badge stability-pill-${stability.level}`}>
                {stability.label}
              </span>
              <strong>24h Availability: {stability.availabilityPct24h.toFixed(2)}%</strong>
              <span className="muted small">
                · {stability.crashes24h} crash{stability.crashes24h === 1 ? "" : "es"} in 24h ({stability.totalCrashes} total, {stability.restartCount} restart{stability.restartCount === 1 ? "" : "s"})
              </span>
            </div>
            <span className="muted small" title={stability.rule}>
              Rule: {stability.rule}
            </span>
          </div>
          {stability.lastCrashAt && (
            <p className="muted small" style={{ margin: "0.4rem 0 0" }}>
              Last crash <span title={fullTime(stability.lastCrashAt)}>{relTime(stability.lastCrashAt)}</span>
              {stability.lastCrashReason ? ` — ${stability.lastCrashReason}` : ""}
            </p>
          )}
        </section>
      )}

      {/* Live Snapshot + Query Latency Percentiles */}
      <section className="panel">
        <div className="panel-head">
          <h3 className="panel-title" style={{ margin: 0 }}>Live Resource &amp; Query Telemetry</h3>
          <span className={`muted small sampled${metricsPolling ? " sampling" : ""}`}>
            {metricsDegraded
              ? "Metrics unavailable"
              : liveMetrics
                ? `Sampled ${new Date(liveMetrics.sampledAt).toLocaleTimeString()}`
                : "Awaiting sample…"}
          </span>
        </div>
        <MetricTiles metrics={liveMetrics} />

        {history && (
          <div className="metric-grid" style={{ marginTop: "0.75rem" }}>
            <div className="metric-tile">
              <span className="metric-label">Query Latency (p50 / p95 / p99)</span>
              <span className="metric-value" style={{ fontSize: "1.02rem" }}>
                {history.latency.p50Ms !== null
                  ? `${history.latency.p50Ms} / ${history.latency.p95Ms} / ${history.latency.p99Ms} ms`
                  : "—"}
              </span>
            </div>
            <div className="metric-tile">
              <span className="metric-label">Total Queries / Errors</span>
              <span className="metric-value" style={{ fontSize: "1.02rem" }}>
                {history.latency.totalQueries.toLocaleString()} ({history.latency.errorRatePct}% err)
              </span>
            </div>
            <div className="metric-tile">
              <span className="metric-label">WAL File Size</span>
              <span className="metric-value" style={{ fontSize: "1.02rem" }}>
                {fmtBytes(points.at(-1)?.walBytes ?? storage?.walBytes ?? 0)}
              </span>
            </div>
            <div className="metric-tile">
              <span className="metric-label">Disk Growth Rate</span>
              <span className="metric-value" style={{ fontSize: "1.02rem" }}>
                {fmtGrowth(history.diskGrowthBytesPerHour)}
              </span>
            </div>
          </div>
        )}
      </section>

      {/* Time-Series uPlot Charts */}
      <section className="panel">
        <div className="panel-head">
          <h3 className="panel-title" style={{ margin: 0 }}>Historical Time-Series</h3>
          <div className="stmt-tabs" role="tablist" aria-label="Time range">
            {(["1h", "24h", "7d"] as MetricsRange[]).map((r) => (
              <button
                key={r}
                type="button"
                role="tab"
                aria-selected={range === r}
                className={`stmt-tab ${range === r ? "active" : ""}`}
                onClick={() => setRange(r)}
              >
                {r}
              </button>
            ))}
          </div>
        </div>

        {points.length === 0 ? (
          <p className="muted small">Collecting time-series samples…</p>
        ) : (
          <div className="uplot-charts-grid">
            <UPlotChart
              title="CPU (%)"
              timestamps={points.map((p) => Math.floor(p.t / 1000))}
              series={[
                {
                  label: "CPU %",
                  color: "#4f8cff",
                  values: points.map((p) => p.cpuPct ?? 0),
                },
              ]}
            />
            <UPlotChart
              title="Memory RSS (MB)"
              timestamps={points.map((p) => Math.floor(p.t / 1000))}
              series={[
                {
                  label: "RSS MB",
                  color: "#3fb950",
                  values: points.map((p) => Number((p.memoryBytes / (1024 * 1024)).toFixed(2))),
                },
              ]}
            />
            <UPlotChart
              title="Disk & WAL Size (KB)"
              timestamps={points.map((p) => Math.floor(p.t / 1000))}
              series={[
                {
                  label: "Disk KB",
                  color: "#d29922",
                  values: points.map((p) => Number((p.diskBytes / 1024).toFixed(1))),
                },
                {
                  label: "WAL KB",
                  color: "#e5534b",
                  values: points.map((p) => Number((p.walBytes / 1024).toFixed(1))),
                },
              ]}
            />
            <UPlotChart
              title="Query Latency p50 / p95 (ms)"
              timestamps={points.map((p) => Math.floor(p.t / 1000))}
              series={[
                {
                  label: "p50 ms",
                  color: "#4f8cff",
                  values: points.map((p) => p.p50Ms ?? 0),
                },
                {
                  label: "p95 ms",
                  color: "#e5534b",
                  values: points.map((p) => p.p95Ms ?? 0),
                },
              ]}
            />
          </div>
        )}
      </section>

      {/* SQLite PRAGMA Storage & Per-Table Row Counts */}
      {storage && (
        <section className="panel">
          <h3 className="panel-title">SQLite Page &amp; Table Storage Breakdown</h3>
          <div className="metric-grid" style={{ marginBottom: "1rem" }}>
            <div className="metric-tile">
              <span className="metric-label">Page Count × Size</span>
              <span className="metric-value" style={{ fontSize: "1rem" }}>
                {storage.pageCount.toLocaleString()} × {storage.pageSize} B
              </span>
            </div>
            <div className="metric-tile">
              <span className="metric-label">Freelist Pages</span>
              <span className="metric-value" style={{ fontSize: "1rem" }}>
                {storage.freelistCount.toLocaleString()} ({fmtBytes(storage.freelistCount * storage.pageSize)})
              </span>
            </div>
            <div className="metric-tile">
              <span className="metric-label">Total DB Directory</span>
              <span className="metric-value" style={{ fontSize: "1rem" }}>
                {fmtBytes(storage.diskBytes)}
              </span>
            </div>
          </div>

          {storage.tableRowCounts.length > 0 && (
            <div className="table-scroll">
              <table className="token-table">
                <thead>
                  <tr>
                    <th>Table</th>
                    <th className="cell-end">Exact Row Count</th>
                  </tr>
                </thead>
                <tbody>
                  {storage.tableRowCounts.map((t) => (
                    <tr key={t.name}>
                      <td>
                        <code>{t.name}</code>
                      </td>
                      <td className="cell-end">{t.count.toLocaleString()}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>
      )}
    </div>
  );
}

function UPlotChart({
  title,
  timestamps,
  series,
}: {
  title: string;
  timestamps: number[];
  series: { label: string; color: string; values: (number | null)[] }[];
}) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const plotRef = useRef<uPlot | null>(null);

  useEffect(() => {
    const el = hostRef.current;
    if (!el || timestamps.length === 0) return;

    const width = Math.max(260, el.clientWidth - 16);
    const opts: uPlot.Options = {
      width,
      height: 150,
      legend: { show: true },
      axes: [
        {
          stroke: "#9aa0a6",
          grid: { stroke: "rgba(154,160,166,0.12)" },
        },
        {
          stroke: "#9aa0a6",
          grid: { stroke: "rgba(154,160,166,0.12)" },
          size: 48,
        },
      ],
      series: [
        {},
        ...series.map((s) => ({
          label: s.label,
          stroke: s.color,
          width: 2,
          fill: `${s.color}18`,
        })),
      ],
    };

    const alignedData: uPlot.AlignedData = [
      timestamps,
      ...series.map((s) => s.values),
    ];

    if (plotRef.current) {
      plotRef.current.destroy();
    }
    plotRef.current = new uPlot(opts, alignedData, el);

    const onResize = () => {
      if (plotRef.current && hostRef.current) {
        plotRef.current.setSize({
          width: Math.max(260, hostRef.current.clientWidth - 16),
          height: 150,
        });
      }
    };
    window.addEventListener("resize", onResize);
    return () => {
      window.removeEventListener("resize", onResize);
      plotRef.current?.destroy();
      plotRef.current = null;
    };
  }, [timestamps, series]);

  return (
    <div className="uplot-card">
      <h4 className="subhead" style={{ marginBottom: "0.35rem" }}>{title}</h4>
      <div ref={hostRef} className="uplot-host" />
    </div>
  );
}
