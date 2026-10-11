/*! OpenUptime status embed. <script src="https://YOUR-HOST/embed.js" data-slug="my-page" async></script> */
(function () {
  var s = document.currentScript;
  if (!s || !s.dataset.slug) return;
  var d = s.dataset;
  var origin = new URL(s.src).origin;
  var slug = d.slug;
  var mode = d.mode === "banner" ? "banner" : "badge";
  var lang = d.lang || (document.documentElement.lang || "en");
  var COLORS = { operational: "#16a34a", degraded: "#d97706", outage: "#dc2626" };
  var dark = d.theme === "dark" || (d.theme !== "light" && window.matchMedia && matchMedia("(prefers-color-scheme: dark)").matches);

  var host = document.createElement("span");
  var shown = mode === "banner" ? "block" : "inline-block";
  host.style.display = "none";
  var root = host.attachShadow({ mode: "open" });
  var css = mode === "banner"
    ? ".b{display:flex;align-items:center;justify-content:center;gap:10px;padding:10px 16px;font:500 14px/1.4 system-ui,-apple-system,'Segoe UI',sans-serif;color:#fff;text-decoration:none;background:var(--c)}.i{width:8px;height:8px;border-radius:50%;background:#fff}"
    : ".b{display:inline-flex;align-items:center;gap:8px;padding:6px 12px;border-radius:999px;font:500 13px/1.3 system-ui,-apple-system,'Segoe UI',sans-serif;text-decoration:none;border:1px solid " + (dark ? "#2a2a2a" : "#e5e5e5") + ";background:" + (dark ? "#141414" : "#fff") + ";color:" + (dark ? "#f2f2f2" : "#1a1a1a") + "}.i{width:8px;height:8px;border-radius:50%;background:var(--c)}";
  root.innerHTML = "<style>" + css + "</style><a class=\"b\" target=\"_blank\" rel=\"noopener\"><i class=\"i\"></i><span class=\"t\"></span></a>";
  var a = root.querySelector("a");
  var t = root.querySelector(".t");

  // badge sits where the script tag is; the banner goes on top of the page
  if (d.target && document.querySelector(d.target)) document.querySelector(d.target).appendChild(host);
  else if (mode === "banner") document.body.insertBefore(host, document.body.firstChild);
  else s.parentNode.insertBefore(host, s.nextSibling);

  function load() {
    fetch(origin + "/api/public/status/" + encodeURIComponent(slug) + "/summary?lang=" + encodeURIComponent(lang))
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (j) {
        if (!j || !COLORS[j.overall]) return;
        host.style.display = mode === "banner" && j.overall === "operational" && d.always !== "true" ? "none" : shown;
        host.style.setProperty("--c", COLORS[j.overall]);
        a.style.setProperty("--c", COLORS[j.overall]);
        a.href = j.url;
        t.textContent = j.label;
      })
      .catch(function () {});
  }
  load();
  setInterval(load, 60000);
})();
