/**
 * The "a newer build took over" rule (src/lib/appUpdate.ts).
 *
 * One subtlety carries the whole module: with `clientsClaim`, the FIRST
 * service worker to install also fires `controllerchange`. Counting that as an
 * update would tell someone opening Wander for the very first time that a new
 * version is ready — wrong, and unactionable. Everything below exists to keep
 * that distinction from being lost in a later refactor.
 *
 *   node --test tests/app-update.test.mjs      # or: npm run test:unit
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'

const { watchForUpdate, UPDATE_POLL_MS } = await import('../src/lib/appUpdate.ts')

/** A fake `navigator.serviceWorker` whose controller and events tests drive. */
function fakeSW({ controller = null, withRegistration = true } = {}) {
  const listeners = new Set()
  const updates = []
  const sw = {
    controller,
    addEventListener: (type, fn) => { if (type === 'controllerchange') listeners.add(fn) },
    removeEventListener: (type, fn) => { if (type === 'controllerchange') listeners.delete(fn) },
    listenerCount: () => listeners.size,
    updates,
    /** Simulate a worker claiming the page. */
    claim(next = { id: 'sw2' }) {
      sw.controller = next
      for (const fn of [...listeners]) fn()
    },
  }
  if (withRegistration) {
    sw.getRegistration = async () => ({
      update: async () => { updates.push(Date.now.name) },
    })
  }
  return sw
}

/** Captures scheduled intervals so the poll can be inspected without waiting. */
function fakeTimers() {
  const scheduled = []
  return {
    scheduled,
    setInterval: (fn, ms) => { scheduled.push({ fn, ms }); return scheduled.length },
    clearInterval: (id) => { scheduled[id - 1] = null },
  }
}

test('a first install is not an update', () => {
  // No controller at subscribe time means this page has never been claimed —
  // the controllerchange that follows is the SW arriving, not a new build.
  const sw = fakeSW({ controller: null })
  let called = 0
  watchForUpdate(sw, () => { called++ }, fakeTimers())
  sw.claim()
  assert.equal(called, 0, 'the very first service worker must not read as an update')
})

test('a newer worker claiming an already-controlled page IS an update', () => {
  const sw = fakeSW({ controller: { id: 'sw1' } })
  let called = 0
  watchForUpdate(sw, () => { called++ }, fakeTimers())
  sw.claim({ id: 'sw2' })
  assert.equal(called, 1)
})

test('the prompt fires once, however many times control changes', () => {
  // Two toasts saying the same thing is worse than one, and a reload is a
  // reload regardless of how many workers came and went.
  const sw = fakeSW({ controller: { id: 'sw1' } })
  let called = 0
  watchForUpdate(sw, () => { called++ }, fakeTimers())
  sw.claim({ id: 'sw2' })
  sw.claim({ id: 'sw3' })
  sw.claim({ id: 'sw4' })
  assert.equal(called, 1)
})

test('unsubscribing stops the callback and clears the poll', () => {
  const sw = fakeSW({ controller: { id: 'sw1' } })
  const timers = fakeTimers()
  let called = 0
  const stop = watchForUpdate(sw, () => { called++ }, timers)
  assert.equal(sw.listenerCount(), 1)
  stop()
  assert.equal(sw.listenerCount(), 0, 'the listener is removed')
  assert.equal(timers.scheduled[0], null, 'the interval is cleared')
  sw.claim()
  assert.equal(called, 0, 'no callback after unsubscribe')
})

test('a tab left open polls for a newer worker', () => {
  // The case that actually went wrong: nothing navigates, so nothing would
  // otherwise ask the browser to look.
  const sw = fakeSW({ controller: { id: 'sw1' } })
  const timers = fakeTimers()
  watchForUpdate(sw, () => {}, timers)
  assert.equal(timers.scheduled.length, 1)
  assert.equal(timers.scheduled[0].ms, UPDATE_POLL_MS)
  assert.ok(UPDATE_POLL_MS >= 60_000, 'polling must not be chatty')
})

test('a browser with no registration support still watches for changes', () => {
  // Detection is the point; polling is the nicety. Losing the second must not
  // cost the first.
  const sw = fakeSW({ controller: { id: 'sw1' }, withRegistration: false })
  const timers = fakeTimers()
  let called = 0
  watchForUpdate(sw, () => { called++ }, timers)
  assert.equal(timers.scheduled.length, 0, 'nothing to poll, so nothing scheduled')
  sw.claim()
  assert.equal(called, 1, 'controllerchange is still observed')
})

test('the default timers path calls the real setInterval with a valid receiver', () => {
  // Regression for the boot white-screen (#264): the default branch built
  // `{ setInterval, clearInterval }` and called `timers.setInterval(...)`, which
  // invokes the global with `this` = that plain object. Modern Chromium enforces
  // the WHATWG rule that these run with `this === window` (a bare call, whose
  // `this` is undefined, is coerced to the global), so a detached `this` throws
  // `TypeError: Illegal invocation` — and since this runs in a root mount effect,
  // it white-screened the whole app. Node's own timers tolerate the detached
  // `this`, so the earlier fake-`poll`-only tests never exercised the crash. Here
  // we stand in a strict double that mirrors Chromium's enforcement and run the
  // REAL default path (no `poll` injected).
  const realSetInterval = globalThis.setInterval
  const realClearInterval = globalThis.clearInterval
  const strict = (real) => function (...args) {
    // WebIDL coerces an undefined/null `this` to the global; any other detached
    // receiver (a plain object) is an Illegal invocation.
    if (this != null && this !== globalThis) throw new TypeError('Illegal invocation')
    return real.apply(globalThis, args)
  }
  globalThis.setInterval = strict(realSetInterval)
  globalThis.clearInterval = strict(realClearInterval)
  try {
    const sw = fakeSW({ controller: { id: 'sw1' } })
    let stop
    assert.doesNotThrow(() => {
      stop = watchForUpdate(sw, () => {})
    }, 'the default-timers path must not throw Illegal invocation when it schedules its poll')
    // And the teardown path (clearInterval) must be equally safe.
    assert.doesNotThrow(() => stop(), 'unsubscribe must clear the real interval without throwing')
  } finally {
    globalThis.setInterval = realSetInterval
    globalThis.clearInterval = realClearInterval
  }
})

test('a failing update check is swallowed rather than surfaced', async () => {
  const sw = fakeSW({ controller: { id: 'sw1' } })
  sw.getRegistration = async () => { throw new Error('offline') }
  const timers = fakeTimers()
  watchForUpdate(sw, () => {}, timers)
  // Running the scheduled poll must not produce an unhandled rejection: a
  // failed check is simply a check that happens again in fifteen minutes.
  await assert.doesNotReject(async () => {
    timers.scheduled[0].fn()
    await new Promise((r) => setTimeout(r, 0))
  })
})
