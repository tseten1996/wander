import { format } from 'date-fns'
import { MapPin } from 'lucide-react'
import { useTripContext } from '@/hooks/useTrip'
import { AvatarStack } from '@/components/ui/avatar'
import { hasPresenceDates, presentOn } from '@/lib/presence'
import { cn } from '@/lib/utils'

/**
 * "Who's here today" — the physical-presence counterpart to LivePresence
 * (which shows who currently has the app *open*). Members can set arrival and
 * departure dates (#286); this reads them and shows who is on the trip today.
 *
 * Renders nothing until at least one member has set a date AND someone is
 * actually present today — so before/after the trip, and on any trip that never
 * uses dates, it is invisible with no empty affordance.
 */
export function TripDayPresence({
  max = 4,
  size = 'sm',
  showLabel = false,
  className,
}: {
  max?: number
  size?: 'xs' | 'sm' | 'md'
  /** Show a "Here today" text label beside the avatars (desktop sidebar). */
  showLabel?: boolean
  className?: string
}) {
  const { trip, members } = useTripContext()

  if (!hasPresenceDates(members)) return null

  const today = format(new Date(), 'yyyy-MM-dd')
  // Keep roster order (joined_at) so avatars don't reshuffle.
  const here = presentOn(members, today, trip)
  if (here.length === 0) return null

  const names = here.map((m) => m.display_name)
  const label = `Here today: ${names.join(', ')}`

  return (
    <div
      className={cn('flex items-center gap-2', className)}
      role="status"
      aria-label={label}
      title={label}
    >
      <MapPin className="size-3.5 shrink-0 text-primary" aria-hidden />
      <AvatarStack members={here} max={max} size={size} />
      {showLabel && (
        <span className="truncate text-xs text-muted">
          {here.length === members.length ? 'Everyone here today' : `${here.length} here today`}
        </span>
      )}
    </div>
  )
}
