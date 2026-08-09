import { z } from 'zod'

/**
 * An optional money field that stays empty when the user leaves it empty.
 *
 * The obvious spelling is a trap:
 *
 * ```ts
 * z.coerce.number().min(0).optional().nullable().or(z.literal(''))
 * ```
 *
 * `z.coerce.number()` runs `Number('')`, which is `0` — a perfectly valid
 * number that satisfies `.min(0)`. The first branch therefore succeeds, the
 * `z.literal('')` fallback is unreachable, and every blank field is silently
 * stored as a real `0`. (The idiom only works when the constraint rejects
 * zero, e.g. `.positive()`, which is why the rate fields never showed it.)
 *
 * A stored `0` is not the same fact as "no amount", and the difference is
 * load-bearing: `tripActual(e) ?? tripEstimated(e)` stops falling back once
 * `actual` is `0`, and `ItemBudgetLink` keys its whole UI off `cost == null`.
 *
 * So: normalise empty and whitespace-only input to `null` *before* the
 * coercion can see it, and keep the real validation messages.
 */
export function optionalAmount(messages: { invalid?: string; negative?: string } = {}) {
  return z
    .preprocess(
      (v) => (typeof v === 'string' && v.trim() === '' ? null : v),
      z.coerce
        .number({ invalid_type_error: messages.invalid ?? 'Enter a number' })
        .min(0, messages.negative ?? 'Can’t be negative')
        .nullable()
    )
    .optional()
}
