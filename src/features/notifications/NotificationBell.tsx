import * as React from 'react'
import { Link } from 'react-router-dom'
import { Bell, CheckCheck, Inbox, ListChecks, PiggyBank, Vote } from 'lucide-react'
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

/** Which tab (and icon) each event type deep-links to. */
const TYPE_META: Record<NotificationType, { tab: string; icon: LucideIcon; verb: string }> = {
  checklist_assigned: { tab: 'checklist', icon: ListChecks, verb: 'assigned you a task' },
  poll_opened: { tab: 'polls', icon: Vote, verb: 'opened a poll' },
  expense_owed: { tab: 'budget', icon: PiggyBank, verb: 'added an expense you owe on' },
}

/** Deep link to the relevant tab, flashing the entity when it still exists. */
function linkFor(tripId: string, n: Notification): string {
  const base = `/trip/${tripId}/${TYPE_META[n.type].tab}`
  return n.entity_id ? `${base}#${searchAnchorId(n.entity_id)}` : base
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
        to={linkFor(tripId, n)}
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

/**
 * The personal inbox in the app shell header (#182): a bell with an unread
 * badge that updates live via realtime, and a dropdown listing recent
 * "things that need me" newest-first, each deep-linking to its tab. Mounted in
 * both the desktop sidebar and the mobile top bar; the two instances share one
 * query (same key) and one realtime subscription.
 */
export function NotificationBell({ className }: { className?: string }) {
  const { trip, me } = useTripContext()
  const [open, setOpen] = React.useState(false)
  const notifications = useNotifications(trip.id, me.id)
  const markRead = useMarkNotificationRead(trip.id)
  const markAll = useMarkAllNotificationsRead(trip.id, me.id)

  const items = notifications.data ?? []
  const unread = unreadCount(items)
  const badge = unread > 9 ? '9+' : String(unread)

  function onNavigate(n: Notification) {
    if (!n.read_at) markRead.mutate(n.id)
    setOpen(false)
  }

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          variant="ghost"
          size="icon"
          className={cn('relative', className)}
          aria-label={unread > 0 ? `Notifications, ${unread} unread` : 'Notifications'}
        >
          <Bell />
          {unread > 0 && (
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
        {unread > 0 ? `${unread} unread notifications` : ''}
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

        {notifications.isLoading ? (
          <div className="space-y-2 p-3">
            <Skeleton className="h-12" />
            <Skeleton className="h-12" />
            <Skeleton className="h-12" />
          </div>
        ) : notifications.isError ? (
          <div className="p-3">
            <ErrorState
              onRetry={() => notifications.refetch()}
              isRetrying={notifications.isFetching}
            />
          </div>
        ) : items.length === 0 ? (
          <div className="px-3 py-8">
            <EmptyState
              icon={Inbox}
              title="You’re all caught up"
              description="When someone assigns you a task, opens a poll, or logs an expense you owe, it shows up here."
            />
          </div>
        ) : (
          <ul className="max-h-[60vh] space-y-0.5 overflow-y-auto p-2">
            {items.map((n) => (
              <NotificationRow key={n.id} n={n} tripId={trip.id} onNavigate={onNavigate} />
            ))}
          </ul>
        )}
      </PopoverContent>
    </Popover>
  )
}
