import type { LucideIcon } from 'lucide-react'
import { Loader2, RefreshCw, CloudOff } from 'lucide-react'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'

export function Spinner({ className }: { className?: string }) {
  return <Loader2 className={cn('size-5 animate-spin text-muted', className)} />
}

export function PageLoader() {
  return (
    <div className="flex h-[60dvh] items-center justify-center">
      <Spinner className="size-6" />
    </div>
  )
}

export function Skeleton({ className }: { className?: string }) {
  return <div className={cn('animate-pulse rounded-xl bg-sunken', className)} />
}

interface EmptyStateProps {
  icon: LucideIcon
  title: string
  description?: string
  action?: React.ReactNode
  className?: string
}

export function EmptyState({ icon: Icon, title, description, action, className }: EmptyStateProps) {
  return (
    <div
      className={cn(
        'flex flex-col items-center justify-center gap-3 rounded-2xl border border-dashed border-line-strong px-6 py-14 text-center',
        className
      )}
    >
      <div className="flex size-12 items-center justify-center rounded-2xl bg-primary-faint">
        <Icon className="size-6 text-primary" />
      </div>
      <div>
        <p className="font-display font-semibold">{title}</p>
        {description && <p className="mt-1 max-w-sm text-sm text-muted">{description}</p>}
      </div>
      {action && <div className="mt-2">{action}</div>}
    </div>
  )
}

interface ErrorStateProps {
  /** Optional icon override; defaults to a "connection lost" glyph. */
  icon?: LucideIcon
  title?: string
  description?: string
  /** Wired to the query's `refetch` — recovers in place, no full reload. */
  onRetry?: () => void
  /** True while a retry is in flight, to disable the button and spin the icon. */
  isRetrying?: boolean
  className?: string
}

/**
 * Shown when a query fails (network drop, Supabase unreachable, RLS denial).
 * Deliberately distinct from EmptyState so a failed load never reads as an
 * empty trip. Uses only `danger`/`muted` design tokens from index.css.
 */
export function ErrorState({
  icon: Icon = CloudOff,
  title = 'Couldn’t load this',
  description = 'Something went wrong reaching the server. Check your connection and try again.',
  onRetry,
  isRetrying,
  className,
}: ErrorStateProps) {
  return (
    <div
      role="alert"
      className={cn(
        'flex flex-col items-center justify-center gap-3 rounded-2xl border border-dashed border-danger/40 px-6 py-14 text-center',
        className
      )}
    >
      <div className="flex size-12 items-center justify-center rounded-2xl bg-danger-soft">
        <Icon className="size-6 text-danger" />
      </div>
      <div>
        <p className="font-display font-semibold">{title}</p>
        {description && <p className="mt-1 max-w-sm text-sm text-muted">{description}</p>}
      </div>
      {onRetry && (
        <Button
          variant="secondary"
          onClick={onRetry}
          disabled={isRetrying}
          className="mt-2"
        >
          <RefreshCw className={cn(isRetrying && 'animate-spin')} />
          {isRetrying ? 'Retrying…' : 'Try again'}
        </Button>
      )}
    </div>
  )
}
