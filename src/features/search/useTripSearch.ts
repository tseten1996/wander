import * as React from 'react'
import { useQueryClient, type QueryClient } from '@tanstack/react-query'
import { Lightbulb, ListChecks, MessageCircle, NotebookPen, Vote, type LucideIcon } from 'lucide-react'
import type { ChecklistItem, InspirationItem, Message, Note, Poll, PollOption } from '@/types'
import { searchAnchorId } from './anchor'

export type SearchKind = 'poll' | 'message' | 'checklist' | 'note' | 'idea'

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

export interface SearchGroup {
  kind: SearchKind
  label: string
  icon: LucideIcon
  results: SearchResult[]
}

export interface SearchOutcome {
  groups: SearchGroup[]
  total: number
}

/** Minimum query length before we search — one char is all noise. */
export const MIN_QUERY_LENGTH = 2

/** Cap per section so the palette stays skimmable. */
const MAX_PER_KIND = 6

const KIND_META: Record<SearchKind, { label: string; icon: LucideIcon }> = {
  poll: { label: 'Polls', icon: Vote },
  message: { label: 'Chat', icon: MessageCircle },
  checklist: { label: 'Checklist', icon: ListChecks },
  note: { label: 'Notes', icon: NotebookPen },
  idea: { label: 'Ideas', icon: Lightbulb },
}

const KIND_ORDER: SearchKind[] = ['poll', 'message', 'checklist', 'note', 'idea']

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
 * Collect matches from the TanStack Query cache only — no network. A section
 * is searchable once its page has been opened this session (which is what
 * populated its cache); unopened sections simply don't contribute results.
 */
function collect(queryClient: QueryClient, tripId: string, q: string): SearchOutcome {
  const byKind: Record<SearchKind, SearchResult[]> = {
    poll: [], message: [], checklist: [], note: [], idea: [],
  }

  const polls =
    queryClient.getQueryData<(Poll & { poll_options: PollOption[] })[]>(['polls', tripId]) ?? []
  for (const p of polls) {
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

  const messages = queryClient.getQueryData<Message[]>(['messages', tripId]) ?? []
  for (const m of messages) {
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

  const checklist = queryClient.getQueryData<ChecklistItem[]>(['checklist_items', tripId]) ?? []
  for (const it of checklist) {
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

  const notes = queryClient.getQueryData<Note[]>(['notes', tripId]) ?? []
  for (const n of notes) {
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

  const ideas = queryClient.getQueryData<InspirationItem[]>(['inspiration_items', tripId]) ?? []
  for (const it of ideas) {
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

  const groups: SearchGroup[] = []
  let total = 0
  for (const kind of KIND_ORDER) {
    const results = byKind[kind].slice(0, MAX_PER_KIND)
    if (results.length) {
      groups.push({ kind, label: KIND_META[kind].label, icon: KIND_META[kind].icon, results })
      total += results.length
    }
  }
  return { groups, total }
}

/**
 * Client-side search across the current trip's already-cached feature data.
 * Recomputed synchronously from the cache whenever the query text changes.
 */
export function useTripSearch(tripId: string, rawQuery: string): SearchOutcome {
  const queryClient = useQueryClient()
  return React.useMemo(() => {
    const q = rawQuery.trim().toLowerCase()
    if (q.length < MIN_QUERY_LENGTH) return { groups: [], total: 0 }
    return collect(queryClient, tripId, q)
  }, [queryClient, tripId, rawQuery])
}
