import { QueryClient } from '@tanstack/react-query'
import { createSyncStoragePersister } from '@tanstack/query-sync-storage-persister'

/**
 * The single TanStack Query client, plus a localStorage persister so the
 * last-fetched trip data survives a reload and renders read-only when the
 * device is offline (issue #55).
 *
 * Persistence only keeps queries that are still in the cache when the snapshot
 * is written, so `gcTime` must be at least as long as the persister's
 * `maxAge` — otherwise a query could be garbage-collected out of the cache
 * before it is ever persisted. Realtime invalidation (see useRealtime) keeps
 * the in-memory copy fresh while online; `staleTime` is unchanged.
 */

/** How long a persisted snapshot is trusted before it is discarded on restore. */
export const PERSIST_MAX_AGE = 1000 * 60 * 60 * 24 // 24 hours

/**
 * Bump when a breaking change to cached data shape ships, to discard every
 * older persisted snapshot on the next load rather than hydrating stale rows.
 */
export const PERSIST_BUSTER = '1'

export const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 30_000, // realtime invalidation keeps data fresh
      gcTime: PERSIST_MAX_AGE, // keep cached rows long enough to persist for offline
      retry: 1,
      refetchOnWindowFocus: true,
    },
  },
})

/** localStorage key the persisted snapshot is written under. */
export const PERSIST_CACHE_KEY = 'wander_query_cache'

/** How long persistence writes are throttled/coalesced. */
export const PERSIST_THROTTLE = 1000

/**
 * Synchronous localStorage persister. `storage: undefined` (e.g. SSR / a
 * locked-down browser) makes it a no-op instead of throwing — the app simply
 * runs without offline persistence.
 */
export const persister = createSyncStoragePersister({
  storage: typeof window !== 'undefined' ? window.localStorage : undefined,
  key: PERSIST_CACHE_KEY,
  throttleTime: PERSIST_THROTTLE,
})

/**
 * Purge every trace of cached server state. Used on sign-out (see useAuth) so
 * one account's private trip data — trip names, member emails, notes, budget —
 * can't survive on disk or re-hydrate for the next account signing in on a
 * shared browser (query keys are not user-scoped). RLS still guards every
 * server read; this closes the client-side data-at-rest gap the persisted
 * cache opened (issue #55 review).
 *
 * Clearing the in-memory cache makes PersistQueryClientProvider's throttled
 * subscription re-persist one more (now-empty) snapshot up to PERSIST_THROTTLE
 * later, so we remove the client immediately AND once more past that window —
 * leaving not even an empty snapshot at rest.
 */
export function purgePersistedCache(): void {
  queryClient.clear()
  void persister.removeClient()
  if (typeof window !== 'undefined') {
    window.setTimeout(() => void persister.removeClient(), PERSIST_THROTTLE + 300)
  }
}
