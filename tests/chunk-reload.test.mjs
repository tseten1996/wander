/**
 * Unit tests for the lazy-chunk reload guard in src/lib/chunkReload.ts — the
 * self-heal that recovers a blank screen after a deploy (#142), and the guard
 * that stops it becoming an infinite reload loop.
 *
 * These exist because the failure they lock down cannot be reproduced by the
 * hermetic smoke harness: a post-deploy chunk 404 is outside the Supabase
 * stub's surface. The loop-prevention property is therefore asserted here,
 * against a fake Storage, by simulating successive page boots.
 *
 * The regression this pins down (PR #144, fixed in the follow-up): the guard
 * was cleared on every boot — from the boundary's `componentDidMount`, which
 * commits before the lazy import settles — so the flag a failing boot wrote
 * was always wiped before the next boot could read it, and a persistent chunk
 * failure reloaded forever. The guard is now keyed on the failing chunk and
 * never un-claimed, which is what makes the loop impossible.
 *
 * Same module-loading convention as the other unit tests: a resolve hook
 * supplies the '.ts' extension Node's type-stripping loader won't add.
 *
 *   node --test tests/chunk-reload.test.mjs   # or: npm run test:unit
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { register } from 'node:module'

register(
  'data:text/javascript,' +
    encodeURIComponent(`
export async function resolve(specifier, context, nextResolve) {
  if (/^\\.\\.?\\//.test(specifier) && !/\\.[cm]?[jt]sx?$/i.test(specifier)) {
    try { return await nextResolve(specifier + '.ts', context) } catch {}
  }
  return nextResolve(specifier, context)
}`),
)
const { createChunkReloadGuard, isChunkLoadError, chunkKey } = await import(
  '../src/lib/chunkReload.ts'
)

/** Minimal in-memory Storage; survives across "boots" like sessionStorage. */
function fakeStore() {
  const map = new Map()
  return {
    getItem: (k) => (map.has(k) ? map.get(k) : null),
    setItem: (k, v) => void map.set(k, String(v)),
    removeItem: (k) => void map.delete(k),
  }
}

/** A page boot: a fresh guard over the same (session-scoped) storage. */
const boot = (store) => createChunkReloadGuard(store)

const chunkError = () =>
  new Error('Failed to fetch dynamically imported module: /assets/Budget-a1b2.js')

/* ── error classification ───────────────────────────────────────────────── */

test('isChunkLoadError recognises the browser phrasings', () => {
  const messages = [
    'Failed to fetch dynamically imported module: /assets/x.js',
    'error loading dynamically imported module',
    'Importing a module script failed.',
    'Loading chunk 42 failed.',
    'Unable to preload CSS for /assets/x.css',
  ]
  for (const message of messages) {
    assert.equal(isChunkLoadError(new Error(message)), true, message)
  }
  const named = new Error('boom')
  named.name = 'ChunkLoadError'
  assert.equal(isChunkLoadError(named), true, 'ChunkLoadError by name')
})

test('isChunkLoadError ignores ordinary render errors', () => {
  assert.equal(isChunkLoadError(new Error("Cannot read properties of undefined")), false)
  assert.equal(isChunkLoadError(null), false)
  assert.equal(isChunkLoadError(undefined), false)
})

/* ── reload guard: the loop-prevention property ─────────────────────────── */

test('first chunk failure claims the one automatic reload', () => {
  const store = fakeStore()
  assert.equal(boot(store).claimReload(chunkError()), true)
})

test('a chunk failure that survives the reload does NOT reload again', () => {
  // This is the regression. Boot 1 fails and spends the reload; boot 2 is the
  // page that came back from that reload and fails again (offline, corrupt
  // chunk, stale precache). It must fall through to the fallback UI.
  const store = fakeStore()

  assert.equal(boot(store).claimReload(chunkError()), true, 'boot 1 reloads')

  const second = boot(store)
  assert.equal(second.claimReload(chunkError()), false, 'boot 2 must not reload')
  assert.equal(second.hasClaimed(chunkError()), true, 'boot 2 knows it was spent')

  // ...and it stays refused however many times the page comes back.
  assert.equal(boot(store).claimReload(chunkError()), false, 'boot 3 must not reload')
})

test('a later deploy self-heals — its chunks carry new content hashes', () => {
  const store = fakeStore()
  assert.equal(boot(store).claimReload(chunkError()), true, 'first deploy reloads')
  assert.equal(boot(store).claimReload(chunkError()), false, 'same chunk stays refused')

  // A new deploy means new hashed filenames, so it is a different key and
  // gets its own single reload — no "release" step needed.
  const next = new Error(
    'Failed to fetch dynamically imported module: /assets/Budget-99zz99.js',
  )
  assert.equal(boot(store).claimReload(next), true, 'next deploy may reload')
  assert.equal(boot(store).claimReload(next), false, 'and only once')
})

test('chunkKey identifies the failing module, ignoring host and query noise', () => {
  const a = new Error('Failed to fetch dynamically imported module: https://x.io/assets/A-1.js?t=9')
  const b = new Error('Failed to fetch dynamically imported module: https://cdn.other/assets/A-1.js')
  assert.equal(chunkKey(a), '/assets/A-1.js')
  assert.equal(chunkKey(a), chunkKey(b), 'same chunk from different hosts is one key')
  // Safari names no module — those share one key, still bounded to one reload.
  assert.equal(chunkKey(new Error('Importing a module script failed.')), '<unknown>')
})

test('distinct chunks each get their own single reload', () => {
  const store = fakeStore()
  const one = new Error('Failed to fetch dynamically imported module: /assets/One-a.js')
  const two = new Error('Failed to fetch dynamically imported module: /assets/Two-b.js')
  assert.equal(boot(store).claimReload(one), true)
  assert.equal(boot(store).claimReload(two), true, 'a different chunk may try once')
  assert.equal(boot(store).claimReload(one), false, 'but neither repeats')
  assert.equal(boot(store).claimReload(two), false)
})

test('a legacy guard value migrates safely — one reload, then guarded', () => {
  // The build this fix replaces stored a bare '1' here, and that value is
  // sitting in real sessions right now. It must not survive as a permanent
  // block (the user would lose the self-heal) nor as a permanent hole (a
  // loop). One reload, then the new per-chunk record takes over.
  const store = fakeStore()
  store.setItem('wander:chunk-reload', '1')
  assert.equal(boot(store).claimReload(chunkError()), true, 'migrates to one reload')
  assert.equal(boot(store).claimReload(chunkError()), false, 'then guarded as normal')
})

test('an unparseable guard value cannot open a reload loop', () => {
  const store = fakeStore()
  store.setItem('wander:chunk-reload', '{not json')
  assert.equal(boot(store).claimReload(chunkError()), false, 'corrupt → refuse')
})

test('a non-chunk render error never triggers a reload', () => {
  const store = fakeStore()
  const guard = boot(store)
  assert.equal(guard.claimReload(new Error('undefined is not a function')), false)
  assert.equal(guard.hasClaimed(chunkError()), false, 'and it does not spend the guard')
})

test('without usable storage the reload is disabled, not unguarded', () => {
  // No place to record the attempt → an automatic reload could never be
  // stopped, so we must not start one. The fallback UI handles it instead.
  const guard = createChunkReloadGuard(null)
  assert.equal(guard.claimReload(chunkError()), false, 'no auto-reload')
  // ...and the boundary must render the fallback straight away rather than a
  // loader waiting on a reload that is never coming.
  assert.equal(guard.hasClaimed(chunkError()), true, 'treated as already spent')
})

test('a throwing storage degrades safely', () => {
  const hostile = {
    getItem: () => { throw new Error('blocked') },
    setItem: () => { throw new Error('blocked') },
    removeItem: () => { throw new Error('blocked') },
  }
  const guard = createChunkReloadGuard(hostile)
  assert.equal(guard.claimReload(chunkError()), false, 'cannot persist → no reload')
})
