/*
  Noticing that a newer build has taken over, so the app can say so.

  Wander's service worker is registered `autoUpdate`, which means a new build
  installs and claims the page silently. That is the right default — nobody
  should have to approve a bug fix — but it has a failure mode that cost two
  round trips while debugging a live issue: the *already-loaded* page keeps
  running the old JavaScript until something navigates, so a fix can be
  deployed, live, and provably present in the bundle while the person looking
  at it still sees the old behaviour. There was no way to tell from the app.

  This module answers one question — "has a newer build taken control?" — and
  it is deliberately separate from the component that renders the answer so the
  rule can be unit-tested. The rule has one subtlety worth the whole file:

    A `controllerchange` on FIRST install is not an update.

  With `clientsClaim`, the very first service worker to install also fires
  `controllerchange`. Treating that as an update would show "a new version is
  ready" to someone who just opened the app for the first time — a prompt that
  is both wrong and unactionable. So the presence of a controller is captured
  when watching begins, and only a change *after* one already existed counts.
*/

/** The slice of `navigator.serviceWorker` this needs — so tests can fake it. */
export interface ServiceWorkerLike {
  /** The worker controlling this page, or null before the first one claims it. */
  controller: unknown
  addEventListener(type: 'controllerchange', listener: () => void): void
  removeEventListener(type: 'controllerchange', listener: () => void): void
  getRegistration?(): Promise<{ update(): Promise<unknown> } | undefined>
}

/**
 * How often a page left open asks whether a newer build exists.
 *
 * The browser checks on navigation anyway, so this only matters for a tab that
 * stays open — which is exactly the case that went wrong. Fifteen minutes is
 * frequent enough to catch a deploy during a working session and rare enough
 * that it is not worth thinking about: the request is a conditional GET for
 * one small file that is served `no-cache`, so it is usually a 304.
 */
export const UPDATE_POLL_MS = 15 * 60 * 1000

/**
 * Call `onUpdate` once when a newer build takes control of this page.
 *
 * Returns an unsubscribe function. Never throws: a browser with no service
 * worker support, or one where registration was blocked, simply never calls
 * back — an app that cannot detect updates must still run.
 */
export function watchForUpdate(
  sw: ServiceWorkerLike,
  onUpdate: () => void,
  poll?: { setInterval: typeof setInterval; clearInterval: typeof clearInterval },
): () => void {
  // Captured at subscribe time, not read later: by the time controllerchange
  // fires, `controller` is already the NEW worker, so asking then can never
  // distinguish a first install from an update.
  const hadController = sw.controller != null
  let fired = false

  const listener = () => {
    if (fired || !hadController) return
    fired = true
    onUpdate()
  }
  sw.addEventListener('controllerchange', listener)

  // A tab left open never navigates, so nothing would prompt the browser to
  // look for a new worker. This is what makes the feature useful during an
  // active session rather than only on the next cold start.
  let timer: ReturnType<typeof setInterval> | undefined
  const timers = poll ?? { setInterval, clearInterval }
  if (sw.getRegistration) {
    timer = timers.setInterval(() => {
      // Fire and forget: a failed check is a check that happens again in
      // fifteen minutes, not something to surface.
      sw.getRegistration?.()
        .then((reg) => reg?.update())
        .catch(() => {})
    }, UPDATE_POLL_MS)
  }

  return () => {
    sw.removeEventListener('controllerchange', listener)
    if (timer !== undefined) timers.clearInterval(timer)
  }
}
