// Railnote's service worker on a phone: the app opens without a connection, and vault/<path>
// serves attachments straight from the vault in IndexedDB (the database src/web/store.ts keeps).
const CACHE = "railnote-app-v1";
const TYPES = {
  png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif", webp: "image/webp", svg: "image/svg+xml", avif: "image/avif",
  mp3: "audio/mpeg", wav: "audio/wav", m4a: "audio/mp4", ogg: "audio/ogg", webm: "video/webm", mp4: "video/mp4", mov: "video/quicktime",
  pdf: "application/pdf", json: "application/json", canviz: "application/json", txt: "text/plain; charset=utf-8", md: "text/markdown; charset=utf-8",
};

// The first visit loads the page before this worker exists, so fetch the shell now: the page and
// every file it names. Chunks loaded later (diagrams, maths) are cached the first time they're used.
self.addEventListener("install", (e) =>
  e.waitUntil(
    (async () => {
      const c = await caches.open(CACHE);
      const page = await fetch("./", { cache: "no-cache" });
      const html = await page.clone().text();
      await c.put("./", page);
      const files = [...html.matchAll(/(?:src|href)="([^"#]+)"/g)].map((m) => m[1]).filter((u) => !/^(https?:)?\/\//.test(u));
      await c.addAll([...new Set(files)]).catch(() => {});
      await self.skipWaiting();
    })(),
  ),
);
self.addEventListener("activate", (e) => e.waitUntil(self.clients.claim()));

function vaultFile(path) {
  return new Promise((resolve) => {
    const req = indexedDB.open("railnote", 1);
    req.onerror = () => resolve(null);
    req.onsuccess = () => {
      try {
        const get = req.result.transaction("files").objectStore("files").get(path);
        get.onsuccess = () => resolve(get.result || null);
        get.onerror = () => resolve(null);
      } catch {
        resolve(null);
      }
    };
  });
}

self.addEventListener("fetch", (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== "GET" || url.origin !== location.origin || url.pathname.startsWith("/v1/")) return;
  const scope = new URL(self.registration.scope).pathname;
  if (url.pathname.startsWith(scope + "vault/")) {
    const path = url.pathname.slice(scope.length + 6).split("/").map(decodeURIComponent).join("/");
    e.respondWith(
      vaultFile(path).then((f) =>
        f ? new Response(f.bytes, { headers: { "content-type": TYPES[path.split(".").pop().toLowerCase()] || "application/octet-stream" } }) : new Response("Not in this vault", { status: 404 }),
      ),
    );
    return;
  }
  // Hashed build files never change: the cached copy is the copy. Everything else: network first.
  if (url.pathname.includes("/assets/")) {
    e.respondWith(caches.open(CACHE).then(async (c) => (await c.match(e.request)) || fetch(e.request).then((r) => (r.ok && c.put(e.request, r.clone()), r))));
    return;
  }
  e.respondWith(
    fetch(e.request)
      .then((r) => {
        if (r.ok) caches.open(CACHE).then((c) => c.put(e.request, r.clone()));
        return r;
      })
      .catch(async () => (await caches.match(e.request)) || (e.request.mode === "navigate" && (await caches.match(scope))) || Response.error()),
  );
});
