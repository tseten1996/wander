import * as React from 'react'
import { Link } from 'react-router-dom'
import { motion } from 'framer-motion'
import {
  CalendarDays, ListChecks, Luggage, MapPin, MessageCircle, PartyPopper,
  PiggyBank, Sparkles, Vote, ArrowRight,
} from 'lucide-react'
import { useTripContext } from '@/hooks/useTrip'
import { useDashboard, planningProgress } from './api'
import { ITINERARY_META } from '@/features/itinerary/meta'
import { celebrateOncePerTrip, resetCelebration } from '@/lib/confetti'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Progress } from '@/components/ui/progress'
import { MemberAvatar } from '@/components/ui/avatar'
import { Skeleton } from '@/components/ui/misc'
import { cn, dateRange, daysUntil, formatMoney, longDate, formatTime, timeAgo } from '@/lib/utils'

const fadeUp = {
  initial: { opacity: 0, y: 12 },
  animate: { opacity: 1, y: 0 },
}

function Hero() {
  const { trip, members } = useTripContext()
  const days = trip.start_date ? daysUntil(trip.start_date) : null
  const started = days != null && days <= 0
  const ended = trip.end_date ? daysUntil(trip.end_date) < 0 : false

  return (
    <motion.div {...fadeUp} transition={{ duration: 0.3 }}>
      <Card className="relative overflow-hidden border-0 text-white shadow-lift">
        {trip.cover_url ? (
          <>
            <img src={trip.cover_url} alt="" className="absolute inset-0 h-full w-full object-cover" />
            <div className="absolute inset-0 bg-gradient-to-t from-black/70 via-black/30 to-black/10" />
          </>
        ) : (
          <div className="gradient-travel absolute inset-0" />
        )}
        <div className="relative flex min-h-44 flex-col justify-end p-6">
          <div className="flex flex-wrap items-end justify-between gap-4">
            <div>
              {trip.destination && (
                <p className="flex items-center gap-1.5 text-sm font-medium text-white/80">
                  <MapPin className="size-4" /> {trip.destination}
                </p>
              )}
              <h1 className="mt-1 font-display text-3xl font-bold tracking-tight md:text-4xl">
                {trip.name}
              </h1>
              <p className="mt-1 text-sm text-white/80">
                {dateRange(trip.start_date, trip.end_date)} · {members.length}{' '}
                {members.length === 1 ? 'traveler' : 'travelers'}
              </p>
            </div>
            {days != null && !ended && (
              <div className="rounded-2xl bg-white/15 px-4 py-2.5 text-center backdrop-blur-md">
                {started ? (
                  <p className="flex items-center gap-1.5 font-display text-lg font-bold">
                    <PartyPopper className="size-5" /> Trip in progress!
                  </p>
                ) : (
                  <>
                    <p className="font-display text-3xl font-bold leading-none">{days}</p>
                    <p className="mt-1 text-xs font-medium text-white/80">
                      {days === 1 ? 'day to go' : 'days to go'}
                    </p>
                  </>
                )}
              </div>
            )}
          </div>
        </div>
      </Card>
    </motion.div>
  )
}

export default function DashboardPage() {
  const { trip, membersById } = useTripContext()
  const dash = useDashboard(trip.id)

  const progress = dash.data ? planningProgress(dash.data) : null

  // Confetti the moment the group's planning reaches 100%
  React.useEffect(() => {
    if (!progress || progress.total === 0) return
    if (progress.pct === 100) celebrateOncePerTrip(trip.id)
    else resetCelebration(trip.id)
  }, [progress, trip.id])

  const budgetPlanned = dash.data?.budget.reduce((s, b) => s + (b.actual ?? b.estimated ?? 0), 0) ?? 0
  const budgetSpent = dash.data?.budget.reduce((s, b) => s + (b.actual ?? 0), 0) ?? 0

  const quickLinks = [
    { to: 'polls', label: 'Polls', icon: Vote, hint: dash.data ? `${dash.data.pollsTotal - dash.data.pollsClosed} open` : '' },
    { to: 'chat', label: 'Chat', icon: MessageCircle, hint: dash.data ? `${dash.data.messagesCount} messages` : '' },
    { to: 'checklist', label: 'Checklist', icon: ListChecks, hint: dash.data ? `${dash.data.checklist.filter((c) => !c.done).length} open` : '' },
    { to: 'packing', label: 'Packing', icon: Luggage, hint: dash.data ? `${dash.data.packingPacked}/${dash.data.packingTotal} packed` : '' },
  ]

  return (
    <div className="space-y-5">
      <Hero />

      {/* Progress + budget */}
      <div className="grid gap-5 md:grid-cols-2">
        <motion.div {...fadeUp} transition={{ duration: 0.3, delay: 0.05 }}>
          <Card className="h-full">
            <CardHeader>
              <CardTitle className="flex items-center gap-2">
                <Sparkles className="size-4 text-primary" /> Planning progress
              </CardTitle>
            </CardHeader>
            <CardContent>
              {!dash.data ? (
                <Skeleton className="h-16" />
              ) : progress!.total === 0 ? (
                <p className="text-sm text-muted">
                  Add checklist items, polls and questions — this bar tracks how
                  much of the planning your group has knocked out.
                </p>
              ) : (
                <>
                  <div className="flex items-end justify-between">
                    <p className="font-display text-3xl font-bold">{progress!.pct}%</p>
                    <p className="text-sm text-muted">
                      {progress!.done} of {progress!.total} planning items done
                    </p>
                  </div>
                  <Progress value={progress!.pct} className="mt-3 h-2.5" label="Planning progress" />
                  {progress!.pct === 100 && (
                    <p className="mt-2 text-sm font-medium text-success">
                      Everything's planned — time to pack! 🎉
                    </p>
                  )}
                </>
              )}
            </CardContent>
          </Card>
        </motion.div>

        <motion.div {...fadeUp} transition={{ duration: 0.3, delay: 0.1 }}>
          <Link to="budget" className="block h-full">
            <Card className="h-full transition-shadow hover:shadow-lift">
              <CardHeader>
                <CardTitle className="flex items-center gap-2">
                  <PiggyBank className="size-4 text-primary" /> Budget
                  <ArrowRight className="ml-auto size-4 text-faint" />
                </CardTitle>
              </CardHeader>
              <CardContent>
                {!dash.data ? (
                  <Skeleton className="h-16" />
                ) : (
                  <>
                    <div className="flex items-end justify-between">
                      <p className="font-display text-3xl font-bold">
                        {formatMoney(budgetSpent, trip.currency)}
                      </p>
                      <p className="text-sm text-muted">
                        {trip.estimated_budget
                          ? `of ${formatMoney(trip.estimated_budget, trip.currency)} budget`
                          : `${formatMoney(budgetPlanned, trip.currency)} planned`}
                      </p>
                    </div>
                    <Progress
                      value={
                        trip.estimated_budget
                          ? (budgetSpent / trip.estimated_budget) * 100
                          : budgetPlanned > 0
                            ? (budgetSpent / budgetPlanned) * 100
                            : 0
                      }
                      className="mt-3 h-2.5"
                      barClassName={
                        trip.estimated_budget && budgetSpent > trip.estimated_budget
                          ? 'bg-danger'
                          : undefined
                      }
                      label="Budget used"
                    />
                  </>
                )}
              </CardContent>
            </Card>
          </Link>
        </motion.div>
      </div>

      {/* Quick nav */}
      <motion.div
        {...fadeUp}
        transition={{ duration: 0.3, delay: 0.15 }}
        className="grid grid-cols-2 gap-3 sm:grid-cols-4"
      >
        {quickLinks.map(({ to, label, icon: Icon, hint }) => (
          <Link key={to} to={to}>
            <Card className="p-4 transition-all hover:-translate-y-0.5 hover:shadow-lift">
              <Icon className="size-5 text-primary" />
              <p className="mt-2 font-display text-sm font-semibold">{label}</p>
              <p className="text-xs text-muted">{hint || '—'}</p>
            </Card>
          </Link>
        ))}
      </motion.div>

      {/* Upcoming + activity */}
      <div className="grid gap-5 md:grid-cols-2">
        <motion.div {...fadeUp} transition={{ duration: 0.3, delay: 0.2 }}>
          <Card className="h-full">
            <CardHeader>
              <CardTitle className="flex items-center gap-2">
                <CalendarDays className="size-4 text-primary" /> Coming up
              </CardTitle>
            </CardHeader>
            <CardContent className="space-y-3">
              {!dash.data ? (
                <Skeleton className="h-24" />
              ) : dash.data.upcoming.length === 0 ? (
                <p className="text-sm text-muted">
                  Nothing scheduled yet —{' '}
                  <Link to="itinerary" className="font-medium text-primary hover:underline">
                    start the itinerary
                  </Link>
                  .
                </p>
              ) : (
                dash.data.upcoming.map((item) => {
                  const meta = ITINERARY_META[item.category]
                  return (
                    <div key={item.id} className="flex items-center gap-3">
                      <span className={cn('flex size-9 shrink-0 items-center justify-center rounded-xl', meta.chip)}>
                        <meta.icon className="size-4.5" />
                      </span>
                      <div className="min-w-0">
                        <p className="truncate text-sm font-medium">{item.title}</p>
                        <p className="truncate text-xs text-muted">
                          {item.day ? longDate(item.day) : 'Unscheduled'}
                          {item.start_time && ` · ${formatTime(item.start_time)}`}
                        </p>
                      </div>
                    </div>
                  )
                })
              )}
            </CardContent>
          </Card>
        </motion.div>

        <motion.div {...fadeUp} transition={{ duration: 0.3, delay: 0.25 }}>
          <Card className="h-full">
            <CardHeader>
              <CardTitle>Recent activity</CardTitle>
            </CardHeader>
            <CardContent className="space-y-3">
              {!dash.data ? (
                <Skeleton className="h-24" />
              ) : dash.data.activity.length === 0 ? (
                <p className="text-sm text-muted">
                  It's quiet… invite friends from{' '}
                  <Link to="settings" className="font-medium text-primary hover:underline">
                    Settings
                  </Link>{' '}
                  and start planning together.
                </p>
              ) : (
                dash.data.activity.map((a) => {
                  const member = a.member_id ? membersById.get(a.member_id) : null
                  return (
                    <div key={a.id} className="flex items-center gap-3">
                      {member ? (
                        <MemberAvatar name={member.display_name} color={member.color} size="sm" />
                      ) : (
                        <span className="size-7 shrink-0 rounded-full bg-sunken" />
                      )}
                      <p className="min-w-0 flex-1 truncate text-sm">
                        <span className="font-medium">{member?.display_name ?? 'Someone'}</span>{' '}
                        <span className="text-muted">{a.verb}</span>
                        {a.subject && <span className="font-medium"> “{a.subject}”</span>}
                      </p>
                      <span className="shrink-0 text-xs text-faint">{timeAgo(a.created_at)}</span>
                    </div>
                  )
                })
              )}
            </CardContent>
          </Card>
        </motion.div>
      </div>
    </div>
  )
}
