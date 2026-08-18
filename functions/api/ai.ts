/*
  The only platform-specific file in the AI path (#211).

  Cloudflare Pages routes `functions/api/ai.ts` to `/api/ai` — same origin as
  the app, so there is no CORS layer to maintain. Everything below it is plain
  TypeScript in src/server/ai/, which is what keeps the runtime decision in
  docs/AI-ARCHITECTURE.md §5.1 cheap to reverse: moving platforms means
  rewriting this file and nothing else.

  Keep it thin. Anything with a rule in it belongs in the handler, where the
  Node test runner can reach it without a Workers environment.

  NOTE WHAT IS ABSENT: there is no secret here. The Supabase URL and anon key
  are public by design (RLS is the boundary), the ledger write goes through a
  SECURITY DEFINER RPC instead of a service-role key, and Workers AI is a
  platform-authenticated binding rather than an API credential. The endpoint
  holds nothing worth stealing.
*/
import { createClient } from '@supabase/supabase-js'
import {
  PUBLIC_SUPABASE_ANON_KEY,
  PUBLIC_SUPABASE_URL,
} from '../../src/lib/supabase-public'
import { handleAiRequest } from '../../src/server/ai/handler'
import type { Db } from '../../src/server/ai/handler'
import { workersAiProvider } from '../../src/server/ai/provider'
import type { AiBinding } from '../../src/server/ai/provider'

interface Env {
  /** Optional overrides; the public defaults are used when unset. */
  SUPABASE_URL?: string
  SUPABASE_ANON_KEY?: string
  /** Kill switch. Anything other than the exact string 'true' disables AI. */
  AI_ENABLED?: string
  /**
   * Workers AI binding — configured in the Pages dashboard (Settings →
   * Bindings), authenticated by the platform rather than by a key we hold.
   * Deliberately NOT declared in a wrangler.toml: that file's presence makes
   * Cloudflare's Git integration deploy with `wrangler deploy` (the Workers
   * command), which fails on a Pages project.
   *
   * Typed as `unknown` rather than `AiBinding` so a missing binding is a value
   * this file has to check, not a type it can assume.
   */
  AI?: unknown
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

/** Narrow the dashboard-supplied binding before trusting it has a `run()`. */
const isAiBinding = (v: unknown): v is AiBinding =>
  typeof v === 'object' && v !== null && typeof (v as AiBinding).run === 'function'

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
  let body: unknown
  try {
    body = await request.json()
  } catch {
    return json({ ok: false, reason: 'forbidden', message: 'Expected a JSON body.' }, 400)
  }

  // Runs as the caller so RLS applies exactly as it does in the browser.
  // `persistSession: false` matters: this is a shared, stateless worker with no
  // per-user storage to write a session into.
  const db = createClient(
    env.SUPABASE_URL || PUBLIC_SUPABASE_URL,
    env.SUPABASE_ANON_KEY || PUBLIC_SUPABASE_ANON_KEY,
    {
      global: { headers: { Authorization: request.headers.get('Authorization') ?? '' } },
      auth: { persistSession: false, autoRefreshToken: false },
    },
  ) as unknown as Db

  const { status, body: result } = await handleAiRequest(body, {
    db,
    // Explicit opt-in. Unset, misspelled, or bound only to production means
    // preview deployments answer "disabled" rather than serving requests on
    // every pull request.
    enabled: env.AI_ENABLED === 'true',
    // Two independent switches, and that is the point: the flag says "AI is
    // allowed here", the binding says "there is a model to call". Losing the
    // binding degrades to "switched off" instead of throwing on first use.
    provider: isAiBinding(env.AI) ? workersAiProvider(env.AI) : undefined,
  })

  return json(result, status)
}
