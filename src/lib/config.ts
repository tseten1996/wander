// Supabase connection. The URL and publishable (anon) key are PUBLIC values —
// Row Level Security is the security boundary, not key secrecy — so shipping
// defaults here keeps GitHub Pages deploys zero-config. Env vars still win,
// which is how you'd point the app at a different project.
export const SUPABASE_URL =
  import.meta.env.VITE_SUPABASE_URL ?? 'https://qqmfxbcroxunvtgxxray.supabase.co'

export const SUPABASE_ANON_KEY =
  import.meta.env.VITE_SUPABASE_ANON_KEY ??
  'sb_publishable_TJuVLg5h31V-kg3gX36vUQ_wKR-Ga2_'
