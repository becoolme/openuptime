import { describe, expect, it } from "vitest";
import { isWebhookSecret, newWebhookSecret, signWebhook, webhookHeaders } from "./webhook-signing";

describe("webhook signing", () => {
  it("matches the Standard Webhooks reference signature", async () => {
    const sig = await signWebhook("whsec_MfKQ9r8GKYqrTwjUPD8ILPZIo2LaLaSw", "msg_p5jXN8AQM9LWM0D4loKWxJek", 1614265330, '{"test": 2432232314}');
    expect(sig).toBe("v1,g0hM9SsE+OTPJTGt/tmIKtSyZlE3uFJELVlNIOLJ1OE=");
  });

  it("creates distinct secrets in the accepted format", () => {
    const a = newWebhookSecret();
    expect(isWebhookSecret(a)).toBe(true);
    expect(a).not.toBe(newWebhookSecret());
    for (const bad of ["", "whsec_", "whsec_short", "MfKQ9r8GKYqrTwjUPD8ILPZIo2LaLaSw", "whsec_not base64 at all, really not"]) expect(isWebhookSecret(bad)).toBe(false);
  });

  it("accepts 24 to 64 key bytes and nothing outside that", () => {
    const of = (n: number) => "whsec_" + btoa("k".repeat(n));
    for (const n of [24, 25, 26, 63, 64]) expect(isWebhookSecret(of(n))).toBe(true);
    for (const n of [23, 65, 66, 68]) expect(isWebhookSecret(of(n))).toBe(false);
  });

  it("always sends the id and timestamp, and signs only with a secret", async () => {
    const now = 1_700_000_000_123;
    expect(await webhookHeaders("d1", "{}", undefined, now)).toEqual({ "webhook-id": "d1", "webhook-timestamp": "1700000000" });
    const secret = newWebhookSecret();
    const signed = await webhookHeaders("d1", "{}", secret, now);
    expect(signed["webhook-signature"]).toBe(await signWebhook(secret, "d1", 1700000000, "{}"));
  });
});
