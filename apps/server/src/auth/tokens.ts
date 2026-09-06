// ---------------------------------------------------------------------------
// Token minting — ONE Ed25519 signing keypair PER DATABASE.
//
// AUTH MODEL (validated empirically against sqld 0.24.32):
//   • sqld enforces EdDSA-signed JWTs via --auth-jwt-key-file, where the file
//     holds the raw Ed25519 PUBLIC key bytes in URL-safe base64 (the `x` of
//     the public JWK). Any token signed by that key is accepted; claims are
//     parsed but NOT enforced (no token -> 401). Tokens carrying a `p`
//     (permission) claim are REJECTED outright (401) by this build.
//   • A single platform-wide key would therefore make ANY token (including a
//     nominally read-only one) a full-access key to EVERY database: each sqld
//     would accept tokens signed by the shared key regardless of which
//     database they were minted for. Verified exploitable in review.
//   → sqlitend instead generates a dedicated keypair per database under
//     <dataRoot>/keys/<dbId>.{key,pub}, passes ONLY that database's pub file
//     to its sqld process, and mints that database's tokens with its private
//     key. A token is then cryptographically bound to exactly one database:
//     the negative test "token for DB A must be rejected by DB B" holds.
//
// SCOPE (`full` vs `ro`): sqld 0.24.32 cannot enforce per-request scopes and
// rejects tokens carrying a `p` claim, so sqlitend v1 mints full-access
// tokens only, scoped per database by key + network isolation. The CreateToken
// schema rejects anything else rather than silently upgrading a requested
// read-only token to full access.
// ---------------------------------------------------------------------------

import { mkdir, access, readFile, writeFile, chmod } from "node:fs/promises";
import path from "node:path";
import { generateKeyPair, exportJWK, importJWK, SignJWT, type JWK } from "jose";
import type { TokenIssued, TokenScope } from "@sqlitend/shared";

const KEYS_DIR = "keys";
const ISS = "sqlitend";

export interface DbKeyMaterial {
  /** jose-importable private JWK (kty OKP, crv Ed25519, with d + x). */
  privateJwk: JWK;
  /** Absolute path to this database's public-key file (the sqld auth file). */
  pubFile: string;
}

/** The pub-file path for a database, relative to the data root. Stored in
 *  databases.auth_key for documentation; the filesystem path is derived
 *  deterministically from dbId so it is valid for rows created before the
 *  column was populated. */
export function dbKeyRelPath(dbId: string): string {
  return path.posix.join(KEYS_DIR, `${dbId}.pub`);
}

/**
 * Lazily (re)create the per-database Ed25519 signing key, idempotently.
 *
 * - <dataRoot>/keys/<dbId>.key  — private JWK, 0600.
 * - <dataRoot>/keys/<dbId>.pub  — URL-safe base64 raw public bytes (the exact
 *   format sqld's --auth-jwt-key-file expects), passed to that DB's sqld only.
 */
export async function ensureDbKey(dataRoot: string, dbId: string): Promise<DbKeyMaterial> {
  const dir = path.join(dataRoot, KEYS_DIR);
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const keyPath = path.join(dir, `${dbId}.key`);
  const pubPath = path.join(dir, `${dbId}.pub`);

  let privateJwk: JWK;
  try {
    const raw = await readFile(keyPath, "utf8");
    privateJwk = JSON.parse(raw) as JWK;
    if (!privateJwk.d || !privateJwk.x || privateJwk.crv !== "Ed25519") {
      throw new Error(`invalid ${keyPath}: expected an Ed25519 private JWK`);
    }
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
    const { publicKey, privateKey } = await generateKeyPair("EdDSA", { extractable: true });
    const pubJwk = await exportJWK(publicKey);
    privateJwk = await exportJWK(privateKey);
    // mode on write avoids the brief 0644 window of write-then-chmod.
    await writeFile(keyPath, JSON.stringify(privateJwk, null, 2), { mode: 0o600 });
    await chmod(keyPath, 0o600);
    await writePubIfMissing(pubPath, pubJwk.x as string);
  }

  await writePubIfMissing(pubPath, privateJwk.x as string);
  return { privateJwk, pubFile: pubPath };
}

async function writePubIfMissing(pubPath: string, x: string): Promise<void> {
  try {
    await access(pubPath);
  } catch {
    await writeFile(pubPath, x, { mode: 0o600 });
  }
}

export interface MintTokenDeps {
  /** Root dir holding keys/<dbId>.{key,pub}. */
  dataRoot: string;
  dbSlug: string;
  dbId: string;
  /** v1 mints full-access tokens only (see header); anything else throws. */
  scope: TokenScope;
  /** Optional per-token TTL override (hours). Defaults to tokenTtlHours. */
  expiresInHours?: number;
}

/**
 * Mint an EdDSA JWT for a single database, signed by THAT database's key, and
 * return the full TokenIssued shape. The access token is returned to the
 * caller exactly once.
 */
export async function mintToken(deps: MintTokenDeps, tokenTtlHours: number): Promise<TokenIssued> {
  if (deps.scope !== "full") {
    throw new Error(`scope "${deps.scope}" is not supported by this sqld build; only full-access tokens can be minted`);
  }
  const { privateJwk } = await ensureDbKey(deps.dataRoot, deps.dbId);
  const privateKey = await importJWK(privateJwk, "EdDSA");

  const now = Date.now();
  const ttlHours = deps.expiresInHours ?? tokenTtlHours;
  const expiresAt = now + ttlHours * 3600 * 1000;
  const jti = crypto.randomUUID();

  // Claims stay minimal: `d` is informational; per-database scoping comes from
  // the per-DB signing key + one-process-per-database network isolation (a `p`
  // claim would make sqld 0.24.32 reject the token outright).
  const token = await new SignJWT({ d: deps.dbSlug })
    .setProtectedHeader({ alg: "EdDSA" })
    .setIssuer(ISS)
    .setJti(jti)
    .setIssuedAt(Math.floor(now / 1000))
    .setExpirationTime(Math.floor(expiresAt / 1000))
    .sign(privateKey);

  return {
    jti,
    databaseId: deps.dbId,
    scope: deps.scope,
    createdAt: now,
    expiresAt,
    token,
    dbSlug: deps.dbSlug,
  };
}
