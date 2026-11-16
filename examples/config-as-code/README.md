# Monitors as code

Keep a project's monitors in `monitors.json`, review changes to it in pull requests, and let CI apply them. It uses
only the public REST API and Node 20 or newer, with no dependencies.

```bash
export OPENUPTIME_API_KEY=ou_...          # an owner or admin key of the workspace
export OPENUPTIME_PROJECT_ID=...          # optional: the workspace's default project otherwise
export OPENUPTIME_URL=https://openuptime.app   # or your own install
export HEALTH_TOKEN=...                   # every ${NAME} in the file must be set
node sync.mjs plan                        # shows what would change; changes nothing
node sync.mjs apply                       # makes those changes
```

`plan` prints one line per change and exits with 1 when something in the file cannot be applied (an unknown alert
channel, a target the server refuses, a changed type). `apply` makes the same checks first and changes nothing when one
fails. Running `apply` twice in a row: the second run reports `No changes`.

## The file

```json
{
  "source": "config:production",
  "monitors": [
    { "key": "website", "name": "Website", "type": "http", "target": "https://example.com", "intervalSec": 60, "channels": ["On-call"] }
  ]
}
```

- `source` names this file. Use a different one for each file or repository that manages monitors in the same
  project, so they never touch each other's monitors.
- `key` identifies a monitor across runs: lowercase letters, digits, `.`, `_` and `-`. Renaming a monitor keeps its
  key; changing the key replaces the monitor with a new one (after `--prune`, the old one is deleted).
- Every other field is a monitor field as in the [API reference](https://openuptime.app/docs/api) (`intervalSec`,
  `keyword`, `headers`, `jsonAssertions`, `regions`, `tags`, ...), plus `paused`. Only the fields you write are
  managed; one you leave out keeps whatever value the monitor has, including changes made in the app.
- `channels` lists alert channels by name. Without it, new monitors get the project's channels that are on for new
  monitors, and existing ones keep theirs.
- `"${NAME}"` anywhere in a string is replaced by the environment variable `NAME`. Put tokens there, never in the file.
- A monitor's `type` cannot change. Give it a new key instead.

## What it touches

New monitors are created through the import endpoint with `source` and `key` as their identity; changes to fields go
through `PATCH`. Only monitors created this way, with the same `source`, are compared, changed or deleted. Monitors
made in the app or by another file are never touched.

A monitor that is in the project but no longer in the file is listed and kept. Add `--prune` to delete it.

The plan shows that a header or request body changes but not its value. The API shows header values only to owners and
admins, so a key of another role cannot compare them and the plan says so.

## In CI

`workflow.yml` runs the plan on pull requests that change this folder (the plan lands in the job summary) and applies
on pushes to `main`. Copy it to `.github/workflows/`, then add the secret `OPENUPTIME_API_KEY` and one for every
`${NAME}` the file uses. Pull requests from forks get no secrets, so their plan fails rather than seeing your key.

`node --test` runs the script's own tests against an in-memory stand-in for the API, without an account.

## Why a script and not a Terraform provider

This example is the first step towards managing monitors from Git. It answers what most teams ask for (review in pull
requests, the same result on every run, no credentials in the repository) with a single file you can read and change.

A Terraform provider would fit teams that already keep their infrastructure in Terraform: monitors next to the
services they check, shared state, `terraform import`. It also brings a state file, a provider release for every new
monitor field and a Go code base. A CLI would package this script with more output formats.

Which one comes next depends on what people use this for. If you would rather have a Terraform provider or a CLI, say
so in an issue on GitHub.
