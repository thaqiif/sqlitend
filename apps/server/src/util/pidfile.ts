// ---------------------------------------------------------------------------
// <dataRoot>/sqlitend.pid — lets offline tools (restore-control/restore-data)
// know a control plane is running on this data root, whatever host/port it
// binds. Stale files (dead pid, or a reused pid that is not sqlitend) are
// ignored.
// ---------------------------------------------------------------------------

import { readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";

const FILE = "sqlitend.pid";

export function writePidFile(dataRoot: string): void {
  writeFileSync(path.join(dataRoot, FILE), `${process.pid}\n`, { mode: 0o600 });
}

export function removePidFile(dataRoot: string): void {
  try {
    if (readFileSync(path.join(dataRoot, FILE), "utf8").trim() === String(process.pid)) rmSync(path.join(dataRoot, FILE), { force: true });
  } catch {
    /* already gone */
  }
}

/** pid of a live sqlitend server using this data root, or null. */
export function runningServerPid(dataRoot: string, procRoot = "/proc"): number | null {
  let pid: number;
  try {
    pid = Number(readFileSync(path.join(dataRoot, FILE), "utf8").trim());
  } catch {
    return null;
  }
  if (!Number.isInteger(pid) || pid <= 0 || pid === process.pid) return null;
  try {
    process.kill(pid, 0);
  } catch {
    return null; // dead
  }
  try {
    const cmd = readFileSync(path.join(procRoot, String(pid), "cmdline"), "utf8");
    return cmd.includes("apps/server/src/index.ts") || cmd.includes("sqlitend") ? pid : null;
  } catch {
    return pid; // alive but unreadable: assume it is ours (fail safe)
  }
}
