import { appendFileSync } from "node:fs";
import type { Reporter, TestCase, TestResult, TestStep } from "@playwright/test/reporter";

/** Values that must never reach a log line or the job summary. */
const SECRETS = ["LOGIN_PASSWORD", "LOGIN_EMAIL", "OPENUPTIME_HEARTBEAT_URL"]
  .map((k) => process.env[k])
  .filter((v): v is string => Boolean(v && v.length >= 4));

// eslint-disable-next-line no-control-regex
const ANSI = /\x1b\[[0-9;]*m/g;

/** Removes the configured secrets, typed input values and anything labelled as a password or token. */
export const redact = (text: string, secrets: string[] = SECRETS) =>
  secrets
    .reduce((t, s) => t.split(s).join("[redacted]"), text.replace(ANSI, ""))
    .replace(/\bvalue="[^"]*"/gi, 'value="[redacted]"')
    .replace(/(password|passwd|token|secret)(["':=\s]+)[^\s"',}]+/gi, "$1$2[redacted]");

/** The innermost user step (test.step) that failed, so an alert can say "Sign in" rather than "test failed". */
function failedStep(steps: TestStep[]): TestStep | undefined {
  for (const s of steps) {
    if (!s.error) continue;
    const inner = failedStep(s.steps);
    return inner ?? (s.category === "test.step" ? s : undefined);
  }
  return undefined;
}

/**
 * Prints one line per test, and for a failure the step it failed at and the first lines of the error, redacted. When
 * GITHUB_STEP_SUMMARY is set (in GitHub Actions) the failures also go to the job summary.
 */
export default class StepReporter implements Reporter {
  private failures: string[] = [];

  onTestEnd(test: TestCase, result: TestResult) {
    const retrying = result.status !== "passed" && result.status !== "skipped" && result.retry < test.retries;
    const mark = result.status === "passed" ? "passed" : retrying ? `failed, retrying (${result.retry + 1}/${test.retries})` : result.status;
    console.log(`${test.title}: ${mark} in ${result.duration} ms`);
    if (result.status === "passed" || result.status === "skipped" || retrying) return;
    const step = failedStep(result.steps)?.title ?? "(before the first step)";
    const lines = redact(result.error?.message ?? "no error message").split("\n").map((l) => l.trimEnd()).filter(Boolean);
    console.log(`  failed at step: ${step}\n${lines.slice(0, 6).map((l) => `  ${l}`).join("\n")}`);
    this.failures.push(`- **${test.title}** failed at step **${step}**: ${lines[0]?.slice(0, 300) ?? ""}`);
  }

  onEnd() {
    if (!this.failures.length || !process.env.GITHUB_STEP_SUMMARY) return;
    appendFileSync(process.env.GITHUB_STEP_SUMMARY, ["### Browser check failed", "", ...this.failures, ""].join("\n") + "\n");
  }
}
