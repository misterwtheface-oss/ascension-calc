/*
  sw.js — Ascension talent calculator service worker (Tier 1: cache correctness + offline).

  Every script, data file and image URL carries ?v=<content hash> (rule A-cache-bust), but index.html itself cannot:
  GitHub Pages serves it max-age=600, so a stale shell would point at old hashes. Navigations are therefore
  network-first; everything else is versioned by URL and served cache-first.

    navigation / HTML -> network-first (SHELL, purged every deploy)
    /assets/*         -> cache-first  (ASSETS, stable name: a code deploy does not re-download the art)
    other same-origin -> cache-first  (SHELL)

  BUILD is stamped by tools/app/stamp_cache.py (data build + pre-commit hook).
*/
const BUILD = "73aee8c4";
const SHELL = `ascbc-shell-${BUILD}`;
const ASSETS = "ascbc-assets";
const KEEP = new Set([SHELL, ASSETS]);

self.addEventListener("install", () => self.skipWaiting());

self.addEventListener("activate", (e) => {
  e.waitUntil((async () => {
    const names = await caches.keys();
    await Promise.all(names.filter((n) => !KEEP.has(n)).map((n) => caches.delete(n)));
    await self.clients.claim();
  })());
});

const isNavigation = (req) =>
  req.mode === "navigate" || (req.headers.get("accept") || "").includes("text/html");

async function cacheFirst(request, cacheName) {
  const cache = await caches.open(cacheName);
  const hit = await cache.match(request);
  if (hit) return hit;
  const fresh = await fetch(request);
  if (fresh.ok) cache.put(request, fresh.clone());
  return fresh;
}

self.addEventListener("fetch", (e) => {
  const { request } = e;
  if (request.method !== "GET") return;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;

  if (isNavigation(request)) {
    e.respondWith((async () => {
      try {
        const fresh = await fetch(request);
        (await caches.open(SHELL)).put(request, fresh.clone());
        return fresh;
      } catch {
        const shell = await caches.open(SHELL);
        return (await shell.match(request, { ignoreSearch: true })) || (await shell.match("./")) || Response.error();
      }
    })());
    return;
  }
  e.respondWith(cacheFirst(request, url.pathname.includes("/assets/") ? ASSETS : SHELL));
});
