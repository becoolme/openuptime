import { afterEach, describe, expect, it, vi } from "vitest";
import { configureEmail, sendEmail, setMailTransport } from "./email";

const msg = { to: "a@example.com", subject: "s", html: "<p>x</p>", text: "x", headers: { "List-Unsubscribe": "<https://x/u>" } };

describe("sendEmail through the Cloudflare binding", () => {
  afterEach(() => { setMailTransport(undefined); vi.restoreAllMocks(); });

  it("passes custom headers along", async () => {
    const send = vi.fn(async (_m: Record<string, unknown>) => ({}));
    configureEmail({ EMAIL: { send }, EMAIL_FROM: "alerts@example.com", WEB_ORIGIN: "https://x" } as never);
    await sendEmail(msg);
    expect(send).toHaveBeenCalledTimes(1);
    expect(send.mock.calls[0][0]).toMatchObject({ headers: msg.headers });
  });

  it("sends again without the headers when the binding refuses them", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const send = vi.fn(async (m: Record<string, unknown>) => { if (m.headers) throw new Error("unknown field headers"); return {}; });
    configureEmail({ EMAIL: { send }, EMAIL_FROM: "alerts@example.com", WEB_ORIGIN: "https://x" } as never);
    await sendEmail(msg);
    expect(send).toHaveBeenCalledTimes(2);
    expect(send.mock.calls[1][0]).not.toHaveProperty("headers");
  });

  it("still fails when the message is refused without headers too", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    configureEmail({ EMAIL: { send: async () => { throw new Error("rejected"); } }, EMAIL_FROM: "alerts@example.com", WEB_ORIGIN: "https://x" } as never);
    await expect(sendEmail(msg)).rejects.toThrow("rejected");
  });
});
