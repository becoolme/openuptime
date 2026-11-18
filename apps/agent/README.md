# OpenUptime server agent

A small Linux program that reports a server's CPU, memory, swap, load, disks (every data mount, network shares
included), disk I/O and network interfaces (all IPv4 and IPv6 addresses) to OpenUptime. It only makes outbound HTTPS
requests; nothing listens on the server. It uses the Go standard library and reads `/proc`, nothing else.

It is report-only: it never runs commands, scripts or updates sent to it. The only field it reads from the server's
answer is `interval`, how often to report. It runs as an unprivileged systemd `DynamicUser` with a read-only view of the
file system.

## Install

Open **Servers → Add server** in the dashboard and run the command shown there. It looks like:

```sh
curl -fsSL https://raw.githubusercontent.com/becoolme/openuptime/main/apps/agent/install.sh | sudo sh -s -- --key oua_… --endpoint https://openuptime.app
```

The script ([`install.sh`](install.sh)) comes straight from this repository, so you can read it before running it. It
downloads the binary for the machine (amd64 or arm64) from the latest GitHub release, checks it against the release's
`SHA256SUMS` before running it, writes the key to `/etc/openuptime-agent.env` (readable by root only) and starts the
`openuptime-agent` systemd service under a dynamic, unprivileged user. The report address must use HTTPS (plain HTTP
only for localhost). Pass `--binary-url` (or set `OPENUPTIME_AGENT_URL`) to download from an HTTPS mirror instead, with
a `SHA256SUMS` file next to the binary or `--sha256 HEX`. Run the script again with `--uninstall` to remove it.

One key per project: run the same command on as many servers as you like. Each machine registers itself on its first
report, by `/etc/machine-id`, and takes its host name as its name.

## Options

| Flag | Environment | Default |
| --- | --- | --- |
| `--key` | `OPENUPTIME_KEY` | (required) |
| `--endpoint` | `OPENUPTIME_ENDPOINT` | `https://openuptime.app` |
| `--ignore-interfaces` | `OPENUPTIME_IGNORE_INTERFACES` | `lo,docker,veth,br-,virbr,cni,flannel,cali,vxlan` (name prefixes) |
| `--interval` | | `60s`, until the server answers with the interval set in the dashboard |
| `--once` | | print one report as JSON and exit, without sending it |

## Develop

```sh
go test ./...
GOOS=linux GOARCH=amd64 CGO_ENABLED=0 go build -o openuptime-agent .
```

Binaries for each `v*` tag are built by `.github/workflows/agent.yml` and attached to the GitHub release.
