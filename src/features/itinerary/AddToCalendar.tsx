import { CalendarArrowDown } from 'lucide-react'
import { googleCalendarUrl, outlookCalendarUrl } from '@/lib/calendarLinks'
import { downloadItemIcs } from '@/lib/export'
import { DropdownMenuItem, DropdownMenuSeparator } from '@/components/ui/dropdown-menu'
import type { ItineraryItem } from '@/types'

/** One "Add to <provider>" link row, rendered only when a URL could be built. */
function CalendarLink({ href, label }: { href: string | null; label: string }) {
  if (!href) return null
  return (
    <DropdownMenuItem asChild>
      <a href={href} target="_blank" rel="noreferrer noopener">
        <CalendarArrowDown /> {label}
      </a>
    </DropdownMenuItem>
  )
}

/**
 * "Add to calendar" section for an itinerary item's overflow menu (#288):
 * Google, Outlook, and a single-event `.ics` download. Google and Outlook are
 * real links opened in a new tab (keyless, no server); the `.ics` reuses the
 * whole-itinerary export's builder for the one thing a URL scheme can't do
 * (Apple). An item with no day offers nothing rather than a broken link, so the
 * whole block — its leading separator included — renders only when there's a
 * day to place. `ItineraryItem` is a structural superset of the builders'
 * `CalendarEventInput`, so the item is passed straight through (no field copy).
 * Rendered inside a DropdownMenuContent.
 */
export function AddToCalendarItems({ item }: { item: ItineraryItem }) {
  if (!item.day) return null

  return (
    <>
      <DropdownMenuSeparator />
      <CalendarLink href={googleCalendarUrl(item)} label="Add to Google Calendar" />
      <CalendarLink href={outlookCalendarUrl(item)} label="Add to Outlook" />
      {/* item.day is set here (the block returns null otherwise), so this always writes a file. */}
      <DropdownMenuItem onSelect={() => downloadItemIcs(item)}>
        <CalendarArrowDown /> Download .ics
      </DropdownMenuItem>
    </>
  )
}
