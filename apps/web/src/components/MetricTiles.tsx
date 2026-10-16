import type { ReactNode } from "react";
import { Card } from "@heroui/react";
import type { Metrics } from "@sqlitend/shared";
import { StatusChip } from "./StatusChip";
import { dbStatusTone } from "./status-tones";

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

export function Tile({ label, children }: { label: string; children: ReactNode }) {
  return (
    <Card className="gap-1 p-3">
      <span className="text-xs text-muted">{label}</span>
      <span className="text-lg font-semibold tabular-nums">{children}</span>
    </Card>
  );
}

export function MetricTiles({ metrics }: Props) {
  const cpu = metrics == null || metrics.cpuPct == null ? null : metrics.cpuPct;
  return (
    <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 md:grid-cols-5">
      <Tile label="CPU">{cpu == null ? "—" : `${cpu.toFixed(1)}%`}</Tile>
      <Tile label="Memory">{metrics == null ? "—" : fmtBytes(metrics.memoryBytes)}</Tile>
      <Tile label="Disk">{metrics == null ? "—" : fmtBytes(metrics.diskBytes)}</Tile>
      <Tile label="Uptime">{metrics == null ? "—" : fmtUptime(metrics.uptimeSec)}</Tile>
      <Tile label="Status">
        {metrics ? <StatusChip tone={dbStatusTone(metrics.status)}>{metrics.status}</StatusChip> : "—"}
      </Tile>
    </div>
  );
}
