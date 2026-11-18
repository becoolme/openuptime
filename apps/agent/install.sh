#!/bin/sh
# Installs the OpenUptime server agent as a systemd service.
#
#   curl -fsSL https://raw.githubusercontent.com/becoolme/openuptime/main/apps/agent/install.sh | sudo sh -s -- --key oua_… --endpoint https://<your OpenUptime>
#
# The agent only sends metrics out. It opens no port and never runs commands it receives: the one thing it reads from
# the server's answer is how often to report.
#
# Options:
#   --key KEY          the project's agent key (required to install)
#   --endpoint URL     where the agent reports (default: https://openuptime.app); https, or http to this machine
#   --allow-http       accept a plain http:// endpoint on another machine, such as a self-hosted install on a LAN
#                      without TLS. The key and the metrics then cross the network unencrypted.
#   --binary-url URL   download the agent from here instead of GitHub releases (mirrors, air-gapped installs);
#                      https only, with a SHA256SUMS file next to it or --sha256
#   --sha256 HEX       the checksum the agent must have, instead of reading SHA256SUMS
#   --uninstall        stop the service and remove the agent
#
# The agent is checked against the release's SHA256SUMS before it runs; a mismatch stops the install.
#
# Source: https://github.com/becoolme/openuptime/tree/main/apps/agent
set -eu

KEY=""
ENDPOINT="https://openuptime.app"
BINARY_URL="${OPENUPTIME_AGENT_URL:-}"
SHA256=""
ALLOW_HTTP=0
UNINSTALL=0
BIN=/usr/local/bin/openuptime-agent
ENV_FILE=/etc/openuptime-agent.env
UNIT=/etc/systemd/system/openuptime-agent.service

say() { printf '%s\n' "$*"; }
fail() { printf 'openuptime-agent: %s\n' "$*" >&2; exit 1; }

while [ $# -gt 0 ]; do
  case "$1" in
    --key) KEY="${2:-}"; shift 2 ;;
    --key=*) KEY="${1#*=}"; shift ;;
    --endpoint) ENDPOINT="${2:-}"; shift 2 ;;
    --endpoint=*) ENDPOINT="${1#*=}"; shift ;;
    --binary-url) BINARY_URL="${2:-}"; shift 2 ;;
    --binary-url=*) BINARY_URL="${1#*=}"; shift ;;
    --sha256) SHA256="${2:-}"; shift 2 ;;
    --sha256=*) SHA256="${1#*=}"; shift ;;
    --allow-http) ALLOW_HTTP=1; shift ;;
    --uninstall) UNINSTALL=1; shift ;;
    *) fail "unknown option: $1" ;;
  esac
done

[ "$(uname -s)" = "Linux" ] || fail "only Linux is supported"
[ "$(id -u)" -eq 0 ] || fail "run as root (pipe into: sudo sh -s -- …)"
command -v systemctl >/dev/null 2>&1 || fail "systemd is required; run $BIN by hand with OPENUPTIME_KEY and OPENUPTIME_ENDPOINT set instead"

if [ "$UNINSTALL" -eq 1 ]; then
  systemctl disable --now openuptime-agent >/dev/null 2>&1 || true
  rm -f "$UNIT" "$BIN" "$ENV_FILE"
  systemctl daemon-reload
  say "OpenUptime agent removed. The server stays in the dashboard until you delete it there."
  exit 0
fi

# what goes into the env file must be a plain value: no spaces, quotes, backslashes or $
# grep reads line by line, so a value holding a newline is refused before it is matched
matches() { [ "$(printf '%s' "$1" | wc -l)" -eq 0 ] && printf '%s' "$1" | grep -Eq "$2"; }
URL_CHARS='^[]A-Za-z0-9._~:/?#@!&()*+,;=%[-]+$'
matches "$KEY" '^oua_[A-Za-z0-9]{16,64}$' || fail "pass the agent key from the dashboard: --key oua_…"
matches "$ENDPOINT" "$URL_CHARS" || fail "--endpoint is not a valid URL"
# plain http only to this machine, where nothing is on the wire, unless --allow-http says otherwise
if ! matches "$ENDPOINT" '^https://[^/]+' && ! matches "$ENDPOINT" '^http://(localhost|127\.0\.0\.1|\[::1\])(:[0-9]+)?(/|$)'; then
  matches "$ENDPOINT" '^http://[^/]+' && [ "$ALLOW_HTTP" -eq 1 ] \
    || fail "--endpoint must start with https:// (add --allow-http to report over plain http)"
  printf 'openuptime-agent: warning: %s is plain http; the key and metrics cross the network unencrypted\n' "$ENDPOINT" >&2
fi
ENDPOINT="${ENDPOINT%/}"
[ -z "$SHA256" ] || matches "$SHA256" '^[0-9a-fA-F]{64}$' || fail "--sha256 takes 64 hex characters"

case "$(uname -m)" in
  x86_64|amd64) ARCH=amd64 ;;
  aarch64|arm64) ARCH=arm64 ;;
  *) fail "unsupported CPU architecture: $(uname -m)" ;;
esac
[ -n "$BINARY_URL" ] || BINARY_URL="https://github.com/becoolme/openuptime/releases/latest/download/openuptime-agent-linux-$ARCH"
matches "$BINARY_URL" "$URL_CHARS" && matches "$BINARY_URL" '^https://[^/]+/' || fail "--binary-url must be an https:// URL"

if command -v curl >/dev/null 2>&1; then
  fetch() { curl -fsSL --proto '=https' --retry 3 -o "$2" "$1"; }
elif command -v wget >/dev/null 2>&1; then
  fetch() { wget -q -O "$2" "$1"; }
else
  fail "curl or wget is required"
fi
if command -v sha256sum >/dev/null 2>&1; then
  sha256() { sha256sum "$1" | cut -d' ' -f1; }
elif command -v shasum >/dev/null 2>&1; then
  sha256() { shasum -a 256 "$1" | cut -d' ' -f1; }
else
  fail "sha256sum is required to check the download"
fi

TMP="$(mktemp)"
SUMS="$(mktemp)"
trap 'rm -f "$TMP" "$SUMS"' EXIT
say "Downloading $BINARY_URL"
fetch "$BINARY_URL" "$TMP" || fail "download failed"
if [ -z "$SHA256" ]; then
  NAME="${BINARY_URL%%[?#]*}"
  NAME="${NAME##*/}"
  fetch "${BINARY_URL%/*}/SHA256SUMS" "$SUMS" || fail "could not download SHA256SUMS next to the agent; pass --sha256 to check it yourself"
  SHA256="$(awk -v n="$NAME" '$2 == n || $2 == "*" n { print $1; exit }' "$SUMS")"
  [ -n "$SHA256" ] || fail "SHA256SUMS has no line for $NAME"
fi
GOT="$(sha256 "$TMP")"
[ "$(printf '%s' "$GOT" | tr 'A-F' 'a-f')" = "$(printf '%s' "$SHA256" | tr 'A-F' 'a-f')" ] || fail "checksum mismatch for $BINARY_URL; nothing was installed"
say "Checksum verified (sha256 $GOT)"
chmod 0755 "$TMP"
"$TMP" --version >/dev/null 2>&1 || fail "the downloaded file is not a working agent for $ARCH"
systemctl stop openuptime-agent >/dev/null 2>&1 || true
mv "$TMP" "$BIN"
rm -f "$SUMS"
trap - EXIT

umask 077
cat > "$ENV_FILE" <<EOF
OPENUPTIME_KEY=$KEY
OPENUPTIME_ENDPOINT=$ENDPOINT
EOF
chmod 0600 "$ENV_FILE"

umask 022
cat > "$UNIT" <<EOF
[Unit]
Description=OpenUptime server agent
Documentation=https://github.com/becoolme/openuptime/tree/main/apps/agent
After=network-online.target
Wants=network-online.target

[Service]
EnvironmentFile=$ENV_FILE
ExecStart=$BIN
Restart=always
RestartSec=10
DynamicUser=yes
NoNewPrivileges=yes
PrivateTmp=yes
ProtectSystem=strict
ProtectHome=read-only

[Install]
WantedBy=multi-user.target
EOF

systemctl daemon-reload
systemctl enable --now openuptime-agent >/dev/null
say "OpenUptime agent $("$BIN" --version) is running. The server appears in the dashboard within a minute."
say "Logs: journalctl -u openuptime-agent -f    Remove: rerun this script with --uninstall"
