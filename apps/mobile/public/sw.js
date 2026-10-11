// Service worker for the web app: shows push alerts and opens the right screen when one is tapped.
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (event) => event.waitUntil(self.clients.claim()));

self.addEventListener('push', (event) => {
  let d = {};
  try {
    d = event.data ? event.data.json() : {};
  } catch (e) {
    d = {};
  }
  const data = d.data || {};
  event.waitUntil(
    self.registration.showNotification(d.title || 'Skill Marketplace', {
      body: d.body || '',
      data,
      icon: '/icon-192.png',
      badge: '/icon-192.png',
      // One alert per lead or chat, replaced rather than stacked.
      tag: data.matchId || data.conversationId || data.requestId || 'general',
      renotify: true,
      requireInteraction: d.channelId === 'requests',
      vibrate: d.channelId === 'requests' ? [300, 200, 300] : [150],
    }),
  );
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const data = event.notification.data || {};
  const url = data.conversationId ? '/chat/' + data.conversationId : '/';
  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((list) => {
      for (const client of list) {
        if ('focus' in client) {
          client.navigate(url);
          return client.focus();
        }
      }
      return self.clients.openWindow(url);
    }),
  );
});
