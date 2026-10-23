import { deflateSync } from 'node:zlib';

const manifest = {
  id: '/',
  name: 'Reminder — Email & Phone Alerts',
  short_name: 'Reminder',
  description: 'Create private reminders delivered by email and optional phone notifications.',
  start_url: '/',
  scope: '/',
  display: 'standalone',
  background_color: '#f8fafc',
  theme_color: '#2563eb',
  icons: [
    { src: '/icon-192.png', sizes: '192x192', type: 'image/png', purpose: 'any maskable' },
    { src: '/icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'any maskable' }
  ]
};

const worker = `
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', event => event.waitUntil(self.clients.claim()));
self.addEventListener('push', event => {
  let info = {};
  try { info = event.data ? event.data.json() : {}; } catch {}
  const title = String(info.title || 'Reminder').slice(0, 120);
  const body = String(info.body || 'Your reminder is due.').slice(0, 300);
  event.waitUntil(self.registration.showNotification(title, {
    body,
    icon: '/icon-192.png',
    badge: '/icon-192.png',
    tag: String(info.tag || 'reminder'),
    renotify: false,
    data: { url: '/my-reminders' }
  }));
});
self.addEventListener('notificationclick', event => {
  event.notification.close();
  const url = new URL('/my-reminders', self.location.origin).href;
  event.waitUntil((async () => {
    const tabs = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    for (const tab of tabs) {
      if (new URL(tab.url).origin === self.location.origin) {
        await tab.focus();
        if (tab.navigate) await tab.navigate(url);
        return;
      }
    }
    return self.clients.openWindow(url);
  })());
});
`;

const client = `
(function () {
  if (!('serviceWorker' in navigator)) return;
  navigator.serviceWorker.register('/sw.js').catch(() => {});
  const button = document.getElementById('installAppBtn');
  if (!button) return;
  let installEvent = null;
  window.addEventListener('beforeinstallprompt', event => {
    event.preventDefault();
    installEvent = event;
    button.hidden = false;
  });
  window.addEventListener('appinstalled', () => {
    installEvent = null;
    button.hidden = true;
  });
  button.addEventListener('click', async () => {
    if (installEvent) {
      installEvent.prompt();
      await installEvent.userChoice;
      installEvent = null;
      return;
    }
    alert('To install: use your browser menu and choose Install app or Add to Home Screen. On iPhone, open in Safari, tap Share, then Add to Home Screen.');
  });
  if (/iPad|iPhone|iPod/.test(navigator.userAgent) && !window.navigator.standalone) {
    button.hidden = false;
  }
})();
`;

let pngCache = new Map();
function crc32(bytes) {
  let value = 0xffffffff;
  for (const b of bytes) {
    value ^= b;
    for (let i = 0; i < 8; i++) value = (value >>> 1) ^ ((value & 1) ? 0xedb88320 : 0);
  }
  return (value ^ 0xffffffff) >>> 0;
}
function chunk(type, bytes) {
  const typeBytes = Buffer.from(type);
  const header = Buffer.alloc(8);
  header.writeUInt32BE(bytes.length, 0);
  typeBytes.copy(header, 4);
  const checksum = Buffer.alloc(4);
  checksum.writeUInt32BE(crc32(Buffer.concat([typeBytes, bytes])), 0);
  return Buffer.concat([header, bytes, checksum]);
}
function distanceToSegment(x, y, x1, y1, x2, y2) {
  const lengthSquared = (x2-x1)**2 + (y2-y1)**2;
  const t = Math.max(0, Math.min(1, ((x-x1)*(x2-x1)+(y-y1)*(y2-y1))/lengthSquared));
  return Math.hypot(x-x1-t*(x2-x1), y-y1-t*(y2-y1));
}
function iconPng(size) {
  if (pngCache.has(size)) return pngCache.get(size);
  const scan = Buffer.alloc(size*(size*4+1));
  for (let y=0; y<size; y++) {
    const row = y*(size*4+1);
    scan[row]=0;
    for (let x=0; x<size; x++) {
      const a=x/size, b=y/size;
      const d=Math.min(
        distanceToSegment(a,b,0.28,0.52,0.43,0.67),
        distanceToSegment(a,b,0.43,0.67,0.74,0.34)
      );
      const tick=d<0.055;
      const corner=0.15;
      const dx=Math.max(corner-a, 0, a-(1-corner));
      const dy=Math.max(corner-b, 0, b-(1-corner));
      const inside=dx*dx+dy*dy<=corner*corner;
      const i=row+1+x*4;
      scan[i]=tick?255:37;
      scan[i+1]=tick?255:99;
      scan[i+2]=tick?255:235;
      scan[i+3]=inside?255:0;
    }
  }
  const ihdr=Buffer.alloc(13);
  ihdr.writeUInt32BE(size,0);ihdr.writeUInt32BE(size,4);
  ihdr[8]=8;ihdr[9]=6;
  const signature=Buffer.from([137,80,78,71,13,10,26,10]);
  const png=Buffer.concat([signature,chunk('IHDR',ihdr),chunk('IDAT',deflateSync(scan)),chunk('IEND',Buffer.alloc(0))]);
  pngCache.set(size,png);
  return png;
}

export function servePwaAsset(res, path) {
  let body, type;
  if (path === '/manifest.webmanifest') { type='application/manifest+json'; body=JSON.stringify(manifest); }
  else if (path === '/sw.js') { type='text/javascript; charset=utf-8'; body=worker; res.setHeader('Service-Worker-Allowed','/'); }
  else if (path === '/pwa-client.js') { type='text/javascript; charset=utf-8'; body=client; }
  else if (path === '/icon-192.png') { type='image/png'; body=iconPng(192); }
  else if (path === '/icon-512.png') { type='image/png'; body=iconPng(512); }
  else return false;
  res.status(200);
  res.setHeader('Content-Type',type);
  res.setHeader('Cache-Control',path === '/sw.js' ? 'no-cache, no-store, must-revalidate' : 'public, max-age=3600');
  res.end(body);
  return true;
}
