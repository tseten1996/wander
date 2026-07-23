import { useTripContext } from '@/hooks/useTrip'
import { AvatarStack } from '@/components/ui/avatar'
import { cn } from '@/lib/utils'

/**
 * "Who's here right now" — avatars of the trip members who currently have the
 * plan open, driven by Supabase realtime presence. Renders nothing until at
 * least one member is present, and updates live as people join and leave.
 */
export function LivePresence({
  max = 4,
  size = 'sm',
  showLabel = false,
  hideWhenSolo = false,
  className,
}: {
  max?: number
  size?: 'xs' | 'sm' | 'md'
  /** Show a "Here now" text label beside the avatars (desktop sidebar). */
  showLabel?: boolean
  /** Render nothing when the only active member is you (mobile top bar). */
  hideWhenSolo?: boolean
  className?: string
}) {
  const { members, me, activeIds } = useTripContext()

  // Keep the roster's stable joined_at order so avatars don't reshuffle as
  // presence syncs.
  const active = members.filter((m) => activeIds.has(m.id))
  const soloIsMe = active.length === 1 && active[0].id === me.id

  if (active.length === 0) return null
  if (hideWhenSolo && soloIsMe) return null

  const names = active.map((m) => m.display_name)
  const label = soloIsMe
    ? 'You’re the only one here right now'
    : `Here right now: ${names.join(', ')}`

  return (
    <div
      className={cn('flex items-center gap-2', className)}
      role="status"
      aria-label={label}
      title={label}
    >
      {/* Pulsing "live" dot — the ping animation is dropped for reduced motion. */}
      <span className="relative flex size-2 shrink-0" aria-hidden>
        <span className="absolute inline-flex size-full animate-ping rounded-full bg-success opacity-60 motion-reduce:hidden" />
        <span className="relative inline-flex size-2 rounded-full bg-success" />
      </span>
      <AvatarStack members={active} max={max} size={size} />
      {showLabel && (
        <span className="truncate text-xs text-muted">
          {soloIsMe ? 'Just you' : `${active.length} here now`}
        </span>
      )}
    </div>
  )
}
