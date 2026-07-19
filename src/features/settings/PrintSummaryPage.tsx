import { useParams } from 'react-router-dom'
import { useQuery } from '@tanstack/react-query'
import { Printer, ArrowLeft } from 'lucide-react'
import { Link } from 'react-router-dom'
import { supabase } from '@/lib/supabase'
import { TripProvider, useTripContext } from '@/hooks/useTrip'
import { ITINERARY_META } from '@/features/itinerary/meta'
import { Button } from '@/components/ui/button'
import { PageLoader } from '@/components/ui/misc'
import { dateRange, formatMoney, formatTime, longDate } from '@/lib/utils'
import type { BudgetEntry, ChecklistItem, ItineraryItem, Note, PackingItem } from '@/types'

/**
 * A print-optimized, single-page summary of the whole trip. "Export to PDF"
 * is the browser's print dialog — zero dependencies, perfect typography.
 */
function Summary() {
  const { trip, members } = useTripContext()
  const data = useQuery({
    queryKey: ['print', trip.id],
    queryFn: async () => {
      const [itinerary, checklist, budget, packing, notes] = await Promise.all([
        supabase.from('itinerary_items').select('*').eq('trip_id', trip.id).order('day', { nullsFirst: false }).order('position'),
        supabase.from('checklist_items').select('*').eq('trip_id', trip.id).order('position'),
        supabase.from('budget_entries').select('*').eq('trip_id', trip.id).order('created_at'),
        supabase.from('packing_items').select('*').eq('trip_id', trip.id).order('category').order('position'),
        supabase.from('notes').select('*').eq('trip_id', trip.id).order('updated_at', { ascending: false }),
      ])
      return {
        itinerary: (itinerary.data ?? []) as ItineraryItem[],
        checklist: (checklist.data ?? []) as ChecklistItem[],
        budget: (budget.data ?? []) as BudgetEntry[],
        packing: (packing.data ?? []) as PackingItem[],
        notes: (notes.data ?? []) as Note[],
      }
    },
  })

  if (!data.data) return <PageLoader />
  const { itinerary, checklist, budget, packing, notes } = data.data

  const byDay = new Map<string | null, ItineraryItem[]>()
  for (const item of itinerary) byDay.set(item.day, [...(byDay.get(item.day) ?? []), item])
  const planned = budget.reduce((s, e) => s + (e.actual ?? e.estimated ?? 0), 0)

  return (
    <div className="print-page mx-auto max-w-3xl px-4 py-6 sm:px-6 sm:py-8">
      <div className="no-print mb-6 flex flex-wrap items-center justify-between gap-2">
        <Button variant="ghost" asChild>
          <Link to={`/trip/${trip.id}`}>
            <ArrowLeft /> Back to trip
          </Link>
        </Button>
        <Button onClick={() => window.print()}>
          <Printer /> Print / Save as PDF
        </Button>
      </div>

      <header className="border-b-2 border-ink pb-4">
        <h1 className="font-display text-3xl font-bold sm:text-4xl">{trip.name}</h1>
        <p className="mt-1 text-lg text-muted">
          {trip.destination && `${trip.destination} · `}
          {dateRange(trip.start_date, trip.end_date)}
        </p>
        {trip.description && <p className="mt-2 text-sm">{trip.description}</p>}
        <p className="mt-2 text-sm text-muted">
          Travelers: {members.map((m) => m.display_name).join(', ')}
        </p>
      </header>

      {itinerary.length > 0 && (
        <section className="mt-6">
          <h2 className="font-display text-xl font-bold">Itinerary</h2>
          {[...byDay.entries()].map(([day, items]) => (
            <div key={day ?? 'tbd'} className="mt-3">
              <h3 className="text-sm font-semibold text-primary">
                {day ? longDate(day) : 'Not scheduled'}
              </h3>
              <ul className="mt-1 space-y-1">
                {items.map((item) => (
                  <li key={item.id} className="flex gap-2 text-sm">
                    <span className="w-20 shrink-0 tabular-nums text-muted">
                      {item.start_time ? formatTime(item.start_time) : '—'}
                    </span>
                    <span>
                      <strong>{item.title}</strong>
                      <span className="text-muted">
                        {' '}({ITINERARY_META[item.category].label.toLowerCase()})
                        {item.location && ` · ${item.location}`}
                        {item.cost != null && ` · ${formatMoney(item.cost, trip.currency)}`}
                      </span>
                      {item.notes && <span className="block text-xs text-muted">{item.notes}</span>}
                    </span>
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </section>
      )}

      {checklist.length > 0 && (
        <section className="mt-6">
          <h2 className="font-display text-xl font-bold">Checklist</h2>
          <ul className="mt-2 grid gap-x-6 gap-y-1 sm:grid-cols-2">
            {checklist.map((c) => (
              <li key={c.id} className="text-sm">
                <span className="mr-1.5">{c.done ? '☑' : '☐'}</span>
                <span className={c.done ? 'text-muted line-through' : ''}>{c.title}</span>
              </li>
            ))}
          </ul>
        </section>
      )}

      {budget.length > 0 && (
        <section className="mt-6">
          <h2 className="font-display text-xl font-bold">Budget</h2>
          <div className="mt-2 overflow-x-auto">
            <table className="w-full min-w-[420px] text-sm">
              <thead>
                <tr className="border-b border-line text-left text-xs uppercase tracking-wide text-muted">
                  <th className="py-1.5">Item</th>
                  <th className="py-1.5 text-right">Estimated</th>
                  <th className="py-1.5 text-right">Actual</th>
                </tr>
              </thead>
              <tbody>
                {budget.map((e) => (
                  <tr key={e.id} className="border-b border-line/50">
                    <td className="py-1.5">{e.title}</td>
                    <td className="py-1.5 text-right tabular-nums">{formatMoney(e.estimated, trip.currency)}</td>
                    <td className="py-1.5 text-right tabular-nums">{formatMoney(e.actual, trip.currency)}</td>
                  </tr>
                ))}
                <tr className="font-semibold">
                  <td className="py-2">Total planned</td>
                  <td />
                  <td className="py-2 text-right tabular-nums">{formatMoney(planned, trip.currency)}</td>
                </tr>
              </tbody>
            </table>
          </div>
        </section>
      )}

      {packing.length > 0 && (
        <section className="mt-6">
          <h2 className="font-display text-xl font-bold">Packing</h2>
          <ul className="mt-2 grid gap-x-6 gap-y-1 sm:grid-cols-3">
            {packing.map((p) => (
              <li key={p.id} className="text-sm">
                <span className="mr-1.5">{p.packed ? '☑' : '☐'}</span>
                {p.name}
              </li>
            ))}
          </ul>
        </section>
      )}

      {notes.length > 0 && (
        <section className="mt-6">
          <h2 className="font-display text-xl font-bold">Notes</h2>
          {notes.map((n) => (
            <div key={n.id} className="mt-2">
              <h3 className="text-sm font-semibold">{n.title}</h3>
              <p className="whitespace-pre-wrap text-xs text-muted">{n.content}</p>
            </div>
          ))}
        </section>
      )}

      <footer className="mt-8 border-t border-line pt-3 text-center text-xs text-faint">
        Made with Wander · exported {new Date().toLocaleDateString()}
      </footer>
    </div>
  )
}

export default function PrintSummaryPage() {
  const { tripId } = useParams<{ tripId: string }>()
  if (!tripId) return null
  return (
    <TripProvider tripId={tripId} fallback={<PageLoader />} denied={<PageLoader />}>
      <Summary />
    </TripProvider>
  )
}
