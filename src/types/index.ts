// Row types mirroring supabase/migrations. Keep in sync with the schema.

export type Role = 'owner' | 'member'

export type PollCategory =
  | 'dates' | 'stay' | 'flights' | 'food' | 'activities' | 'transport' | 'general'

export type ItineraryCategory =
  | 'flight' | 'hotel' | 'activity' | 'restaurant' | 'transport' | 'free'

export type BudgetCategory =
  | 'stay' | 'transport' | 'food' | 'activities' | 'shopping' | 'other'

export type PackingCategory =
  | 'clothes' | 'toiletries' | 'electronics' | 'documents' | 'misc'

export type InspirationCategory =
  | 'stay' | 'food' | 'activities' | 'places' | 'general'

export interface Trip {
  id: string
  owner_id: string
  name: string
  destination: string | null
  description: string | null
  cover_url: string | null
  start_date: string | null
  end_date: string | null
  estimated_budget: number | null
  currency: string
  invite_code: string
  invite_enabled: boolean
  /** Unguessable token for the read-only public share link (#127). null = the
   *  trip is not publicly shared. Owner-writable through the set_trip_share RPC
   *  only; never exposed to non-members, and never in the public projection. */
  share_token: string | null
  /** Whether this trip's post-trip recap is opted in to public sharing (#238,
   *  epic #205). A separate switch from #127's `share_token`: the token is the
   *  capability, this flag is the deliberate "also share a recap" opt-in.
   *  Owner-writable through the set_trip_recap_share RPC only. The public recap
   *  link works while this is on AND `share_token` is set AND the trip has ended. */
  recap_shared: boolean
  archived: boolean
  checklist_starter_dismissed: boolean
  created_at: string
}

/** An ordered leg of a multi-destination trip (#197, epic #196). Purely
 *  additive: a trip with zero destinations falls back to `trips.destination`
 *  and behaves exactly as before. A day is assigned to whichever destination's
 *  [start_date, end_date] contains it — derived client-side, no FK. */
export interface Destination {
  id: string
  trip_id: string
  name: string
  /** Optional geocoded pin from the shared place autocomplete. */
  latitude: number | null
  longitude: number | null
  /** Optional leg date range; a null on either side is an open/dateless leg. */
  start_date: string | null
  end_date: string | null
  position: number
  created_at: string
}

export interface Member {
  id: string
  trip_id: string
  user_id: string
  display_name: string
  color: string
  role: Role
  joined_at: string
}

export interface Poll {
  id: string
  trip_id: string
  created_by: string | null
  question: string
  category: PollCategory
  closes_at: string | null
  closed: boolean
  created_at: string
}

export interface PollOption {
  id: string
  trip_id: string
  poll_id: string
  label: string
  position: number
  image_url: string | null
  link_url: string | null
}

export interface Vote {
  id: string
  trip_id: string
  poll_id: string
  option_id: string
  member_id: string
  created_at: string
}

export interface Message {
  id: string
  trip_id: string
  member_id: string | null
  content: string
  /** Path into the private `chat-images` bucket for an image message (#51),
   *  or null for a plain text message. Rendered via a short-lived signed URL. */
  image_path: string | null
  reply_to: string | null
  pinned: boolean
  edited_at: string | null
  created_at: string
}

export interface MessageReaction {
  id: string
  trip_id: string
  message_id: string
  member_id: string
  emoji: string
}

export interface Question {
  id: string
  trip_id: string
  member_id: string | null
  title: string
  body: string | null
  answered: boolean
  answer: string | null
  created_at: string
}

export interface ChecklistItem {
  id: string
  trip_id: string
  title: string
  notes: string | null
  assignee_id: string | null
  due_date: string | null
  done: boolean
  position: number
  created_by: string | null
  created_at: string
}

export interface ItineraryItem {
  id: string
  trip_id: string
  title: string
  category: ItineraryCategory
  day: string | null
  /** Optional closing day of a multi-day span (#166): a stay/rail-pass/rental
   *  that runs from `day` to `end_day`. null = a single-day item (`end_time` is
   *  then the same-day end). Never earlier than `day` (DB CHECK + form guard).
   *  `end_time` doubles as the clock time on this closing day (check-out time). */
  end_day: string | null
  start_time: string | null
  end_time: string | null
  location: string | null
  latitude: number | null
  longitude: number | null
  url: string | null
  notes: string | null
  cost: number | null
  /** Optional link to the budget entry that actually pays for this item (#151).
   *  null = the `cost` above is only a planning note, not tracked spend. The FK
   *  is ON DELETE SET NULL, so deleting the expense clears this rather than
   *  leaving a dangling reference. Budget totals never read this — they sum
   *  `budget_entries` alone, so an amount is never counted twice. */
  budget_entry_id: string | null
  position: number
  created_by: string | null
  created_at: string
}

export interface BudgetEntry {
  id: string
  trip_id: string
  title: string
  category: BudgetCategory
  estimated: number | null
  actual: number | null
  /** Original ISO currency the amounts were logged in. null = trip currency. */
  currency: string | null
  /** `estimated`/`actual` expressed in the trip currency, frozen at entry time.
   *  null when the entry is already in the trip currency — read `converted ?? raw`. */
  estimated_converted: number | null
  actual_converted: number | null
  /** original→trip rate used, kept so historical entries don't drift. */
  exchange_rate: number | null
  /** Member ids that share this cost in settle-up. null / empty = shared by all
   *  current members (the historic default) — see settlement.ts. */
  participants: string[] | null
  /** Per-sharer weights for an unequal split (#203): a `{ member_id: weight }`
   *  map. null / empty = equal split across `participants` (the historic
   *  default). When present, the keys are authoritative for *who* shares and
   *  each member's cost is `amount * weight_i / Σweights` — see settlement.ts.
   *  Weights encode shares, exact amounts, or percentages interchangeably. */
  shares: Record<string, number> | null
  paid_by: string | null
  entry_date: string | null
  notes: string | null
  created_by: string | null
  created_at: string
}

export interface Repayment {
  id: string
  trip_id: string
  /** Member who paid the money. */
  from_member: string
  /** Member who received it. */
  to_member: string
  amount: number
  /** Original ISO currency the amount was recorded in. null = trip currency. */
  currency: string | null
  /** `amount` expressed in the trip currency, frozen at record time.
   *  null when already in the trip currency — read `converted ?? raw`. */
  amount_converted: number | null
  /** original→trip rate used, kept so a settled balance doesn't drift. */
  exchange_rate: number | null
  created_by: string | null
  created_at: string
}

export interface PackingItem {
  id: string
  trip_id: string
  name: string
  category: PackingCategory
  packed: boolean
  added_by: string | null
  position: number
  created_at: string
}

export interface Note {
  id: string
  trip_id: string
  title: string
  content: string
  pinned: boolean
  created_by: string | null
  created_at: string
  updated_at: string
}

export interface InspirationItem {
  id: string
  trip_id: string
  title: string | null
  url: string | null
  image_url: string | null
  note: string | null
  category: InspirationCategory
  created_by: string | null
  created_at: string
}

export interface Activity {
  id: string
  trip_id: string
  member_id: string | null
  verb: string
  subject: string | null
  created_at: string
}

export type AvailabilityStatus = 'yes' | 'maybe' | 'no'

export interface AvailabilityPoll {
  id: string
  trip_id: string
  created_by: string | null
  title: string
  closed: boolean
  /** The candidate whose range was applied to the trip. A soft pointer (no FK)
   *  so it survives the candidate being deleted; set by apply_availability_dates. */
  applied_candidate_id: string | null
  created_at: string
}

export interface AvailabilityCandidate {
  id: string
  trip_id: string
  poll_id: string
  start_date: string
  end_date: string
  position: number
  created_at: string
}

export interface AvailabilityResponse {
  id: string
  trip_id: string
  poll_id: string
  candidate_id: string
  member_id: string
  status: AvailabilityStatus
  created_at: string
}

export type NotificationType =
  | 'checklist_assigned' | 'poll_opened' | 'expense_owed' | 'mention'

export interface Notification {
  id: string
  trip_id: string
  /** The member this notification is addressed to. */
  recipient_id: string
  /** Who caused it; null if that member has since left the trip. */
  actor_id: string | null
  type: NotificationType
  /** The row it points at (checklist_item / poll / budget_entry); a soft
   *  pointer used for deep-linking, so it may dangle if the target is deleted. */
  entity_id: string | null
  /** Snapshot of the subject at write time (task / poll / expense title). */
  title: string | null
  created_at: string
  /** null while unread; the timestamp it was marked read. */
  read_at: string | null
}

export interface InvitePreview {
  trip_name: string
  destination: string | null
  cover_url: string | null
  member_count: number
  start_date: string | null
  end_date: string | null
  /** Hex colours already taken by existing members, so the join form can
   *  default to an unused swatch and dim the taken ones (#234). No member
   *  names or other PII — just the palette hexes. Empty when none are set. */
  taken_colors: string[]
}

/** A single read-only itinerary item as returned by the get_public_itinerary
 *  RPC (#127). A strict, whitelisted subset of ItineraryItem — no ids that leak
 *  authorship, no cost, no coordinates, no invite code. */
export interface PublicItineraryItem {
  id: string
  title: string
  category: ItineraryCategory
  day: string | null
  end_day: string | null
  start_time: string | null
  end_time: string | null
  location: string | null
  notes: string | null
}

/** The whole payload of the public share page: whitelisted trip meta plus the
 *  read-only itinerary. The RPC returns SQL null (→ null here) for an invalid,
 *  revoked, or absent token, which the page renders as "link unavailable". */
export interface PublicItinerary {
  trip: {
    name: string
    destination: string | null
    start_date: string | null
    end_date: string | null
  }
  items: PublicItineraryItem[]
}

/** Whitelisted trip meta shared by every public projection (#127, #238). */
export interface PublicTripMeta {
  name: string
  destination: string | null
  start_date: string | null
  end_date: string | null
}

/** A single located stop in the public recap (#238): a strict, whitelisted
 *  subset of ItineraryItem — no times, notes, cost, coordinates, or authorship,
 *  just the place name and its category icon for the "where we went" list. */
export interface PublicRecapPlace {
  id: string
  title: string
  category: ItineraryCategory
  location: string | null
}

/** The public post-trip recap payload (#238, epic #205), returned by the
 *  get_public_recap RPC. Three shapes, distinct on purpose:
 *   - SQL null (→ null here): invalid / revoked / not-shared token → "link unavailable"
 *   - `pending`: a valid, shared link whose trip has not ended yet → "recap not ready yet"
 *   - `ready`: the whitelisted recap — aggregate counts + located stops, no
 *     costs and no member identity (mirrors #127's exclusions). */
export type PublicRecap =
  | { status: 'pending'; trip: PublicTripMeta }
  | {
      status: 'ready'
      trip: PublicTripMeta
      stats: { stops: number; travelers: number }
      places: PublicRecapPlace[]
    }
