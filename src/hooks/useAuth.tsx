import * as React from 'react'
import type { Session } from '@supabase/supabase-js'
import { supabase } from '@/lib/supabase'
import { getDeviceId } from '@/lib/device'

interface AuthContextValue {
  session: Session | null
  loading: boolean
  /** True when this session was created invisibly for an invited friend. */
  isAnonymous: boolean
  signInWithEmail: (email: string) => Promise<void>
  /**
   * Guarantee a session exists (used by the join flow). Friends get an
   * anonymous session — no email, no password, ~1 network call.
   */
  ensureSession: () => Promise<Session>
  signOut: () => Promise<void>
}

const AuthContext = React.createContext<AuthContextValue | null>(null)

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [session, setSession] = React.useState<Session | null>(null)
  const [loading, setLoading] = React.useState(true)

  React.useEffect(() => {
    getDeviceId() // ensure the device id exists from first load
    supabase.auth.getSession().then(({ data }) => {
      setSession(data.session)
      setLoading(false)
    })
    const { data: sub } = supabase.auth.onAuthStateChange((_event, s) => {
      setSession(s)
      setLoading(false)
    })
    return () => sub.subscription.unsubscribe()
  }, [])

  const value = React.useMemo<AuthContextValue>(
    () => ({
      session,
      loading,
      isAnonymous: session?.user?.is_anonymous ?? false,
      signInWithEmail: async (email: string) => {
        const { error } = await supabase.auth.signInWithOtp({
          email,
          options: {
            // Return to exactly where the app is hosted (works for GitHub
            // Pages subpaths); PKCE puts ?code= in the query, which doesn't
            // clash with hash routing.
            emailRedirectTo: window.location.origin + window.location.pathname,
          },
        })
        if (error) throw error
      },
      ensureSession: async () => {
        const { data } = await supabase.auth.getSession()
        if (data.session) return data.session
        const { data: anon, error } = await supabase.auth.signInAnonymously()
        if (error || !anon.session) {
          throw error ?? new Error('Could not create a session')
        }
        return anon.session
      },
      signOut: async () => {
        await supabase.auth.signOut()
      },
    }),
    [session, loading]
  )

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>
}

export function useAuth(): AuthContextValue {
  const ctx = React.useContext(AuthContext)
  if (!ctx) throw new Error('useAuth must be used inside <AuthProvider>')
  return ctx
}
