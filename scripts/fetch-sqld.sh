#!/usr/bin/env bash
# Fetches the pinned sqld (libsql-server) binary and verifies its SHA-256.
#
#   ./scripts/fetch-sqld.sh
#
# The expected SHA-256 values below are PINNED LITERALS OF THE EXTRACTED BINARY
# (fail-closed, TOFU-free): neither a compromised GitHub release that swaps its
# own .sha256 asset nor a tampered/replaced bin/sqld that merely reports the
# right version can pass — the binary itself is hashed against the pin on every
# run, including the fast path. To upgrade sqld, bump TAG and replace the
# PINNED_BIN_SHA256_* values with hashes from a verified source.
#
# Idempotent: if bin/sqld exists, hashes to the pin, and reports the pinned
# version, this is a no-op.
#
# Writes the binary to <repo>/bin/sqld (gitignored).
#
# Fallback (documented): `cargo install libsql-server --bin sqld` then point
# SQLITEND_SQLD_PATH at the binary. A cargo-built binary cannot be hash-pinned
# here; treat it as an explicit trust decision.
set -euo pipefail

REPO="tursodatabase/libsql"
TAG="libsql-server-v0.24.32"
# Binary prints "sqld sqld 0.24.32 …" — strip both the tag prefix and the `v`.
VERSION="${TAG#libsql-server-}"
VERSION="${VERSION#v}"

# Pinned SHA-256 of the extracted `sqld` BINARY per release artifact.
PINNED_BIN_SHA256_x86_64_unknown_linux_gnu="0863c3fbe68ac9714bca2cec1330def7a0ba5e4a29f199bf60ef46fa0c95b895"
PINNED_BIN_SHA256_aarch64_apple_darwin="cc075b5bf145e5e750afd2941f390b46dbfe9ae47158d95ab637a00559681054"
PINNED_BIN_SHA256_x86_64_apple_darwin="f831a1050a68e2342ce715283b6367382bd02e143ed85d7879c2b6f64485812c"

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
BIN_DIR="$ROOT/bin"

OS="$(uname -s)"
ARCH="$(uname -m)"
case "$OS-$ARCH" in
  Linux-x86_64)  TARGET="x86_64-unknown-linux-gnu";  PINNED="$PINNED_BIN_SHA256_x86_64_unknown_linux_gnu" ;;
  Darwin-arm64)  TARGET="aarch64-apple-darwin";      PINNED="$PINNED_BIN_SHA256_aarch64_apple_darwin" ;;
  Darwin-x86_64) TARGET="x86_64-apple-darwin";       PINNED="$PINNED_BIN_SHA256_x86_64_apple_darwin" ;;
  *)
    echo "Unsupported platform: $OS $ARCH" >&2
    echo "Only linux-x86_64 (and macOS aarch64/x64) are supported by fetch-sqld.sh." >&2
    echo "Fallback: cargo install libsql-server --bin sqld, then set SQLITEND_SQLD_PATH." >&2
    exit 1
    ;;
esac
if [[ -z "${PINNED:-}" ]]; then
  echo "FATAL: no pinned SHA-256 for $TARGET — refusing to download unverified." >&2
  exit 1
fi

TARBALL="libsql-server-$TARGET.tar.xz"
URL="https://github.com/$REPO/releases/download/$TAG/$TARBALL"
DEST="$BIN_DIR/sqld"

hash_file() { shasum -a 256 "$1" 2>/dev/null | awk '{print $1}'; }
# NOTE: no `grep -q` under `set -o pipefail` — an early-exit grep SIGPIPEs the
# producer and makes a MATCH look like a failure.
version_ok() { "$1" --version 2>/dev/null | grep "$VERSION" >/dev/null; }

mkdir -p "$BIN_DIR"

# Fast path: the INSTALLED BINARY's own hash must equal the pin (a swapped
# binary that prints the right version fails here) and its version must match.
if [[ -x "$DEST" ]] && version_ok "$DEST"; then
  ACTUAL="$(hash_file "$DEST")"
  if [[ "$ACTUAL" == "$PINNED" ]]; then
    echo "sqld $VERSION present, binary hash matches the pin (skip)."
    exit 0
  fi
  echo "sqld reports $VERSION but its hash differs from the pin — re-fetching a verified copy." >&2
fi

echo "==> Downloading $TAG ($TARGET)"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
curl -fL --retry 3 -o "$TMP/$TARBALL" "$URL"

echo "==> Extracting sqld binary"
tar -xJf "$TMP/$TARBALL" -C "$TMP"
SQLD_BIN="$(find "$TMP" -type f -name 'sqld' -perm -u+x | head -n1)"
if [[ -z "$SQLD_BIN" ]]; then
  echo "Could not locate the sqld binary inside the tarball." >&2
  exit 1
fi

echo "==> Verifying BINARY SHA-256 against the PINNED hash"
ACTUAL="$(hash_file "$SQLD_BIN")"
if [[ "$ACTUAL" != "$PINNED" ]]; then
  echo "SHA-256 mismatch: pinned $PINNED, got $ACTUAL" >&2
  echo "Refusing to install. If this is a legitimate new release, update PINNED_BIN_SHA256_* in scripts/fetch-sqld.sh." >&2
  exit 1
fi

install -m 0755 "$SQLD_BIN" "$DEST"

echo "==> Installed:"
"$DEST" --version
echo "Binary verified against pinned SHA-256: $ACTUAL"
