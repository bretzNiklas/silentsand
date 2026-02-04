// Silent Sand — Push notification service worker (no fetch handler)

self.addEventListener('push', (event) => {
  let data = { title: 'Silent Sand', body: 'Time for a moment of calm.' };
  try {
    if (event.data) data = Object.assign(data, event.data.json());
  } catch (_) { /* use defaults */ }

  event.waitUntil(
    self.registration.showNotification(data.title, {
      body: data.body,
      icon: '/favicon/android-chrome-192x192.png',
      badge: '/favicon/favicon-32x32.png',
      tag: 'silentsand-reminder',
    })
  );
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  event.waitUntil(
    clients.matchAll({ type: 'window', includeUncontrolled: true }).then((windowClients) => {
      for (const client of windowClients) {
        if (client.url.includes('silentsand.me') && 'focus' in client) {
          return client.focus();
        }
      }
      return clients.openWindow('https://silentsand.me');
    })
  );
});
