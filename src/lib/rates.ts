/*
  Foreign-exchange rates via Frankfurter (https://frankfurter.dev) — a free,
  no-key, no-attribution API over the European Central Bank's published daily
  reference rates. Same zero-cost / no-key posture as the Open-Meteo weather
  (`weather.ts`) and Photon geocoder (`geocode.ts`) — see docs/ARCHITECTURE.md
  §"No backend, no paid anything".

  Rates are fetched once per trip currency and cached by TanStack Query. They
  are used only to *seed* the converted amount as a member types an expense;
  the converted value is then frozen onto the row (see the #79 migration), so a
  trip's settled numbers never move when the ECB rate does. When the API is
  unreachable or the trip currency isn't covered by the ECB set, the query
  errors and the Budget form degrades to trip-currency-only entry.
*/

const RATES_URL = 'https://api.frankfurter.dev/v1/latest'

/**
 * The ECB reference-rate currencies Frankfurter covers. Kept as a static list
 * (rather than derived from a live response) so the currency picker is stable
 * offline and the labels are human-readable. Codes must stay uppercase ISO 4217.
 */
export const CURRENCIES: { code: string; name: string }[] = [
  { code: 'AUD', name: 'Australian dollar' },
  { code: 'BGN', name: 'Bulgarian lev' },
  { code: 'BRL', name: 'Brazilian real' },
  { code: 'CAD', name: 'Canadian dollar' },
  { code: 'CHF', name: 'Swiss franc' },
  { code: 'CNY', name: 'Chinese yuan' },
  { code: 'CZK', name: 'Czech koruna' },
  { code: 'DKK', name: 'Danish krone' },
  { code: 'EUR', name: 'Euro' },
  { code: 'GBP', name: 'British pound' },
  { code: 'HKD', name: 'Hong Kong dollar' },
  { code: 'HUF', name: 'Hungarian forint' },
  { code: 'IDR', name: 'Indonesian rupiah' },
  { code: 'ILS', name: 'Israeli shekel' },
  { code: 'INR', name: 'Indian rupee' },
  { code: 'ISK', name: 'Icelandic króna' },
  { code: 'JPY', name: 'Japanese yen' },
  { code: 'KRW', name: 'South Korean won' },
  { code: 'MXN', name: 'Mexican peso' },
  { code: 'MYR', name: 'Malaysian ringgit' },
  { code: 'NOK', name: 'Norwegian krone' },
  { code: 'NZD', name: 'New Zealand dollar' },
  { code: 'PHP', name: 'Philippine peso' },
  { code: 'PLN', name: 'Polish złoty' },
  { code: 'RON', name: 'Romanian leu' },
  { code: 'SEK', name: 'Swedish krona' },
  { code: 'SGD', name: 'Singapore dollar' },
  { code: 'THB', name: 'Thai baht' },
  { code: 'TRY', name: 'Turkish lira' },
  { code: 'USD', name: 'US dollar' },
  { code: 'ZAR', name: 'South African rand' },
]

const CURRENCY_CODES = new Set(CURRENCIES.map((c) => c.code))

export function isSupportedCurrency(code: string | null | undefined): boolean {
  return !!code && CURRENCY_CODES.has(code.toUpperCase())
}

/**
 * A rate table keyed by the *trip* currency: `rates[X]` is how many units of X
 * equal one unit of the trip currency. The trip currency itself maps to 1.
 */
export type RateTable = Record<string, number>

/**
 * Fetch ECB rates with `base` as the reference. Returns a table that includes
 * `base: 1`. Throws on network/HTTP failure or an unsupported base (Frankfurter
 * 404s) so the caller's TanStack Query lands in an error state the Budget form
 * reads as "live rates unavailable".
 */
export async function fetchRates(base: string, signal?: AbortSignal): Promise<RateTable> {
  const code = base.toUpperCase()
  const res = await fetch(`${RATES_URL}?base=${encodeURIComponent(code)}`, { signal })
  if (!res.ok) throw new Error(`Rates API returned ${res.status}`)
  const data: unknown = await res.json()
  const raw =
    data && typeof data === 'object' ? (data as { rates?: unknown }).rates : undefined
  const table: RateTable = { [code]: 1 }
  if (raw && typeof raw === 'object') {
    for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
      if (typeof v === 'number' && v > 0) table[k.toUpperCase()] = v
    }
  }
  return table
}

/**
 * The multiplier that converts an amount in `from` into the trip currency the
 * `rates` table is based on: `tripAmount = fromAmount * rate`. Returns null when
 * the source currency isn't in the table (nothing to convert with).
 */
export function conversionRate(from: string, rates: RateTable): number | null {
  const per = rates[from.toUpperCase()] // units of `from` per 1 trip-currency
  if (!per || per <= 0) return null
  return 1 / per
}

/**
 * Round to cents the same way the settlement math does, avoiding fp dust. The
 * `Number.EPSILON` nudge prevents binary under-rounding at exact half-cent
 * boundaries — e.g. `1.005 * 100` is `100.49999…` in IEEE-754, which would
 * otherwise floor a converted amount one cent low.
 */
export function toCents(amount: number): number {
  return Math.round((amount + Number.EPSILON) * 100) / 100
}
