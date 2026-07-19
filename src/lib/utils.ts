import { clsx, type ClassValue } from 'clsx'
import { twMerge } from 'tailwind-merge'
import { differenceInCalendarDays, format, parseISO } from 'date-fns'

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs))
}

export function initials(name: string): string {
  return name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((w) => w[0]!.toUpperCase())
    .join('')
}

export function formatMoney(amount: number | null | undefined, currency = 'USD'): string {
  if (amount == null) return '—'
  return new Intl.NumberFormat(undefined, {
    style: 'currency',
    currency,
    maximumFractionDigits: amount % 1 === 0 ? 0 : 2,
  }).format(amount)
}

/** "Mar 14" — for compact chips */
export function shortDate(iso: string | null | undefined): string {
  if (!iso) return ''
  return format(parseISO(iso), 'MMM d')
}

/** "Saturday, March 14" — for headings */
export function longDate(iso: string | null | undefined): string {
  if (!iso) return ''
  return format(parseISO(iso), 'EEEE, MMMM d')
}

/** "Mar 14 – 22" or "Mar 14 – Apr 2" */
export function dateRange(start: string | null, end: string | null): string {
  if (!start && !end) return 'Dates TBD'
  if (start && !end) return `From ${shortDate(start)}`
  if (!start && end) return `Until ${shortDate(end)}`
  const s = parseISO(start!)
  const e = parseISO(end!)
  if (s.getMonth() === e.getMonth() && s.getFullYear() === e.getFullYear()) {
    return `${format(s, 'MMM d')} – ${format(e, 'd')}`
  }
  return `${format(s, 'MMM d')} – ${format(e, 'MMM d')}`
}

/** Whole days from today until `iso` (negative = past). */
export function daysUntil(iso: string): number {
  return differenceInCalendarDays(parseISO(iso), new Date())
}

/** "14:30" | "14:30:00" → "2:30 PM" */
export function formatTime(t: string | null | undefined): string {
  if (!t) return ''
  const [h = 0, m = 0] = t.split(':').map(Number)
  const d = new Date()
  d.setHours(h, m)
  return format(d, 'p')
}

/** Relative time for feeds: "just now", "5m", "3h", "2d", then a date */
export function timeAgo(iso: string): string {
  const seconds = (Date.now() - new Date(iso).getTime()) / 1000
  if (seconds < 60) return 'just now'
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m`
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h`
  if (seconds < 86400 * 7) return `${Math.floor(seconds / 86400)}d`
  return shortDate(iso)
}

/** Midpoint ordering for drag-and-drop without renumbering. */
export function positionBetween(before: number | null, after: number | null): number {
  if (before == null && after == null) return 1024
  if (before == null) return after! - 1
  if (after == null) return before + 1
  return (before + after) / 2
}

export function randomCode(length = 12): string {
  const alphabet = '23456789abcdefghjkmnpqrstuvwxyzABCDEFGHJKMNPQRSTUVWXYZ'
  const bytes = crypto.getRandomValues(new Uint8Array(length))
  return Array.from(bytes, (b) => alphabet[b % alphabet.length]).join('')
}
