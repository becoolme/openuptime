/**
 * Where the iOS app can be installed. Leave empty while the app is not public yet: /ios then shows "Coming soon".
 * Set it to the TestFlight public link for a beta, and to the App Store link once the app is approved.
 */
export const IOS_INSTALL_URL = "https://testflight.apple.com/join/6cqKNY9q";

/** What the /ios page offers: nothing yet, a TestFlight beta, or the App Store. */
export function iosInstall(url: string = IOS_INSTALL_URL): { kind: "soon" | "testflight" | "appstore"; url: string } {
  if (!url) return { kind: "soon", url: "" };
  return { kind: /^https:\/\/testflight\.apple\.com\//.test(url) ? "testflight" : "appstore", url };
}
