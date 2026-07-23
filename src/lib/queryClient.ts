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

/**
 * Synchronous localStorage persister. `storage: undefined` (e.g. SSR / a
 * locked-down browser) makes it a no-op instead of throwing — the app simply
 * runs without offline persistence.
 */
export const persister = createSyncStoragePersister({
  storage: typeof window !== 'undefined' ? window.localStorage : undefined,
  key: 'wander_query_cache',
  throttleTime: 1000,
})
