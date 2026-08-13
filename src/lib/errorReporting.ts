import { supabase } from './supabase'

/**
 * Client error telemetry (#57). A broken deploy used to surface only when a
 * user noticed and reported it. These global handlers write minimal, best-effort
 * records of uncaught errors and unhandled promise rejections to the
 * `error_reports` table, so the maintainer sees a runtime crash without waiting
 * for a bug report.
 *
 * This is UX-grade telemetry, never a security path — RLS decides who can read
 * the rows (a trip owner for their trip's errors; the maintainer via the
 * dashboard for deploy-level ones). The rules this file lives by:
 *
 *   - Fire-and-forget. A failed insert must never surface to the user or throw
 *     back into the error pipeline — that would recurse.
 *   - Bounded. A render loop or a repeated rejection must not flood the
 *     free-tier table: reports are deduped within a short window and capped per
 *     tab session (persisted so a reload-loop can't reset the budget). This is
 *     defense-in-depth — the DB-side throttle (#170) is the real boundary; the
 *     client just avoids firing requests it knows will be rejected.
 *   - Minimal + safe. We send the message, stack, current URL, and user agent —
 *     truncated, and with the invite code (the trip's only capability) redacted
 *     from the URL so telemetry never persists it.
 */

const MAX_REPORTS_PER_SESSION = 20
const DEDUP_WINDOW_MS = 10_000
const MAX_MESSAGE = 1_000
const MAX_STACK = 4_000
const MAX_URL = 500
const MAX_USER_AGENT = 400
const SESSION_COUNT_KEY = 'wander:error-reports-sent'

let sent = 0
let installed = false
const recentlyReported = new Map<string, number>()

function truncate(value: string | null | undefined, max: number): string | null {
  if (!value) return null
  return value.length > max ? value.slice(0, max) : value
}

/**
 * The number of reports already sent this tab session. Persisted in
 * sessionStorage so a crash-loop that reloads the page can't reset the cap back
 * to zero and keep hammering. Falls back to the in-memory counter when
 * sessionStorage is unavailable (private mode / disabled), which still caps the
 * current load. Every access is guarded — telemetry must never throw.
 */
function sessionCount(): number {
  try {
    const raw = window.sessionStorage.getItem(SESSION_COUNT_KEY)
    const n = raw ? Number.parseInt(raw, 10) : 0
    return Number.isFinite(n) && n > sent ? n : sent
  } catch {
    return sent
  }
}

function bumpSessionCount(): void {
  sent = sessionCount() + 1
  try {
    window.sessionStorage.setItem(SESSION_COUNT_KEY, String(sent))
  } catch {
    // sessionStorage unavailable — the in-memory counter still caps this load.
  }
}

/**
 * The trip being viewed when the error fired, from the HashRouter path
 * (`#/trip/<uuid>/...`), or null for the home/join screens or a boot-time crash.
 * The INSERT policy only accepts a trip the caller belongs to, so this stays
 * consistent with what RLS will allow.
 */
function currentTripId(): string | null {
  const match = window.location.hash.match(
    /#\/trip\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/i
  )
  return match ? match[1] : null
}

/**
 * Never persist the invite code — it is the trip's only capability (guardrail
 * #2). Redact it from the join path before the URL is stored.
 */
function sanitizedUrl(): string {
  return window.location.href.replace(/(#\/join\/)[^/?&#]+/i, '$1<redacted>')
}

async function report(message: string, stack: string | null): Promise<void> {
  try {
    if (sessionCount() >= MAX_REPORTS_PER_SESSION) return

    const now = Date.now()
    const key = `${message}\n${stack?.slice(0, 200) ?? ''}`
    const last = recentlyReported.get(key)
    if (last !== undefined && now - last < DEDUP_WINDOW_MS) return
    recentlyReported.set(key, now)
    bumpSessionCount()

    // The INSERT policy requires auth.uid() = user_id, so a session must exist.
    // Errors before the anonymous session is minted are dropped rather than
    // failing an RLS check we can predict — telemetry is best-effort.
    const { data } = await supabase.auth.getSession()
    if (!data.session) return

    await supabase.from('error_reports').insert({
      message: truncate(message, MAX_MESSAGE) ?? 'Unknown error',
      stack: truncate(stack, MAX_STACK),
      url: truncate(sanitizedUrl(), MAX_URL),
      trip_id: currentTripId(),
      user_agent: truncate(navigator.userAgent, MAX_USER_AGENT),
    })
  } catch {
    // Swallow everything: telemetry must never break the app or recurse into
    // the very handlers that called it.
  }
}

/**
 * Register the global error listeners. Idempotent and safe to call once at
 * startup (main.tsx). The listeners are passive — they never call
 * preventDefault(), so the browser's own error logging and React's dev overlay
 * are unaffected.
 */
export function initErrorReporting(): void {
  if (installed || typeof window === 'undefined') return
  installed = true

  window.addEventListener('error', (event) => {
    // event.error is absent for cross-origin script errors; fall back to the
    // (opaque) message the browser still gives us.
    const message = event.message || event.error?.message || 'Unknown error'
    void report(message, event.error?.stack ?? null)
  })

  window.addEventListener('unhandledrejection', (event) => {
    const reason = event.reason as { message?: string; stack?: string } | undefined
    const message = reason?.message ?? String(event.reason)
    void report(`Unhandled rejection: ${message}`, reason?.stack ?? null)
  })
}
