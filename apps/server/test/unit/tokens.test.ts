import { describe, expect, test } from "bun:test";
import { access, mkdtemp, readFile, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { generateKeyPair, exportJWK, importJWK, jwtVerify } from "jose";
import { dbKeyRelPath, ensureDbKey, mintToken } from "../../src/auth/tokens.ts";
import type { TokenIssued } from "@sqlitend/shared";

async function tempDataRoot(): Promise<string> {
  return mkdtemp(path.join(os.tmpdir(), "sqlitend-auth-"));
}

describe("auth/tokens: ensureDbKey (per-database signing keys)", () => {
  test("creates keys/<dbId>.key (0600) + keys/<dbId>.pub, idempotent across calls", async () => {
    const dataRoot = await tempDataRoot();
    const dbId = crypto.randomUUID();

    const first = await ensureDbKey(dataRoot, dbId);
    const keyPath = path.join(dataRoot, "keys", `${dbId}.key`);
    const pubPath = path.join(dataRoot, "keys", `${dbId}.pub`);
    expect(first.pubFile).toBe(pubPath);

    const keyStat = await stat(keyPath);
    expect(keyStat.mode & 0o777).toBe(0o600);

    await access(pubPath); // exists
    const pub = await readFile(pubPath, "utf8");
    expect(pub.length).toBeGreaterThan(0);
    // The pub file is exactly the public JWK's `x` (URL-safe raw Ed25519 bytes
    // — the format sqld's --auth-jwt-key-file expects).
    expect(pub).toBe(first.privateJwk.x as string);

    // Calling again re-imports the SAME private key and keeps the same pub x.
    const second = await ensureDbKey(dataRoot, dbId);
    expect(second.pubFile).toBe(first.pubFile);
    expect(second.privateJwk.x).toBe(first.privateJwk.x);
    expect(second.privateJwk.d).toBe(first.privateJwk.d);
  });

  test("different databases get DIFFERENT keys", async () => {
    const dataRoot = await tempDataRoot();
    const a = await ensureDbKey(dataRoot, crypto.randomUUID());
    const b = await ensureDbKey(dataRoot, crypto.randomUUID());
    expect(a.privateJwk.d).not.toBe(b.privateJwk.d);
    expect(a.pubFile).not.toBe(b.pubFile);
  });

  test("dbKeyRelPath is the documented keys/<dbId>.pub layout", () => {
    const id = "abc-123";
    expect(dbKeyRelPath(id)).toBe(`keys/${id}.pub`);
  });
});

describe("auth/tokens: mintToken", () => {
  test("default TTL ≈ 24h, override ≈ 1h", async () => {
    const dataRoot = await tempDataRoot();
    const dbId = crypto.randomUUID();
    const deps = {
      dataRoot,
      dbSlug: "demo",
      dbId,
      scope: "full" as const,
    };

    const defaultToken = await mintToken(deps, 24);
    expect(Math.abs(defaultToken.expiresAt - defaultToken.createdAt) - 24 * 3600 * 1000).toBeLessThanOrEqual(10_000);
    expect(defaultToken.scope).toBe("full");
    expect(defaultToken.dbSlug).toBe("demo");

    const short = await mintToken({ ...deps, expiresInHours: 1 }, 24);
    expect(Math.abs(short.expiresAt - short.createdAt) - 3600 * 1000).toBeLessThanOrEqual(10_000);
  });

  test("token verifies against ITS database's public key and carries d/iss/jti (no p claim)", async () => {
    const dataRoot = await tempDataRoot();
    const dbId = crypto.randomUUID();
    const { privateJwk } = await ensureDbKey(dataRoot, dbId);
    const issued: TokenIssued = await mintToken({ dataRoot, dbSlug: "demo", dbId, scope: "full" }, 24);

    const publicKey = await crypto.subtle.importKey(
      "jwk",
      { kty: "OKP", crv: "Ed25519", x: privateJwk.x },
      "Ed25519",
      true,
      ["verify"],
    );
    const publicJwk = await exportJWK(publicKey);

    const { payload, protectedHeader } = await jwtVerify(issued.token, publicJwk, {
      issuer: "sqlitend",
    });
    expect(protectedHeader.alg).toBe("EdDSA");
    expect(payload.d).toBe("demo");
    // A `p` (permission) claim is REJECTED (401) by sqld 0.24.32, so minted
    // tokens intentionally carry NO `p` claim.
    expect(payload.p).toBeUndefined();
    expect(payload.iss).toBe("sqlitend");
    expect(payload.jti).toBe(issued.jti);
  });

  test("REGRESSION (security review #1): a token minted for DB A is REJECTED by DB B's key", async () => {
    const dataRoot = await tempDataRoot();
    const idA = crypto.randomUUID();
    const idB = crypto.randomUUID();
    const issuedA = await mintToken({ dataRoot, dbSlug: "database-a", dbId: idA, scope: "full" }, 24);
    const keyB = await ensureDbKey(dataRoot, idB);

    // DB B's sqld process trusts ONLY keyB's public key — the exact verify sqld
    // performs. The cross-database token must fail that check.
    const pubB = await importJWK({ kty: "OKP", crv: "Ed25519", x: keyB.privateJwk.x }, "EdDSA");
    await expect(jwtVerify(issuedA.token, pubB, { issuer: "sqlitend" })).rejects.toThrow();
  });

  test("scope other than full is refused (never silently minted as full)", async () => {
    const dataRoot = await tempDataRoot();
    await expect(
      mintToken({ dataRoot, dbSlug: "x", dbId: crypto.randomUUID(), scope: "ro" }, 24),
    ).rejects.toThrow(/not supported/);
  });

  test("a token signed by a DIFFERENT (foreign) Ed25519 key is rejected", async () => {
    const dataRoot = await tempDataRoot();
    const issued = await mintToken(
      { dataRoot, dbSlug: "other", dbId: crypto.randomUUID(), scope: "full" },
      24,
    );

    const { publicKey: wrongPublic } = await generateKeyPair("EdDSA");
    const wrongJwk = await exportJWK(wrongPublic);

    await expect(jwtVerify(issued.token, wrongJwk)).rejects.toThrow();
  });
});
