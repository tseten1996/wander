/**
 * Member payment links for the settle-up "Pay" affordance (#347).
 *
 * A member stores a payment link on their own profile (a PayPal.me / Venmo /
 * Revolut handle link, or any plain `https://` URL). On a "you owe X" row the
 * settle-up card builds a deep link that opens X's payment target with the owed
 * amount — and, where the target takes it, a trip-named note — already filled
 * in, so no one retypes a handle from memory.
 *
 * Pure module, no runtime imports: the Node test runner exercises it directly
 * (see tests/payment-link.test.mjs), and it is the single source of truth for
 * both storing the value and rendering it as a link.
 *
 * Security posture: a payment link is a user-supplied string rendered as an
 * `href`, which is a capability. Both the stored value and the rendered link are
 * constrained to `https:` — `javascript:`, `data:`, and every other scheme are
 * rejected, so a pasted value can never become an open-redirect or script sink.
 * `normalizePaymentLink` is applied on save AND again before use, so even a
 * value slipped past the client (a hand-crafted PostgREST write) is re-checked.
 */

/** Any leading `scheme:` — used to tell "handle only" from a declared scheme. */
const HAS_SCHEME = /^[a-z][a-z0-9+.-]*:/i

/**
 * Validate and normalize a member-typed payment link to a safe `https:` URL, or
 * null when it isn't one.
 *
 * A paste with no scheme (`paypal.me/alex`) is treated as an https host and
 * upgraded, so members needn't type the scheme. A value that *declares* a scheme
 * keeps it — and anything other than `https:` (notably `http:`, `javascript:`,
 * `data:`) is rejected rather than reinterpreted, so a script scheme can never
 * be laundered into an https link.
 */
export function normalizePaymentLink(raw: string | null | undefined): string | null {
  if (!raw) return null
  const trimmed = raw.trim()
  if (!trimmed) return null
  // Only prepend a scheme when the paste omitted one entirely. `javascript:…`
  // already has a scheme, so it is parsed and rejected below — never upgraded.
  const candidate = HAS_SCHEME.test(trimmed) ? trimmed : `https://${trimmed}`
  try {
    const u = new URL(candidate)
    if (u.protocol !== 'https:') return null
    // A URL must have a host to be a payment target (`https:///x` and the like
    // parse but point nowhere).
    if (!u.hostname) return null
    return u.href
  } catch {
    return null
  }
}

/** The bare host, lowercased and without a leading `www.`, for target matching. */
function baseHost(u: URL): string {
  return u.hostname.replace(/^www\./i, '').toLowerCase()
}

/** A payment amount as a plain 2-decimal string for a URL param (never `$40`). */
function amountParam(amount: number): string {
  return (Math.round(amount * 100) / 100).toFixed(2)
}

export interface PaymentTarget {
  /** The creditor's stored payment link. */
  link: string | null | undefined
  /** The owed amount, in the trip currency. */
  amount: number
  /** The trip's ISO currency code (e.g. `EUR`) — used where the target takes it. */
  currency: string
  /** A short note for the payment (the trip-named settle-up memo). */
  note: string
}

/**
 * Build the URL to open for a "Pay X" tap: X's stored link with the owed amount
 * (and, where supported, the note) prefilled. Returns null when the stored value
 * isn't a safe link, so the caller renders no Pay action rather than a broken one.
 *
 * Prefill is best-effort per target:
 *   • paypal.me/<handle>      → append `/<amount><CURRENCY>` (PayPal.me amount path)
 *   • venmo.com/u/<handle>    → add `?txn=pay&amount=&note=` (Venmo web charge)
 *   • anything else           → opened unchanged (Revolut profile, a plain https
 *                               link) — the amount is still shown on the button so
 *                               the member knows what to send.
 */
export function buildPaymentUrl({ link, amount, currency, note }: PaymentTarget): string | null {
  const normalized = normalizePaymentLink(link)
  if (!normalized || !(amount > 0)) return null
  let u: URL
  try {
    u = new URL(normalized)
  } catch {
    return null
  }
  const host = baseHost(u)
  const amt = amountParam(amount)
  const code = currency.trim().toUpperCase()

  if (host === 'paypal.me') {
    // PayPal.me takes the amount as a trailing path segment: /Name/40.00EUR.
    // Only append when the link is a bare handle (one path segment); if the
    // member already put an amount in the path, leave their link as they set it.
    const segments = u.pathname.split('/').filter(Boolean)
    if (segments.length === 1) {
      u.pathname = `/${segments[0]}/${amt}${/^[A-Z]{3}$/.test(code) ? code : ''}`
    }
    return u.href
  }

  if (host === 'venmo.com') {
    // Venmo's web charge form reads these query params.
    u.searchParams.set('txn', 'pay')
    u.searchParams.set('amount', amt)
    if (note) u.searchParams.set('note', note)
    return u.href
  }

  // Unknown target (Revolut profile link, a plain https URL): open it as stored.
  // We don't invent a deep-link shape we can't be sure of — a wrong URL is worse
  // than one the member finishes by hand.
  return u.href
}
