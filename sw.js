/* Go BB — service worker
   Does three jobs:
   1. keeps the app working with no internet
   2. fires alarm notifications while the browser keeps it alive in the background
   3. handles the Done / Snooze buttons on a notification
*/

const CACHE = 'gobb-v2';
const SHELL = ['./', './index.html', './manifest.json', './icon-192.png', './icon-512.png', './icon-180.png'];
const DATA_KEY = './__gobb_schedule';

self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(SHELL)).catch(() => {}));
  self.skipWaiting();
});

self.addEventListener('activate', e => {
  e.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k)));
    await self.clients.claim();
    await armTimers();
  })());
});

/* ---------- offline: fresh page when online, cached page when not ---------- */
self.addEventListener('fetch', e => {
  const req = e.request;
  if (req.method !== 'GET' || !req.url.startsWith(self.location.origin)) return;
  e.respondWith((async () => {
    try {
      const fresh = await fetch(req);
      const cache = await caches.open(CACHE);
      cache.put(req, fresh.clone()).catch(() => {});
      return fresh;
    } catch (err) {
      const hit = await caches.match(req);
      return hit || caches.match('./index.html');
    }
  })());
});

/* ---------- schedule storage ---------- */
async function readSchedule() {
  try {
    const cache = await caches.open(CACHE);
    const res = await cache.match(DATA_KEY);
    if (!res) return { items: [], fired: {}, snooze: 10 };
    return await res.json();
  } catch (e) { return { items: [], fired: {}, snooze: 10 }; }
}
async function writeSchedule(data) {
  try {
    const cache = await caches.open(CACHE);
    await cache.put(DATA_KEY, new Response(JSON.stringify(data), {
      headers: { 'Content-Type': 'application/json' }
    }));
  } catch (e) {}
}

/* ---------- the page hands us the upcoming alarms ---------- */
self.addEventListener('message', e => {
  const msg = e.data || {};
  if (msg.type === 'SCHEDULE') {
    e.waitUntil((async () => {
      const prev = await readSchedule();
      const now = Date.now();
      const fired = {};
      Object.keys(prev.fired || {}).forEach(k => {
        if (prev.fired[k] > now - 6 * 3600 * 1000) fired[k] = prev.fired[k];
      });
      await writeSchedule({ items: msg.items || [], fired, snooze: msg.snooze || 10 });
      await armTimers();
    })());
  }
});

/* ---------- fire anything that is due ---------- */
async function fireDue() {
  const data = await readSchedule();
  const now = Date.now();
  let changed = false;
  for (const it of data.items || []) {
    if (data.fired[it.k]) continue;
    if (it.at > now) continue;
    if (now - it.at > 15 * 60 * 1000) { data.fired[it.k] = now; changed = true; continue; }
    data.fired[it.k] = now;
    changed = true;
    await self.registration.showNotification(it.time + ' — now', {
      body: it.name,
      tag: it.k,
      renotify: true,
      requireInteraction: true,
      icon: 'icon-192.png',
      badge: 'icon-192.png',
      vibrate: [400, 180, 400, 180, 600],
      data: { key: it.k, name: it.name, snooze: data.snooze || 10 },
      actions: [
        { action: 'done', title: 'Done' },
        { action: 'snooze', title: 'Snooze ' + (data.snooze || 10) + 'm' }
      ]
    });
  }
  if (changed) await writeSchedule(data);
  return data;
}

/* Set real timers for anything due soon. The browser may stop the worker at any
   time, so this is a best-effort extra on top of the checks the page runs. */
let timers = [];
async function armTimers() {
  timers.forEach(clearTimeout);
  timers = [];
  const data = await fireDue();
  const now = Date.now();
  (data.items || []).forEach(it => {
    const wait = it.at - now;
    if (wait > 0 && wait < 11 * 60 * 1000 && !data.fired[it.k]) {
      timers.push(setTimeout(() => { fireDue(); }, wait + 400));
    }
  });
}

self.addEventListener('periodicsync', e => {
  if (e.tag === 'gobb-check') e.waitUntil(armTimers());
});
self.addEventListener('sync', e => {
  if (e.tag === 'gobb-check') e.waitUntil(armTimers());
});

/* ---------- notification buttons ---------- */
self.addEventListener('notificationclick', e => {
  const n = e.notification;
  const info = n.data || {};
  n.close();

  if (e.action === 'snooze' && info.key) {
    e.waitUntil((async () => {
      const data = await readSchedule();
      const mins = info.snooze || 10;
      const at = Date.now() + mins * 60 * 1000;
      data.items = (data.items || []).filter(i => i.k !== info.key);
      data.items.push({ k: info.key, at, name: info.name, time: n.title.replace(' — now', '') });
      delete data.fired[info.key];
      await writeSchedule(data);
      await armTimers();
      const cs = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
      cs.forEach(c => c.postMessage({ type: 'SNOOZED', key: info.key, at }));
    })());
    return;
  }

  const target = (e.action === 'done' && info.key)
    ? './index.html#done=' + encodeURIComponent(info.key)
    : './index.html';

  e.waitUntil((async () => {
    const cs = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    if (e.action === 'done' && info.key && cs.length) {
      cs.forEach(c => c.postMessage({ type: 'DONE', key: info.key }));
      return cs[0].focus();
    }
    if (cs.length && e.action !== 'done') return cs[0].focus();
    return self.clients.openWindow(target);
  })());
});
