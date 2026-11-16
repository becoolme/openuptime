# Browser check with Playwright

A scheduled sign-in run in GitHub Actions that reports to an OpenUptime **heartbeat monitor**. It catches the failure an
HTTP monitor misses: every request answers 200, yet a person cannot sign in.

```
GitHub Actions (every 15 min) ── Playwright signs in ──▶ passed ──▶ POST heartbeat URL
                                                      └─▶ failed ──▶ no ping, failed step in the job summary
OpenUptime: no ping within the heartbeat period + grace ──▶ incident and alerts
```

## Set up

1. In OpenUptime, create a **heartbeat** monitor. Set its period to the schedule (15 minutes) and a grace period of
   10 to 15 minutes: scheduled GitHub workflows often start several minutes late. Copy its ping URL.
2. Copy this folder into your repository and `workflow.yml` to `.github/workflows/browser-check.yml`. Change
   `working-directory` and the artifact path if the folder lives elsewhere.
3. Add the repository secrets `BASE_URL`, `LOGIN_EMAIL`, `LOGIN_PASSWORD` and `OPENUPTIME_HEARTBEAT_URL`, and
   optionally the variable `EXPECT_TEXT`, a text the signed-in page always shows. Use an account made for the check,
   with no more access than it needs.
4. Run the workflow once by hand (**Run workflow**) and check that the heartbeat monitor turns up.

`tests/sign-in.spec.ts` finds the form by its labels (email, password) and a "Sign in" or "Log in" button. Adjust the
selectors and steps for your site; each `test.step` title is the name the failure report uses.

Run it locally:

```bash
npm install && npx playwright install chromium
BASE_URL=https://staging.example.com LOGIN_EMAIL=... LOGIN_PASSWORD=... npx playwright test
```

## What a failure shows

The check retries once, so a single network blip does not alert. When both attempts fail:

- the heartbeat is not pinged, and OpenUptime opens an incident once the period and grace have passed;
- the job summary names the test and the step, for example `failed at step Sign in: TimeoutError: page.waitForURL:
  Timeout 15000ms exceeded.`;
- a screenshot of the page at the failure is kept as a workflow artifact for 7 days.

## Keeping the credentials out

- Traces and videos are off: a Playwright trace records every value typed into the page, the password included.
- Only the reporter in `step-reporter.ts` runs. Playwright's built-in reporters print the HTML of the element an
  assertion waited for, which for an input includes what was typed. This reporter strips ANSI colours, the secrets
  above, `value="…"` attributes and anything labelled as a password or token.
- The sign-in step waits for the address to leave the sign-in page instead of asserting on the password field, for
  the same reason.
- Only the screenshots are uploaded; the other files Playwright writes next to them (such as `error-context.md`) can
  contain typed values. Password fields are drawn masked in a screenshot, but the email address can be visible.
- GitHub masks the values of repository secrets in workflow logs as well.

Tested against a local OpenUptime install: a correct password passes; a wrong one fails at **Sign in** after the retry,
with neither the password nor the email in the output or the summary.

## Cost and limits (evaluation)

Measured locally, the test itself takes about 1 second; a full run in CI is dominated by `npm install` and
`playwright install --with-deps chromium`, which download the browser and system libraries on every run unless you
cache them. GitHub bills each job rounded up to the whole minute, so plan for at least 1 to 2 minutes per run: every 15
minutes that is 96 runs a day, roughly 2,900 to 5,800 minutes a month. Public repositories run free; for a private one,
compare that with the minutes included in your GitHub plan, or run less often, or on a self-hosted runner.

What this setup does not give you, and what a built-in browser monitor would have to add:

- **Speed of the alert.** A failure is known only when the heartbeat is missed, up to one period plus the grace after
  the run. OpenUptime's heartbeat has no "failed" ping yet, so the step that failed stays in GitHub, not on the incident.
- **Regions.** The run comes from wherever GitHub's runner is, not from the regions an HTTP monitor can use.
- **Isolation.** Running other people's browser scripts on shared probes needs a sandbox per run (no access to the
  probe's network or files, CPU and memory limits, a hard time limit) and a browser on every probe. That cost, per run
  and per region, is the main thing to measure before building it in.
