/*
  The Supabase project's PUBLIC connection values, as bare literals.

  These are not secrets — Row Level Security is the security boundary, not key
  secrecy — and they already ship inside every client bundle. They live in their
  own module because two very different runtimes need them:

    * the browser app, via config.ts, which layers Vite's `import.meta.env`
      overrides on top;
    * the Cloudflare Pages Function, which has no `import.meta.env` at all and
      would otherwise need them duplicated or passed as environment variables.

  One copy, so the two can never drift apart.
*/

export const PUBLIC_SUPABASE_URL = 'https://qqmfxbcroxunvtgxxray.supabase.co'
export const PUBLIC_SUPABASE_ANON_KEY = 'sb_publishable_TJuVLg5h31V-kg3gX36vUQ_wKR-Ga2_'
