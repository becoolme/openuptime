#!/usr/bin/env node
// Keeps the monitors of one OpenUptime project in step with a JSON file, over the REST API.
//
//   node sync.mjs plan  [--config monitors.json] [--prune]   shows what apply would change; changes nothing
//   node sync.mjs apply [--config monitors.json] [--prune]   makes those changes
//
// Environment: OPENUPTIME_API_KEY (required), OPENUPTIME_URL (default https://openuptime.app),
// OPENUPTIME_PROJECT_ID (optional; the workspace's default project, or a limited key's first project, otherwise). Any "${NAME}" in a string value of the config
// is replaced by the environment variable NAME, so tokens come from CI secrets and never sit in the file.
//
// Only monitors created by this script are managed: they carry the config's `source` and their `key`. Monitors made
// in the app are never changed or deleted. Node 20 or newer, no dependencies.

import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";

const MASK = "••••••••";
/** Keys of a config entry that are not monitor fields. */
const OWN_KEYS = new Set(["key", "channels"]);
/** Fields the import endpoint does not take from a record; they are set by an update right after creation. */
const AFTER_CREATE = new Set(["paused"]);
const KEY = /^[a-z0-9][a-z0-9._-]{0,99}$/;

/** Replaces each "${NAME}" in the strings of `value` with process.env.NAME; a variable that is not set is an error. */
export function substitute(value, env = process.env, where = "config") {
  if (typeof value === "string") {
    return value.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g, (_, name) => {
      if (env[name] === undefined) throw new Error(`${where}: environment variable ${name} is not set`);
      return env[name];
    });
  }
  if (Array.isArray(value)) return value.map((v, i) => substitute(v, env, `${where}[${i}]`));
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, substitute(v, env, `${where}.${k}`)]));
  return value;
}

/** Checks the shape of a config file and returns it with environment variables filled in. */
export function readConfig(raw, env = process.env) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("The config must be an object with source and monitors");
  const { source, monitors } = raw;
  if (typeof source !== "string" || !/^[a-zA-Z0-9._:-]{1,80}$/.test(source)) throw new Error("source must be 1 to 80 letters, digits or . _ : -, such as config:production");
  if (!Array.isArray(monitors)) throw new Error("monitors must be a list");
  const seen = new Set();
  const out = monitors.map((m, i) => {
    const where = `monitors[${i}]`;
    if (!m || typeof m !== "object" || Array.isArray(m)) throw new Error(`${where} must be an object`);
    if (typeof m.key !== "string" || !KEY.test(m.key)) throw new Error(`${where}.key must be lowercase letters, digits and . _ -, up to 100 characters`);
    if (seen.has(m.key)) throw new Error(`${where}.key "${m.key}" is used twice`);
    seen.add(m.key);
    if (typeof m.name !== "string" || typeof m.type !== "string") throw new Error(`${where} (${m.key}) needs a name and a type`);
    if (m.channels !== undefined && !(Array.isArray(m.channels) && m.channels.every((c) => typeof c === "string"))) throw new Error(`${where}.channels must be a list of channel names`);
    return substitute(m, env, where);
  });
  return { source, monitors: out };
}

/** JSON with object keys sorted, so two values compare equal whatever order their keys were written in. */
const canonical = (v) => JSON.stringify(v, (_, x) => (x && typeof x === "object" && !Array.isArray(x) ? Object.fromEntries(Object.keys(x).sort().map((k) => [k, x[k]])) : x));
const same = (a, b) => canonical(a ?? null) === canonical(b ?? null);
const hasMask = (v) => typeof v === "string" ? v === MASK : v && typeof v === "object" ? Object.values(v).some(hasMask) : false;

/** The fields of a config entry that differ from the stored monitor: { field: { from, to } }. */
export function diffMonitor(want, current, channelIds) {
  const changes = {};
  for (const [k, v] of Object.entries(want)) {
    if (OWN_KEYS.has(k) || k === "type") continue;
    if (k === "paused" ? Boolean(current.paused) !== Boolean(v) : !same(v, current[k])) {
      if (hasMask(current[k])) throw new Error(`${want.key}: ${k} is masked for this API key, so it cannot be compared; use a key of an owner or admin`);
      changes[k] = { from: current[k] ?? null, to: v };
    }
  }
  if (channelIds && !same([...channelIds].sort(), [...(current.channelIds ?? [])].sort())) changes.channelIds = { from: current.channelIds ?? [], to: channelIds };
  return changes;
}

/** A minimal client for the endpoints the sync uses. `fetch` can be replaced, which is what the tests do. */
export function client({ baseUrl = "https://openuptime.app", apiKey, projectId, fetch: f = globalThis.fetch } = {}) {
  if (!apiKey) throw new Error("Set OPENUPTIME_API_KEY to an API key of the workspace");
  if (projectId === "all") throw new Error("OPENUPTIME_PROJECT_ID must name one project; a config file manages the monitors of a single project");
  const root = baseUrl.replace(/\/+$/, "") + "/api";
  const call = async (method, path, body) => {
    const headers = { "x-api-key": apiKey, accept: "application/json" };
    if (projectId) headers["x-project-id"] = projectId;
    if (body !== undefined) headers["content-type"] = "application/json";
    const res = await f(root + path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
    const text = await res.text();
    const data = text ? JSON.parse(text) : null;
    if (!res.ok && !(path.startsWith("/monitors/import") && data?.report)) throw new Error(`${method} ${path}: ${res.status} ${data?.error ?? text.slice(0, 200)}`);
    return data;
  };
  return {
    monitors: () => call("GET", "/monitors"),
    channels: () => call("GET", "/channels"),
    importMonitors: (source, monitors, preview) => call("POST", preview ? "/monitors/import/preview" : "/monitors/import", { source, format: "json", monitors }),
    update: (id, patch) => call("PATCH", `/monitors/${id}`, patch),
    remove: (id) => call("DELETE", `/monitors/${id}`),
  };
}

/** The record sent to the import endpoint for a new monitor. */
const importRecord = (m) => Object.fromEntries([...Object.entries(m).filter(([k]) => !OWN_KEYS.has(k) && !AFTER_CREATE.has(k)), ["sourceId", m.key]]);

/**
 * Compares the config with the project and returns the steps apply would take: creates, updates, deletes (with
 * `prune`) and problems. New monitors are checked by the server's import preview, so a bad target shows up here.
 */
export async function plan(config, api, { prune = false } = {}) {
  const [monitors, channels] = await Promise.all([api.monitors(), config.monitors.some((m) => m.channels) ? api.channels() : []]);
  const byName = new Map(channels.map((c) => [c.name, c.id]));
  const managed = new Map(monitors.filter((m) => m.importSource === config.source).map((m) => [m.importSourceId, m]));
  const steps = { create: [], update: [], remove: [], unchanged: [], problems: [] };
  for (const want of config.monitors) {
    let channelIds;
    if (want.channels) {
      const missing = want.channels.filter((n) => !byName.has(n));
      if (missing.length) { steps.problems.push({ key: want.key, error: `No alert channel named ${missing.map((n) => `"${n}"`).join(", ")} in this project` }); continue; }
      channelIds = want.channels.map((n) => byName.get(n));
    }
    const current = managed.get(want.key);
    if (!current) { steps.create.push({ key: want.key, want, channelIds }); continue; }
    if (current.type !== want.type) { steps.problems.push({ key: want.key, error: `type cannot change (${current.type} to ${want.type}); give the monitor a new key to replace it` }); continue; }
    try {
      const changes = diffMonitor(want, current, channelIds);
      if (Object.keys(changes).length) steps.update.push({ key: want.key, id: current.id, changes });
      else steps.unchanged.push({ key: want.key, id: current.id });
    } catch (e) { steps.problems.push({ key: want.key, error: e.message }); }
  }
  const wanted = new Set(config.monitors.map((m) => m.key));
  const extra = [...managed.values()].filter((m) => !wanted.has(m.importSourceId));
  if (prune) steps.remove = extra.map((m) => ({ key: m.importSourceId, id: m.id, name: m.name }));
  else steps.kept = extra.map((m) => ({ key: m.importSourceId, id: m.id, name: m.name }));
  if (steps.create.length) {
    const preview = await api.importMonitors(config.source, steps.create.map((c) => importRecord(c.want)), true);
    for (const row of preview.report ?? []) {
      if (row.status === "skipped" || row.error) steps.problems.push({ key: steps.create[row.index].key, error: row.error ?? "refused by the server" });
    }
    if (preview.capacity) steps.problems.push({ key: "*", error: `The plan allows ${preview.capacity.max} active monitors; this config needs more` });
  }
  return steps;
}

/** Carries out a plan. Stops before changing anything when the plan has problems. */
export async function apply(config, api, steps) {
  if (steps.problems.length) throw new Error("The plan has problems; fix them before applying");
  const done = { created: [], updated: [], removed: [] };
  if (steps.create.length) {
    const result = await api.importMonitors(config.source, steps.create.map((c) => importRecord(c.want)), false);
    const failed = (result.report ?? []).filter((r) => r.status !== "created");
    if (failed.length || result.code) throw new Error(`Creating monitors failed: ${result.error ?? failed.map((r) => `${steps.create[r.index].key}: ${r.error ?? r.status}`).join("; ")}`);
    // the import attaches the project's auto-enabled channels and skips some fields; one update sets the rest
    const now = new Map((await api.monitors()).filter((m) => m.importSource === config.source).map((m) => [m.importSourceId, m]));
    for (const c of steps.create) {
      const m = now.get(c.key);
      if (!m) throw new Error(`${c.key}: created, but not found afterwards`);
      const changes = diffMonitor(c.want, m, c.channelIds);
      if (Object.keys(changes).length) await api.update(m.id, Object.fromEntries(Object.entries(changes).map(([k, v]) => [k, v.to])));
      done.created.push(c.key);
    }
  }
  for (const u of steps.update) {
    await api.update(u.id, Object.fromEntries(Object.entries(u.changes).map(([k, v]) => [k, v.to])));
    done.updated.push(u.key);
  }
  for (const r of steps.remove) { await api.remove(r.id); done.removed.push(r.key); }
  return done;
}

const short = (v) => { const s = typeof v === "string" ? JSON.stringify(v) : canonical(v); return s.length > 80 ? s.slice(0, 77) + "..." : s; };
/** Header values and bodies can hold credentials: the plan shows that they change, not what they are. */
const shown = (field, v) => (field === "headers" && v && typeof v === "object" ? short(Object.fromEntries(Object.keys(v).map((k) => [k, "…"]))) : field === "requestBody" && v ? '"…"' : short(v));

/** The plan as text, one line per monitor. */
export function describe(steps) {
  const lines = [];
  for (const c of steps.create) lines.push(`+ create  ${c.key}  (${c.want.type} ${c.want.target || "heartbeat"})`);
  for (const u of steps.update) {
    lines.push(`~ update  ${u.key}`);
    for (const [k, v] of Object.entries(u.changes)) lines.push(`      ${k}: ${shown(k, v.from)} -> ${shown(k, v.to)}`);
  }
  for (const r of steps.remove) lines.push(`- delete  ${r.key}  (${r.name})`);
  for (const k of steps.kept ?? []) lines.push(`! not in the config: ${k.key} (${k.name}); kept, run with --prune to delete it`);
  for (const p of steps.problems) lines.push(`x ${p.key}: ${p.error}`);
  const n = steps.create.length + steps.update.length + steps.remove.length;
  lines.push(n ? `${steps.create.length} to create, ${steps.update.length} to update, ${steps.remove.length} to delete, ${steps.unchanged.length} unchanged` : `No changes. ${steps.unchanged.length} monitors match the config.`);
  return lines.join("\n");
}

async function main(argv) {
  const [command, ...rest] = argv;
  if (command !== "plan" && command !== "apply") { console.error("Usage: node sync.mjs plan|apply [--config monitors.json] [--prune]"); return 64; }
  const flag = (name) => { const i = rest.indexOf(name); return i >= 0 ? rest[i + 1] : undefined; };
  const config = readConfig(JSON.parse(await readFile(flag("--config") ?? "monitors.json", "utf8")));
  const api = client({ baseUrl: process.env.OPENUPTIME_URL, apiKey: process.env.OPENUPTIME_API_KEY, projectId: process.env.OPENUPTIME_PROJECT_ID || undefined });
  const steps = await plan(config, api, { prune: rest.includes("--prune") });
  console.log(describe(steps));
  if (steps.problems.length) return 1;
  if (command === "apply") {
    const done = await apply(config, api, steps);
    console.log(`Applied: ${done.created.length} created, ${done.updated.length} updated, ${done.removed.length} deleted.`);
  }
  return 0;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  main(process.argv.slice(2)).then((code) => { process.exitCode = code; }, (e) => { console.error(`Error: ${e.message}`); process.exitCode = 1; });
}
