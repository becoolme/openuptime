import { describe, expect, it } from "vitest";
import { convertRecord, detectFormat, monitorsOf } from "./import-formats";
import robot from "./import-fixtures/uptimerobot-getmonitors.json";
import kuma from "./import-fixtures/uptime-kuma-backup.json";

const all = (format: "uptimerobot" | "uptime-kuma", list: unknown[]) => list.map((m) => convertRecord(format, m));
const basic = (s: string) => `Basic ${Buffer.from(s).toString("base64")}`;

describe("detecting the export format", () => {
  it("recognises an UptimeRobot answer, a Kuma backup and our own files", () => {
    expect(detectFormat(robot, monitorsOf(robot) as unknown[])).toBe("uptimerobot");
    expect(detectFormat(kuma, monitorsOf(kuma) as unknown[])).toBe("uptime-kuma");
    // the Kuma list alone, as the dashboard sends it
    expect(detectFormat({ monitors: kuma.monitorList }, kuma.monitorList)).toBe("uptime-kuma");
    expect(detectFormat({}, [{ name: "a", type: "http", target: "https://a.test" }])).toBe("json");
    expect(monitorsOf([{ a: 1 }])).toEqual([{ a: 1 }]);
  });
});

describe("UptimeRobot getMonitors", () => {
  const out = all("uptimerobot", robot.monitors);

  it("keeps the source ids and maps each supported type", () => {
    expect(out.map((o) => o.record?.sourceId ?? null)).toEqual([777000001, 777000002, 777000003, 777000004, 777000005, 777000006, 777000007]);
    expect(out[0].record).toEqual({ name: "Website", sourceId: 777000001, type: "http", target: "https://www.example.com", method: "GET", intervalSec: 300, timeoutMs: 30000 });
    expect(out[4].record).toMatchObject({ type: "tcp", target: "mail.example.com:25" });
    expect(out[5].record).toMatchObject({ type: "heartbeat", target: "", intervalSec: 86400 });
    expect(out[5].warnings.join(" ")).toMatch(/new heartbeat URL/);
    expect(out[6].record).toEqual({ name: "Router", sourceId: 777000007, type: "ping", target: "203.0.113.10", intervalSec: 300 });
    expect(convertRecord("uptimerobot", { id: 1, friendly_name: "x", type: 3, url: "https://Host.Example.com/" }).record).toMatchObject({ type: "ping", target: "host.example.com" });
  });

  it("turns the alerting keyword condition into the healthy one", () => {
    // "alert when it does not exist" is healthy when the text is there
    expect(out[1].record).toMatchObject({ keyword: "Pay now", keywordMode: "contains" });
    expect(out[2].record).toMatchObject({ keyword: "Service unavailable", keywordMode: "absent" });
    expect(out[2].warnings.join(" ")).toMatch(/ignoring case/);
    expect(out[2].warnings.join(" ")).toMatch(/Paused/);
    expect(out[1].warnings).toEqual(["Alert contacts are not imported; this project's auto-enabled channels apply"]);
  });

  it("carries basic authentication, headers and custom statuses", () => {
    // 204 up and 500 down are already how 2xx is judged, so nothing extra is needed
    expect(out[3].record).toMatchObject({ headers: { "X-Env": "production", Authorization: basic("monitor:redacted-test-password") } });
    expect(out[3].record).not.toHaveProperty("acceptedStatuses");
    const custom = (statuses: string) => convertRecord("uptimerobot", { id: 1, friendly_name: "x", type: 1, url: "https://a.test", custom_http_statuses: statuses }).record;
    expect(custom("401:1_204:0")).toMatchObject({ acceptedStatuses: "2xx,401,!204" });
    expect(out[3].warnings).toContain("Basic authentication carried over as an Authorization header");
  });

  it("explains what needs setting up by hand", () => {
    expect(convertRecord("uptimerobot", { id: 1, friendly_name: "x", type: 3, url: "" }).error).toMatch(/no hostname or IP address/);
    expect(convertRecord("uptimerobot", { id: 1, friendly_name: "x", type: 1, url: "https://a.test", http_username: "u", http_password: "p", http_auth_type: 2 }).error).toMatch(/digest/);
    expect(convertRecord("uptimerobot", { id: 1, friendly_name: "x", type: 9 }).error).toMatch(/type 9 is not supported/);
    expect(convertRecord("uptimerobot", { id: 1, friendly_name: "x", type: 1, url: "ftp://a.test" }).error).toMatch(/no http\(s\) URL/);
    expect(convertRecord("uptimerobot", "nope").error).toBeTruthy();
  });

  it("keeps intervals and timeouts inside our bounds", () => {
    expect(convertRecord("uptimerobot", { id: 1, friendly_name: "x", type: 1, url: "https://a.test", interval: 20, timeout: 60 }).record).toMatchObject({ intervalSec: 30, timeoutMs: 30000 });
  });
});

describe("Uptime Kuma 1.x backup", () => {
  const out = all("uptime-kuma", kuma.monitorList);
  const byName = (n: string) => out[kuma.monitorList.findIndex((m) => m.name === n)];

  it("maps HTTP, keyword, JSON query, port, DNS, ping and push monitors with their ids", () => {
    expect(byName("Homepage").record).toEqual({ name: "Homepage", sourceId: 1, type: "http", target: "https://www.example.com", method: "GET", intervalSec: 60, failureThreshold: 3, timeoutMs: 30000, tags: ["web"] });
    expect(byName("Login page").record).toMatchObject({ keyword: "Sign in", keywordMode: "contains", failureThreshold: 1, intervalSec: 120 });
    expect(byName("Status JSON").record).toMatchObject({ jsonAssertions: [{ path: "$.data.status", op: "equals", value: "ok" }], headers: { Accept: "application/json", Authorization: basic("monitor:redacted-test-password") } });
    expect(byName("Postgres port").record).toMatchObject({ type: "tcp", target: "db.example.com:5432", failureThreshold: 4 });
    expect(byName("MX records").record).toMatchObject({ type: "dns", target: "example.com", dnsRecordType: "MX" });
    expect(byName("Cron job").record).toMatchObject({ type: "heartbeat", target: "", intervalSec: 3600 });
    expect(byName("Gateway").record).toEqual({ name: "Gateway", sourceId: 7, type: "ping", target: "203.0.113.1", intervalSec: 60 });
    expect(convertRecord("uptime-kuma", { id: 1, name: "p", type: "ping", hostname: "2001:DB8::1", packetSize: 1200 })).toMatchObject({ record: { type: "ping", target: "2001:db8::1" }, warnings: [expect.stringMatching(/packet size/)] });
    expect(convertRecord("uptime-kuma", { id: 1, name: "p", type: "ping", hostname: "https://a.test" }).error).toMatch(/no hostname or IP address/);
    // the push token belongs to Kuma's URL and is never carried over
    expect(JSON.stringify(byName("Cron job").record)).not.toContain("redactedpushtoken");
  });

  it("reports what did not carry over", () => {
    expect(byName("Homepage").warnings).toEqual(["Certificate expiry alerts are not imported", "Notifications are not imported; this project's auto-enabled channels apply"]);
    expect(byName("Postgres port").warnings).toContain("Paused in Uptime Kuma; it starts checking here once imported");
    expect(byName("MX records").warnings.join(" ")).toMatch(/resolver/);
  });

  it("refuses monitors that need setting up by hand, with a reason", () => {
    expect(["Containers", "Production", "Maintenance flag"].map((n) => byName(n).error)).toEqual([
      expect.stringMatching(/Docker/), expect.stringMatching(/Groups/), expect.stringMatching(/Upside down/),
    ]);
    expect(convertRecord("uptime-kuma", { id: 1, name: "q", type: "json-query", url: "https://a.test", jsonPath: "$count(items) > 1" }).error).toMatch(/JSON query/);
    expect(convertRecord("uptime-kuma", { id: 1, name: "n", type: "http", url: "https://a.test", authMethod: "ntlm" }).error).toMatch(/ntlm/);
    expect(convertRecord("uptime-kuma", { id: 1, name: "h", type: "http", url: "https://a.test", headers: "{oops" }).error).toMatch(/headers/);
    expect(convertRecord("uptime-kuma", { id: 1, name: "d", type: "dns", hostname: "a.test", dns_resolve_type: "CAA" }).error).toMatch(/CAA/);
    expect(convertRecord("uptime-kuma", { id: 1, name: "pg", type: "postgres", databaseConnectionString: "postgres://u:p@h/db" }).error).toMatch(/credentials/);
  });

  it("brackets an IPv6 host and carries accepted status lists", () => {
    expect(convertRecord("uptime-kuma", { id: 1, name: "v6", type: "port", hostname: "2001:db8::1", port: 443 }).record).toMatchObject({ target: "[2001:db8::1]:443" });
    const r = convertRecord("uptime-kuma", { id: 1, name: "c", type: "http", url: "https://a.test", accepted_statuscodes: ["200-299", "301"] });
    expect(r).toMatchObject({ record: { acceptedStatuses: "200-299,301" }, warnings: [] });
    expect(convertRecord("uptime-kuma", { id: 1, name: "c", type: "http", url: "https://a.test", accepted_statuscodes: ["teapot"] }).warnings.join(" ")).toMatch(/Accepted status codes/);
    expect(convertRecord("uptime-kuma", { id: 1, name: "c", type: "http", url: "https://a.test", accepted_statuscodes: ["204"] }).record).toMatchObject({ expectedStatus: 204 });
  });
});
