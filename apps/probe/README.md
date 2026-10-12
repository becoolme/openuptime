# OpenUptime probe

A probe runs one check on request, from wherever it is deployed. Deploy it in several places and OpenUptime can check a
monitor from all of them, so an outage that only some of the world sees is told apart from a real one.

Probes run **http** and **tcp** checks only. Database checks carry credentials and stay on the scheduler; heartbeats are
not checks of ours at all.

## How it fits together

```
scheduler ──signed POST──▶ https://probe.example.app/api/probe/eu-central ──▶ target
                                         │
              {ok, statusCode, latencyMs, error} ◀──┘
```

Every request carries `x-ou-timestamp` and `x-ou-signature` (HMAC-SHA256 of `<timestamp>.<body>` under `PROBE_SECRET`).
A probe refuses anything unsigned or older than 60 seconds, and refuses private and internal targets whatever the
signature says, so it is not an open proxy.

## Deploy to Vercel (several regions)

One project, one function per region, each pinned to a single Vercel region.

```bash
cd apps/probe
pnpm install
pnpm build                          # all of regions.json; or PROBE_BUILD_REGIONS=us-east,eu-central pnpm build

npx vercel link                     # once, creates a project for apps/probe
npx vercel env add PROBE_SECRET production   # a long random string; the same value goes to the API
npx vercel deploy --prebuilt --prod
```

`regions.json` maps the id OpenUptime uses (`eu-central`) to a Vercel region code (`fra1`). The ids are yours: they are
what monitors store, so renaming one later means re-saving the monitors that use it.

Running a function in more than one region needs a paid Vercel plan, and each plan has its own cap on how many regions
a project may use. Check Vercel's current limits before choosing how many to build.

## Tell OpenUptime about them

On the API (Worker secrets, or `.env` for self-hosting):

```bash
PROBE_SECRET=<the same secret>
PROBE_REGIONS='{"us-east":"https://probe.example.app/api/probe/us-east","eu-central":"https://probe.example.app/api/probe/eu-central","ap-southeast":{"url":"https://probe.example.app/api/probe/ap-southeast","name":"Singapore"}}'
```

A value is a URL, or `{ "url": …, "name": … }` to label it yourself. Nothing configured means every monitor runs from
`auto`, the scheduler's own location, exactly as before. Regions show up in the dashboard and in `GET /api/regions`.

## Anywhere else

The same code runs as a plain Node server, so a probe can be a container on any VPS in any country:

```bash
pnpm build:node
PROBE_SECRET=… PROBE_REGION=sao-paulo PORT=8787 pnpm start
```

Put it behind HTTPS and list its URL under `PROBE_REGIONS` like any other region.

## Develop

```bash
pnpm test        # handler: signatures, validation, private-target refusal, real http/tcp checks
pnpm typecheck
```
