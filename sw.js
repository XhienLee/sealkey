const CACHE = 'sealkey-offline';
const FILES = [
    './',
    'css/app.css',
    'js/app.js',
    'js/bundle.js',
    'js/core.js',
    'js/format.js',
    'js/key.js',
    'js/save.js',
    'js/words.js',
    'js/worker.js',
    'vendor/client-zip/index.js',
    'vendor/libsodium/libsodium-wrappers.mjs',
    'vendor/libsodium/libsodium-sumo.mjs',
    'fonts/inter-latin-400-normal.woff2',
    'fonts/inter-latin-500-normal.woff2',
    'fonts/inter-latin-600-normal.woff2',
    'fonts/jetbrains-mono-latin-500-normal.woff2',
    'manifest.webmanifest',
    'icons/icon-192.png',
    'icons/icon-512.png',
    'icons/icon-maskable-512.png',
    'icons/apple-touch-icon.png',
];
const SCOPE = new URL('./', self.location).href;
const KNOWN = new Set(FILES.map((file) => new URL(file, SCOPE).href));

self.addEventListener('install', (event) => {
    event.waitUntil((async () => {
        const cache = await caches.open(CACHE);
        await cache.addAll(FILES.map((file) => new Request(file, { cache: 'reload' })));
        await self.skipWaiting();
    })());
});

self.addEventListener('activate', (event) => {
    event.waitUntil((async () => {
        for (const name of await caches.keys()) {
            if (name !== CACHE) await caches.delete(name);
        }
        await self.clients.claim();
    })());
});

function cacheKey(request) {
    const url = new URL(request.url);
    url.search = '';
    url.hash = '';
    if (request.mode === 'navigate' || url.href === new URL('index.html', SCOPE).href) return SCOPE;
    return url.href;
}

self.addEventListener('fetch', (event) => {
    const { request } = event;
    if (request.method !== 'GET') return;
    const key = cacheKey(request);
    if (!KNOWN.has(key)) return;
    event.respondWith((async () => {
        const cache = await caches.open(CACHE);
        try {
            const response = await fetch(request, { cache: 'no-store' });
            if (response.ok && response.type === 'basic') await cache.put(key, response.clone());
            return response;
        } catch {
            const saved = await cache.match(key);
            if (saved) return saved;
            throw new Error('offline');
        }
    })());
});
