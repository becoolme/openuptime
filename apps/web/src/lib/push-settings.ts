/**
 * Where a person turns notifications back on for this site once their browser has blocked them. A web page cannot open a
 * browser's own settings (links to chrome:// and about: are refused), so the best it can do is name the right address
 * for them to paste into a new tab. `address` is null when the browser has no such address (Safari, phones).
 */
export type PushSettingsHelp = { browser: string; address: string | null; safari: boolean };

export function pushSettingsHelp(ua: string, origin: string, opts: { brave?: boolean } = {}): PushSettingsHelp {
  const mobile = /Android|iPhone|iPad|iPod/.test(ua);
  const site = encodeURIComponent(origin);
  if (/Edg\//.test(ua)) return { browser: "Edge", address: mobile ? null : `edge://settings/content/siteDetails?site=${site}`, safari: false };
  if (/OPR\//.test(ua)) return { browser: "Opera", address: mobile ? null : "opera://settings/content/notifications", safari: false };
  if (/Firefox\//.test(ua) || /FxiOS\//.test(ua)) return { browser: "Firefox", address: mobile ? null : "about:preferences#privacy", safari: false };
  if (/Chrome\//.test(ua) || /CriOS\//.test(ua)) {
    if (mobile) return { browser: "Chrome", address: null, safari: false };
    return opts.brave
      ? { browser: "Brave", address: `brave://settings/content/siteDetails?site=${site}`, safari: false }
      : { browser: "Chrome", address: `chrome://settings/content/siteDetails?site=${site}`, safari: false };
  }
  if (/Safari\//.test(ua)) return { browser: "Safari", address: null, safari: !mobile };
  return { browser: "", address: null, safari: false };
}
