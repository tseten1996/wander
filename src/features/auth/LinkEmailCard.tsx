import * as React from 'react'
import { motion } from '@/lib/motion'
import { MailCheck, ShieldCheck } from 'lucide-react'
import { toast } from 'sonner'
import { useAuth } from '@/hooks/useAuth'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Card } from '@/components/ui/card'
import { Label } from '@/components/ui/label'
import { normalizeEmail } from './linkEmail'

/**
 * "Keep your trips — add your email" (#383, epic #365 slice 1).
 *
 * The opt-in CTA that turns the dead-end warning we already show an anonymous
 * friend ("without an account you can only rejoin with a fresh invite link")
 * into an action: submitting an email calls `updateUser({ email })`, which
 * attaches a durable credential to the *same* session — every joined trip stays
 * theirs. Strictly additive: a friend who ignores it participates exactly as
 * before (guardrail #3). Rendered only for anonymous users — callers gate on
 * `isAnonymous` and the component also no-ops for a non-anonymous session.
 *
 * One component, two homes: the full `Card` on the anonymous home
 * (`compact={false}`, the default) and a borderless inline block in Settings
 * beside the existing warning (`compact`), so the copy and the error/confirm
 * handling can't drift between the two surfaces.
 */
export function LinkEmailCard({ compact = false }: { compact?: boolean }) {
  const { isAnonymous, linkEmail } = useAuth()
  const [email, setEmail] = React.useState('')
  const [sent, setSent] = React.useState(false)
  const [busy, setBusy] = React.useState(false)
  const [error, setError] = React.useState<string | null>(null)
  const fieldId = React.useId()
  const errorId = `${fieldId}-error`

  // Never render for an owner / email session — belt-and-braces with the
  // caller's own `isAnonymous` gate so this CTA can't leak onto a real account.
  if (!isAnonymous) return null

  async function submit(e: React.FormEvent) {
    e.preventDefault()
    if (busy) return
    if (!normalizeEmail(email)) {
      setError('Enter a valid email address.')
      return
    }
    setBusy(true)
    setError(null)
    try {
      await linkEmail(email)
      setSent(true)
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Something went wrong. Please try again.'
      setError(message)
      toast.error(message)
    } finally {
      setBusy(false)
    }
  }

  const heading = compact ? 'text-sm font-semibold' : 'font-display text-lg font-semibold'

  if (sent) {
    const confirm = (
      <div className={compact ? 'flex items-start gap-2' : 'text-center'}>
        <MailCheck className={compact ? 'mt-0.5 size-4 shrink-0 text-primary' : 'mx-auto size-8 text-primary'} />
        <div className={compact ? 'min-w-0' : 'mt-3'}>
          <p className={heading}>Check your inbox</p>
          <p className="mt-1 text-sm text-muted">
            Confirm via the link we emailed to <strong className="break-words">{email}</strong> and your
            trips are saved to it. You stay in every trip you’ve joined.
          </p>
          <Button
            variant="link"
            size={compact ? 'sm' : 'md'}
            className="mt-1 px-0"
            onClick={() => {
              setSent(false)
              setEmail('')
            }}
          >
            Use a different email
          </Button>
        </div>
      </div>
    )
    return compact ? (
      <div className="mt-2">{confirm}</div>
    ) : (
      <Card className="p-6">{confirm}</Card>
    )
  }

  const form = (
    <>
      <div className={compact ? 'flex items-start gap-2' : 'flex items-center gap-2'}>
        <ShieldCheck className={compact ? 'mt-0.5 size-4 shrink-0 text-primary' : 'size-5 text-primary'} />
        <div className="min-w-0">
          <p className={heading}>Keep your trips — add your email</p>
          <p className="mt-1 text-sm text-muted">
            You joined without an account, so you can only rejoin from a fresh invite link. Add an
            email and your trips are saved to it — nothing else changes.
          </p>
        </div>
      </div>
      <form onSubmit={submit} className={compact ? 'mt-3 space-y-2' : 'mt-4 space-y-2'} noValidate>
        <Label htmlFor={fieldId} className="sr-only">
          Email address
        </Label>
        <div className="flex flex-col gap-2 sm:flex-row">
          <Input
            id={fieldId}
            type="email"
            inputMode="email"
            autoComplete="email"
            placeholder="you@example.com"
            value={email}
            disabled={busy}
            aria-invalid={error ? true : undefined}
            aria-describedby={error ? errorId : undefined}
            onChange={(e) => {
              setEmail(e.target.value)
              if (error) setError(null)
            }}
            className="h-11 flex-1 text-base sm:text-sm"
          />
          <Button type="submit" disabled={busy} className="h-11 shrink-0 sm:w-auto">
            {busy ? 'Sending…' : 'Save my trips'}
          </Button>
        </div>
        {error && (
          <p id={errorId} role="alert" className="text-xs text-danger">
            {error}
          </p>
        )}
      </form>
    </>
  )

  if (compact) return <div className="mt-2">{form}</div>

  return (
    <motion.div
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.3, ease: 'easeOut' }}
    >
      <Card className="border-primary/30 bg-primary-faint/40 p-5">{form}</Card>
    </motion.div>
  )
}
