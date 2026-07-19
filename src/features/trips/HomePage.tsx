import * as React from 'react'
import { Link } from 'react-router-dom'
import { motion } from 'framer-motion'
import { Compass, Mail, Moon, Plus, Sun, LogOut, MapPin, Archive } from 'lucide-react'
import { toast } from 'sonner'
import { useAuth } from '@/hooks/useAuth'
import { useTheme } from '@/hooks/useTheme'
import { useTrips, type TripWithMembers } from './api'
import { CreateTripDialog } from './CreateTripDialog'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Card } from '@/components/ui/card'
import { AvatarStack } from '@/components/ui/avatar'
import { Badge } from '@/components/ui/badge'
import { PageLoader, Skeleton } from '@/components/ui/misc'
import { dateRange, daysUntil } from '@/lib/utils'

function Wordmark() {
  return (
    <span className="inline-flex items-center gap-2 font-display text-xl font-bold">
      <span className="flex size-8 items-center justify-center rounded-xl bg-primary text-on-primary">
        <Compass className="size-4.5" />
      </span>
      Wander
    </span>
  )
}

/* ── Signed-out landing: magic-link sign-in ─────────────────────────────── */

function SignIn() {
  const { signInWithEmail } = useAuth()
  const [email, setEmail] = React.useState('')
  const [sent, setSent] = React.useState(false)
  const [busy, setBusy] = React.useState(false)

  async function submit(e: React.FormEvent) {
    e.preventDefault()
    if (!email.includes('@')) return
    setBusy(true)
    try {
      await signInWithEmail(email.trim())
      setSent(true)
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Could not send the link')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="gradient-travel-soft flex min-h-dvh flex-col">
      <header className="flex items-center justify-between px-6 py-5">
        <Wordmark />
      </header>
      <main className="mx-auto flex w-full max-w-md flex-1 flex-col justify-center px-6 pb-24">
        <motion.div
          initial={{ opacity: 0, y: 12 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.35, ease: 'easeOut' }}
        >
          <h1 className="font-display text-4xl font-bold tracking-tight text-balance">
            Plan trips together, in one beautiful place.
          </h1>
          <p className="mt-3 text-muted">
            Polls, itinerary, budget, packing and chat — everything your group
            chat was bad at.
          </p>

          {sent ? (
            <Card className="mt-8 p-6 text-center">
              <Mail className="mx-auto size-8 text-primary" />
              <p className="mt-3 font-display font-semibold">Check your inbox</p>
              <p className="mt-1 text-sm text-muted">
                We sent a sign-in link to <strong>{email}</strong>. Open it on
                this device and you’re in.
              </p>
              <Button variant="link" className="mt-2" onClick={() => setSent(false)}>
                Use a different email
              </Button>
            </Card>
          ) : (
            <form onSubmit={submit} className="mt-8 space-y-3">
              <Input
                type="email"
                required
                placeholder="you@example.com"
                value={email}
                autoComplete="email"
                onChange={(e) => setEmail(e.target.value)}
                className="h-12 rounded-2xl text-base"
              />
              <Button type="submit" size="lg" className="w-full" disabled={busy}>
                {busy ? 'Sending…' : 'Email me a magic link'}
              </Button>
              <p className="text-center text-xs text-muted">
                No passwords. Got an invite link from a friend? Just open it —
                you don’t need to sign in here.
              </p>
            </form>
          )}
        </motion.div>
      </main>
    </div>
  )
}

/* ── Trip card ──────────────────────────────────────────────────────────── */

function TripCard({ trip, index }: { trip: TripWithMembers; index: number }) {
  const days = trip.start_date ? daysUntil(trip.start_date) : null
  return (
    <motion.div
      initial={{ opacity: 0, y: 14 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.3, delay: index * 0.05, ease: 'easeOut' }}
    >
      <Link to={`/trip/${trip.id}`} className="group block">
        <Card className="overflow-hidden transition-all duration-200 group-hover:-translate-y-0.5 group-hover:shadow-lift">
          <div className="relative h-36">
            {trip.cover_url ? (
              <img
                src={trip.cover_url}
                alt=""
                loading="lazy"
                className="h-full w-full object-cover"
              />
            ) : (
              <div className="gradient-travel h-full w-full" />
            )}
            {days != null && days >= 0 && !trip.archived && (
              <Badge className="absolute right-3 top-3 bg-white/90 text-stone-800 backdrop-blur">
                {days === 0 ? 'Today!' : `${days} days to go`}
              </Badge>
            )}
            {trip.archived && (
              <Badge className="absolute right-3 top-3 bg-white/90 text-stone-500 backdrop-blur">
                <Archive /> Archived
              </Badge>
            )}
          </div>
          <div className="p-4">
            <p className="font-display font-bold">{trip.name}</p>
            <p className="mt-0.5 flex items-center gap-1 text-sm text-muted">
              {trip.destination && (
                <>
                  <MapPin className="size-3.5" />
                  {trip.destination}
                  <span className="mx-1">·</span>
                </>
              )}
              {dateRange(trip.start_date, trip.end_date)}
            </p>
            <div className="mt-3">
              <AvatarStack members={trip.members} max={5} />
            </div>
          </div>
        </Card>
      </Link>
    </motion.div>
  )
}

/* ── Signed-in home ─────────────────────────────────────────────────────── */

function TripsHome() {
  const { session, isAnonymous, signOut } = useAuth()
  const { dark, toggle } = useTheme()
  const trips = useTrips(!!session)
  const [createOpen, setCreateOpen] = React.useState(false)

  const active = (trips.data ?? []).filter((t) => !t.archived)
  const archived = (trips.data ?? []).filter((t) => t.archived)

  return (
    <div className="min-h-dvh">
      <header className="mx-auto flex max-w-4xl items-center justify-between px-5 py-5">
        <Wordmark />
        <div className="flex items-center gap-1">
          <Button variant="ghost" size="icon" onClick={toggle} aria-label="Toggle theme">
            {dark ? <Sun /> : <Moon />}
          </Button>
          {!isAnonymous && (
            <Button variant="ghost" size="icon" onClick={signOut} aria-label="Sign out" title="Sign out">
              <LogOut />
            </Button>
          )}
        </div>
      </header>

      <main className="mx-auto max-w-4xl px-5 pb-24">
        <div className="mb-6 flex flex-wrap items-end justify-between gap-3">
          <div>
            <h1 className="font-display text-3xl font-bold tracking-tight">Your trips</h1>
            <p className="mt-1 text-sm text-muted">
              {isAnonymous
                ? 'Trips you’ve joined on this device.'
                : `Signed in as ${session?.user.email}`}
            </p>
          </div>
          {!isAnonymous && (
            <Button onClick={() => setCreateOpen(true)}>
              <Plus /> New trip
            </Button>
          )}
        </div>

        {trips.isLoading ? (
          <div className="grid gap-4 sm:grid-cols-2">
            <Skeleton className="h-56" />
            <Skeleton className="h-56" />
          </div>
        ) : active.length === 0 ? (
          <Card className="p-10 text-center">
            <Compass className="mx-auto size-10 text-primary" />
            <p className="mt-4 font-display text-lg font-semibold">
              {isAnonymous ? 'No trips on this device yet' : 'Where to next?'}
            </p>
            <p className="mx-auto mt-1 max-w-sm text-sm text-muted">
              {isAnonymous
                ? 'Open an invite link from a friend to join their trip — it takes seconds.'
                : 'Create your first trip, then share the invite link with your friends.'}
            </p>
            {!isAnonymous && (
              <Button className="mt-5" onClick={() => setCreateOpen(true)}>
                <Plus /> Create a trip
              </Button>
            )}
          </Card>
        ) : (
          <div className="grid gap-4 sm:grid-cols-2">
            {active.map((t, i) => (
              <TripCard key={t.id} trip={t} index={i} />
            ))}
          </div>
        )}

        {archived.length > 0 && (
          <>
            <h2 className="mb-3 mt-10 font-display text-lg font-semibold text-muted">Archived</h2>
            <div className="grid gap-4 opacity-70 sm:grid-cols-2">
              {archived.map((t, i) => (
                <TripCard key={t.id} trip={t} index={i} />
              ))}
            </div>
          </>
        )}
      </main>

      <CreateTripDialog open={createOpen} onOpenChange={setCreateOpen} />
    </div>
  )
}

export default function HomePage() {
  const { session, loading } = useAuth()
  if (loading) return <PageLoader />
  return session ? <TripsHome /> : <SignIn />
}
