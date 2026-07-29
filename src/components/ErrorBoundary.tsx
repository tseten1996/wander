import * as React from 'react'
import { AlertTriangle } from 'lucide-react'
import { PageLoader } from '@/components/ui/misc'
import { Button } from '@/components/ui/button'
import {
  createChunkReloadGuard, isChunkLoadError, sessionStore,
} from '@/lib/chunkReload'

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
 * 1. A chunk-load failure (stale deploy) → one automatic `location.reload()`
 *    to pick up the freshly-activated assets, so it self-heals instead of
 *    needing a manual back-and-retry. The reload is claimed per failing
 *    chunk (see lib/chunkReload), so a failure that survives the reload
 *    shows the fallback instead of reloading again.
 * 2. Any other render error → a recoverable fallback (message + Reload).
 */
export class ErrorBoundary extends React.Component<
  ErrorBoundaryProps,
  ErrorBoundaryState
> {
  state: ErrorBoundaryState = { error: null }

  private guard = createChunkReloadGuard(sessionStore())

  static getDerivedStateFromError(error: Error): ErrorBoundaryState {
    return { error }
  }

  componentDidCatch(error: Error) {
    if (this.guard.claimReload(error)) {
      window.location.reload()
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
    if (isChunkLoadError(error) && !this.guard.hasClaimed(error)) {
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
