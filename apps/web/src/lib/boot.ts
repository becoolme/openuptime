import { api, prefetch } from "./api";
import { translate, type Locale } from "./i18n";

// Runs from the static shell as soon as it is parsed: start every read the page needs, then fill in the bits of the
// shell that depend on who is looking (labels, identity, counts). The HTML itself is identical for everyone.
prefetch(location.pathname);

const lang = (document.documentElement.lang === "zh-CN" ? "zh-CN" : "en") as Locale;
document.querySelectorAll<HTMLElement>("[data-t]").forEach((el) => {
  el.textContent = translate(lang, el.textContent ?? "");
});
document.querySelectorAll<HTMLElement>("[aria-label]").forEach((el) => {
  el.setAttribute("aria-label", translate(lang, el.getAttribute("aria-label") ?? ""));
});

api.me().then((me) => {
  const name = me.user?.name || me.user?.email || "";
  document.querySelectorAll<HTMLElement>("[data-me=name]").forEach((el) => (el.textContent = name));
  document.querySelectorAll<HTMLElement>("[data-me=email]").forEach((el) => (el.textContent = me.user?.email ?? ""));
  // first visit: remember the language in use so emails to this user match it (plain fetch: api.* mutations drop the prefetched reads)
  if (me.user && !me.user.locale) {
    fetch("/api/me/locale", { method: "PATCH", credentials: "include", headers: { "content-type": "application/json" }, body: JSON.stringify({ locale: lang }) }).catch(() => {});
  }
}).catch(() => {});

api.counts().then((c) => {
  document.querySelectorAll<HTMLElement>("[data-count]").forEach((el) => {
    const k = el.getAttribute("data-count") ?? "";
    const n = c[k];
    if (n == null) return;
    el.textContent = String(n);
    el.hidden = !(n > 0);
    el.className = k === "incidents" && n > 0 ? "cnt" : "";
  });
}).catch(() => {});
