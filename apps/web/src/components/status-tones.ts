import type { DatabaseStatus } from "@sqlitend/shared";

export type ChipTone = "default" | "accent" | "success" | "warning" | "danger";

const DB_STATUS_TONE: Record<DatabaseStatus, ChipTone> = {
  running: "success",
  starting: "warning",
  restoring: "warning",
  deleting: "warning",
  stopped: "default",
  trashed: "default",
  unknown: "default",
  crashed: "danger",
  failed: "danger",
};
export const dbStatusTone = (s: DatabaseStatus): ChipTone => DB_STATUS_TONE[s];

export const stabilityTone = (level: string): ChipTone =>
  level === "healthy" ? "success" : level === "warning" ? "warning" : level === "degraded" ? "danger" : "default";

export const backupTone = (state: string): ChipTone =>
  state === "ok" ? "success" : state === "starting" || state === "lagging" ? "warning" : "danger";

export const verifyTone = (health: string): ChipTone =>
  health === "ok" ? "success" : health === "stale" ? "warning" : health === "failed" ? "danger" : "default";

export const auditTone = (outcome: string): ChipTone =>
  outcome === "ok" ? "success" : outcome === "denied" ? "warning" : "danger";
