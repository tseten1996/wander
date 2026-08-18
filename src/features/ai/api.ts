import { useMutation } from '@tanstack/react-query'
import { supabase } from '@/lib/supabase'
import type { AiResponse, Intent } from '@/server/ai/schemas'

/*
  Client access to the AI endpoint (#211).

  Unlike every other feature's api.ts this does not talk to Supabase directly —
  it POSTs to /api/ai, a Cloudflare Pages Function on the same origin. Same
  origin is why there is no CORS handling here and no base URL to configure.

  The caller's Supabase access token goes in the Authorization header because
  the function uses it to read as them: RLS is still the authorization boundary,
  it is simply being applied one hop further out. Nothing here is trusted by the
  server — the trip id is re-checked against the caller's membership.
*/

/** Thrown for transport-level failures. Refusals are NOT errors — see below. */
export class AiUnavailableError extends Error {
  constructor(message = 'Wander AI is unavailable right now.') {
    super(message)
    this.name = 'AiUnavailableError'
  }
}

export interface AiInput {
  intent: Intent
  tripId: string
  [key: string]: unknown
}

/**
 * Call the AI endpoint once.
 *
 * A *refusal* — disabled, over quota, forbidden — resolves normally with
 * `ok: false` rather than throwing. Those are expected outcomes the UI should
 * render as a message, not exceptions to be caught; treating "you've used
 * today's allowance" as an error would push it into a generic failure toast and
 * lose the reason. Only a genuine transport failure throws.
 */
export async function callAi(input: AiInput): Promise<AiResponse> {
  const { data } = await supabase.auth.getSession()
  const token = data.session?.access_token
  if (!token) {
    // Every Wander user has a session (owners via magic link, friends via
    // anonymous sign-in), so this means auth has not settled yet rather than
    // that the user is signed out.
    return { ok: false, reason: 'forbidden', message: 'Still signing you in — try again in a moment.' }
  }

  let res: Response
  try {
    res = await fetch('/api/ai', {
      method: 'POST',
      headers: { 'content-type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify(input),
    })
  } catch {
    // Offline, or the function is unreachable. The PWA works offline, so this
    // is an ordinary state rather than an exceptional one.
    throw new AiUnavailableError()
  }

  try {
    return (await res.json()) as AiResponse
  } catch {
    // A non-JSON body means something upstream of the function answered —
    // an edge error page, say. Do not surface it raw.
    throw new AiUnavailableError()
  }
}

/**
 * Mutation wrapper for call sites.
 *
 * Deliberately no toast and no global error handling: an AI response is a
 * *proposal* the caller previews, so what to show depends entirely on the
 * feature. The itinerary paste flow, for instance, degrades to today's
 * behaviour rather than announcing a failure.
 */
export function useAiRequest() {
  return useMutation({
    mutationFn: (input: AiInput) => callAi(input),
    retry: false, // a refusal must never be retried automatically — see #211
  })
}
