// ---------------------------------------------------------------------------
// sqlitend operator CLI — runs on the server against the metadata DB (safe
// while the control plane is running: WAL + short transactions).
//
//   sqlitend set-password      set/replace the admin password (ends all sessions)
//   sqlitend enable-totp       turn on authenticator codes (ends all sessions)
//   sqlitend disable-totp      turn them off (ends all sessions)
//   sqlitend revoke-sessions   log out everywhere
//   sqlitend audit [N]         print the last N audit entries (default 30)
//   sqlitend gen-backup-key    print a new SQLITEND_CONTROL_BACKUP_KEY (store it OFFLINE)
//   sqlitend backup-control    upload an encrypted control-plane backup now (server may run)
// Server rebuild (sqlitend must be STOPPED):
//   sqlitend restore-control [--list | --object <key>] [--force]
//                              bring back metadata + signing keys from S3
//   sqlitend restore-data      restore each database's data in place, then start sqlitend
// ---------------------------------------------------------------------------

import path from "node:path";
import { createInterface } from "node:readline";
import { loadConfig } from "./config.ts";
import { openMetadata } from "./db/metadata.ts";
import { MIN_PASSWORD_LENGTH } from "./auth/session.ts";
import { generateTotpSecret, otpauthUri, verifyTotp } from "./auth/totp.ts";
import {
  ControlBackupService,
  decryptBundle,
  generateBackupKey,
  keyFingerprint,
  parseBackupKey,
  snapshotControlPlane,
  writeControlPlane,
} from "./backup/control.ts";
import { preflightReplica, realRunLitestream, s3ClientFor, verifySqliteFile, litestreamReplicaUrl } from "./backup/restore.ts";
import { sqldDataFile } from "./backup/replicator.ts";
import { mkdirSync, renameSync, rmSync, existsSync } from "node:fs";
import type { Config } from "./config.ts";
import { runningServerPid } from "./util/pidfile.ts";
import { assertInside } from "./util/paths.ts";

export const RESTORE_PENDING = "restore pending: run `sqlitend restore-data`";

async function rebuildCommand(cmd: string, rest: string[], config: Config): Promise<number> {
  if (cmd === "gen-backup-key") {
    const k = generateBackupKey();
    console.log(k);
    console.error(
      `\nfingerprint ${keyFingerprint(parseBackupKey(k)).toString("hex")}\n` +
        "Put it in ~/.config/sqlitend/env as SQLITEND_CONTROL_BACKUP_KEY=… AND store a copy OFFLINE\n" +
        "(password manager). Without it, control-plane backups cannot be decrypted.",
    );
    return 0;
  }
  const b = config.backup;
  if (!b?.control) throw new Error("needs SQLITEND_BACKUP_S3_* and SQLITEND_CONTROL_BACKUP_KEY (the key you stored offline)");
  await assertServerStopped(config);
  const s3 = s3ClientFor(b);
  const key = parseBackupKey(b.control.key);

  if (cmd === "restore-control") {
    const svc = new ControlBackupService({ s3: s3 as never, key, prefix: b.prefix, snapshot: () => { throw new Error("n/a"); } });
    const keys = await svc.listKeys();
    if (rest.includes("--list")) {
      for (const k of keys) console.log(k);
      console.log(`${keys.length} backup(s) under ${b.prefix}/control/`);
      return 0;
    }
    const i = rest.indexOf("--object");
    const objectKey = i >= 0 ? rest[i + 1] : keys.at(-1);
    if (!objectKey) throw new Error(`no control-plane backups found under s3://${b.bucket}/${b.prefix}/control/`);
    const blob = Buffer.from(await (s3.file(objectKey) as unknown as { arrayBuffer(): Promise<ArrayBuffer> }).arrayBuffer());
    const bundle = decryptBundle(blob, key);
    const m = bundle.manifest;
    console.log(`backup ${objectKey}\n  taken ${new Date(m.createdAt).toISOString()} on ${m.hostname} (sqlitend ${m.sqlitendVersion})\n  ${m.databases} database(s), ${m.tokens} token(s), ${m.files.length - 1} key file(s)`);
    const { movedAside, remapped } = writeControlPlane(bundle, config.dataRoot, { force: rest.includes("--force") });
    if (movedAside) console.log(`  existing metadata moved aside to ${movedAside}`);
    if (remapped) console.log(`  remapped ${remapped} data path(s) from ${m.dataRoot} to ${config.dataRoot}`);
    // Upgrade the restored schema, and park every database until its data is back:
    // started now, each would come up EMPTY and replicate emptiness.
    const meta = openMetadata(path.join(config.dataRoot, "metadata.sqlite"));
    try {
      meta.db.query("UPDATE databases SET status = 'stopped', auto_start = 0, pid = NULL, start_time = NULL, failed_reason = ?").run(RESTORE_PENDING);
      meta.db.query("DELETE FROM sessions").run();
      meta.auth.audit({ actor: "cli", ip: null, action: "backup.restore_control", target: objectKey, outcome: "ok", detail: `${m.databases} db` });
    } finally {
      meta.db.close();
    }
    console.log(`control plane restored. next: sqlitend restore-data`);
    return 0;
  }

  // restore-data: bring each parked database's data back, in place.
  const meta = openMetadata(path.join(config.dataRoot, "metadata.sqlite"));
  try {
    const run = realRunLitestream(b);
    const pending = meta.databases.list().filter((r) => (r.failed_reason ?? "").startsWith("restore pending"));
    if (pending.length === 0) {
      console.log("no databases are waiting for restore-data");
      return 0;
    }
    let ok = 0;
    for (const row of pending) {
      const label = `${row.slug} (${row.id})`;
      assertInside(config.dataRoot, row.data_dir);
      const finalFile = sqldDataFile(row.data_dir);
      if (existsSync(finalFile)) {
        // Never overwritten. A verified file already in place (an earlier run
        // that died before recording it, or one copied in by hand) is adopted.
        const bad = verifySqliteFile(finalFile);
        if (bad) {
          console.log(`FAIL  ${label}: a data file is already in place but unusable (${bad}); move it away and re-run`);
          continue;
        }
        meta.db.query("UPDATE databases SET status = 'starting', auto_start = 1, failed_reason = NULL WHERE id = ?").run(row.id);
        console.log(`OK    ${label}: data file already in place, verified and adopted`);
        ok++;
        continue;
      }
      const pre = await preflightReplica(s3 as never, b, row.id);
      if (pre) {
        console.log(`FAIL  ${label}: ${pre}`);
        continue;
      }
      const staging = `${row.data_dir}.restore`;
      rmSync(staging, { recursive: true, force: true });
      mkdirSync(staging, { recursive: true, mode: 0o700 });
      const tmp = path.join(staging, "data");
      const r = await run(["restore", "-o", tmp, litestreamReplicaUrl(b, row.id)], 60 * 60_000);
      const bad = r.code !== 0 ? `litestream exited ${r.code}: ${r.output.trim().slice(-300)}` : !existsSync(tmp) ? "no data restored" : verifySqliteFile(tmp);
      if (bad) {
        rmSync(staging, { recursive: true, force: true });
        console.log(`FAIL  ${label}: ${bad}`);
        continue;
      }
      mkdirSync(path.dirname(finalFile), { recursive: true, mode: 0o700 });
      renameSync(tmp, finalFile);
      rmSync(staging, { recursive: true, force: true });
      // "starting" + auto_start=1: the next sqlitend boot launches it.
      meta.db.query("UPDATE databases SET status = 'starting', auto_start = 1, failed_reason = NULL WHERE id = ?").run(row.id);
      console.log(`OK    ${label}: restored and verified`);
      ok++;
    }
    meta.auth.audit({ actor: "cli", ip: null, action: "backup.restore_data", target: null, outcome: ok === pending.length ? "ok" : "error", detail: `${ok}/${pending.length}` });
    console.log(`${ok}/${pending.length} database(s) restored. Start sqlitend now; failed ones stay parked (fix and re-run).`);
    return ok === pending.length ? 0 : 1;
  } finally {
    meta.db.close();
  }
}

export const CLI_COMMANDS = [
  "set-password", "enable-totp", "disable-totp", "revoke-sessions", "audit",
  "gen-backup-key", "backup-control", "restore-control", "restore-data",
] as const;

/** Rebuild commands must never race a running control plane: checked by the
 *  server's pid file on this data root AND by probing the address it binds. */
async function assertServerStopped(config: Config): Promise<void> {
  const pid = runningServerPid(config.dataRoot);
  if (pid) throw new Error(`sqlitend (pid ${pid}) is running on ${config.dataRoot} — stop it first (systemctl --user stop sqlitend)`);
  const h = ["0.0.0.0", "::", "*"].includes(config.host) ? "127.0.0.1" : config.host;
  try {
    await fetch(`http://${h.includes(":") ? `[${h}]` : h}:${config.port}/healthz`, { signal: AbortSignal.timeout(1_500) });
  } catch {
    return; // nothing listening: good
  }
  throw new Error(`something is listening on ${h}:${config.port} (sqlitend?) — stop it first`);
}

/** Read one line; with a TTY the input is not echoed. Piped stdin works too. */
async function prompt(question: string, hidden = false): Promise<string> {
  const stdin = process.stdin;
  if (hidden && stdin.isTTY) {
    process.stdout.write(question);
    stdin.setRawMode(true);
    stdin.resume();
    let value = "";
    return new Promise((resolve, reject) => {
      const onData = (buf: Buffer) => {
        for (const ch of buf.toString("utf8")) {
          if (ch === "\r" || ch === "\n") {
            stdin.setRawMode(false);
            stdin.pause();
            stdin.off("data", onData);
            process.stdout.write("\n");
            return resolve(value);
          }
          if (ch === "\u0003") {
            stdin.setRawMode(false);
            return reject(new Error("cancelled"));
          }
          if (ch === "\u007f") value = value.slice(0, -1);
          else value += ch;
        }
      };
      stdin.on("data", onData);
    });
  }
  process.stdout.write(question);
  const line = await nextLine();
  if (line === null) throw new Error("no input");
  return line;
}

// One reader for the whole run: a readline per prompt would buffer and drop
// the lines meant for later prompts when stdin is piped.
let lineQueue: string[] | null = null;
let lineWaiters: ((l: string | null) => void)[] = [];
let stdinClosed = false;
function nextLine(): Promise<string | null> {
  if (!lineQueue) {
    lineQueue = [];
    const rl = createInterface({ input: process.stdin, terminal: false });
    rl.on("line", (l) => {
      const w = lineWaiters.shift();
      if (w) w(l);
      else lineQueue!.push(l);
    });
    rl.on("close", () => {
      stdinClosed = true;
      for (const w of lineWaiters) w(null);
      lineWaiters = [];
    });
  }
  if (lineQueue.length > 0) return Promise.resolve(lineQueue.shift()!);
  if (stdinClosed) return Promise.resolve(null);
  return new Promise((resolve) => lineWaiters.push(resolve));
}

export async function runCli(argv: string[]): Promise<number> {
  const [cmd, ...rest] = argv;
  const config = loadConfig();
  // These must not open (and so create) metadata.sqlite up front.
  if (cmd === "gen-backup-key" || cmd === "restore-control" || cmd === "restore-data") {
    try {
      return await rebuildCommand(cmd, rest, config);
    } catch (err) {
      console.error(`error: ${(err as Error).message}`);
      return 1;
    }
  }
  const meta = openMetadata(path.join(config.dataRoot, "metadata.sqlite"));
  const { auth } = meta;
  const log = (action: string, detail: string | null = null) =>
    auth.audit({ actor: "cli", ip: null, action, target: null, outcome: "ok", detail });

  try {
    switch (cmd) {
      case "set-password": {
        const pw = await prompt("New admin password: ", true);
        if (pw.length < MIN_PASSWORD_LENGTH) {
          console.error(`password must be at least ${MIN_PASSWORD_LENGTH} characters`);
          return 1;
        }
        const again = await prompt("Repeat: ", true);
        if (again !== pw) {
          console.error("passwords do not match");
          return 1;
        }
        auth.setPassword(await Bun.password.hash(pw), Date.now());
        log("auth.set_password");
        console.log("password set; all sessions ended");
        return 0;
      }
      case "enable-totp": {
        if (!auth.getAdmin()) {
          console.error("set a password first: sqlitend set-password");
          return 1;
        }
        const secret = generateTotpSecret();
        console.log("Add this to your authenticator app:\n");
        console.log(`  secret: ${secret}`);
        console.log(`  uri:    ${otpauthUri(secret)}\n`);
        const code = (await prompt("Enter the 6-digit code it shows: ")).trim();
        if (!verifyTotp(secret, code, Date.now())) {
          console.error("code did not match; TOTP not enabled");
          return 1;
        }
        auth.setTotpSecret(secret);
        log("auth.enable_totp");
        console.log("TOTP enabled; all sessions ended");
        return 0;
      }
      case "disable-totp":
        auth.setTotpSecret(null);
        log("auth.disable_totp");
        console.log("TOTP disabled; all sessions ended");
        return 0;
      case "revoke-sessions": {
        const n = auth.deleteAllSessions();
        log("auth.revoke_sessions", `${n} session(s)`);
        console.log(`ended ${n} session(s)`);
        return 0;
      }
      case "audit": {
        // Route params are attacker-influenced; never let them drive the terminal.
        const clean = (v: string) => v.replace(/[\u0000-\u001f\u007f-\u009f]/g, "?");
        const n = Math.min(500, Math.max(1, Number(rest[0] ?? 30) || 30));
        for (const r of auth.listAudit(n).reverse()) {
          console.log(
            clean(
              `${new Date(r.at).toISOString()}  ${r.outcome.padEnd(6)} ${r.actor.padEnd(9)} ${(r.ip ?? "-").padEnd(15)} ${r.action}` +
                `${r.target ? ` ${r.target}` : ""}${r.detail ? `  (${r.detail})` : ""}`,
            ),
          );
        }
        return 0;
      }
      case "backup-control": {
        if (!config.backup?.control) {
          console.error("backups need SQLITEND_BACKUP_S3_* and SQLITEND_CONTROL_BACKUP_KEY");
          return 1;
        }
        const svc = new ControlBackupService({
          s3: s3ClientFor(config.backup) as never,
          key: parseBackupKey(config.backup.control.key),
          prefix: config.backup.prefix,
          keep: config.backup.control.keep,
          snapshot: () => snapshotControlPlane(config.dataRoot, meta.db, "cli"),
        });
        await svc.runNow();
        log("backup.control", svc.status().lastKey);
        console.log(`uploaded ${svc.status().lastKey}`);
        return 0;
      }
      default:
        console.error(`unknown command "${cmd}". commands: ${CLI_COMMANDS.join(", ")}`);
        return 2;
    }
  } finally {
    meta.db.close();
  }
}

if (import.meta.main) process.exit(await runCli(process.argv.slice(2)));
