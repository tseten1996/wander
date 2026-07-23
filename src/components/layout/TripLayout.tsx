
import * as React from 'react'
import { NavLink, Outlet, Link, useLocation, useParams } from 'react-router-dom'
import {
  ArrowLeft, CalendarDays, Compass, Lightbulb, ListChecks,
  Luggage, MapPin, MessageCircle, Moon, MoreHorizontal, NotebookPen, PiggyBank,
  Search, Settings, Sun, Vote, HelpCircle,
} from 'lucide-react'
import { TripProvider, useTripContext } from '@/hooks/useTrip'
import { useAuth } from '@/hooks/useAuth'
import { useTheme } from '@/hooks/useTheme'
import { useUnreadDots, type UnreadRoute } from '@/hooks/useUnreadDots'
import { AvatarStack, MemberAvatar } from '@/components/ui/avatar'
import { LivePresence } from '@/components/layout/LivePresence'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { PageLoader, EmptyState } from '@/components/ui/misc'
import { SearchDialog, SearchHighlighter, useSearchHotkey } from '@/features/search'
import { cn } from '@/lib/utils'

/** ⌘K on Apple platforms, Ctrl-K elsewhere — decorative hint on the trigger. */
const HOTKEY_HINT =
  typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform) ? '⌘K' : 'Ctrl K'

const NAV = [
  { to: '', label: 'Overview', icon: Compass, end: true },
  { to: 'itinerary', label: 'Itinerary', icon: MapPin },
  { to: 'chat', label: 'Chat', icon: MessageCircle },
  { to: 'polls', label: 'Polls', icon: Vote },
  { to: 'checklist', label: 'Checklist', icon: ListChecks },
  { to: 'budget', label: 'Budget', icon: PiggyBank },
  { to: 'packing', label: 'Packing', icon: Luggage },
  { to: 'calendar', label: 'Calendar', icon: CalendarDays },
  { to: 'questions', label: 'Questions', icon: HelpCircle },
  { to: 'notes', label: 'Notes', icon: NotebookPen },
  { to: 'ideas', label: 'Ideas', icon: Lightbulb },
  { to: 'settings', label: 'Settings', icon: Settings },
] as const

// The tabs that earn a spot on the mobile tab bar — everything else lives
// behind "More" so every page stays reachable on a phone.
const MOBILE_NAV = ['', 'itinerary', 'chat', 'checklist', 'budget']

/** Icon wrapper that badges an amber "new since last visit" dot (#43). */
function IconWithDot({ icon: Icon, unread, className }: {
  icon: typeof NAV[number]['icon']
  unread: boolean
  className?: string
}) {
  return (
    <span className="relative inline-flex">
      <Icon className={className} />
      {unread && (
        <>
          <span
            aria-hidden
            className="absolute -right-1 -top-1 size-2 rounded-full bg-accent ring-2 ring-surface"
          />
          <span className="sr-only">(new activity)</span>
        </>
      )}
    </span>
  )
}

/** Bottom-sheet listing every nav item that didn't make the mobile tab bar. */
function MoreSheet({ open, onOpenChange, items, unread }: {
  open: boolean
  onOpenChange: (o: boolean) => void
  items: typeof NAV[number][]
  unread: Record<UnreadRoute, boolean>
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>More</DialogTitle>
        </DialogHeader>
        <div className="grid grid-cols-3 gap-3">
          {items.map(({ to, label, icon: Icon, ...rest }) => (
            <NavLink
              key={to}
              to={to}
              end={'end' in rest}
              onClick={() => onOpenChange(false)}
              className={({ isActive }) =>
                cn(
                  'flex min-h-20 flex-col items-center justify-center gap-1.5 rounded-xl border px-2 py-3 text-center text-xs font-medium transition-colors',
                  isActive
                    ? 'border-primary bg-primary-faint text-primary'
                    : 'border-line text-ink-soft hover:bg-sunken'
                )
              }
            >
              <IconWithDot icon={Icon} unread={unread[to as UnreadRoute] ?? false} className="size-5" />
              {label}
            </NavLink>
          ))}
        </div>
      </DialogContent>
    </Dialog>
  )
}

function Shell() {
  const { trip, members, me } = useTripContext()
  const { dark, toggle } = useTheme()
  const location = useLocation()
  const [moreOpen, setMoreOpen] = React.useState(false)
  const [searchOpen, setSearchOpen] = React.useState(false)
  const openSearch = React.useCallback(() => setSearchOpen(true), [])
  useSearchHotkey(openSearch)

  const mobileItems = NAV.filter((n) => MOBILE_NAV.includes(n.to))
  const overflowItems = NAV.filter((n) => !MOBILE_NAV.includes(n.to))
  const onOverflowPage = overflowItems.some((n) => location.pathname.endsWith(`/${n.to}`))

  // Trip-relative segment: /trip/<id>/<feature> → '<feature>' ('' = overview)
  const activeRoute = location.pathname.split('/')[3] ?? ''
  const unread = useUnreadDots(trip.id, me.id, activeRoute)
  const overflowUnread = overflowItems.some((n) => unread[n.to as UnreadRoute])

  // A sheet opened from the tab bar should close itself the moment the
  // route actually changes (link tap, browser back/forward, deep link).
  React.useEffect(() => {
    setMoreOpen(false)
  }, [location.pathname])

  return (
    <div className="min-h-dvh md:flex">
      {/* ── Desktop sidebar ─────────────────────────────────────────── */}
      <aside className="no-print fixed inset-y-0 left-0 z-40 hidden w-60 flex-col border-r border-line bg-surface md:flex">
        <div className="flex items-center gap-2 px-5 pb-2 pt-5">
          <Link
            to="/"
            className="flex size-8 items-center justify-center rounded-lg text-muted transition-colors hover:bg-sunken hover:text-ink"
            title="All trips"
          >
            <ArrowLeft className="size-4" />
          </Link>
          <div className="min-w-0">
            <p className="truncate font-display text-sm font-bold leading-tight">{trip.name}</p>
            {trip.destination && (
              <p className="truncate text-xs text-muted">{trip.destination}</p>
            )}
          </div>
        </div>

        <div className="px-5 pt-1">
          <LivePresence showLabel />
        </div>

        <button
          type="button"
          onClick={openSearch}
          className="mx-3 mt-3 flex items-center gap-2 rounded-xl border border-line bg-surface px-3 py-2 text-sm text-muted transition-colors hover:border-line-strong hover:text-ink"
        >
          <Search className="size-4 shrink-0" />
          <span className="flex-1 text-left">Search…</span>
          <kbd className="rounded border border-line px-1.5 py-0.5 text-[10px] font-medium text-faint">
            {HOTKEY_HINT}
          </kbd>
        </button>

        <nav className="scrollbar-thin mt-3 flex-1 space-y-0.5 overflow-y-auto px-3">
          {NAV.map(({ to, label, icon: Icon, ...rest }) => (
            <NavLink
              key={to}
              to={to}
              end={'end' in rest}
              className={({ isActive }) =>
                cn(
                  'flex items-center gap-3 rounded-xl px-3 py-2 text-sm font-medium transition-colors',
                  isActive
                    ? 'bg-primary-faint text-primary'
                    : 'text-ink-soft hover:bg-sunken hover:text-ink'
                )
              }
            >
              <IconWithDot icon={Icon} unread={unread[to as UnreadRoute] ?? false} className="size-4.5" />
              {label}
            </NavLink>
          ))}
        </nav>

        <div className="border-t border-line p-4">
          <div className="flex items-center justify-between">
            <AvatarStack members={members} max={4} />
            <Button variant="ghost" size="icon" onClick={toggle} aria-label="Toggle theme">
              {dark ? <Sun /> : <Moon />}
            </Button>
          </div>
          <div className="mt-3 flex items-center gap-2.5">
            <MemberAvatar name={me.display_name} color={me.color} size="sm" />
            <span className="truncate text-xs text-muted">
              You’re planning as <strong className="text-ink-soft">{me.display_name}</strong>
            </span>
          </div>
        </div>
      </aside>

      {/* ── Mobile top bar ──────────────────────────────────────────── */}
      <header className="no-print sticky top-0 z-40 flex items-center gap-1 border-b border-line bg-bg/80 px-2 py-1.5 backdrop-blur-md md:hidden [transform:translateZ(0)] will-change-transform">
        <Link
          to="/"
          className="flex size-11 shrink-0 items-center justify-center rounded-lg text-muted"
          title="All trips"
          aria-label="All trips"
        >
          <ArrowLeft className="size-4" />
        </Link>
        <p className="min-w-0 flex-1 truncate px-1 font-display font-bold">{trip.name}</p>
        <LivePresence className="shrink-0" size="xs" max={3} hideWhenSolo />
        <Button variant="ghost" size="icon" onClick={openSearch} aria-label="Search this trip">
          <Search />
        </Button>
        <Button variant="ghost" size="icon" onClick={toggle} aria-label="Toggle theme">
          {dark ? <Sun /> : <Moon />}
        </Button>
        <NavLink
          to="settings"
          className="flex size-11 shrink-0 items-center justify-center rounded-lg"
          aria-label="Settings"
          title="Settings"
        >
          <MemberAvatar name={me.display_name} color={me.color} size="sm" />
        </NavLink>
      </header>

      {/* ── Content ─────────────────────────────────────────────────── */}
      <main className="min-w-0 flex-1 pb-24 md:ml-60 md:pb-10">
        <div className="mx-auto w-full max-w-4xl px-4 pt-5 md:px-8 md:pt-8">
          <Outlet />
        </div>
      </main>

      {/* ── Mobile bottom tabs ──────────────────────────────────────── */}
      {/*
        iOS/Android browsers auto-hide their chrome (URL bar) while scrolling,
        which changes the visual viewport height mid-scroll. A plain
        `position: fixed` element is repainted on the main thread in step with
        that chrome animation, and on fast/momentum scrolls the repaint falls
        behind — the bar visibly lags and a gap opens below it until scrolling
        settles. Forcing this onto its own GPU compositor layer (translateZ +
        will-change) makes the browser track it every frame independently of
        that repaint, which is the standard fix for this class of bug.
      */}
      <nav className="no-print fixed inset-x-0 bottom-0 z-40 border-t border-line bg-surface/90 backdrop-blur-md md:hidden [transform:translateZ(0)] will-change-transform">
        <div className="flex items-stretch justify-around pb-[env(safe-area-inset-bottom)]">
          {mobileItems.map(({ to, label, icon: Icon, ...rest }) => (
            <NavLink
              key={to}
              to={to}
              end={'end' in rest}
              className={({ isActive }) =>
                cn(
                  'flex min-w-0 flex-1 flex-col items-center gap-0.5 py-2 text-[10px] font-medium transition-colors',
                  isActive ? 'text-primary' : 'text-muted'
                )
              }
            >
              <IconWithDot icon={Icon} unread={unread[to as UnreadRoute] ?? false} className="size-5" />
              {label}
            </NavLink>
          ))}
          <button
            type="button"
            onClick={() => setMoreOpen(true)}
            aria-label="More pages"
            aria-haspopup="dialog"
            className={cn(
              'flex min-w-0 flex-1 flex-col items-center gap-0.5 py-2 text-[10px] font-medium transition-colors',
              onOverflowPage ? 'text-primary' : 'text-muted'
            )}
          >
            <IconWithDot icon={MoreHorizontal} unread={overflowUnread} className="size-5" />
            More
          </button>
        </div>
      </nav>

      <MoreSheet open={moreOpen} onOpenChange={setMoreOpen} items={overflowItems} unread={unread} />
      <SearchDialog open={searchOpen} onOpenChange={setSearchOpen} tripId={trip.id} />
      <SearchHighlighter />
    </div>
  )
}

export default function TripLayout() {
  const { tripId } = useParams<{ tripId: string }>()
  const { session, loading } = useAuth()

  if (loading) return <PageLoader />
  if (!session || !tripId) {
    return (
      <div className="mx-auto max-w-md px-4 py-20">
        <EmptyState
          icon={Compass}
          title="This trip is invite-only"
          description="Open the invite link your friend sent you, or sign in from the home page."
          action={
            <Button asChild>
              <Link to="/">Go home</Link>
            </Button>
          }
        />
      </div>
    )
  }

  return (
    <TripProvider
      tripId={tripId}
      fallback={<PageLoader />}
      denied={
        <div className="mx-auto max-w-md px-4 py-20">
          <EmptyState
            icon={Compass}
            title="No access to this trip"
            description="You’re not a member of this trip on this device. Ask for a fresh invite link."
            action={
              <Button asChild>
                <Link to="/">Go home</Link>
              </Button>
            }
          />
        </div>
      }
    >
      <Shell />
    </TripProvider>
  )
}
