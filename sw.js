// PDF 결재 - 서비스 워커
// 1) 카카오톡 등에서 '공유'로 보낸 PDF 받기  2) 앱 파일 저장(오프라인 실행)
const VERSION = 'v1.0.1';           // 앱 파일을 고치면 이 값을 올려 주세요
const APP_CACHE = 'ds-app-' + VERSION;
const INBOX = 'ds-inbox';
const ASSETS = [
  './', './index.html', './app.js', './core.js', './manifest.webmanifest',
  './vendor/pdf.min.mjs', './vendor/pdf.worker.min.mjs', './vendor/pdf-lib.min.js',
  './icons/icon-192.png', './icons/icon-512.png',
];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(APP_CACHE).then(c => c.addAll(ASSETS)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', e => {
  e.waitUntil((async () => {
    for (const k of await caches.keys()) if (k.startsWith('ds-app-') && k !== APP_CACHE) await caches.delete(k);
    await self.clients.claim();
  })());
});

self.addEventListener('fetch', e => {
  const req = e.request;
  const url = new URL(req.url);
  if (req.method === 'POST' && url.pathname.endsWith('/share-target')) { e.respondWith(receiveShare(req)); return; }
  if (req.method !== 'GET' || url.origin !== self.location.origin) return;
  e.respondWith(url.pathname.includes('/vendor/') ? cacheFirst(req) : networkFirst(req));
});

async function receiveShare(req) {
  const back = q => Response.redirect(new URL('./?' + q, self.registration.scope).href, 303);
  try {
    const fd = await req.formData();
    const file = fd.getAll('file').find(f => f && typeof f !== 'string');
    if (!file) return back('shared=none');
    const c = await caches.open(INBOX);
    await c.put(new URL('./inbox', self.registration.scope).href, new Response(file, {
      headers: { 'content-type': 'application/pdf', 'x-name': encodeURIComponent(file.name || '문서.pdf') },
    }));
    return back('shared=1');
  } catch (err) {
    return back('shared=none');
  }
}

async function networkFirst(req) {
  const c = await caches.open(APP_CACHE);
  try {
    const res = await fetch(req);
    if (res.ok && !new URL(req.url).search) c.put(req, res.clone());
    return res;
  } catch {
    return (await c.match(req, { ignoreSearch: true })) || (await c.match('./index.html')) || Response.error();
  }
}

async function cacheFirst(req) {
  const c = await caches.open(APP_CACHE);
  const hit = await c.match(req);
  if (hit) return hit;
  const res = await fetch(req);
  if (res.ok) c.put(req, res.clone());
  return res;
}
