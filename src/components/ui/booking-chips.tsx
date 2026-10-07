import * as React from 'react'
import { Check, Copy, ExternalLink, KeyRound } from 'lucide-react'
import { toast } from 'sonner'

/*
  The display chips a stay or a transport hop carries for its confirmation code
  and its booking link. Stays and Transport rendered byte-identical copies of
  these; they live here once so the two surfaces inherit the same look and the
  same mobile tap-target floor from a single definition (guardrail #6, #384).

  `data-tap-target` floors each chip to 44px tall on phones (see the rule in
  src/index.css) — the controls are a phone's front-desk fields, so they must
  clear the fat-finger floor without changing their compact desktop size.
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

/** Sanitized external booking link chip. The caller passes an already
 *  http(s)-sanitized URL — an `href` is a capability, so a member-supplied link
 *  is only ever rendered when it is a real URL. */
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
