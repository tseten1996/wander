import * as React from 'react'
import { Link } from 'react-router-dom'
import {
  AtSign,
  Bell,
  CalendarClock,
  CheckCheck,
  Inbox,
  ListChecks,
  Luggage,
  PiggyBank,
  Timer,
  Vote,
  X,
} from 'lucide-react'
import type { LucideIcon } from 'lucide-react'
import { useTripContext } from '@/hooks/useTrip'
import { Button } from '@/components/ui/button'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { MemberAvatar } from '@/components/ui/avatar'
import { EmptyState, ErrorState, Skeleton } from '@/components/ui/misc'
import { searchAnchorId } from '@/features/search/anchor'
import { cn, timeAgo } from '@/lib/utils'
import type { Notification, NotificationType } from '@/types'
import {
  unreadCount,
  useMarkAllNotificationsRead,
  useMarkNotificationRead,
  useNotifications,
} from './api'
import type { Reminder, ReminderKind } from './reminders'
import { useReminders } from './useReminders'
import { dismissReminder } from './reminderDismissal'

/** Which tab (and icon) each event type deep-links to. */
const TYPE_META: Record<NotificationType, { tab: string; icon: LucideIcon; verb: string }> = {
  checklist_assigned: { tab: 'checklist', icon: ListChecks, verb: 'assigned you a task' },
  poll_opened: { tab: 'polls', icon: Vote, verb: 'opened a poll' },
  expense_owed: { tab: 'budget', icon: PiggyBank, verb: 'added an expense you owe on' },
  mention: { tab: 'chat', icon: AtSign, verb: 'mentioned you' },
}

/** Deep link to a tab, flashing the entity (via the shared search anchor). */
function tabLink(tripId: string, tab: string, entityId: string | null): string {
  const base = `/trip/${tripId}/${tab}`
  return entityId ? `${base}#${searchAnchorId(entityId)}` : base
}

function NotificationRow({
  n,
  tripId,
  onNavigate,
}: {
  n: Notification
  tripId: string
  onNavigate: (n: Notification) => void
}) {
  const { membersById } = useTripContext()
  const actor = n.actor_id ? membersById.get(n.actor_id) : undefined
  const meta = TYPE_META[n.type]
  const Icon = meta.icon

  return (
    <li>
      <Link
        to={tabLink(tripId, meta.tab, n.entity_id)}
        onClick={() => onNavigate(n)}
        className={cn(
          'flex gap-3 rounded-xl px-2.5 py-2.5 transition-colors hover:bg-sunken',
          'focus-visible:bg-sunken focus-visible:outline-none'
        )}
      >
        <span className="relative mt-0.5 shrink-0">
          {actor ? (
            <MemberAvatar name={actor.display_name} color={actor.color} size="sm" />
          ) : (
            <span className="flex size-7 items-center justify-center rounded-full bg-sunken text-muted">
              <Icon className="size-3.5" aria-hidden />
            </span>
          )}
          <span className="absolute -bottom-1 -right-1 flex size-4 items-center justify-center rounded-full bg-elevated text-ink-soft ring-2 ring-elevated">
            <Icon className="size-2.5" aria-hidden />
          </span>
        </span>
        <span className="min-w-0 flex-1">
          <span className="block text-sm leading-snug text-ink-soft">
            <strong className="font-semibold text-ink">{actor?.display_name ?? 'Someone'}</strong>{' '}
            {meta.verb}
            {n.title ? (
              <>
                : <span className="text-ink">{n.title}</span>
              </>
            ) : null}
          </span>
          <span className="mt-0.5 block text-xs text-muted">{timeAgo(n.created_at)}</span>
        </span>
        {!n.read_at && (
          <span
            aria-hidden
            className="mt-1.5 size-2 shrink-0 self-start rounded-full bg-accent"
          />
        )}
      </Link>
    </li>
  )
}

/** Icon for each reminder kind (the deadline itself, not a person). */
const REMINDER_ICON: Record<ReminderKind, LucideIcon> = {
  task_due: CalendarClock,
  trip_countdown: Luggage,
  poll_closing: Timer,
}

function ReminderRow({
  r,
  tripId,
  onNavigate,
}: {
  r: Reminder
  tripId: string
  onNavigate: () => void
}) {
  const Icon = REMINDER_ICON[r.kind]
  const urgent = r.tone === 'urgent'

  return (
    <li className="group relative">
      <Link
        to={tabLink(tripId, r.tab, r.entityId)}
        onClick={onNavigate}
        className={cn(
          'flex gap-3 rounded-xl py-2.5 pl-2.5 pr-10 transition-colors hover:bg-sunken',
          'focus-visible:bg-sunken focus-visible:outline-none'
        )}
      >
        <span
          className={cn(
            'mt-0.5 flex size-7 shrink-0 items-center justify-center rounded-full',
            urgent ? 'bg-accent/15 text-accent' : 'bg-sunken text-muted'
          )}
        >
          <Icon className="size-3.5" aria-hidden />
        </span>
        <span className="min-w-0 flex-1">
          <span className="block truncate text-sm font-medium leading-snug text-ink">
            {r.title}
          </span>
          <span
            className={cn(
              'mt-0.5 block text-xs font-medium',
              urgent ? 'text-accent' : 'text-muted'
            )}
          >
            {r.detail}
          </span>
        </span>
      </Link>
      <Button
        variant="ghost"
        size="icon"
        className="absolute right-1 top-1/2 size-7 -translate-y-1/2 text-muted"
        aria-label={`Dismiss reminder: ${r.title}`}
        onClick={() => dismissReminder(r.id)}
      >
        <X className="size-3.5" />
      </Button>
    </li>
  )
}

function SectionLabel({ children }: { children: React.ReactNode }) {
  return (
    <p className="px-2.5 pb-1 pt-2 text-[11px] font-semibold uppercase tracking-wide text-faint">
      {children}
    </p>
  )
}

/**
 * The personal inbox in the app shell header: a bell with a badge and a
 * dropdown. It surfaces two kinds of "things that need me":
 *  - **Reminders (#195)** — time-based, derived on the client from cached data
 *    (a task due soon, the trip counting down, a poll closing) and *never*
 *    persisted. Shown in their own section, dismissible for the session.
 *  - **Notifications (#182)** — actor-caused, persisted, cross-device; updated
 *    live via realtime.
 * Mounted in both the desktop sidebar and the mobile top bar; the two instances
 * share the same queries (by key) and the same session-dismissal set.
 */
export function NotificationBell({ className }: { className?: string }) {
  const { trip, me } = useTripContext()
  const [open, setOpen] = React.useState(false)
  const notifications = useNotifications(trip.id, me.id)
  const markRead = useMarkNotificationRead(trip.id)
  const markAll = useMarkAllNotificationsRead(trip.id, me.id)
  const reminders = useReminders()

  const items = notifications.data ?? []
  const unread = unreadCount(items)
  // The badge counts both unread notifications and live reminders, so a
  // deadline raises it even though nobody acted — the point of #195.
  const alerts = unread + reminders.length
  const badge = alerts > 9 ? '9+' : String(alerts)

  function onNavigateNotification(n: Notification) {
    if (!n.read_at) markRead.mutate(n.id)
    setOpen(false)
  }

  const hasReminders = reminders.length > 0

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          variant="ghost"
          size="icon"
          className={cn('relative', className)}
          aria-label={alerts > 0 ? `Notifications, ${alerts} need attention` : 'Notifications'}
        >
          <Bell />
          {alerts > 0 && (
            <span
              aria-hidden
              className="absolute -right-0.5 -top-0.5 flex min-w-4 items-center justify-center rounded-full bg-primary px-1 text-[10px] font-bold leading-4 text-on-primary ring-2 ring-surface"
            >
              {badge}
            </span>
          )}
        </Button>
      </PopoverTrigger>

      {/* Announce badge changes for screen-reader users without stealing focus. */}
      <span aria-live="polite" className="sr-only">
        {alerts > 0 ? `${alerts} items need attention` : ''}
      </span>

      <PopoverContent align="end" className="w-80 p-0">
        <div className="flex items-center justify-between gap-2 border-b border-line px-3 py-2.5">
          <p className="font-display text-sm font-bold">Notifications</p>
          {unread > 0 && (
            <Button
              variant="ghost"
              size="sm"
              onClick={() => markAll.mutate()}
              disabled={markAll.isPending}
            >
              <CheckCheck /> Mark all read
            </Button>
          )}
        </div>

        {notifications.isLoading && !hasReminders ? (
          <div className="space-y-2 p-3">
            <Skeleton className="h-12" />
            <Skeleton className="h-12" />
            <Skeleton className="h-12" />
          </div>
        ) : notifications.isError && !hasReminders ? (
          <div className="p-3">
            <ErrorState
              onRetry={() => notifications.refetch()}
              isRetrying={notifications.isFetching}
            />
          </div>
        ) : !hasReminders && items.length === 0 ? (
          <div className="px-3 py-8">
            <EmptyState
              icon={Inbox}
              title="You’re all caught up"
              description="Deadlines you’re close to, plus tasks, polls, expenses, and @-mentions from your group, show up here."
            />
          </div>
        ) : (
          <div className="max-h-[60vh] overflow-y-auto p-2">
            {hasReminders && (
              <section aria-label="Reminders">
                <SectionLabel>Reminders</SectionLabel>
                <ul className="space-y-0.5">
                  {reminders.map((r) => (
                    <ReminderRow
                      key={r.id}
                      r={r}
                      tripId={trip.id}
                      onNavigate={() => setOpen(false)}
                    />
                  ))}
                </ul>
              </section>
            )}

            {items.length > 0 && (
              <section aria-label="Notifications">
                {hasReminders && <SectionLabel>From your group</SectionLabel>}
                <ul className="space-y-0.5">
                  {items.map((n) => (
                    <NotificationRow
                      key={n.id}
                      n={n}
                      tripId={trip.id}
                      onNavigate={onNavigateNotification}
                    />
                  ))}
                </ul>
              </section>
            )}
          </div>
        )}
      </PopoverContent>
    </Popover>
  )
}
