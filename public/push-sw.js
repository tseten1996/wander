/*
  Wander service-worker push handlers (#267).

  Imported into the vite-plugin-pwa generated worker via `workbox.importScripts`
  (see vite.config.ts). Kept as a hand-written, un-bundled script on purpose: it
  ONLY registers `push` and `notificationclick` listeners and never touches the
  generated precache or the autoUpdate/clientsClaim lifecycle, so the update path
  (#260/#264) keeps behaving exactly as before — the push handler rides along
  and is re-imported by every fresh worker a deploy generates.

  The payload is already decrypted by the browser's push layer (RFC 8291) before
  it reaches us, so `event.data.json()` is the plain object /api/push sent:
    { title, body, url, tag, notificationId }
*/
/* eslint-disable no-undef */

self.addEventListener('push', (event) => {
  let payload = {}
  try {
    payload = event.data ? event.data.json() : {}
  } catch (_e) {
    payload = {}
  }

  const title = payload.title || 'Wander'
  const url = payload.url || '#/'
  const options = {
    body: payload.body || '',
    tag: payload.tag || 'wander',
    data: { url },
    icon: 'pwa-192.png',
    badge: 'pwa-192.png',
    renotify: true,
  }

  event.waitUntil(
    (async () => {
      // Don't double-notify a member who is already looking at Wander on this
      // device — the in-app realtime badge already tells them. Only suppress
      // when a window is genuinely visible AND focused.
      const windows = await self.clients.matchAll({ type: 'window', includeUncontrolled: true })
      const activelyViewing = windows.some((c) => c.visibilityState === 'visible' && c.focused)
      if (activelyViewing) return
      await self.registration.showNotification(title, options)
    })(),
  )
})

self.addEventListener('notificationclick', (event) => {
  event.notification.close()
  const url = (event.notification.data && event.notification.data.url) || '#/'
  const href = new URL(url, self.registration.scope).href

  event.waitUntil(
    (async () => {
      const windows = await self.clients.matchAll({ type: 'window', includeUncontrolled: true })
      // Prefer an already-open Wander tab: focus it and route it to the deep
      // link (a hash change HashRouter picks up without a reload).
      for (const client of windows) {
        if ('focus' in client) {
          await client.focus()
          if ('navigate' in client) {
            try {
              await client.navigate(href)
            } catch (_e) {
              // Some browsers refuse cross-navigation; the focus alone still
              // surfaces the app.
            }
          }
          return
        }
      }
      // No open tab: open one at the deep link.
      await self.clients.openWindow(href)
    })(),
  )
})
