import { describe, expect, it } from "vitest";
import { newWebhookSecret, signWebhook, WEBHOOK_SECRET_RE, webhookHeaders } from "./webhook-signing";

describe("webhook signing", () => {
  it("matches the Standard Webhooks reference signature", async () => {
    const sig = await signWebhook("whsec_MfKQ9r8GKYqrTwjUPD8ILPZIo2LaLaSw", "msg_p5jXN8AQM9LWM0D4loKWxJek", 1614265330, '{"test": 2432232314}');
    expect(sig).toBe("v1,g0hM9SsE+OTPJTGt/tmIKtSyZlE3uFJELVlNIOLJ1OE=");
  });

  it("creates distinct secrets in the accepted format", () => {
    const a = newWebhookSecret();
    expect(a).toMatch(WEBHOOK_SECRET_RE);
    expect(a).not.toBe(newWebhookSecret());
    for (const bad of ["", "whsec_", "whsec_short", "MfKQ9r8GKYqrTwjUPD8ILPZIo2LaLaSw", "whsec_not base64 at all, really not"]) expect(bad).not.toMatch(WEBHOOK_SECRET_RE);
  });

  it("always sends the id and timestamp, and signs only with a secret", async () => {
    const now = 1_700_000_000_123;
    expect(await webhookHeaders("d1", "{}", undefined, now)).toEqual({ "webhook-id": "d1", "webhook-timestamp": "1700000000" });
    const secret = newWebhookSecret();
    const signed = await webhookHeaders("d1", "{}", secret, now);
    expect(signed["webhook-signature"]).toBe(await signWebhook(secret, "d1", 1700000000, "{}"));
  });
});
