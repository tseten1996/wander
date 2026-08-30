// Supabase connection. The URL and publishable (anon) key are PUBLIC values —
// Row Level Security is the security boundary, not key secrecy — so shipping
// defaults here keeps static-host deploys zero-config. Env vars still win,
// which is how you'd point the app at a different project.
// `||` (not `??`) on purpose: CI defines unset vars as empty strings.
//
// The literals live in supabase-public.ts so the Pages Function can import the
// same values — it has no `import.meta.env` to read overrides from.
import { PUBLIC_SUPABASE_ANON_KEY, PUBLIC_SUPABASE_URL } from './supabase-public'

export const SUPABASE_URL = import.meta.env.VITE_SUPABASE_URL || PUBLIC_SUPABASE_URL

export const SUPABASE_ANON_KEY =
  import.meta.env.VITE_SUPABASE_ANON_KEY || PUBLIC_SUPABASE_ANON_KEY

// Web Push (#267). The VAPID *public* key is public by design — it is the
// `applicationServerKey` the browser needs to create a push subscription, and
// it only identifies the sender; it seals nothing. It therefore ships in the
// bundle like the Supabase anon key. The matching VAPID *private* key is the
// feature's one true secret and never appears here — it lives only in the
// server function's secret store (guardrail #5, the #191 decision).
//
// Empty until a deployment provisions push: with no key, the opt-in never
// renders and the app is unchanged. So the whole client push surface is dark
// by default and lights up only once a real key is configured.
export const VAPID_PUBLIC_KEY = import.meta.env.VITE_VAPID_PUBLIC_KEY || ''
