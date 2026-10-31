const CACHE_NAME = 'knowledgehub-shell-v7';
// Only files that render on their own: a cached app page would show unstyled when its CSS cannot load,
// so a failed navigation gets the self-contained connection notice instead.
const OFFLINE_PAGE = '/offline.html';
const APP_SHELL = [OFFLINE_PAGE, '/favicon.svg', '/icons/icon-192.png', '/icons/icon-512.png', '/manifest.webmanifest'];

self.addEventListener('install', event => {
  event.waitUntil(caches.open(CACHE_NAME).then(cache => cache.addAll(APP_SHELL)).catch(() => undefined));
  self.skipWaiting();
});

self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(key => key !== CACHE_NAME).map(key => caches.delete(key))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', event => {
  const url = new URL(event.request.url);
  if (event.request.method !== 'GET' || url.origin !== self.location.origin) return;
  // API failures belong to the application, not the offline shell.
  if (event.request.mode !== 'navigate' && !APP_SHELL.includes(url.pathname)) return;
  event.respondWith(
    fetch(event.request).catch(async () => {
      const cache = await caches.open(CACHE_NAME);
      if (event.request.mode !== 'navigate') {
        const cached = await cache.match(event.request);
        if (cached) return cached;
        return new Response('Không thể kết nối máy chủ.', { status: 503, headers: { 'Content-Type': 'text/plain; charset=utf-8' } });
      }
      const offline = await cache.match(OFFLINE_PAGE);
      if (offline) return new Response(offline.body, { status: 503, headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' } });
      return new Response('<!doctype html><html lang="vi"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Không kết nối được máy chủ</title><body style="font-family:system-ui,sans-serif;max-width:420px;margin:15vh auto;padding:0 24px"><h1 style="font-size:22px">Không kết nối được máy chủ</h1><p>Kiểm tra ứng dụng máy chủ đang chạy, sau đó tải lại trang.</p><button onclick="location.reload()">Thử lại</button></body></html>', {
        status: 503, headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' }
      });
    })
  );
});
