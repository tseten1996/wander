import * as React from 'react'
import { NavLink, Outlet, Link, useParams } from 'react-router-dom'
import {
  ArrowLeft, CalendarDays, CheckSquare, Compass, Lightbulb, ListChecks,
  Luggage, MapPin, MessageCircle, Moon, NotebookPen, PiggyBank, Settings,
  Sun, Vote, HelpCircle,
} from 'lucide-react'
import { TripProvider, useTripContext } from '@/hooks/useTrip'
import { useAuth } from '@/hooks/useAuth'
import { useTheme } from '@/hooks/useTheme'
import { AvatarStack, MemberAvatar } from '@/components/ui/avatar'
import { Button } from '@/components/ui/button'
import { PageLoader, EmptyState } from '@/components/ui/misc'
import { cn } from '@/lib/utils'

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

// The five tabs that earn a spot on the mobile tab bar
const MOBILE_NAV = ['', 'itinerary', 'chat', 'checklist', 'budget']

function Shell() {
  const { trip, members, me } = useTripContext()
  const { dark, toggle } = useTheme()

  const mobileItems = NAV.filter((n) => MOBILE_NAV.includes(n.to))

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
              <Icon className="size-4.5" />
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
      <header className="no-print sticky top-0 z-40 flex items-center gap-2 border-b border-line bg-bg/80 px-4 py-3 backdrop-blur-md md:hidden">
        <Link
          to="/"
          className="flex size-8 shrink-0 items-center justify-center rounded-lg text-muted"
          title="All trips"
        >
          <ArrowLeft className="size-4" />
        </Link>
        <p className="min-w-0 flex-1 truncate font-display font-bold">{trip.name}</p>
        <Button variant="ghost" size="icon" onClick={toggle} aria-label="Toggle theme">
          {dark ? <Sun /> : <Moon />}
        </Button>
        <NavLink to="settings">
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
      <nav className="no-print fixed inset-x-0 bottom-0 z-40 border-t border-line bg-surface/90 backdrop-blur-md md:hidden">
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
              <Icon className="size-5" />
              {label}
            </NavLink>
          ))}
        </div>
      </nav>
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
