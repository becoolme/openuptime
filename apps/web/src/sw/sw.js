// OpenUptime service worker. Read this before changing it.
//
// What it does:
//   1. Makes the back office installable.
//   2. Keeps this build's own files (the hashed /_astro assets and the static /app shell) in a cache named after the
//      build, downloaded while the worker waits to activate, so an update opens fast and the app shell opens offline.
//   3. Answers a back-office page navigation with the cached shell (the client router renders the right page), or a
//      small offline page when there is neither a cache nor a network.
//
// What it must never do: touch data. The cache holds only the URLs in PRECACHE, which the build lists from /_astro and
// the shell, and they are written once, at install. The fetch handler reads from the cache only for those exact URLs.
// /api, /internal, auth redirects, uploads, POSTs, cross-origin requests and every other fetch() are left alone: the
// browser handles them exactly as it would without a service worker, so cookies, sessions and live data behave as before.
//
// A deploy changes the build id and the list, which makes this file differ, which is how open tabs learn that an
// update exists (lib/pwa.ts). The new worker installs in the background and waits until the person agrees to refresh;
// until then the old worker keeps serving the old cache, so a page and its assets always come from the same build.
//
// The build (src/sw/stamp.mjs) replaces the two placeholders below.

const VERSION = "__BUILD_ID__";
const PRECACHE = "__PRECACHE__";

const PREFIX = "ou-shell-";
const CACHE = PREFIX + VERSION;
const SHELL = "/app";
const APP_PAGE = /^\/(zh-Hans\/)?app(\/|$)/;
const URLS = Array.isArray(PRECACHE) ? PRECACHE : [];
const ASSETS = new Set(URLS.filter((u) => u !== SHELL));

self.addEventListener("install", (event) => {
  event.waitUntil(precache());
});

self.addEventListener("activate", (event) => {
  // earlier builds' caches (ours only: other names are not ours to delete)
  event.waitUntil(
    caches.keys().then((names) => Promise.all(names.filter((n) => n.startsWith(PREFIX) && n !== CACHE).map((n) => caches.delete(n)))),
  );
});

self.addEventListener("message", (event) => {
  const type = event.data && event.data.type;
  if (type === "SKIP_WAITING") self.skipWaiting();
  if (type === "VERSION" && event.source) event.source.postMessage({ type: "VERSION", version: VERSION });
});

self.addEventListener("fetch", (event) => {
  const request = event.request;
  if (request.method !== "GET") return;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;
  if (request.mode === "navigate") {
    if (APP_PAGE.test(url.pathname)) event.respondWith(page(request, url));
    return;
  }
  // exact, build-listed files only; anything else (including every /api call) falls through untouched
  if (ASSETS.has(url.pathname)) event.respondWith(asset(request, url));
});

async function precache() {
  const cache = await caches.open(CACHE);
  await Promise.all(
    URLS.map(async (path) => {
      // `reload`: straight from the server, so the shell is never an older copy out of the HTTP cache
      const res = await fetch(new Request(path, { cache: "reload" }));
      // a failed or redirected file fails the install; the previous worker (if any) keeps running and it is retried
      if (!res.ok || res.redirected) throw new Error("precache " + path + ": " + res.status);
      await cache.put(path, res);
    }),
  );
}

async function asset(request, url) {
  const hit = await caches.match(url.pathname, { cacheName: CACHE });
  return hit || fetch(request);
}

async function page(request, url) {
  const shell = await caches.match(SHELL, { cacheName: CACHE });
  if (shell) return shell;
  try {
    return await fetch(request);
  } catch (e) {
    return offline(url);
  }
}

function offline(url) {
  const zh = /^\/zh-Hans(\/|$)/.test(url.pathname) || /^zh/i.test((self.navigator && self.navigator.language) || "");
  const title = zh ? "当前处于离线状态" : "You are offline";
  const body = zh ? "无法连接到 OpenUptime。恢复网络后会自动重试。" : "OpenUptime can't be reached. This page retries when you are back online.";
  const retry = zh ? "重试" : "Retry";
  const html =
    '<!doctype html><html lang="' + (zh ? "zh-CN" : "en") + '"><head><meta charset="utf-8">' +
    '<meta name="viewport" content="width=device-width,initial-scale=1"><title>' + title + " · OpenUptime</title>" +
    "<style>:root{color-scheme:light dark}body{margin:0;min-height:100vh;display:grid;place-items:center;padding:24px;" +
    "font:16px/1.5 system-ui,-apple-system,'Segoe UI',sans-serif;background:#fafaf7;color:#0e1411}" +
    "main{max-width:420px;text-align:center}h1{font-size:22px;margin:0 0 8px}p{margin:0 0 20px;color:#5a635d}" +
    "button{font:inherit;padding:9px 18px;border-radius:10px;border:0;background:#0f9d58;color:#fff;cursor:pointer}" +
    "@media (prefers-color-scheme:dark){body{background:#0a0c0b;color:#f1f4f2}p{color:#a1aaa5}button{background:#3ddc84;color:#0a0c0b}}" +
    "</style></head><body><main><h1>" + title + "</h1><p>" + body + '</p><button onclick="location.reload()">' + retry +
    "</button></main><script>addEventListener('online',function(){location.reload()})</script></body></html>";
  return new Response(html, { status: 503, headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" } });
}
