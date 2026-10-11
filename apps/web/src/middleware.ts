import { defineMiddleware } from "astro:middleware";
import { pickLocale } from "./lib/i18n";

// Only the public status pages are rendered per request; everything else is static HTML that localises itself in the browser.
// /zh-Hans/status/x is Chinese: the prefix route rewrites to /status/x and forwards the language in `x-ou-lang`.
export const onRequest = defineMiddleware(async (ctx, next) => {
  if (!ctx.isPrerendered) {
    // set by the /[locale]/ route when it rewrites /zh-Hans/... to an unprefixed page
    const forced = ctx.request.headers.get("x-ou-lang") === "zh-CN";
    ctx.locals.lang = forced
      ? "zh-CN"
      : pickLocale(ctx.request.headers.get("cookie"), ctx.request.headers.get("accept-language"), new URL(ctx.request.url).pathname);
  }
  return next();
});
