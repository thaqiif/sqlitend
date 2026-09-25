#!/usr/bin/env bash
# Fetches the pinned Litestream binary (continuous S3 backup of each database)
# and verifies its SHA-256.
#
#   ./scripts/fetch-litestream.sh
#
# Same trust model as fetch-sqld.sh: the pins are SHA-256 values of the
# EXTRACTED BINARY, checked on every run including the fast path. To upgrade,
# bump VERSION and replace the pins with hashes from a verified source.
# 0.5.16 is the version already proven on sqld data files in production
# (postgresql-db-infra, byte-identical restore).
#
# Writes <repo>/bin/litestream (gitignored). Idempotent.
set -euo pipefail

VERSION="0.5.16"
PINNED_BIN_SHA256_linux_x86_64="97e7ffd943f9ce1954b79f59bcca2585b6fe4a81c7115345bf536da690b30bc0"
PINNED_BIN_SHA256_linux_arm64="ca797e6f997df6965a2d2e51f6ffffa72371c01a9314c8170cd87c4a535d9b31"

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
BIN_DIR="$ROOT/bin"
DEST="$BIN_DIR/litestream"

case "$(uname -s)-$(uname -m)" in
  Linux-x86_64)  ARCH="x86_64"; PINNED="$PINNED_BIN_SHA256_linux_x86_64" ;;
  Linux-aarch64) ARCH="arm64";  PINNED="$PINNED_BIN_SHA256_linux_arm64" ;;
  *)
    echo "Unsupported platform: $(uname -s) $(uname -m) (Linux x86_64/aarch64 only)." >&2
    echo "Install litestream $VERSION yourself and set SQLITEND_LITESTREAM_PATH." >&2
    exit 1
    ;;
esac

if   command -v sha256sum >/dev/null 2>&1; then hash_file() { sha256sum "$1" | awk '{print $1}'; }
elif command -v shasum    >/dev/null 2>&1; then hash_file() { shasum -a 256 "$1" | awk '{print $1}'; }
else echo "FATAL: no SHA-256 tool (sha256sum/shasum) found on PATH." >&2; exit 1
fi

mkdir -p "$BIN_DIR"
if [[ -x "$DEST" && "$(hash_file "$DEST")" == "$PINNED" ]]; then
  echo "litestream $("$DEST" version) already installed and verified: $DEST"
  exit 0
fi

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
URL="https://github.com/benbjohnson/litestream/releases/download/v$VERSION/litestream-$VERSION-linux-$ARCH.tar.gz"
echo "Downloading $URL"
curl -fsSL -o "$TMP/ls.tar.gz" "$URL"
tar -xzf "$TMP/ls.tar.gz" -C "$TMP" litestream
ACTUAL="$(hash_file "$TMP/litestream")"
if [[ "$ACTUAL" != "$PINNED" ]]; then
  echo "FATAL: litestream SHA-256 mismatch (expected $PINNED, got $ACTUAL) — refusing to install." >&2
  exit 1
fi
install -m 0755 "$TMP/litestream" "$DEST"
echo "litestream $("$DEST" version) installed and verified: $DEST"
