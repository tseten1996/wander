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
  archived: boolean
  checklist_starter_dismissed: boolean
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
  start_time: string | null
  end_time: string | null
  location: string | null
  url: string | null
  notes: string | null
  cost: number | null
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
  paid_by: string | null
  entry_date: string | null
  notes: string | null
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

export interface InvitePreview {
  trip_name: string
  destination: string | null
  cover_url: string | null
  member_count: number
  start_date: string | null
  end_date: string | null
}
