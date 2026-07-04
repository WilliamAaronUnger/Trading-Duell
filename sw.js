/* SPCX Trading-Duell – Service Worker (offline-fähig) */
const CACHE = "spcx-duell-v52";
const FILES = [
  "./",
  "./index.html",
  "./styles.css",
  "./qr.js",
  "./jsqr.js",
  "./data.js",
  "./game.js",
  "./manifest.json",
  "./icon-192.png",
  "./icon-512.png",
  "./apple-touch-icon.png"
];

self.addEventListener("install", e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(FILES)).then(() => self.skipWaiting()));
});

self.addEventListener("activate", e => {
  e.waitUntil(
    caches.keys().then(keys =>
      Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k)))
    ).then(() => self.clients.claim())
  );
});

/* Netzwerk zuerst, Cache als Fallback – so kommen Updates an, offline läuft's trotzdem.
   cache:"no-cache": beim Server revalidieren statt bis zu 10 Min alten HTTP-Cache zu
   akzeptieren (GitHub Pages max-age) – 304-Antworten bleiben billig, Updates kommen sofort.
   ignoreSearch: Teil-Links (?join=…/?vs=…) treffen offline die gecachte Seite. */
self.addEventListener("fetch", e => {
  e.respondWith(
    fetch(e.request, {cache:"no-cache"}).then(res => {
      const copy = res.clone();
      caches.open(CACHE).then(c => c.put(e.request, copy));
      return res;
    }).catch(() => caches.match(e.request, {ignoreSearch:true}))
  );
});
