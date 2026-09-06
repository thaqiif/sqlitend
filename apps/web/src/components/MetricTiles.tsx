import type { Metrics } from "@sqlitend/shared";

interface Props {
  metrics: Metrics | null;
}

function fmtBytes(bytes: number): string {
  const mb = bytes / (1024 * 1024);
  if (mb >= 1024) return `${(mb / 1024).toFixed(1)} GB`;
  return `${Math.round(mb)} MB`;
}

function fmtUptime(sec: number): string {
  const d = Math.floor(sec / 86400);
  const h = Math.floor((sec % 86400) / 3600);
  const m = Math.floor((sec % 3600) / 60);
  if (d > 0) return `${d}d ${h}h`;
  if (h > 0) return `${h}h ${m}m`;
  return `${m}m`;
}

export function MetricTiles({ metrics }: Props) {
  const cpu = metrics == null || metrics.cpuPct == null ? null : metrics.cpuPct;
  return (
    <div className="metric-grid">
      <div className="metric-tile">
        <span className="metric-label">CPU</span>
        <span className="metric-value">{cpu == null ? "—" : `${cpu.toFixed(1)}%`}</span>
      </div>
      <div className="metric-tile">
        <span className="metric-label">Memory</span>
        <span className="metric-value">{metrics == null ? "—" : fmtBytes(metrics.memoryBytes)}</span>
      </div>
      <div className="metric-tile">
        <span className="metric-label">Disk</span>
        <span className="metric-value">{metrics == null ? "—" : fmtBytes(metrics.diskBytes)}</span>
      </div>
      <div className="metric-tile">
        <span className="metric-label">Uptime</span>
        <span className="metric-value">{metrics == null ? "—" : fmtUptime(metrics.uptimeSec)}</span>
      </div>
      <div className="metric-tile">
        <span className="metric-label">Status</span>
        <span className={`status-badge status-${metrics?.status ?? "unknown"}`}>
          {metrics?.status ?? "—"}
        </span>
      </div>
    </div>
  );
}
