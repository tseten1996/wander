/*
  Request/response contracts for the AI endpoint (#211).

  Runtime-agnostic on purpose: this module and its siblings run unchanged on
  Cloudflare Workers, Deno or Node, so the platform decision recorded in
  docs/AI-ARCHITECTURE.md §5.1 stays cheap to reverse. Only
  functions/api/ai.ts knows what platform it is on.

  The single most important rule here is negative: **there is no field a caller
  can use to supply prompt text.** The request carries an intent from a closed
  enum plus ids; the prompt is assembled server-side from data the caller is
  already entitled to read. The moment a caller can influence the prompt
  directly, this endpoint stops being an AI feature and becomes free inference
  for whoever finds the URL.
*/
import { z } from 'zod'

/** Every capability the endpoint will serve. Closed by construction. */
export const INTENTS = ['parse_booking', 'improve_day'] as const
export type Intent = (typeof INTENTS)[number]

/**
 * The payload each intent accepts. Ids and enums only — no strings that reach
 * a model unexamined.
 *
 * `parse_booking` is the exception that proves the rule: it genuinely needs
 * user text (the pasted confirmation). It is modelled as its own field with a
 * hard length cap rather than a general `prompt`, so the one place raw text is
 * allowed is explicit, bounded, and attached to a single intent.
 */
export const AiRequest = z.discriminatedUnion('intent', [
  z.object({
    intent: z.literal('parse_booking'),
    tripId: z.string().uuid(),
    // ~8k characters is a generous booking email and a hard ceiling on what
    // one request can cost. Longer input is a caller error, not something to
    // silently truncate — truncating mid-text produces confident nonsense.
    text: z.string().min(1).max(8000),
  }),
  z.object({
    intent: z.literal('improve_day'),
    tripId: z.string().uuid(),
    day: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'expected YYYY-MM-DD'),
  }),
])
export type AiRequest = z.infer<typeof AiRequest>

/**
 * Why a request was refused, in terms the UI can render without a lookup.
 *
 * `unavailable` is the model itself failing — the binding threw, the platform
 * is down. Distinct from `disabled` (switched off on purpose) because the UI
 * should stop offering a feature that is off, and simply retry later on one
 * that broke.
 */
export const REFUSAL_REASONS = ['disabled', 'quota', 'forbidden', 'unavailable'] as const
export type RefusalReason = (typeof REFUSAL_REASONS)[number]

export const AiRefusal = z.object({
  ok: z.literal(false),
  reason: z.enum(REFUSAL_REASONS),
  /** Shown to the member as-is. Never leaks internals. */
  message: z.string(),
})
export type AiRefusal = z.infer<typeof AiRefusal>

export const AiSuccess = z.object({
  ok: z.literal(true),
  intent: z.enum(INTENTS),
  /** Intent-shaped payload; validated by the caller against the intent's own
   *  schema (e.g. ParsedBookingResult). */
  result: z.unknown(),
  usage: z.object({
    inputTokens: z.number().int().nonnegative(),
    outputTokens: z.number().int().nonnegative(),
  }),
})
export type AiSuccess = z.infer<typeof AiSuccess>

export const AiResponse = z.union([AiSuccess, AiRefusal])
export type AiResponse = z.infer<typeof AiResponse>

/**
 * Per-trip calls allowed in the trailing window. Deliberately low: this bounds
 * what one leaked invite link can cost, and the right number is "enough for a
 * group planning a trip", not "enough that nobody ever notices".
 */
export const QUOTA_WINDOW_HOURS = 24
export const QUOTA_PER_TRIP = 40

/* ── the parse_booking result contract ───────────────────────────────────── */

/**
 * Categories the model may choose from. Mirrors `ItineraryCategory` in
 * src/types/index.ts, duplicated rather than imported because this module is
 * runtime-agnostic and must not pull a path alias into a Workers bundle or the
 * Node test runner. Keep the two lists in step; a drift shows up as a
 * validation failure, which degrades safely rather than writing a bad category.
 */
export const ITINERARY_CATEGORIES = [
  'flight', 'hotel', 'activity', 'restaurant', 'transport', 'free',
] as const

const YMD = /^\d{4}-\d{2}-\d{2}$/
const HM = /^([01]\d|2[0-3]):[0-5]\d$/

/** True only for a real calendar date — rejects 2026-02-30 and month 13. */
function isCalendarDate(s: string): boolean {
  const [y, m, d] = s.split('-').map(Number)
  const dt = new Date(Date.UTC(y, m - 1, d))
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d
}

/**
 * A field the model may legitimately not know.
 *
 * Missing keys and empty strings both become `null` before validation. Models
 * express "I couldn't find this" three ways — omit the key, emit `null`, emit
 * `""` — and treating the last two differently would put an empty title into
 * the create form and call it a successful extraction.
 */
const orNull = <T extends z.ZodTypeAny>(inner: T) =>
  z.preprocess(
    (v) => (v === undefined || (typeof v === 'string' && v.trim() === '') ? null : v),
    inner.nullable(),
  )

/**
 * What the model is allowed to hand back for `parse_booking`.
 *
 * Mirrors the fields of `ParsedBooking` (src/features/itinerary/parse.ts) that
 * the create form consumes, minus `notes` and `matched` — the caller owns both:
 * notes stay the user's own pasted text, and `matched` is decided here by
 * whether anything structured came back, not by the model asserting success.
 *
 * This is the security boundary for model output. Workers AI's JSON mode
 * already constrains the shape, but "the provider promised" is not a guarantee
 * — a schema-shaped object can still carry a 40 kB title or February 30th, and
 * both would reach the itinerary table.
 */
export const ParsedBookingResult = z
  .object({
    title: orNull(z.string().trim().min(1).max(120)),
    category: orNull(z.enum(ITINERARY_CATEGORIES)),
    day: orNull(z.string().regex(YMD).refine(isCalendarDate, 'not a real date')),
    end_day: orNull(z.string().regex(YMD).refine(isCalendarDate, 'not a real date')),
    start_time: orNull(z.string().regex(HM)),
    end_time: orNull(z.string().regex(HM)),
    location: orNull(z.string().trim().min(1).max(200)),
  })
  // A closing day before the opening one is a mis-read, not a span — the same
  // rule detectLodging() applies, and the itinerary table would reject it.
  .refine((v) => !(v.day && v.end_day) || v.end_day >= v.day, {
    message: 'end_day precedes day',
  })
  // An end_day with no day has nothing to close. Drop the whole result rather
  // than half of it: a partial span is more confusing than no answer.
  .refine((v) => !v.end_day || !!v.day, { message: 'end_day without day' })
  // The point of this call is to find *structure* the regex parser missed. A
  // title alone is just the first line of the paste, which the free path
  // already produces — returning it would spend a call to change nothing.
  .refine((v) => !!(v.day || v.start_time || v.location), {
    message: 'nothing structured was extracted',
  })
export type ParsedBookingResult = z.infer<typeof ParsedBookingResult>

/* ── the improve_day result contract ─────────────────────────────────────── */

/**
 * What the model is allowed to hand back for `improve_day`.
 *
 * Two fields, and the small one is the important one. `planId` selects from a
 * closed set of plans this server generated and validated (src/server/ai/day.ts)
 * — the model never authors a schedule, so it cannot author a broken one. The
 * measured failure mode (resolve one conflict, create another) is not caught
 * here; it is impossible here.
 *
 * `reason` is the part worth paying a model for: a scored diff reads as
 * robotic. It is capped because output tokens are the expensive side, and
 * because a paragraph is not a reason.
 */
export const DayPickResult = z.object({
  planId: z.string().min(1).max(32),
  reason: z.string().trim().min(1).max(400),
})
export type DayPickResult = z.infer<typeof DayPickResult>

/** How the explanation was produced — shown to the member, not just logged. */
export const REASON_SOURCES = ['model', 'computed'] as const
export type ReasonSource = (typeof REASON_SOURCES)[number]
