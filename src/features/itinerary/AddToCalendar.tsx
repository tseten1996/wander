import { CalendarArrowDown, CalendarPlus } from 'lucide-react'
import { toast } from 'sonner'
import { googleCalendarUrl, outlookCalendarUrl, type CalendarEventInput } from '@/lib/calendarLinks'
import { downloadItemIcs } from '@/lib/export'
import { DropdownMenuItem, DropdownMenuSeparator } from '@/components/ui/dropdown-menu'
import type { ItineraryItem } from '@/types'

function toCalendarInput(item: ItineraryItem): CalendarEventInput {
  return {
    title: item.title,
    day: item.day,
    start_time: item.start_time,
    end_time: item.end_time,
    location: item.location,
    url: item.url,
    notes: item.notes,
  }
}

/**
 * "Add to calendar" section for an itinerary item's overflow menu (#288):
 * Google, Outlook, and a single-event `.ics` download. Google and Outlook are
 * real links opened in a new tab (keyless, no server); the `.ics` reuses the
 * whole-itinerary export's builder for the one thing a URL scheme can't do
 * (Apple). An item with no day offers nothing rather than a broken link, so the
 * whole block — its leading separator included — renders only when there's a
 * day to place. Rendered inside a DropdownMenuContent.
 */
export function AddToCalendarItems({ item }: { item: ItineraryItem }) {
  if (!item.day) return null
  const input = toCalendarInput(item)
  const google = googleCalendarUrl(input)
  const outlook = outlookCalendarUrl(input)

  return (
    <>
      <DropdownMenuSeparator />
      {google && (
        <DropdownMenuItem asChild>
          <a href={google} target="_blank" rel="noreferrer noopener">
            <CalendarPlus /> Add to Google Calendar
          </a>
        </DropdownMenuItem>
      )}
      {outlook && (
        <DropdownMenuItem asChild>
          <a href={outlook} target="_blank" rel="noreferrer noopener">
            <CalendarPlus /> Add to Outlook
          </a>
        </DropdownMenuItem>
      )}
      <DropdownMenuItem
        onSelect={() => {
          if (!downloadItemIcs(item)) toast('Add a day to this item to put it on a calendar')
        }}
      >
        <CalendarArrowDown /> Download .ics
      </DropdownMenuItem>
    </>
  )
}
