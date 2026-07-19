/** Maps Postgres/PostgREST error codes to short, friendly messages for toasts. */
const CODE_MESSAGES: Record<string, string> = {
  '23505': 'That already exists — try a different value.',
  '23503': 'That item is linked elsewhere and can’t be changed right now.',
  '23502': 'A required field is missing.',
  '23514': 'That value isn’t allowed.',
  '22001': 'That text is too long — please shorten it.',
  '22P02': 'That value is in the wrong format.',
  PGRST301: 'Your session expired — refresh the page and try again.',
  PGRST116: 'That item no longer exists.',
}

interface SupabaseLikeError {
  code?: string
  message?: string
}

export function friendlyError(
  error: unknown,
  fallback = 'Something went wrong. Please try again.'
): string {
  if (!error) return fallback
  if (typeof navigator !== 'undefined' && navigator.onLine === false) {
    return 'You appear to be offline — check your connection and try again.'
  }
  if (typeof error === 'object' && error !== null) {
    const e = error as SupabaseLikeError
    if (e.code && CODE_MESSAGES[e.code]) return CODE_MESSAGES[e.code]
    if (e.message) return e.message
  }
  if (error instanceof Error) return error.message
  return fallback
}
