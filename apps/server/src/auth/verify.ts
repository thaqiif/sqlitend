// ---------------------------------------------------------------------------
// Gateway-side JWT signature check against a database's own public key
// (<dataRoot>/keys/<dbId>.pub, URL-safe base64 raw Ed25519 bytes — the same
// file sqld gets). Keys are cached per database; a missing key means the
// database cannot be reached through the gateway at all ("no_key").
// ---------------------------------------------------------------------------

import { readFile } from "node:fs/promises";
import path from "node:path";
import { importJWK, jwtVerify, type KeyLike } from "jose";
import { dbKeyRelPath } from "./tokens.ts";

export function createSignatureVerifier(dataRoot: string) {
  const cache = new Map<string, Promise<KeyLike | Uint8Array | null>>();

  const keyFor = (dbId: string) => {
    let k = cache.get(dbId);
    if (!k) {
      k = readFile(path.join(dataRoot, dbKeyRelPath(dbId)), "utf8").then(
        (x) => importJWK({ kty: "OKP", crv: "Ed25519", x: x.trim() }, "EdDSA"),
        () => null,
      );
      // Do not cache a miss: the key is created lazily and may appear later.
      void k.then((v) => { if (v === null) cache.delete(dbId); });
      cache.set(dbId, k);
    }
    return k;
  };

  return async (dbId: string, jwt: string): Promise<true | "bad_signature" | "no_key"> => {
    const key = await keyFor(dbId);
    if (!key) return "no_key";
    try {
      // Expiry is enforced from the tokens table; only the signature is checked here.
      await jwtVerify(jwt, key, { algorithms: ["EdDSA"], clockTolerance: Number.MAX_SAFE_INTEGER });
      return true;
    } catch {
      return "bad_signature";
    }
  };
}
