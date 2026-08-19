/*
  What to say when the AI endpoint could not be reached at all.

  Its own module, importing nothing, for the same reason src/lib/geo.ts and
  itinerary/directions.ts are: the Node test runner can load it directly, so the
  wording is covered by a test instead of by reading the UI. api.ts cannot be —
  it pulls in React Query and the Supabase client.

  These strings earned a module. An earlier version showed one generic "Wander
  AI is unavailable right now" for every transport failure, and that cost a real
  debugging session: an offline phone and a host with no Function deployed
  produced the identical sentence, so the only evidence available fit both
  explanations equally well.
*/

/**
 * Why the endpoint could not be reached.
 *
 * `offline` is the network refusing the request — the PWA works offline, so
 * this is an ordinary state. `bad-response` is something answering that is not
 * this endpoint: a 404 page, an edge error page, a CDN interstitial. They look
 * identical to whoever is holding the phone and mean completely different
 * things to whoever has to fix it.
 */
export type AiTransportFailure = 'offline' | 'bad-response'

/** A sentence for a member that still names the failure. */
export function describeTransportFailure(
  cause: AiTransportFailure,
  status?: number,
): string {
  if (cause === 'offline') return 'Couldn’t reach Wander AI — you may be offline'
  return status
    ? `Wander AI isn’t available on this version of the app (HTTP ${status})`
    : 'Wander AI isn’t available on this version of the app'
}
