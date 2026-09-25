// ---------------------------------------------------------------------------
// Control-plane backup — the state needed to rebuild a whole server.
//
// Database *contents* are replicated by Litestream. This backs up everything
// else, without which restored databases are unusable:
//   • metadata.sqlite: workspaces, databases (ids ↔ replica paths), the token
//     allowlist the gateway enforces, admin login, audit log
//   • keys/: each database's Ed25519 signing key (tokens verify against it)
//
// The keys can mint tokens, so the bundle is ENCRYPTED before it leaves the
// server: AES-256-GCM under a 32-byte key the operator keeps offline
// (`sqlitend gen-backup-key`). The key never goes to S3, so read access to the
// bucket alone cannot forge tokens or read the admin hash.
//
// File format (all binary):
//   "SQLTNDCB" | u8 version=1 | 8-byte key fingerprint | 12-byte nonce | ciphertext+16-byte tag
// The first 29 bytes are GCM additional data (tamper-evident header).
// Plaintext = gzip(JSON { manifest, files: { "<relative path>": base64 } }).
// ---------------------------------------------------------------------------

import { Database as SQLite } from "bun:sqlite";
import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import { chmodSync, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { gunzipSync, gzipSync } from "node:zlib";

const MAGIC = Buffer.from("SQLTNDCB");
const VERSION = 1;
const HEADER_LEN = MAGIC.length + 1 + 8 + 12; // 29

export interface ControlManifest {
  format: 1;
  createdAt: number;
  hostname: string;
  sqlitendVersion: string;
  databases: number;
  tokens: number;
  files: string[];
  /** The data root the paths in metadata point into (remapped on restore). */
  dataRoot: string;
}

export interface ControlBundle {
  manifest: ControlManifest;
  files: Record<string, string>; // relative path → base64
}

export class WrongKeyError extends Error {}

/** Parse SQLITEND_CONTROL_BACKUP_KEY: 32 bytes as base64 (or base64url). */
export function parseBackupKey(raw: string): Buffer {
  const key = Buffer.from(raw.trim(), raw.includes("-") || raw.includes("_") ? "base64url" : "base64");
  if (key.length !== 32) throw new Error("SQLITEND_CONTROL_BACKUP_KEY must be 32 bytes, base64 (generate one with `sqlitend gen-backup-key`)");
  return key;
}

export function generateBackupKey(): string {
  return randomBytes(32).toString("base64");
}

export function keyFingerprint(key: Buffer): Buffer {
  return createHash("sha256").update("sqlitend-control-backup:").update(key).digest().subarray(0, 8);
}

export function encryptBundle(bundle: ControlBundle, key: Buffer): Buffer {
  const nonce = randomBytes(12);
  const header = Buffer.concat([MAGIC, Buffer.from([VERSION]), keyFingerprint(key), nonce]);
  const cipher = createCipheriv("aes-256-gcm", key, nonce);
  cipher.setAAD(header);
  const plain = gzipSync(Buffer.from(JSON.stringify(bundle)));
  const body = Buffer.concat([cipher.update(plain), cipher.final(), cipher.getAuthTag()]);
  return Buffer.concat([header, body]);
}

export function decryptBundle(blob: Buffer, key: Buffer): ControlBundle {
  if (blob.length < HEADER_LEN + 16 || !blob.subarray(0, MAGIC.length).equals(MAGIC)) {
    throw new Error("not a sqlitend control-plane backup");
  }
  if (blob[MAGIC.length] !== VERSION) throw new Error(`unsupported backup format version ${blob[MAGIC.length]}`);
  const header = blob.subarray(0, HEADER_LEN);
  const fp = header.subarray(MAGIC.length + 1, MAGIC.length + 9);
  if (!fp.equals(keyFingerprint(key))) {
    throw new WrongKeyError(`this backup was encrypted with a different key (fingerprint ${fp.toString("hex")}, yours ${keyFingerprint(key).toString("hex")})`);
  }
  const nonce = header.subarray(MAGIC.length + 9);
  const body = blob.subarray(HEADER_LEN);
  const decipher = createDecipheriv("aes-256-gcm", key, nonce);
  decipher.setAAD(header);
  decipher.setAuthTag(body.subarray(body.length - 16));
  let plain: Buffer;
  try {
    plain = Buffer.concat([decipher.update(body.subarray(0, body.length - 16)), decipher.final()]);
  } catch {
    throw new Error("backup failed authentication (corrupted or tampered)");
  }
  return JSON.parse(gunzipSync(plain).toString("utf8")) as ControlBundle;
}

/**
 * Consistent snapshot of the control plane. metadata.sqlite is copied with
 * VACUUM INTO (a transactionally consistent copy while the server runs);
 * keys/ is read as-is (keys are immutable once written).
 */
export function snapshotControlPlane(dataRoot: string, meta: SQLite, sqlitendVersion: string): ControlBundle {
  const tmp = path.join(dataRoot, `.control-snapshot-${process.pid}-${Date.now()}.sqlite`);
  try {
    // The copy holds the admin hash, TOTP secret and token allowlist: create it private.
    const prevUmask = process.umask(0o077);
    try {
      meta.query("VACUUM INTO ?").run(tmp);
    } finally {
      process.umask(prevUmask);
    }
    chmodSync(tmp, 0o600);
    const files: Record<string, string> = { "metadata.sqlite": readFileSync(tmp).toString("base64") };
    const keysDir = path.join(dataRoot, "keys");
    if (existsSync(keysDir)) {
      for (const f of readdirSync(keysDir).sort()) {
        if (/^[0-9a-f-]{36}\.(key|pub)$/.test(f)) files[`keys/${f}`] = readFileSync(path.join(keysDir, f)).toString("base64");
      }
    }
    const snap = new SQLite(tmp, { readonly: true });
    const count = (t: string) => (snap.query(`SELECT count(*) AS n FROM ${t}`).get() as { n: number }).n;
    const manifest: ControlManifest = {
      format: 1,
      createdAt: Date.now(),
      hostname: os.hostname(),
      sqlitendVersion,
      databases: count("databases"),
      tokens: count("tokens"),
      files: Object.keys(files),
      dataRoot: path.resolve(dataRoot),
    };
    snap.close();
    return { manifest, files };
  } finally {
    rmSync(tmp, { force: true });
  }
}

/**
 * Write a bundle into an EMPTY (or absent) data root. Refuses to touch an
 * existing metadata.sqlite unless `force`, in which case the old one is moved
 * aside (never deleted). Keys are written 0600.
 */
export function writeControlPlane(
  bundle: ControlBundle,
  dataRoot: string,
  opts: { force?: boolean } = {},
): { movedAside: string | null; remapped: number } {
  mkdirSync(dataRoot, { recursive: true, mode: 0o700 });
  const metaPath = path.join(dataRoot, "metadata.sqlite");
  let movedAside: string | null = null;
  if (existsSync(metaPath)) {
    if (!opts.force) throw new Error(`${metaPath} already exists — refusing to overwrite (use --force to move it aside)`);
    movedAside = `${metaPath}.before-restore-${Date.now()}`;
    renameSync(metaPath, movedAside);
    for (const side of ["-wal", "-shm"]) if (existsSync(metaPath + side)) renameSync(metaPath + side, movedAside + side);
  }
  const stamp = Date.now();
  for (const rel of Object.keys(bundle.files)) {
    if (!/^(metadata\.sqlite|keys\/[0-9a-f-]{36}\.(key|pub))$/.test(rel)) throw new Error(`unexpected file in backup: ${rel}`);
  }
  const keysDir = path.join(dataRoot, "keys");
  if (existsSync(keysDir) && lstatSync(keysDir).isSymbolicLink()) throw new Error(`${keysDir} is a symlink — refusing to write keys through it`);
  // Keys first, checked before anything is written: an existing key that differs
  // from the backup is either kept with an error (no --force) or moved aside.
  for (const [rel, b64] of Object.entries(bundle.files)) {
    if (!rel.startsWith("keys/")) continue;
    const dest = path.join(dataRoot, rel);
    if (!existsSync(dest)) continue;
    if (lstatSync(dest).isSymbolicLink()) throw new Error(`${dest} is a symlink — refusing to overwrite`);
    if (readFileSync(dest).equals(Buffer.from(b64, "base64"))) continue;
    if (!opts.force) throw new Error(`${dest} exists and differs from the backup's key — tokens would not verify (use --force to move it aside)`);
  }
  for (const [rel, b64] of Object.entries(bundle.files)) {
    const dest = path.join(dataRoot, rel);
    mkdirSync(path.dirname(dest), { recursive: true, mode: 0o700 });
    const data = Buffer.from(b64, "base64");
    if (existsSync(dest)) {
      if (rel.startsWith("keys/") && readFileSync(dest).equals(data)) continue;
      if (rel.startsWith("keys/")) renameSync(dest, `${dest}.before-restore-${stamp}`); // never destroy a key
    }
    // Write-then-rename: never follows a symlink planted at dest.
    const tmp = `${dest}.restore-tmp-${process.pid}`;
    rmSync(tmp, { force: true });
    writeFileSync(tmp, data, { mode: 0o600, flag: "wx" });
    renameSync(tmp, dest);
  }
  // Metadata stores absolute data_dir paths: point them at THIS data root.
  const from = bundle.manifest.dataRoot;
  const to = path.resolve(dataRoot);
  let remapped = 0;
  if (from && from !== to) {
    const db = new SQLite(metaPath);
    try {
      // Whole path segments only: "/data" must not match "/data2/…".
      remapped = db
        .query("UPDATE databases SET data_dir = ?1 || substr(data_dir, length(?2) + 1) WHERE data_dir = ?2 OR substr(data_dir, 1, length(?2) + 1) = ?2 || '/'")
        .run(to, from).changes;
    } finally {
      db.close();
    }
  }
  return { movedAside, remapped };
}

// ---------------------------------------------------------------------------
// Service: scheduled + change-triggered uploads, pruning, status.
// ---------------------------------------------------------------------------

import type { S3Like } from "./restore.ts";

export interface ControlBackupStatus {
  enabled: boolean;
  lastAt: number | null;
  lastOkAt: number | null;
  lastKey: string | null;
  lastError: string | null;
  lastErrorAt: number | null;
}

export interface ControlBackupDeps {
  s3: S3Like & { delete?(key: string): Promise<unknown>; writeBytes?(key: string, data: Uint8Array): Promise<unknown> };
  key: Buffer;
  prefix: string;
  snapshot: () => ControlBundle;
  keep?: number;
  debounceMs?: number;
  now?: () => number;
  log?: (m: string) => void;
}

export const controlPrefix = (prefix: string) => `${prefix}/control/`;

/** Sortable, S3-safe object name for a backup time. */
export const controlObjectKey = (prefix: string, at: number) =>
  `${controlPrefix(prefix)}${new Date(at).toISOString().replace(/[:.]/g, "-")}.sqlitend-backup`;

export class ControlBackupService {
  private debounce: ReturnType<typeof setTimeout> | null = null;
  private inflight: Promise<void> | null = null;
  private followUp: Promise<void> | null = null;
  private readonly st: ControlBackupStatus = { enabled: true, lastAt: null, lastOkAt: null, lastKey: null, lastError: null, lastErrorAt: null };
  private readonly now: () => number;
  private readonly log: (m: string) => void;

  constructor(private readonly d: ControlBackupDeps) {
    this.now = d.now ?? Date.now;
    this.log = d.log ?? ((m) => console.log(m));
  }

  status(): ControlBackupStatus {
    return { ...this.st };
  }

  /** Learn the newest existing backup from the store (after a restart). */
  async loadLatest(): Promise<void> {
    try {
      const keys = await this.listKeys();
      const last = keys.at(-1);
      if (last) {
        const t = parseKeyTime(last, this.d.prefix);
        this.st.lastKey = last;
        this.st.lastAt = this.st.lastOkAt = t;
      }
    } catch (err) {
      this.st.lastError = `could not list control backups: ${(err as Error).message}`;
      this.st.lastErrorAt = this.now();
    }
  }

  /** Something relevant changed: back up soon (coalesces bursts). */
  trigger(): void {
    if (this.debounce) clearTimeout(this.debounce);
    this.debounce = setTimeout(() => this.runNow().catch(() => {}), this.d.debounceMs ?? 60_000);
  }

  /**
   * Back up now. A call during an upload gets a follow-up run that snapshots
   * AFTER its request (its own changes included); concurrent callers share it.
   */
  runNow(): Promise<void> {
    if (this.inflight) {
      this.followUp ??= this.inflight.catch(() => {}).then(() => {
        this.followUp = null;
        return this.runNow();
      });
      return this.followUp;
    }
    this.inflight = this.upload().finally(() => (this.inflight = null));
    return this.inflight;
  }

  stop(): void {
    if (this.debounce) clearTimeout(this.debounce);
  }

  private async upload(): Promise<void> {
    const at = this.now();
    this.st.lastAt = at;
    try {
      const blob = encryptBundle(this.d.snapshot(), this.d.key);
      const key = controlObjectKey(this.d.prefix, at);
      if (this.d.s3.writeBytes) await this.d.s3.writeBytes(key, blob);
      else await this.d.s3.write(key, blob as unknown as string, { type: "application/octet-stream" });
      this.st.lastOkAt = at;
      this.st.lastKey = key;
      this.st.lastError = null;
      await this.prune();
    } catch (err) {
      this.st.lastError = (err as Error).message.slice(0, 500);
      this.st.lastErrorAt = at;
      this.log(`[control-backup] FAILED: ${this.st.lastError}`);
      throw err;
    }
  }

  async listKeys(): Promise<string[]> {
    const out: string[] = [];
    let continuationToken: string | undefined;
    for (let i = 0; i < 100; i++) {
      const r = await this.d.s3.list({ prefix: controlPrefix(this.d.prefix), maxKeys: 1000, ...(continuationToken ? { continuationToken } : {}) });
      for (const c of r.contents ?? []) if (c.key.endsWith(".sqlitend-backup")) out.push(c.key);
      if (!r.isTruncated || !r.nextContinuationToken) break;
      continuationToken = r.nextContinuationToken;
    }
    return out.sort();
  }

  private async prune(): Promise<void> {
    if (!this.d.s3.delete) return;
    // Never the backup just written (a backwards clock jump would sort it oldest).
    const keys = (await this.listKeys()).filter((k) => k !== this.st.lastKey);
    const excess = keys.slice(0, Math.max(0, keys.length - ((this.d.keep ?? 30) - 1)));
    for (const k of excess) await this.d.s3.delete(k);
  }
}

export function parseKeyTime(key: string, prefix: string): number | null {
  const m = /^(\d{4}-\d{2}-\d{2})T(\d{2})-(\d{2})-(\d{2})-(\d{3})Z\.sqlitend-backup$/.exec(key.slice(controlPrefix(prefix).length));
  return m ? Date.parse(`${m[1]}T${m[2]}:${m[3]}:${m[4]}.${m[5]}Z`) : null;
}
