import { spawn, type ChildProcess } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer, type Server } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { SIGNATURE_HEADER, TIMESTAMP_HEADER, signProbe } from "../../api/src/probe-protocol";

// The Docker image runs the esbuild bundle under plain Node, which words module errors differently from vitest. This
// builds the same bundle and drives it over HTTP, so what ships is what is tested.
const secret = "a-long-enough-shared-secret";
let dir = "";
let child: ChildProcess;
let tcp: Server;
let base = "";
let tcpPort = 0;

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "ou-probe-"));
  const outfile = join(dir, "server.mjs");
  await build({
    entryPoints: [fileURLToPath(new URL("./server.ts", import.meta.url))],
    outfile, bundle: true, platform: "node", target: "node22", format: "esm", logLevel: "silent",
    banner: { js: "import{createRequire as __cr}from'node:module';const require=__cr(import.meta.url);" },
  });
  tcp = createServer((s) => s.end());
  await new Promise<void>((r) => tcp.listen(0, "127.0.0.1", r));
  tcpPort = (tcp.address() as { port: number }).port;
  child = spawn(process.execPath, [outfile], { env: { ...process.env, PORT: "0", HOST: "127.0.0.1", PROBE_SECRET: secret, ALLOW_PRIVATE_TARGETS: "true" }, stdio: ["ignore", "pipe", "inherit"] });
  base = await new Promise<string>((resolve, reject) => {
    child.on("error", reject);
    child.on("exit", (code) => reject(new Error(`probe exited with ${code}`)));
    child.stdout!.on("data", (d: Buffer) => {
      const m = /listening on [\d.]+:(\d+)/.exec(String(d));
      if (m) resolve(`http://127.0.0.1:${m[1]}/`);
    });
  });
});

afterAll(async () => {
  child?.removeAllListeners("exit");
  child?.kill();
  tcp?.close();
  if (dir) await rm(dir, { recursive: true, force: true });
});

async function check(body: unknown) {
  const text = JSON.stringify(body);
  const ts = Math.floor(Date.now() / 1000);
  const res = await fetch(base, { method: "POST", headers: { [TIMESTAMP_HEADER]: String(ts), [SIGNATURE_HEADER]: await signProbe(secret, ts, text) }, body: text });
  return { status: res.status, body: (await res.json()) as { ok: boolean; error?: string } };
}

describe("the bundled probe under plain Node", () => {
  it("runs a tcp check", async () => {
    const up = await check({ type: "tcp", target: `127.0.0.1:${tcpPort}`, timeoutMs: 3000 });
    expect(up).toMatchObject({ status: 200, body: { ok: true } });
    tcp.close();
    const down = await check({ type: "tcp", target: `127.0.0.1:${tcpPort}`, timeoutMs: 3000 });
    expect(down.body.ok).toBe(false);
    expect(down.body.error).toMatch(/ECONNREFUSED/);
  });
});
