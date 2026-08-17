/*
  The only platform-specific file in the AI path (#211).

  Cloudflare Pages routes `functions/api/ai.ts` to `/api/ai` — same origin as
  the app, so there is no CORS layer to maintain. Everything below it is plain
  TypeScript in src/server/ai/, which is what keeps the runtime decision in
  docs/AI-ARCHITECTURE.md §5.1 cheap to reverse: moving platforms means
  rewriting this file and nothing else.

  Keep it thin. Anything with a rule in it belongs in the handler, where the
  Node test runner can reach it without a Workers environment.
*/
import { createClient } from '@supabase/supabase-js'
import { handleAiRequest } from '../../src/server/ai/handler'
import type { Db } from '../../src/server/ai/handler'

interface Env {
  SUPABASE_URL: string
  SUPABASE_ANON_KEY: string
  SUPABASE_SERVICE_ROLE_KEY: string
  /** Kill switch. Anything other than the exact string 'true' disables AI. */
  AI_ENABLED?: string
}

/**
 * The slice of Cloudflare's request context this handler uses.
 *
 * Declared locally rather than pulling in `@cloudflare/workers-types` for the
 * `PagesFunction` generic: that package would be a dependency and a second
 * tsconfig project for two field names, and an ambient global type would go
 * unchecked anyway. `Request`/`Response` come from the DOM lib the app config
 * already sets — the Workers runtime implements the same interfaces.
 */
interface PagesContext {
  request: Request
  env: Env
}

const json = (body: unknown, status: number): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      // A per-caller, per-trip response with a quota in it must never be
      // cached — by Cloudflare, by the browser, or by the service worker.
      'cache-control': 'no-store',
    },
  })

export async function onRequestPost({ request, env }: PagesContext): Promise<Response> {
  // Fail closed on missing configuration. A function that cannot build its
  // clients must not fall through to some degraded path — there isn't one.
  if (!env.SUPABASE_URL || !env.SUPABASE_ANON_KEY || !env.SUPABASE_SERVICE_ROLE_KEY) {
    return json(
      { ok: false, reason: 'disabled', message: 'Wander AI is not configured.' },
      503,
    )
  }

  let body: unknown
  try {
    body = await request.json()
  } catch {
    return json(
      { ok: false, reason: 'forbidden', message: 'Expected a JSON body.' },
      400,
    )
  }

  // Reads run as the caller so RLS applies exactly as it does in the browser.
  // `persistSession: false` matters here: this is a shared, stateless worker
  // and there is no per-user storage to write a session into.
  const asCaller = createClient(env.SUPABASE_URL, env.SUPABASE_ANON_KEY, {
    global: { headers: { Authorization: request.headers.get('Authorization') ?? '' } },
    auth: { persistSession: false, autoRefreshToken: false },
  }) as unknown as Db

  // Service role: the usage ledger and nothing else. See handler.ts.
  const asService = createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  }) as unknown as Db

  const { status, body: result } = await handleAiRequest(body, {
    asCaller,
    asService,
    // Explicit opt-in. Unset, misspelled, or bound only to production means
    // preview deployments answer "disabled" instead of spending money on
    // every pull request.
    enabled: env.AI_ENABLED === 'true',
  })

  return json(result, status)
}
