import type {
  BudgetCategory, BudgetEntry, ChecklistItem, InspirationItem, ItineraryItem,
  Message, Note, Poll, PollOption, Stay, Transport, TransportMode, WishlistItem,
} from '@/types'
import { searchAnchorId } from './anchor'

export type SearchKind =
  | 'itinerary' | 'budget' | 'stay' | 'transport' | 'poll' | 'message'
  | 'checklist' | 'note' | 'idea' | 'wishlist'

export interface SearchResult {
  id: string
  kind: SearchKind
  /** Trip-relative route segment, e.g. `polls` → `/trip/:id/polls`. */
  route: string
  /** DOM id to deep-link to (`#<anchorId>`). */
  anchorId: string
  /** Primary line shown in the result row. */
  title: string
  /** Optional context line (the matched field when it isn't the title). */
  snippet: string | null
}

/** A kind's ordered, capped results — the hook decorates these with a label and
 *  icon (both runtime-only values) so this module stays free of React/lucide and
 *  is unit-testable on its own. */
export interface KindResults {
  kind: SearchKind
  results: SearchResult[]
}

/** Minimum query length before we search — one char is all noise. */
export const MIN_QUERY_LENGTH = 2

/** Cap per section so the palette stays skimmable. */
export const MAX_PER_KIND = 6

// Itinerary and budget lead — the trip's densest, most-referenced content —
// then the logistics "source of truth" (stays, transport) people pull up at a
// check-in desk, the original five, and the wishlist shelf last.
export const KIND_ORDER: SearchKind[] = [
  'itinerary', 'budget', 'stay', 'transport', 'poll', 'message', 'checklist',
  'note', 'idea', 'wishlist',
]

/** The ten cached arrays the index reads — one per searchable section. */
export interface SearchSources {
  itinerary: ItineraryItem[]
  budget: BudgetEntry[]
  polls: (Poll & { poll_options: PollOption[] })[]
  messages: Message[]
  checklist: ChecklistItem[]
  notes: Note[]
  ideas: InspirationItem[]
  stays: Stay[]
  transport: Transport[]
  wishlist: WishlistItem[]
}

/** Human labels for a budget entry's category, so a search for "food" matches a
 *  "Food & drinks" expense. Kept here (not imported from BudgetPage) so the
 *  search chunk never pulls in that heavy page module. */
const BUDGET_CATEGORY_LABELS: Record<BudgetCategory, string> = {
  stay: 'Stay',
  transport: 'Transport',
  food: 'Food & drinks',
  activities: 'Activities',
  shopping: 'Shopping',
  other: 'Other',
}

/** Readable transport-mode labels, so a search for "train" matches a hop. Kept
 *  here (not imported from TransportCard) for the same reason as the budget
 *  labels above — the search chunk must not pull in the card's React/lucide. */
const TRANSPORT_MODE_LABELS: Record<TransportMode, string> = {
  flight: 'Flight',
  train: 'Train',
  bus: 'Bus',
  car: 'Car',
  ferry: 'Ferry',
}

/** `q` is expected pre-lowercased. */
function hit(haystack: string | null | undefined, q: string): boolean {
  return !!haystack && haystack.toLowerCase().includes(q)
}

/** A windowed excerpt around the first match, with ellipses when trimmed. */
function excerpt(text: string, q: string, radius = 60): string {
  const flat = text.replace(/\s+/g, ' ').trim()
  const i = flat.toLowerCase().indexOf(q)
  if (i < 0) return flat.length > radius * 2 ? `${flat.slice(0, radius * 2)}…` : flat
  const start = Math.max(0, i - radius)
  const end = Math.min(flat.length, i + q.length + radius)
  return `${start > 0 ? '…' : ''}${flat.slice(start, end).trim()}${end < flat.length ? '…' : ''}`
}

function hostOf(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, '')
  } catch {
    return url
  }
}

/**
 * Collect ordered, capped matches from already-fetched trip data. Pure: it reads
 * only the arrays handed in (the caller pulls them from the trip-scoped query
 * cache, so there is no cross-trip read path here) and returns the non-empty
 * kinds in `KIND_ORDER`, each capped at `MAX_PER_KIND`. `q` is expected
 * pre-lowercased and already past the `MIN_QUERY_LENGTH` gate.
 */
export function collectResults(sources: SearchSources, q: string): KindResults[] {
  const byKind: Record<SearchKind, SearchResult[]> = {
    itinerary: [], budget: [], stay: [], transport: [], poll: [], message: [],
    checklist: [], note: [], idea: [], wishlist: [],
  }

  for (const it of sources.itinerary) {
    if (hit(it.title, q) || hit(it.location, q) || hit(it.notes, q)) {
      byKind.itinerary.push({
        id: it.id,
        kind: 'itinerary',
        route: 'itinerary',
        anchorId: searchAnchorId(it.id),
        title: it.title,
        snippet: hit(it.title, q)
          ? null
          : hit(it.location, q)
            ? it.location
            : it.notes
              ? excerpt(it.notes, q)
              : null,
      })
    }
  }

  for (const e of sources.budget) {
    const categoryLabel = BUDGET_CATEGORY_LABELS[e.category]
    if (hit(e.title, q) || hit(categoryLabel, q)) {
      byKind.budget.push({
        id: e.id,
        kind: 'budget',
        route: 'budget',
        anchorId: searchAnchorId(e.id),
        title: e.title,
        snippet: hit(e.title, q) ? null : `Category: ${categoryLabel}`,
      })
    }
  }

  // Stays live on the calendar surface (StaysCard) — the "which hotel again?" and
  // front-desk confirmation-code lookup. Match on name, address and code.
  for (const s of sources.stays) {
    const nameHit = hit(s.name, q)
    const codeHit = hit(s.confirmation_code, q)
    const addrHit = hit(s.address, q)
    if (nameHit || codeHit || addrHit) {
      byKind.stay.push({
        id: s.id,
        kind: 'stay',
        route: 'calendar',
        anchorId: searchAnchorId(s.id),
        title: s.name,
        snippet: nameHit
          ? null
          : codeHit
            ? `Confirmation: ${s.confirmation_code}`
            : s.address,
      })
    }
  }

  // Transport hops also live on the calendar surface (TransportCard). Match on
  // the two endpoints, the mode label, and the booking code.
  for (const t of sources.transport) {
    const modeLabel = TRANSPORT_MODE_LABELS[t.mode]
    const hasRoute = !!(t.depart_place || t.arrive_place)
    const title = hasRoute
      ? `${t.depart_place || '—'} → ${t.arrive_place || '—'}`
      : modeLabel
    const placeHit = hit(t.depart_place, q) || hit(t.arrive_place, q)
    const modeHit = hit(modeLabel, q)
    const codeHit = hit(t.confirmation_code, q)
    if (placeHit || modeHit || codeHit) {
      byKind.transport.push({
        id: t.id,
        kind: 'transport',
        route: 'calendar',
        anchorId: searchAnchorId(t.id),
        title,
        // The code is the most useful line when it matched; otherwise surface the
        // mode only when the title shows a route (so it isn't the mode already).
        snippet: codeHit
          ? `Confirmation: ${t.confirmation_code}`
          : modeHit && hasRoute
            ? `Mode: ${modeLabel}`
            : null,
      })
    }
  }

  for (const p of sources.polls) {
    const option = p.poll_options?.find((o) => hit(o.label, q))
    if (hit(p.question, q) || option) {
      byKind.poll.push({
        id: p.id,
        kind: 'poll',
        route: 'polls',
        anchorId: searchAnchorId(p.id),
        title: p.question,
        snippet: hit(p.question, q) ? null : option ? `Option: ${option.label}` : null,
      })
    }
  }

  for (const m of sources.messages) {
    if (hit(m.content, q)) {
      byKind.message.push({
        id: m.id,
        kind: 'message',
        route: 'chat',
        anchorId: searchAnchorId(m.id),
        title: excerpt(m.content, q),
        snippet: null,
      })
    }
  }

  for (const it of sources.checklist) {
    if (hit(it.title, q) || hit(it.notes, q)) {
      byKind.checklist.push({
        id: it.id,
        kind: 'checklist',
        route: 'checklist',
        anchorId: searchAnchorId(it.id),
        title: it.title,
        snippet: hit(it.title, q) ? null : it.notes ? excerpt(it.notes, q) : null,
      })
    }
  }

  for (const n of sources.notes) {
    if (hit(n.title, q) || hit(n.content, q)) {
      byKind.note.push({
        id: n.id,
        kind: 'note',
        route: 'notes',
        anchorId: searchAnchorId(n.id),
        title: n.title || 'Untitled',
        snippet: hit(n.title, q) ? null : n.content ? excerpt(n.content, q) : null,
      })
    }
  }

  for (const it of sources.ideas) {
    if (hit(it.title, q) || hit(it.note, q) || hit(it.url, q)) {
      byKind.idea.push({
        id: it.id,
        kind: 'idea',
        route: 'ideas',
        anchorId: searchAnchorId(it.id),
        title: it.title || (it.url ? hostOf(it.url) : 'Idea'),
        snippet: hit(it.title, q)
          ? null
          : it.note
            ? excerpt(it.note, q)
            : it.url
              ? hostOf(it.url)
              : null,
      })
    }
  }

  // The wishlist shelf renders below the day list on the itinerary page, so a
  // match deep-links there. Match on the place name and the free-text note.
  for (const w of sources.wishlist) {
    const nameHit = hit(w.name, q)
    if (nameHit || hit(w.note, q)) {
      byKind.wishlist.push({
        id: w.id,
        kind: 'wishlist',
        route: 'itinerary',
        anchorId: searchAnchorId(w.id),
        title: w.name,
        snippet: nameHit ? null : w.note ? excerpt(w.note, q) : null,
      })
    }
  }

  const groups: KindResults[] = []
  for (const kind of KIND_ORDER) {
    const results = byKind[kind].slice(0, MAX_PER_KIND)
    if (results.length) groups.push({ kind, results })
  }
  return groups
}
