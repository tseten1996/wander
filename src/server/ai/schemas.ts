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

/** Why a request was refused, in terms the UI can render without a lookup. */
export const REFUSAL_REASONS = ['disabled', 'quota', 'forbidden'] as const
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
  /** Stub until a model is wired in (#212). */
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
