/**
 * Linking an email to an anonymous session (#383, epic #365 slice 1).
 *
 * An invited friend joins with an anonymous Supabase session that lives only in
 * this device's Local Storage — Safari/ITP evicts it in ~7 days, and when it
 * goes the friend loses access to every trip they joined. The one missing auth
 * call that fixes this is `supabase.auth.updateUser({ email })`: it attaches a
 * durable email credential to the *same* session, so `auth.uid()` is preserved
 * and no `members` row is orphaned — strictly an upgrade, never a re-sign-in.
 *
 * The matching and error-mapping are kept pure here (no React, no bound
 * Supabase client) so the continuity guarantee can be unit-tested with a mock
 * client — see tests/link-email.test.mjs. `useAuth` wraps `linkEmailWith` with
 * the real client; the UI only ever sees a resolved email or a thrown, already
 * friendly Error.
 */

/** The minimal Supabase-auth surface `linkEmailWith` touches — just enough to
 *  inject a mock in tests. The real `supabase.auth` satisfies it structurally. */
export interface AuthLinker {
  updateUser(
    attributes: { email: string },
    options?: { emailRedirectTo?: string },
  ): Promise<{ error: LinkEmailError | null }>
}

/** The shape of a Supabase `AuthError` we read — both optional. */
export interface LinkEmailError {
  message?: string
  code?: string
  status?: number
}

/**
 * Trim and minimally validate an email before we attempt to link it. Supabase
 * (and the confirmation email that must actually arrive) is the real validator;
 * this only rejects obvious empties and missing-`@` typos so we never fire a
 * pointless request. Returns the cleaned address, or null when it's unusable.
 */
export function normalizeEmail(raw: string): string | null {
  const email = raw.trim()
  if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return null
  return email
}

/**
 * Does this `updateUser` error mean the email already belongs to another
 * account? That's the one error path with a distinct remedy ("sign in with it
 * instead"), so we detect it explicitly rather than lumping it into the generic
 * failure. Matches on Supabase's error `code` first (stable), falling back to
 * message text for older/edge responses.
 */
export function isEmailTakenError(error: LinkEmailError | null | undefined): boolean {
  if (!error) return false
  const code = (error.code ?? '').toLowerCase()
  if (code === 'email_exists' || code === 'user_already_exists') return true
  const msg = (error.message ?? '').toLowerCase()
  return (
    msg.includes('already registered') ||
    msg.includes('already been registered') ||
    msg.includes('already in use') ||
    msg.includes('already exists')
  )
}

/** Map an `updateUser` error to friendly, actionable toast copy. */
export function linkEmailErrorMessage(error: LinkEmailError | null | undefined): string {
  if (isEmailTakenError(error)) {
    return 'That email is already linked to another account. Sign in with it instead.'
  }
  return error?.message || 'Couldn’t send the confirmation email. Please try again.'
}

/**
 * Attach `rawEmail` to the current session via `client.updateUser`, preserving
 * `auth.uid()`. Resolves with the normalized email on success (Supabase then
 * emails a confirmation link); throws an Error carrying already-friendly copy on
 * an invalid address or any auth error. It deliberately performs *only* the
 * `updateUser` upgrade — it never signs out or re-authenticates, which is what
 * keeps every joined trip attached to the same uid.
 */
export async function linkEmailWith(
  client: AuthLinker,
  rawEmail: string,
  redirectTo?: string,
): Promise<string> {
  const email = normalizeEmail(rawEmail)
  if (!email) throw new Error('Enter a valid email address.')
  const { error } = await client.updateUser(
    { email },
    redirectTo ? { emailRedirectTo: redirectTo } : undefined,
  )
  if (error) throw new Error(linkEmailErrorMessage(error))
  return email
}
