import * as React from 'react'
import { Check, Copy, ExternalLink, KeyRound } from 'lucide-react'
import { toast } from 'sonner'

/**
 * The display chips a booking record shows — the confirmation code and the
 * external booking link. Stays and Transport cards render identical rows, so
 * these live here as one shared presentational primitive rather than a copy per
 * feature (the copies had already gone byte-identical and were drifting apart;
 * #384). Pure display: no feature imports, no data access.
 *
 * Both carry `data-tap-target` so they meet the 44px mobile tap-target floor
 * (guardrail #6) from one definition — the chips are small, front-desk controls
 * a friend taps on a phone, so a fat-finger miss is exactly what the floor
 * guards against.
 */

/** Copy-to-clipboard chip for a confirmation code — the front-desk field, so it
 *  is one tap to copy rather than a select-and-hold on mobile. */
export function CodeChip({ code }: { code: string }) {
  const [copied, setCopied] = React.useState(false)
  const timer = React.useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  React.useEffect(() => () => clearTimeout(timer.current), [])
  async function copy() {
    try {
      await navigator.clipboard.writeText(code)
      setCopied(true)
      clearTimeout(timer.current)
      timer.current = setTimeout(() => setCopied(false), 1500)
    } catch {
      toast.error('Could not copy the code — try again')
    }
  }
  return (
    <button
      type="button"
      onClick={copy}
      data-tap-target
      aria-label={copied ? 'Confirmation code copied' : `Copy confirmation code ${code}`}
      className="inline-flex max-w-full items-center gap-1.5 rounded-full border border-line bg-surface px-2.5 py-1 text-xs text-muted transition-colors hover:border-line-strong hover:text-ink"
    >
      <KeyRound className="size-3.5 shrink-0 text-primary" aria-hidden />
      <span className="truncate font-mono">{code}</span>
      {copied ? (
        <Check className="size-3.5 shrink-0 text-success" aria-hidden />
      ) : (
        <Copy className="size-3.5 shrink-0" aria-hidden />
      )}
    </button>
  )
}

/** Sanitized external booking link chip. The caller passes an already-sanitized
 *  http(s) URL (`safeHttpUrl`) — an `href` is a capability, never a raw field. */
export function BookingChip({ url }: { url: string }) {
  return (
    <a
      href={url}
      target="_blank"
      rel="noreferrer noopener"
      data-tap-target
      className="inline-flex max-w-full items-center gap-1.5 rounded-full border border-line bg-surface px-2.5 py-1 text-xs text-muted transition-colors hover:border-line-strong hover:text-ink"
    >
      <ExternalLink className="size-3.5 shrink-0" aria-hidden />
      <span className="truncate">Booking</span>
    </a>
  )
}
