# OpenUptime probe

A probe runs one check on request, from wherever it is deployed. Deploy it in several places and OpenUptime can check a
monitor from all of them, so an outage that only some of the world sees is told apart from a real one.

Probes run **http**, **tcp** and **websocket** checks only. Database checks carry credentials and stay on the scheduler;
heartbeats are not checks of ours at all.

## How it fits together

```
scheduler ──signed POST──▶ https://probe.example.app/api/probe/eu-central ──▶ target
                                         │
              {ok, statusCode, latencyMs, error} ◀──┘
```

Every request carries `x-ou-timestamp` and `x-ou-signature` (HMAC-SHA256 of `<timestamp>.<body>` under `PROBE_SECRET`).
A probe refuses anything unsigned or older than 60 seconds, and refuses private and internal targets whatever the
signature says (unless its own operator sets `ALLOW_PRIVATE_TARGETS`), so it is not an open proxy.

## Run it as a container or on any Node host

The probe is a plain Node server, so it can run on any VPS or machine in any country, with or without Docker. Build the
image from the repository root:

```bash
docker build -f apps/probe/Dockerfile -t openuptime-probe .
docker run -d --restart unless-stopped -p 8787:8787 \
  -e PROBE_SECRET=$(openssl rand -hex 32) -e PROBE_REGION=sao-paulo \
  openuptime-probe
curl http://localhost:8787/          # {"ok":true,"region":"sao-paulo"}
```

Tagged releases are meant to publish `ghcr.io/becoolme/openuptime-probe` (linux/amd64 and arm64) through `.github/workflows/docker.yml`; until a release made after the probe was added exists, build the image as above.

`docker-compose.yml` in this folder does the same with sensible defaults (loopback-only port, read-only filesystem, no
capabilities) and can terminate HTTPS itself with Caddy:

```bash
cd apps/probe
cp .env.example .env                      # set PROBE_SECRET
PROBE_DOMAIN=probe-sao.example.com docker compose --profile tls up -d   # DNS name must point at this host
```

Without the `tls` profile it listens on `127.0.0.1:8787` for your own reverse proxy. OpenUptime needs an `https` URL
(plain `http` is accepted for `localhost` only).

Without Docker (Node 22):

```bash
pnpm install
pnpm --filter @openuptime/probe build:node
PROBE_SECRET=… PROBE_REGION=sao-paulo node apps/probe/dist/server.mjs
```

| Variable | Meaning |
|---|---|
| `PROBE_SECRET` | Required. Shared with the API; requests without a valid signature are refused. |
| `PROBE_REGION` | Label returned by the health check. The name users see comes from the API's `PROBE_REGIONS`. |
| `PORT`, `HOST` | Where to listen. Default `8787` on `0.0.0.0`. |
| `CHECK_USER_AGENT` | User-Agent of HTTP checks. Set it to the same value as on the API so every region looks alike. |
| `ALLOW_PRIVATE_TARGETS` | `true` lets this probe check private and internal addresses of the network it runs in. Off by default. Use it for a probe that lives inside the network you want to watch (an office, a home lab), and only there. |

The server answers `SIGTERM` by finishing checks in flight, so `docker stop` is clean.

## Deploy to Vercel (several regions)

One project, one function per region, each pinned to a single Vercel region.

```bash
cd apps/probe
pnpm install
pnpm build:vercel                   # all of regions.json; or PROBE_BUILD_REGIONS=us-east,eu-central pnpm build:vercel

npx vercel link                     # once, creates a project for apps/probe
npx vercel env add PROBE_SECRET production   # a long random string; the same value goes to the API
npx vercel deploy --prebuilt --prod
```

`regions.json` maps the id OpenUptime uses (`eu-central`) to a Vercel region code (`fra1`). The ids are yours: they are
what monitors store, so renaming one later means re-saving the monitors that use it.

Running a function in more than one region needs a paid Vercel plan, and each plan has its own cap on how many regions
a project may use. Check Vercel's current limits before choosing how many to build. Private targets are always refused
on Vercel.

## Tell OpenUptime about them

On the API (Worker secrets, or `.env` for self-hosting):

```bash
PROBE_SECRET=<the same secret>
PROBE_REGIONS='{"us-east":"https://probe.example.app/api/probe/us-east","eu-central":"https://probe.example.app/api/probe/eu-central","ap-southeast":{"url":"https://probe.example.app/api/probe/ap-southeast","name":"Singapore"},"sao-paulo":{"url":"https://probe-sao.example.com/","name":"São Paulo"}}'
```

A value is a URL, or `{ "url": …, "name": … }` to label it yourself. Nothing configured means every monitor runs from
`auto`, the scheduler's own location, exactly as before. Regions show up in the dashboard and in `GET /api/regions`.

## Develop

```bash
pnpm test        # handler and server: signatures, validation, private-target refusal, real http/tcp/websocket checks,
                 # and the production bundle driven over HTTP under plain Node
pnpm typecheck
```

### HTTP request bodies

Upgrade probes before enabling HTTP bodies or PUT/PATCH/DELETE/OPTIONS checks. The health GET advertises `http-request-body-v1`; the scheduler verifies this before sending new request semantics. Old probes are unavailable for these checks rather than silently dropping a body. If every selected probe is unavailable, existing local fallback applies. Bodies support up to 16 KiB UTF-8, and a probe refuses a signed request larger than 64 KiB before checking the signature. On a redirect to another origin the custom headers are dropped, and a 307 or 308 that would resend the body there is refused; a 301, 302 or 303 turns the request into a GET without the body, and a same-host http to https upgrade keeps it.
