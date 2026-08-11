import type { InspirationCategory, InspirationItem } from '@/types'
import type { ItineraryFormValues } from './ItemDialog'

/**
 * Best-fit itinerary category for an inspiration idea's category (#204). The
 * boards don't line up one-to-one: inspiration's `places` (a spot worth
 * visiting) maps to an `activity`, and its catch-all `general` lands on `free`
 * time, the itinerary's own unclassified bucket.
 */
const CATEGORY_MAP: Record<InspirationCategory, ItineraryFormValues['category']> = {
  stay: 'hotel',
  food: 'restaurant',
  activities: 'activity',
  places: 'activity',
  general: 'free',
}

/** Hostname of a link, for a readable title fallback when an idea has no title. */
function hostOf(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, '')
  } catch {
    return url
  }
}

/**
 * Seed values for the shared itinerary create dialog from an inspiration idea
 * (#204). Prefills the title and link so a saved idea becomes a real stop without
 * re-typing, and seeds the location from the idea's name so it geocodes on save
 * (#201) and pins on the map like any typed address. A short breadcrumb in the
 * notes keeps the stop traceable back to the board; the inspiration item itself
 * is never touched. Fields the idea doesn't carry fall through to the dialog's
 * own defaults (e.g. day = the trip start), leaving them for the member to fill.
 */
export function itineraryPrefillFromInspiration(item: InspirationItem): Partial<ItineraryFormValues> {
  const name = item.title?.trim() || null
  const prefill: Partial<ItineraryFormValues> = {
    // A titleless idea (saved as just a link or image) still needs a valid title
    // for the itinerary; fall back to the link's host so the form is submittable.
    title: name ?? (item.url ? hostOf(item.url) : 'Saved idea'),
    category: CATEGORY_MAP[item.category],
  }
  // Only a real name is worth geocoding — a bare hostname would pin nowhere
  // sensible, so leave the location blank and let the member add one.
  if (name) prefill.location = name
  if (item.url) prefill.url = item.url

  const note = item.note?.trim()
  const breadcrumb = 'Added from the Ideas board.'
  prefill.notes = note ? `${note}\n\n${breadcrumb}` : breadcrumb

  return prefill
}
