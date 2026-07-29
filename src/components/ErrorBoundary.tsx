import * as React from 'react'
import { AlertTriangle } from 'lucide-react'
import { PageLoader } from '@/components/ui/misc'
import { Button } from '@/components/ui/button'

/**
 * sessionStorage key that records we have already forced one automatic reload
 * for a chunk-load failure this session. It guards the self-heal so a chunk
 * that is genuinely broken (not just a stale-deploy 404) can never send the
 * app into a reload loop. Cleared on any clean boot (see componentDidMount)
 * so a *later* deploy in the same session can self-heal again.
 */
const CHUNK_RELOAD_FLAG = 'wander:chunk-reload'

/**
 * A failed dynamic `import()` — the trip pages are lazy-loaded, and right
 * after a deploy the old hashed chunk files are gone from Pages, so the
 * import 404s. Browsers phrase this several ways; match all of them plus the
 * webpack-era `ChunkLoadError` name for good measure.
 */
function isChunkLoadError(error: unknown): boolean {
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

interface ErrorBoundaryProps {
  children: React.ReactNode
}

interface ErrorBoundaryState {
  error: Error | null
}

/**
 * Wraps the lazy route tree so a render error in any single route can no
 * longer unmount the whole app into a blank screen. Two failure modes:
 *
 * 1. A chunk-load failure (stale deploy) → one guarded automatic
 *    `location.reload()` to pick up the freshly-activated assets, so it
 *    self-heals instead of needing a manual back-and-retry.
 * 2. Any other render error → a recoverable fallback (message + Reload).
 */
export class ErrorBoundary extends React.Component<
  ErrorBoundaryProps,
  ErrorBoundaryState
> {
  state: ErrorBoundaryState = { error: null }

  static getDerivedStateFromError(error: Error): ErrorBoundaryState {
    return { error }
  }

  componentDidMount() {
    // A clean boot means the current assets loaded fine — release the guard
    // so a future deploy's chunk 404 can trigger its own one-time reload.
    if (!this.state.error) {
      try {
        sessionStorage.removeItem(CHUNK_RELOAD_FLAG)
      } catch {
        /* sessionStorage can throw in private/blocked contexts — ignore. */
      }
    }
  }

  componentDidCatch(error: Error) {
    if (isChunkLoadError(error) && !this.hasReloaded()) {
      try {
        sessionStorage.setItem(CHUNK_RELOAD_FLAG, '1')
      } catch {
        /* If we can't persist the guard, fall through to the fallback UI
           rather than risk an unguarded reload loop. */
        return
      }
      window.location.reload()
    }
  }

  private hasReloaded(): boolean {
    try {
      return sessionStorage.getItem(CHUNK_RELOAD_FLAG) === '1'
    } catch {
      return false
    }
  }

  private handleReload = () => {
    window.location.reload()
  }

  render() {
    const { error } = this.state
    if (!error) return this.props.children

    // A first-time chunk failure is about to trigger an automatic reload
    // (componentDidCatch) — show the loader rather than flashing the error UI.
    if (isChunkLoadError(error) && !this.hasReloaded()) {
      return <PageLoader />
    }

    return (
      <div
        role="alert"
        aria-live="assertive"
        className="flex min-h-[100dvh] flex-col items-center justify-center gap-4 px-6 py-16 text-center"
      >
        <div className="flex size-14 items-center justify-center rounded-2xl bg-danger-soft">
          <AlertTriangle className="size-7 text-danger" />
        </div>
        <div>
          <p className="font-display text-lg font-semibold text-ink">
            Something went wrong
          </p>
          <p className="mt-1 max-w-sm text-sm text-muted">
            This part of Wander ran into an error. Reloading usually fixes it.
          </p>
        </div>
        <Button variant="primary" size="lg" onClick={this.handleReload}>
          Reload
        </Button>
      </div>
    )
  }
}
