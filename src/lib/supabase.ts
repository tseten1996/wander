import { createClient } from '@supabase/supabase-js'
import { SUPABASE_URL, SUPABASE_ANON_KEY } from './config'

export const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
  auth: {
    persistSession: true,
    autoRefreshToken: true,
    // Session lives in Local Storage — this is what keeps an invited friend
    // recognized on their device without an account.
    storageKey: 'wander_auth',
  },
})
