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
