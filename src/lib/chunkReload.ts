/*
  Reload guard for the lazy-chunk self-heal (see src/components/ErrorBoundary).

  Right after a deploy the old hashed chunk files are gone from Pages, so a
  lazy `import()` 404s and the route can't render. One automatic reload picks
  up the freshly-activated assets and fixes it. But a chunk failure that does
  *not* clear on reload — offline at the retry moment, a genuinely corrupt
  chunk, a stale service-worker precache pointing at dead files — must never
  reload forever.

  The guard is keyed on the **failing chunk's hashed filename**, and a claimed
  chunk is never un-claimed. That is what makes it loop-proof: the same broken
  chunk gets exactly one reload per session, no matter how many times the page
  comes back. It also means a *later* deploy self-heals for free — its chunks
  carry new content hashes, so they are new keys — with no "release" step that
  could wipe the record early.

  (An earlier attempt released the guard once a lazy chunk mounted. It looked
  right and was not: eager components — TripLayout, HomePage — commit before
  the lazy import settles, so the release fired on essentially every boot and
  the loop came straight back. Verified in a browser, not just reasoned about.)

  The state machine lives here, apart from the React component, so the
  loop-prevention property can be unit-tested (tests/chunk-reload.test.mjs) —
  a post-deploy chunk 404 is outside what the hermetic smoke harness covers.
*/

export const CHUNK_RELOAD_FLAG = 'wander:chunk-reload'

/** Cap on remembered chunks, so a long session can't grow the entry forever. */
const MAX_KEYS = 8

/** Key used when the browser doesn't name the failed module (e.g. Safari). */
const UNKNOWN_CHUNK = '<unknown>'

/** The slice of Storage this guard needs — so tests can pass a fake. */
export interface GuardStore {
  getItem(key: string): string | null
  setItem(key: string, value: string): void
  removeItem(key: string): void
}

/**
 * sessionStorage, or null where it is unavailable (private mode, blocked
 * storage). A null store disables the automatic reload entirely: without
 * somewhere to record that the reload was spent, reloading would be
 * unguarded, and an unguarded reload loop is worse than the blank screen
 * this whole mechanism exists to avoid.
 */
export function sessionStore(): GuardStore | null {
  try {
    return globalThis.sessionStorage ?? null
  } catch {
    return null
  }
}

/**
 * A failed dynamic `import()`. Browsers phrase it several ways; match all of
 * them plus the webpack-era `ChunkLoadError` name.
 */
export function isChunkLoadError(error: unknown): boolean {
  if (!error) return false
  const err = error as { name?: string; message?: string }
  if (err.name === 'ChunkLoadError') return true
  const message = err.message ?? ''
  return (
    /Failed to fetch dynamically imported module/i.test(message) ||
    /error loading dynamically imported module/i.test(message) ||
    /Importing a module script failed/i.test(message) ||
    /Loading chunk \S+ failed/i.test(message) ||
    /Unable to preload CSS/i.test(message)
  )
}

/**
 * Identify *which* chunk failed, from the module URL browsers put in the
 * message ("…imported module: https://host/assets/BudgetPage-a1b2c3.js").
 * Normalised to a pathname so host or query noise can't split one chunk into
 * several keys. Safari omits the URL entirely — those collapse onto a single
 * shared key, which still bounds them to one reload per session.
 */
export function chunkKey(error: unknown): string {
  const message = (error as { message?: string } | null)?.message ?? ''
  const match =
    message.match(/https?:\/\/\S+?\.(?:js|mjs|css)/i) ??
    message.match(/\/[\w./-]+\.(?:js|mjs|css)/i)
  if (!match) return UNKNOWN_CHUNK
  try {
    return new URL(match[0], 'http://local').pathname
  } catch {
    return match[0]
  }
}

export interface ChunkReloadGuard {
  claimReload(error: unknown): boolean
  hasClaimed(error: unknown): boolean
}

export function createChunkReloadGuard(store: GuardStore | null): ChunkReloadGuard {
  /**
   * Chunks already granted a reload, or `null` when the record can't be
   * trusted — no storage at all, or a value we can't parse. `null` means
   * "refuse every reload": we cannot tell what has already been tried, and
   * guessing "nothing" is the single answer that can loop forever.
   */
  const readClaimed = (): string[] | null => {
    if (!store) return null
    try {
      const raw = store.getItem(CHUNK_RELOAD_FLAG)
      if (!raw) return []
      const parsed: unknown = JSON.parse(raw)
      // A non-array parses cleanly from the previous build's bare '1'. Those
      // sessions migrate to one reload and are then guarded by the new
      // per-chunk record — neither permanently blocked nor left looping.
      return Array.isArray(parsed)
        ? parsed.filter((v): v is string => typeof v === 'string')
        : []
    } catch {
      return null
    }
  }

  return {
    /**
     * Whether this chunk has already spent its one automatic reload — also
     * true when the record is untrusted, so the UI shows the recoverable
     * fallback rather than a loader waiting for a reload that won't come.
     */
    hasClaimed(error: unknown): boolean {
      const claimed = readClaimed()
      return claimed === null || claimed.includes(chunkKey(error))
    },

    /**
     * True when the caller should perform the one automatic reload for this
     * chunk, recording the claim as it does. A failure that survives the
     * reload gets `false` next boot and falls through to the recoverable
     * fallback UI instead of reloading again.
     */
    claimReload(error: unknown): boolean {
      if (!isChunkLoadError(error)) return false
      if (!store) return false
      const claimed = readClaimed()
      if (claimed === null) return false
      const key = chunkKey(error)
      if (claimed.includes(key)) return false
      const next = [...claimed, key].slice(-MAX_KEYS)
      try {
        store.setItem(CHUNK_RELOAD_FLAG, JSON.stringify(next))
      } catch {
        return false
      }
      return true
    },
  }
}
