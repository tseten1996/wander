import * as React from 'react'
import { Link } from 'react-router-dom'
import { motion } from 'framer-motion'
import {
  ArrowRight, CalendarClock, HelpCircle, ListChecks, Luggage, PartyPopper,
  PiggyBank, Vote,
} from 'lucide-react'
import { useTripContext } from '@/hooks/useTrip'
import { PageHeader } from '@/components/layout/PageHeader'
import { Card, CardContent } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { EmptyState, ErrorState, Skeleton } from '@/components/ui/misc'
import { cn, daysUntil, formatMoney, shortDate } from '@/lib/utils'
import { useMyTrip, type MyTripSummary } from './api'

const fadeUp = {
  initial: { opacity: 0, y: 12 },
  animate: { opacity: 1, y: 0 },
}

/** One row inside a section — always a full-width link to the owning feature. */
function Row({ to, children }: { to: string; children: React.ReactNode }) {
  return (
    <Link
      to={to}
      className="flex min-h-11 items-center gap-3 rounded-xl px-3 -mx-1 text-sm transition-colors hover:bg-sunken focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/50"
    >
      {children}
    </Link>
  )
}

interface SectionProps {
  icon: typeof ListChecks
  title: string
  to: string
  count: number
  children: React.ReactNode
  delay: number
}

/** A collapsible section: renders nothing when there's nothing outstanding. */
function Section({ icon: Icon, title, to, count, children, delay }: SectionProps) {
  if (count === 0) return null
  return (
    <motion.div {...fadeUp} transition={{ duration: 0.3, delay }}>
      <Card>
        <Link
          to={to}
          className="flex items-center gap-2 border-b border-line px-5 py-3.5 transition-colors hover:bg-sunken focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-primary/50"
        >
          <Icon className="size-4.5 text-primary" />
          <h2 className="font-display text-sm font-semibold">{title}</h2>
          <Badge variant="primary" className="ml-1">{count}</Badge>
          <ArrowRight className="ml-auto size-4 text-faint" />
        </Link>
        <CardContent className="py-2">{children}</CardContent>
      </Card>
    </motion.div>
  )
}

function ChecklistSection({ items, delay }: { items: MyTripSummary['checklist']; delay: number }) {
  return (
    <Section icon={ListChecks} title="Your tasks" to="../checklist" count={items.length} delay={delay}>
      {items.map((item) => {
        const overdue = item.due_date && daysUntil(item.due_date) < 0
        const dueSoon = item.due_date && !overdue && daysUntil(item.due_date) <= 3
        return (
          <Row key={item.id} to="../checklist">
            <span className="min-w-0 flex-1 truncate">{item.title}</span>
            {item.due_date && (
              <Badge variant={overdue ? 'danger' : dueSoon ? 'accent' : 'neutral'}>
                <CalendarClock /> {shortDate(item.due_date)}{overdue && ' · overdue'}
              </Badge>
            )}
          </Row>
        )
      })}
    </Section>
  )
}

function PackingSection({ items, delay }: { items: MyTripSummary['packing']; delay: number }) {
  return (
    <Section icon={Luggage} title="Packing you added" to="../packing" count={items.length} delay={delay}>
      {items.map((item) => (
        <Row key={item.id} to="../packing">
          <span className="min-w-0 flex-1 truncate">{item.name}</span>
          <span className="shrink-0 text-xs capitalize text-faint">{item.category}</span>
        </Row>
      ))}
    </Section>
  )
}

function PollsSection({ items, delay }: { items: MyTripSummary['polls']; delay: number }) {
  return (
    <Section icon={Vote} title="Polls to vote in" to="../polls" count={items.length} delay={delay}>
      {items.map((poll) => (
        <Row key={poll.id} to="../polls">
          <span className="min-w-0 flex-1 truncate">{poll.question}</span>
          <ArrowRight className="size-4 shrink-0 text-faint" />
        </Row>
      ))}
    </Section>
  )
}

function QuestionsSection({ items, delay }: { items: MyTripSummary['questions']; delay: number }) {
  return (
    <Section icon={HelpCircle} title="Your open questions" to="../questions" count={items.length} delay={delay}>
      {items.map((q) => (
        <Row key={q.id} to="../questions">
          <span className="min-w-0 flex-1 truncate">{q.title}</span>
          <ArrowRight className="size-4 shrink-0 text-faint" />
        </Row>
      ))}
    </Section>
  )
}

/** Settle-up is a single status line, not a list — so it renders on its own. */
function BalanceSection({ net, currency, delay }: { net: number; currency: string; delay: number }) {
  const owed = net > 0
  return (
    <motion.div {...fadeUp} transition={{ duration: 0.3, delay }}>
      <Card>
        <Link
          to="../budget"
          className="flex items-center gap-2 border-b border-line px-5 py-3.5 transition-colors hover:bg-sunken focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-primary/50"
        >
          <PiggyBank className="size-4.5 text-primary" />
          <h2 className="font-display text-sm font-semibold">Settle up</h2>
          <ArrowRight className="ml-auto size-4 text-faint" />
        </Link>
        <CardContent className="py-4">
          <div className="flex items-end justify-between gap-3">
            <p className="text-sm text-muted">
              {owed ? "You're owed" : 'You owe'}
            </p>
            <p className={cn('font-display text-2xl font-bold', owed ? 'text-success' : 'text-danger')}>
              {formatMoney(Math.abs(net), currency)}
            </p>
          </div>
        </CardContent>
      </Card>
    </motion.div>
  )
}

export default function MePage() {
  const { trip, me, members } = useTripContext()
  const summary = useMyTrip(trip.id, me.id, members)

  const description = `Everything assigned to or owed by ${me.display_name} on this trip.`

  if (summary.isError) {
    return (
      <div>
        <PageHeader title="My trip" description={description} />
        <ErrorState onRetry={summary.refetch} isRetrying={summary.isFetching} />
      </div>
    )
  }

  if (!summary.data) {
    return (
      <div>
        <PageHeader title="My trip" description={description} />
        <div className="space-y-4">
          <Skeleton className="h-28" />
          <Skeleton className="h-28" />
        </div>
      </div>
    )
  }

  const d = summary.data

  return (
    <div>
      <PageHeader title="My trip" description={description} />

      {d.outstandingCount === 0 ? (
        <motion.div {...fadeUp} transition={{ duration: 0.3 }}>
          <EmptyState
            icon={PartyPopper}
            title="You're all set"
            description="No tasks, packing, votes, questions or balances waiting on you right now. Enjoy the trip!"
          />
        </motion.div>
      ) : (
        <div className="space-y-4">
          <ChecklistSection items={d.checklist} delay={0.03} />
          {d.hasBalance && <BalanceSection net={d.net} currency={trip.currency} delay={0.06} />}
          <PollsSection items={d.polls} delay={0.09} />
          <QuestionsSection items={d.questions} delay={0.12} />
          <PackingSection items={d.packing} delay={0.15} />
        </div>
      )}
    </div>
  )
}
