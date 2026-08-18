/*
  The model fallback for a paste the regex parser could not read (#212).

  This sits *behind* src/features/itinerary/parse.ts, never in front of it. The
  heuristic parser runs first and for free; only when it reports `matched:
  false` is this offered, and only on an explicit tap. That ordering is the
  cost control — the common case never reaches a model — and it is structural
  rather than a rule someone has to remember, because the offer literally does
  not render unless the free path already failed.

  Every failure here resolves to "no fields", which the dialog turns into
  exactly today's behaviour: the create form opens with the raw text in its
  notes. The paste flow cannot dead-end through this module.
*/
import { useMutation } from '@tanstack/react-query'
import { callAi } from '@/features/ai/api'
import { ParsedBookingResult } from '@/server/ai/schemas'
import type { AiResponse, RefusalReason } from '@/server/ai/schemas'
import type { ParsedBooking } from './parse'

export type AiParseOutcome =
  /** The model found structure. `booking` is ready for the create form. */
  | { status: 'parsed'; booking: ParsedBooking }
  /** The call worked and found nothing usable. Not an error — a real answer. */
  | { status: 'empty' }
  /** Refused before or instead of a model call: off, over quota, no access. */
  | { status: 'refused'; reason: RefusalReason; message: string }

/**
 * Whether the endpoint has told us AI is switched off this session.
 *
 * Module-level rather than component state on purpose: the answer is a property
 * of the deployment, not of one dialog, and re-offering a button that is going
 * to refuse on every subsequent failed paste would be worse than not offering
 * it. Reset on reload, which is when a deployment could plausibly have changed.
 */
let disabledForSession = false
export const aiParseDisabled = (): boolean => disabledForSession

/**
 * Overlay the model's fields onto the heuristic draft.
 *
 * The base draft is the `matched: false` one, so its structured fields are all
 * null by definition and this only ever adds. What it protects is `notes`:
 * that holds the user's own pasted text, which is the guarantee that a paste is
 * never a silent loss, and the model never sees a reason to reproduce it.
 */
function merge(base: ParsedBooking, ai: ParsedBookingResult): ParsedBooking {
  return {
    ...base,
    title: ai.title ?? base.title,
    category: ai.category ?? base.category,
    day: ai.day,
    end_day: ai.end_day,
    start_time: ai.start_time,
    end_time: ai.end_time,
    location: ai.location,
    matched: true,
  }
}

/** Interpret one endpoint response. Exported for tests; no network, no React. */
export function interpretAiParse(
  response: AiResponse,
  base: ParsedBooking,
): AiParseOutcome {
  if (!response.ok) {
    if (response.reason === 'disabled') disabledForSession = true
    return { status: 'refused', reason: response.reason, message: response.message }
  }

  // The handler already validated this; re-validating in the browser is not
  // paranoia about the server so much as the cheapest way to keep the two ends
  // from drifting — a deploy skew that changes the payload shape degrades here
  // instead of putting undefined into a form field.
  const result = response.result as { booking?: unknown } | null
  const parsed = ParsedBookingResult.safeParse(result?.booking)
  if (!parsed.success) return { status: 'empty' }

  return { status: 'parsed', booking: merge(base, parsed.data) }
}

/**
 * Ask the model to read a paste the heuristic parser missed.
 *
 * Transport failures are caught rather than surfaced: an offline PWA and an
 * unreachable function are ordinary states here, and both mean the same thing
 * to the user — carry on with the raw text. `retry: false` because a second
 * identical call costs a second call to be wrong the same way.
 */
export function useAiParseBooking() {
  return useMutation({
    mutationFn: async ({
      tripId,
      text,
      base,
    }: {
      tripId: string
      text: string
      base: ParsedBooking
    }): Promise<AiParseOutcome> => {
      try {
        const response = await callAi({ intent: 'parse_booking', tripId, text })
        return interpretAiParse(response, base)
      } catch {
        return { status: 'refused', reason: 'unavailable', message: 'Wander AI could not be reached.' }
      }
    },
    retry: false,
  })
}
