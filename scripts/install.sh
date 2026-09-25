#!/usr/bin/env bash
# ---------------------------------------------------------------------------
# sqlitend installer — single-command setup.
#
#     curl -fsSL https://raw.githubusercontent.com/thaqiif/sqlitend/main/scripts/install.sh | bash
#
# What it does (all under your HOME, no root needed):
#   1. installs Bun (only if missing; respects an existing `bun` on PATH)
#   2. downloads the sqlitend source for the chosen branch (public GitHub)
#   3. installs dependencies, fetches the PINNED sqld binary (SHA-256
#      verified by scripts/fetch-sqld.sh), and builds the web UI
#   4. installs a `sqlitend` launcher into ~/.local/bin
#   5. optionally (SQLITEND_SYSTEMD=1 on Linux) installs a systemd --user unit
#
# Defaults (all under $HOME, no root):
#   install dir        ~/.local/share/sqlitend
#   launcher           ~/.local/bin/sqlitend
#   data + per-DB keys ~/.local/share/sqlitend/data   (server default)
#
# Overrides:
#   SQLITEND_BRANCH      git branch to install (default: main)
#   SQLITEND_INSTALL_DIR install base (default: ~/.local/share/sqlitend)
#   SQLITEND_BIN_DIR     dir for the `sqlitend` launcher (default: ~/.local/bin)
#   SQLITEND_SYSTEMD=1   also install a systemd --user service (Linux only)
# ---------------------------------------------------------------------------
set -euo pipefail

REPO="thaqiif/sqlitend"
BRANCH="${SQLITEND_BRANCH:-main}"
INSTALL_BASE="${SQLITEND_INSTALL_DIR:-$HOME/.local/share/sqlitend}"
APP_DIR="$INSTALL_BASE/app"
DATA_DIR="$INSTALL_BASE/data"
BIN_DIR="${SQLITEND_BIN_DIR:-$HOME/.local/bin}"

c_reset=$'\033[0m'; c_cyan=$'\033[36m'
log()  { printf '%s[sqlitend]%s %s\n' "$c_cyan" "$c_reset" "$*"; }
warn() { printf '%s[sqlitend] warning:%s %s\n' "$c_cyan" "$c_reset" "$*" >&2; }
die()  { printf '%s[sqlitend] error:%s %s\n' "$c_cyan" "$c_reset" "$*" >&2; exit 1; }

[ -n "${HOME:-}" ] || die "HOME is not set; cannot determine install paths"
command -v curl >/dev/null 2>&1 || die "curl is required (apt-get install -y curl, or brew install curl)"
command -v tar  >/dev/null 2>&1 || die "tar is required"

# --- platform -----------------------------------------------------------------
OS="$(uname -s)"
ARCH="$(uname -m)"
case "$OS-$ARCH" in
  Linux-x86_64)  PLATFORM="linux-x86_64"  ;;
  Linux-aarch64) PLATFORM="linux-aarch64" ;;
  Darwin-arm64)  PLATFORM="macos (arm64)" ;;
  Darwin-x86_64) PLATFORM="macos (x64)"   ;;
  *)
    die "unsupported platform $OS $ARCH — sqlitend supports linux x86_64/aarch64 and macOS arm64/x64"
    ;;
esac
log "platform: $PLATFORM"

# --- Bun ----------------------------------------------------------------------
# The official bun.sh installer unpacks with `unzip`; bootstrap it when missing.
install_unzip() {
  local SU=""
  if [ "$(id -u)" != "0" ]; then SU="sudo "; fi
  if   command -v apt-get >/dev/null 2>&1; then ${SU}apt-get update -qq >/dev/null && ${SU}apt-get install -y -qq unzip >/dev/null
  elif command -v dnf     >/dev/null 2>&1; then ${SU}dnf     install -y -q unzip >/dev/null
  elif command -v yum     >/dev/null 2>&1; then ${SU}yum     install -y -q unzip >/dev/null
  elif command -v apk     >/dev/null 2>&1; then ${SU}apk     add --no-cache unzip >/dev/null
  elif command -v brew    >/dev/null 2>&1; then ${SU}brew    install unzip >/dev/null
  else
    die "unzip is required to unpack Bun, but no supported package manager was found. Install unzip, then re-run this script."
  fi
  command -v unzip >/dev/null 2>&1 || die "tried to install unzip but it is still unavailable"
}

ensure_bun() {
  if command -v bun >/dev/null 2>&1; then
    BUN="$(command -v bun)"
    return
  fi
  if ! command -v unzip >/dev/null 2>&1; then
    log "unzip missing — bootstrapping it (Bun's installer needs it) …"
    install_unzip
  fi
  log "Bun not found — installing to ~/.bun …"
  curl -fsSL https://bun.sh/install | bash
  BUN="$HOME/.bun/bin/bun"
  [ -x "$BUN" ] || die "Bun installer ran but $BUN is missing"
}
ensure_bun
log "bun       : $("$BUN" --version) ($BUN)"

# --- download source ----------------------------------------------------------
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

if [ -d "$APP_DIR" ]; then
  log "replacing previous install at $APP_DIR …"
  rm -rf "$APP_DIR"
fi
mkdir -p "$INSTALL_BASE" "$DATA_DIR"

TARBALL_URL="https://github.com/$REPO/archive/refs/heads/$BRANCH.tar.gz"
log "downloading $REPO (branch: $BRANCH) …"
curl -fsSL --retry 3 "$TARBALL_URL" -o "$TMP/repo.tar.gz"
mkdir -p "$TMP/src"
tar -xzf "$TMP/repo.tar.gz" -C "$TMP/src" --strip-components=1
[ -f "$TMP/src/package.json" ] || die "downloaded archive has no package.json — is $REPO public?"
mv "$TMP/src" "$APP_DIR"
cd "$APP_DIR"
log "source    : $APP_DIR"

# --- deps + pinned sqld + web build ---------------------------------------------
log "installing dependencies …"
if ! "$BUN" install --frozen-lockfile >/dev/null 2>&1; then
  warn "frozen install failed — retrying with a regular install"
  "$BUN" install >/dev/null
fi

log "fetching pinned sqld binary (SHA-256 verified) …"
if ! bash scripts/fetch-sqld.sh; then
  cat >&2 <<'EOF'
[sqlitend] error: could not fetch the pinned sqld binary.
    If this platform/arch is unsupported, install sqld another way
    (cargo install libsql-server --bin sqld) and set SQLITEND_SQLD_PATH.
EOF
  exit 1
fi

log "building web UI …"
"$BUN" run build >/dev/null

# --- settings file (shared by launcher + systemd; holds secrets → 0600) ---------
CONF_DIR="${XDG_CONFIG_HOME:-$HOME/.config}/sqlitend"
if [ ! -f "$CONF_DIR/env" ]; then
  (umask 077 && mkdir -p "$CONF_DIR" && cat > "$CONF_DIR/env" <<'ENVEOF'
# sqlitend settings: plain KEY=value lines only (read by systemd EnvironmentFile
# and by the launcher). Keep this file mode 0600 — it holds API tokens.
# See .env.example in the repo for every option.
SQLITEND_HOST=127.0.0.1
ENVEOF
  )
  log "settings  : created $CONF_DIR/env (0600)"
fi

# --- launcher ------------------------------------------------------------------
mkdir -p "$BIN_DIR"
cat > "$BIN_DIR/sqlitend" <<EOF
#!/usr/bin/env bash
# sqlitend launcher (installed by scripts/install.sh).
# Settings live in ~/.config/sqlitend/env (shared with the systemd unit), so
# the server and the operator CLI always use the same data root.
export SQLITEND_DATA_ROOT="\${SQLITEND_DATA_ROOT:-$DATA_DIR}"
ENV_FILE="\${XDG_CONFIG_HOME:-\$HOME/.config}/sqlitend/env"
if [ -f "\$ENV_FILE" ]; then
  case "\$(stat -c %a "\$ENV_FILE" 2>/dev/null || stat -f %Lp "\$ENV_FILE")" in
    *00) ;;
    *) echo "sqlitend: WARNING: \$ENV_FILE is readable by others (it may hold API tokens): chmod 600 it" >&2 ;;
  esac
  set -a; . "\$ENV_FILE"; set +a
fi
# With an operator command (set-password, enable-totp, disable-totp,
# revoke-sessions, audit) runs the CLI; otherwise starts the server.
case "\${1:-}" in
  set-password|enable-totp|disable-totp|revoke-sessions|audit|gen-backup-key|backup-control|restore-control|restore-data)
    exec "$BUN" run --cwd "$APP_DIR" apps/server/src/cli.ts "\$@" ;;
esac
exec "$BUN" run --cwd "$APP_DIR" apps/server/src/index.ts "\$@"
EOF
chmod +x "$BIN_DIR/sqlitend"
log "launcher  : $BIN_DIR/sqlitend"

# --- systemd (optional, Linux) --------------------------------------------------
SYSTEMD_UNIT="$HOME/.config/systemd/user/sqlitend.service"
if [ "${SQLITEND_SYSTEMD:-0}" = "1" ] && [ "$OS" = "Linux" ]; then
  mkdir -p "$(dirname "$SYSTEMD_UNIT")"
  cat > "$SYSTEMD_UNIT" <<EOF
[Unit]
Description=sqlitend — self-hosted sqld manager
After=network.target

[Service]
Type=simple
WorkingDirectory=$APP_DIR
Environment=SQLITEND_DATA_ROOT=$DATA_DIR
EnvironmentFile=-%h/.config/sqlitend/env
ExecStart=$BUN run --cwd $APP_DIR apps/server/src/index.ts
Restart=on-failure

[Install]
WantedBy=default.target
EOF
  systemctl --user daemon-reload
  systemctl --user enable --now sqlitend.service >/dev/null 2>&1 || true
  log "systemd   : enabled sqlitend.service (user)"
fi

# --- done -----------------------------------------------------------------------
PATH_HINT=""
case "$SHELL" in
  *zsh)  PATH_HINT='echo '"'"'export PATH="$HOME/.local/bin:$PATH"'"'"' >> ~/.zshrc' ;;
  *bash) PATH_HINT='echo '"'"'export PATH="$HOME/.local/bin:$PATH"'"'"' >> ~/.bashrc' ;;
esac
if [ -n "$PATH_HINT" ] && ! printf '%s' "$PATH" | grep -q "$HOME/.local/bin"; then
  warn "$BIN_DIR is not on your PATH. Add it with: $PATH_HINT"
fi

cat <<EOF

  sqlitend installed.

  Start it:   $BIN_DIR/sqlitend
  Web UI:     http://127.0.0.1:6100
  Data root:  $DATA_DIR

  Each database you create gets an isolated sqld process on its own port
  with a per-database signing key — token for DB A is rejected by DB B.
EOF