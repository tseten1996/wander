import * as React from 'react'

/**
 * Tracks browser connectivity via `navigator.onLine` and the `online`/
 * `offline` window events. Used to surface a read-only banner when the device
 * drops offline (issue #55) — the persisted TanStack Query cache still renders
 * the last-fetched data, but writes can't reach Supabase.
 *
 * `navigator.onLine` only proves the network interface is up, not that
 * Supabase is reachable, so this is a UX hint layered on top of the real
 * error handling (friendlyError) — never a security or correctness gate.
 */
export function useOnlineStatus(): boolean {
  const [online, setOnline] = React.useState(
    () => typeof navigator === 'undefined' || navigator.onLine
  )

  React.useEffect(() => {
    const goOnline = () => setOnline(true)
    const goOffline = () => setOnline(false)
    window.addEventListener('online', goOnline)
    window.addEventListener('offline', goOffline)
    // Re-sync in case connectivity changed between first render and mount.
    setOnline(navigator.onLine)
    return () => {
      window.removeEventListener('online', goOnline)
      window.removeEventListener('offline', goOffline)
    }
  }, [])

  return online
}
