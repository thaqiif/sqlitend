// ---------------------------------------------------------------------------
// GET /healthz — unauthenticated probe for an uptime monitor. Counts only (no
// database names, no errors) so it is safe to expose. 200 = healthy, 503 =
// degraded. "Not backed up" is degraded on purpose: silence must not look OK.
// ---------------------------------------------------------------------------

import type { ReplicaState } from "../backup/replicator.ts";

export interface HealthInput {
  databases: { id: string; status: string; auto_start: number }[];
  backupState: ((id: string) => ReplicaState) | null;
  /** Restore-verify health per database; null when verification is off. */
  verifyState?: ((id: string) => "ok" | "failed" | "stale" | "pending") | null;
  /** Control-plane backup health; null when not applicable (no backups at all). */
  controlState?: "ok" | "failed" | "stale" | "pending" | "disabled" | null;
  sqldOk: boolean;
}

export interface HealthReport {
  status: "ok" | "degraded";
  sqld: { ok: boolean; running: number; expected: number };
  backup: { enabled: boolean; ok: number; failing: number };
  verify: { enabled: boolean; ok: number; failing: number };
  control: "ok" | "failed" | "stale" | "pending" | "disabled" | null;
}

export function healthReport(h: HealthInput): HealthReport {
  const expected = h.databases.filter((d) => d.auto_start === 1 || d.status === "running");
  const running = expected.filter((d) => d.status === "running");
  let ok = 0;
  let failing = 0;
  if (h.backupState) {
    for (const d of running) {
      const s = h.backupState(d.id);
      if (s === "ok") ok++;
      // "starting" is a grace state right after launch, not a failure.
      else if (s !== "starting") failing++;
    }
  }
  let vOk = 0;
  let vFailing = 0;
  if (h.verifyState) {
    for (const d of running) {
      const v = h.verifyState(d.id);
      if (v === "ok") vOk++;
      // failed = the backup could not be restored; stale = no proof it can be.
      else if (v !== "pending") vFailing++;
    }
  }
  const control = h.controlState ?? null;
  // Without the control plane, restored databases are unusable (keys, token
  // allowlist): "disabled" is as unhealthy as "failed" once backups exist.
  const controlBad = control === "failed" || control === "stale" || control === "disabled";
  const healthy = h.sqldOk && running.length === expected.length && !!h.backupState && failing === 0 && vFailing === 0 && !controlBad;
  return {
    status: healthy ? "ok" : "degraded",
    sqld: { ok: h.sqldOk, running: running.length, expected: expected.length },
    backup: { enabled: !!h.backupState, ok, failing },
    verify: { enabled: !!h.verifyState, ok: vOk, failing: vFailing },
    control,
  };
}
