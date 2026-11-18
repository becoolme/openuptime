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
#   --endpoint URL     where the agent reports (default: https://openuptime.app)
#   --binary-url URL   download the agent from here instead of GitHub releases (mirrors, air-gapped installs)
#   --uninstall        stop the service and remove the agent
#
# Source: https://github.com/becoolme/openuptime/tree/main/apps/agent
set -eu

KEY=""
ENDPOINT="https://openuptime.app"
BINARY_URL="${OPENUPTIME_AGENT_URL:-}"
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

case "$KEY" in
  oua_*) ;;
  *) fail "pass the agent key from the dashboard: --key oua_…" ;;
esac
case "$ENDPOINT" in
  https://*|http://*) ENDPOINT="${ENDPOINT%/}" ;;
  *) fail "--endpoint must start with https://" ;;
esac

case "$(uname -m)" in
  x86_64|amd64) ARCH=amd64 ;;
  aarch64|arm64) ARCH=arm64 ;;
  *) fail "unsupported CPU architecture: $(uname -m)" ;;
esac
[ -n "$BINARY_URL" ] || BINARY_URL="https://github.com/becoolme/openuptime/releases/latest/download/openuptime-agent-linux-$ARCH"

TMP="$(mktemp)"
trap 'rm -f "$TMP"' EXIT
say "Downloading $BINARY_URL"
if command -v curl >/dev/null 2>&1; then
  curl -fsSL --retry 3 -o "$TMP" "$BINARY_URL" || fail "download failed"
elif command -v wget >/dev/null 2>&1; then
  wget -q -O "$TMP" "$BINARY_URL" || fail "download failed"
else
  fail "curl or wget is required"
fi
chmod 0755 "$TMP"
"$TMP" --version >/dev/null 2>&1 || fail "the downloaded file is not a working agent for $ARCH"
systemctl stop openuptime-agent >/dev/null 2>&1 || true
mv "$TMP" "$BIN"
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
