import { describe, expect, it } from "vitest";
import { pushSettingsHelp } from "./push-settings";

const O = "https://openuptime.app";
const CHROME = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36";
const EDGE = `${CHROME} Edg/130.0.0.0`;
const FIREFOX = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10.15; rv:132.0) Gecko/20100101 Firefox/132.0";
const SAFARI = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/605.1.15";
const IPHONE = "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1";
const ANDROID = "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Mobile Safari/537.36";

describe("pushSettingsHelp", () => {
  it("points Chrome at the site's own settings page", () => {
    expect(pushSettingsHelp(CHROME, O)).toEqual({ browser: "Chrome", address: "chrome://settings/content/siteDetails?site=https%3A%2F%2Fopenuptime.app", safari: false });
  });
  it("tells Edge, Brave, Firefox apart from Chrome", () => {
    expect(pushSettingsHelp(EDGE, O).address).toMatch(/^edge:\/\/settings\/content\/siteDetails/);
    expect(pushSettingsHelp(CHROME, O, { brave: true })).toMatchObject({ browser: "Brave", address: expect.stringMatching(/^brave:\/\//) });
    expect(pushSettingsHelp(FIREFOX, O)).toEqual({ browser: "Firefox", address: "about:preferences#privacy", safari: false });
  });
  it("has no address for Safari or phones, only Safari on a Mac gets the menu path", () => {
    expect(pushSettingsHelp(SAFARI, O)).toEqual({ browser: "Safari", address: null, safari: true });
    expect(pushSettingsHelp(IPHONE, O)).toEqual({ browser: "Safari", address: null, safari: false });
    expect(pushSettingsHelp(ANDROID, O)).toEqual({ browser: "Chrome", address: null, safari: false });
  });
  it("gives nothing for an unknown browser", () => {
    expect(pushSettingsHelp("curl/8", O)).toEqual({ browser: "", address: null, safari: false });
  });
});
