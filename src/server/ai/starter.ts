/*
  Candidate places and the first-day plans built from them, in code (#284).

  This is the sibling of day.ts, one step earlier in the funnel. `improve_day`
  reorders a day that already has items; this proposes a starting point for a day
  that has none — the one question epic #209 says a model is actually for, and the
  moment a blank trip is most likely to go back to the group chat and never come
  back.

  The division of labour is the same as day.ts, and for the same reason. The
  expensive, correctness-critical part is done here, deterministically: the
  nearby places were fetched from the leg's coordinates, and this module dedupes
  them, biases the ranking by the group's stated preferences, and caps the set.
  The model's only job is judgement over that closed set — pick four to six that
  make a coherent day and say why. It never authors a place: an id it returns
  that this module did not offer is dropped by the handler, so an invented
  restaurant or a hallucinated address cannot reach the itinerary table.

  Nothing here touches the network, a clock, or a database. It is a pure function
  from a list of places (plus preferences) to a small ranked candidate set, and
  from a chosen ordering to a skeleton day — which is what makes the claims above
  testable rather than aspirational.
*/
import type { NearbyPlace, PoiCategory } from '../../lib/places'
import type { PromptPreferences } from './prompts'

/** Largest candidate set handed to the model. A blank day wants variety to
 *  choose from, but output tokens are the expensive side and a longer list is a
 *  longer prompt for no better a day. */
export const MAX_STARTER_CANDIDATES = 10

/** How many places a default (no-model) plan aims for, bounded by what the
 *  candidate set actually holds. Matches STARTER_MAX_PICKS' four-to-six shape. */
export const TARGET_STARTER_PLACES = 5
export const MIN_STARTER_PLACES = 2
export const MAX_STARTER_PLACES = 6

/**
 * The times a skeleton day is pinned to, by position.
 *
 * The model chooses which places and in what order; the clock is arithmetic, not
 * judgement, so it is assigned here — evenly spaced across a day, a sight-ish
 * slot then a meal-ish one then a sight again. Deliberately start times only,
 * with no end times: a starting point is something the group refines, and
 * inventing durations for places we have never visited would be exactly the
 * "confident guess" the whole propose-then-approve design exists to avoid.
 */
export const STARTER_SLOTS = ['10:00', '12:00', '14:00', '16:00', '18:00', '20:00'] as const

/** A place, ordered and slotted, as the preview card and the apply path read it. */
export interface StarterItem {
  placeId: string
  name: string
  /** Wander's own itinerary category, not the POI bucket — see below. */
  category: 'activity' | 'restaurant'
  /** `HH:MM`, assigned by position from STARTER_SLOTS. */
  startTime: string
  lat: number
  lon: number
}

/**
 * A found place's bucket → an itinerary category.
 *
 * Exactly the mapping `ItineraryPage`'s "add nearby" already uses (a sight is an
 * activity, anywhere you eat or drink is a restaurant), so a suggested place and
 * a hand-added one land in the itinerary as the same kind of thing.
 */
export function starterItineraryCategory(c: PoiCategory): 'activity' | 'restaurant' {
  return c === 'see' ? 'activity' : 'restaurant'
}

/** A sight anchors a day; a meal punctuates it; a drink rounds it off. This is
 *  the base ordering before preferences nudge it. */
const CATEGORY_WEIGHT: Record<PoiCategory, number> = { see: 3, eat: 2, drink: 1 }

/** Whether a place is a place to eat or drink (as opposed to a sight). */
const isFood = (c: PoiCategory): boolean => c === 'eat' || c === 'drink'

/**
 * Which buckets the group's stated interests lean toward.
 *
 * Interests are free-text chips (`trip_preferences.interests`), so this is a
 * loose keyword match rather than a fixed vocabulary — "Food & drink" or
 * "street food" leans toward eating, "museums" or "history" toward sights. A
 * bias on the ranking, never a filter: a lean toward food still keeps the sights
 * in the candidate set, because a day is more than its meals and the model may
 * want them. Dietary needs are deliberately NOT used to filter places here — a
 * place's OSM/Geoapify bucket does not carry a menu, so filtering on it would
 * drop restaurants that are perfectly fine; the dietary line is passed to the
 * model as context instead.
 */
function interestLean(preferences: PromptPreferences | null | undefined): {
  food: boolean
  sights: boolean
} {
  const interests = (preferences?.interests ?? []).map((s) => s.toLowerCase())
  const any = (needles: string[]) => interests.some((i) => needles.some((n) => i.includes(n)))
  return {
    food: any(['food', 'eat', 'drink', 'restaurant', 'cafe', 'coffee', 'cuisine', 'culinary', 'wine', 'bar']),
    sights: any(['museum', 'art', 'gallery', 'culture', 'histor', 'sight', 'landmark', 'architect', 'nature', 'park', 'outdoor', 'view']),
  }
}

/**
 * Rank, dedupe and cap the nearby places into the candidate set the model
 * chooses from.
 *
 * The order matters: it is both the pool the prompt lists and the fallback used
 * when no model runs, so a deterministic, preference-biased ranking is what makes
 * the no-model path coherent. Dedupe is by id first (the two place sources must
 * never collide — see parseGeoapifyPlaces) and by lower-cased name second, so a
 * chain that appears twice is one candidate.
 *
 * Stable within a score: Geoapify already returns places proximity-biased around
 * the leg centre, so preserving that order for ties keeps nearer places first.
 */
export function assembleStarterCandidates(
  places: NearbyPlace[],
  preferences: PromptPreferences | null | undefined,
): NearbyPlace[] {
  const lean = interestLean(preferences)
  const seenId = new Set<string>()
  const seenName = new Set<string>()
  const unique: { place: NearbyPlace; index: number; score: number }[] = []

  places.forEach((place, index) => {
    if (!place || !place.id || !place.name) return
    if (!Number.isFinite(place.lat) || !Number.isFinite(place.lon)) return
    const nameKey = place.name.trim().toLowerCase()
    if (!nameKey || seenId.has(place.id) || seenName.has(nameKey)) return
    seenId.add(place.id)
    seenName.add(nameKey)
    let score = CATEGORY_WEIGHT[place.category] ?? 0
    if (lean.food && isFood(place.category)) score += 2
    if (lean.sights && place.category === 'see') score += 2
    unique.push({ place, index, score })
  })

  // Highest score first; original (proximity) order breaks ties, so the sort is
  // stable and the result is a pure function of its inputs.
  unique.sort((a, b) => b.score - a.score || a.index - b.index)
  return unique.slice(0, MAX_STARTER_CANDIDATES).map((u) => u.place)
}

/**
 * A default first day when no model chooses one: a mix, not a wall.
 *
 * Interleaves sights with places to eat/drink — sight, meal, sight, meal — so a
 * five-stop day reads as a day (a museum, then lunch, then a sight, then a
 * coffee, then a sight) rather than five museums back to back. Sights lead
 * because they are the backbone; food falls on the midday and late slots, which
 * is where STARTER_SLOTS put the meal-ish times. Both queues keep the
 * candidate-set ranking, so this stays deterministic.
 */
export function pickTopStarter(candidates: NearbyPlace[], target: number): NearbyPlace[] {
  const want = Math.min(Math.max(target, MIN_STARTER_PLACES), MAX_STARTER_PLACES, candidates.length)
  const sights = candidates.filter((c) => c.category === 'see')
  const food = candidates.filter((c) => isFood(c.category))
  const chosen: NearbyPlace[] = []
  let takeSight = true
  while (chosen.length < want && (sights.length || food.length)) {
    // Alternate, but never stall: if the preferred queue is empty, take from the
    // other, so a candidate set that is all sights or all food still fills up.
    const primary = takeSight ? sights : food
    const secondary = takeSight ? food : sights
    const next = primary.shift() ?? secondary.shift()
    if (next) chosen.push(next)
    takeSight = !takeSight
  }
  return chosen
}

/**
 * Map the model's chosen ids back onto the candidates, in the model's order.
 *
 * This is where "the model selects from a closed set" stops being a comment and
 * becomes true: an id the candidate set does not contain is simply skipped, and a
 * repeated id is taken once. What comes back is a subset of places this server
 * assembled, in the order the model asked for — never a place the model named
 * that we did not offer.
 */
export function resolveStarterPicks(placeIds: string[], candidates: NearbyPlace[]): NearbyPlace[] {
  const byId = new Map(candidates.map((c) => [c.id, c]))
  const taken = new Set<string>()
  const chosen: NearbyPlace[] = []
  for (const id of placeIds) {
    const place = byId.get(id)
    if (!place || taken.has(id)) continue
    taken.add(id)
    chosen.push(place)
    if (chosen.length >= MAX_STARTER_PLACES) break
  }
  return chosen
}

/** Turn a chosen, ordered set of places into a slotted skeleton day. */
export function buildStarterPlan(chosen: NearbyPlace[]): StarterItem[] {
  return chosen.slice(0, STARTER_SLOTS.length).map((place, i) => ({
    placeId: place.id,
    name: place.name,
    category: starterItineraryCategory(place.category),
    startTime: STARTER_SLOTS[i],
    lat: place.lat,
    lon: place.lon,
  }))
}

/**
 * A deterministic explanation, used when no model is called or its pick fails.
 *
 * Says what the plan is made of, honestly — how many sights, whether it includes
 * somewhere to eat, and where it is — without claiming a judgement it did not
 * make. The model's own reason is better when there is one; this is the floor.
 */
export function computedStarterReason(chosen: NearbyPlace[], placeName: string | null): string {
  const sights = chosen.filter((c) => c.category === 'see').length
  const food = chosen.filter((c) => isFood(c.category)).length
  const parts: string[] = []
  if (sights > 0) parts.push(`${sights} ${sights === 1 ? 'thing to see' : 'things to see'}`)
  if (food > 0) parts.push(`${food === 1 ? 'a place to eat' : `${food} places to eat`}`)
  const made = parts.length ? parts.join(' and ') : `${chosen.length} nearby ${chosen.length === 1 ? 'place' : 'places'}`
  const where = placeName ? ` around ${placeName}` : ' nearby'
  return `A first day to build on: ${made}${where}. Adjust the times and swap anything before you add it.`
}
