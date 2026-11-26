import { generateKeyPairSync } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { configureWebBotAuth } from "@openuptime/kit/webbotauth";
import type { OpenDatabase } from "@openuptime/repo";
import { createApp } from "./app";

// the directory is answered before a database is opened, so a database that throws proves it is never touched
const openDatabase = (() => { throw new Error("database must not be opened"); }) as unknown as OpenDatabase;
const URL_ = "https://api.example.com/.well-known/http-message-signatures-directory";

afterEach(() => configureWebBotAuth({}));

describe("web bot auth key directory", () => {
  it("is not found when signing is not configured", async () => {
    const res = await createApp(openDatabase).request(URL_, {}, {});
    expect(res.status).toBe(404);
  });

  it("serves the signed public key and never the private half", async () => {
    const { privateKey } = generateKeyPairSync("ed25519");
    const jwk = privateKey.export({ format: "jwk" }) as { x: string; d: string };
    const env = { CHECK_SIGNING_KEY: JSON.stringify({ kty: "OKP", crv: "Ed25519", x: jwk.x, d: jwk.d }), CHECK_SIGNATURE_AGENT: "https://api.example.com" };
    const res = await createApp(openDatabase).request(URL_, {}, env);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("application/http-message-signatures-directory+json");
    expect(res.headers.get("signature-input")).toContain('tag="http-message-signatures-directory"');
    expect(res.headers.get("signature")).toMatch(/^sig1=:.+:$/);
    const text = await res.text();
    expect(JSON.parse(text)).toEqual({ keys: [{ kty: "OKP", crv: "Ed25519", x: jwk.x }] });
    expect(text).not.toContain(jwk.d);
  });
});
