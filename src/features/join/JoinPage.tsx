import * as React from 'react'
import { useNavigate, useParams, Link } from 'react-router-dom'
import { motion } from '@/lib/motion'
import { CalendarDays, Compass, MapPin, PartyPopper, Users } from 'lucide-react'
import { toast } from 'sonner'
import { useAuth } from '@/hooks/useAuth'
import { getInvitePreview, joinTrip } from './api'
import { MEMBER_COLORS, firstFreeMemberColor } from '@/lib/colors'
import { dateRange, cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { PageLoader, EmptyState, ErrorState, Spinner } from '@/components/ui/misc'
import { MemberAvatar } from '@/components/ui/avatar'
import { signalTripJoined } from '@/components/layout/InstallNudge'
import type { InvitePreview } from '@/types'

type Phase = 'checking' | 'form' | 'joining' | 'invalid' | 'error'

// Only the server's explicit INVALID_INVITE means the link is genuinely
// dead. Everything else — NOT_AUTHENTICATED, a network drop, a rate-limited
// anonymous sign-in, a thrown ensureSession() — is transient and must offer a
// retry, never the dead-end "ask for a fresh link" screen.
function isInvalidInvite(error: { message?: string } | null | undefined) {
  return !!error?.message?.includes('INVALID_INVITE')
}

export default function JoinPage() {
  const { code } = useParams<{ code: string }>()
  const navigate = useNavigate()
  const { ensureSession } = useAuth()

  const [phase, setPhase] = React.useState<Phase>('checking')
  const [preview, setPreview] = React.useState<InvitePreview | null>(null)
  const [name, setName] = React.useState('')
  const [color, setColor] = React.useState(() => firstFreeMemberColor())
  // Bumped by "Try again" to re-run the initial check() without a full reload.
  const [retryNonce, setRetryNonce] = React.useState(0)

  const takenColors = preview?.taken_colors ?? []

  // 1) Silently create/reuse a session. 2) If this device is already a member,
  // join_trip is idempotent and we go straight in. 3) Otherwise show the
  // 15-second name form alongside a preview of what you're joining.
  //
  // The preview fetch runs *in parallel* with the auto-join probe and paints
  // the invite-context card the moment it resolves — so a slow network shows
  // "You're invited to [Trip]" instead of a contextless spinner, well before
  // the join probe decides whether to auto-navigate or show the form. The
  // join_trip probe stays authoritative over control flow; the preview only
  // ever fills in presentational context and never changes which phase we land
  // on (a real member still auto-navigates; a dead link still dead-ends).
  React.useEffect(() => {
    let cancelled = false
    async function check() {
      if (!code) return setPhase('invalid')
      try {
        await ensureSession()
        if (cancelled) return

        // Fire the preview request exactly once and reuse its resolved value.
        // Calling getInvitePreview once and memoising its promise runs the
        // request a single time (#215): it paints the context card the moment a
        // real trip resolves (even while the join probe is still in flight — a
        // failed or empty preview leaves the bare loader, so context never
        // appears for a link that isn't real) and hands the memoised value to
        // the form render.
        const previewPromise = getInvitePreview(code).then((p) => {
          if (p && !cancelled) {
            setPreview(p)
            // Default to a colour no member has taken yet (#234). This rides the
            // preview fetch already on the critical path — no extra round-trip —
            // and resolves before the form (and its picker) is ever shown, so a
            // later manual pick is never overwritten. Random among the free
            // colours, so two friends joining at once don't land on the same one.
            setColor(firstFreeMemberColor(p.taken_colors))
          }
          return p
        })
        const joinPromise = joinTrip({ code, displayName: '' })

        const { data: tripId, error } = await joinPromise
        if (cancelled) return
        if (!error && tripId) {
          navigate(`/trip/${tripId}`, { replace: true })
          return
        }
        if (error?.message.includes('NAME_REQUIRED')) {
          // Make sure the context is in place before the form (it may already
          // be, from the parallel fetch above). Reuses the single resolved
          // preview — no second network request.
          const p = await previewPromise
          if (cancelled) return
          setPreview((prev) => prev ?? p)
          setPhase('form')
          return
        }
        // A genuinely disabled/regenerated invite dead-ends; a transient
        // failure we must not blame on the link gets a retryable error state.
        setPhase(isInvalidInvite(error) ? 'invalid' : 'error')
      } catch {
        if (!cancelled) setPhase('error')
      }
    }
    check()
    return () => {
      cancelled = true
    }
  }, [code, ensureSession, navigate, retryNonce])

  function retry() {
    setPhase('checking')
    setRetryNonce((n) => n + 1)
  }

  async function join(e: React.FormEvent) {
    e.preventDefault()
    if (!name.trim() || !code) return
    setPhase('joining')
    const { data: tripId, error } = await joinTrip({
      code,
      displayName: name.trim(),
      color,
    })
    if (error || !tripId) {
      setPhase('form')
      toast.error(
        isInvalidInvite(error)
          ? 'This invite link no longer works — ask your friend for a fresh link.'
          : 'Couldn’t connect — check your connection and try again.'
      )
      return
    }
    toast.success(`Welcome aboard, ${name.trim()}!`)
    // They've just committed to the trip — the one moment to offer the install
    // that keeps their anonymous session from being evicted (#99). Flag it for
    // this session and tell the app-root nudge to show; it renders on the trip
    // page the navigate below lands on. Never blocks entry.
    signalTripJoined()
    navigate(`/trip/${tripId}`, { replace: true })
  }

  // While the join probe is still deciding, show the invite context the moment
  // the preview is known; fall back to the bare loader only until it resolves.
  if (phase === 'checking') {
    if (!preview) return <PageLoader />
    return (
      <InviteScaffold preview={preview}>
        <div
          className="flex items-center justify-center gap-2 py-2 text-sm text-muted"
          aria-live="polite"
        >
          <Spinner className="size-4" /> Getting you in…
        </div>
      </InviteScaffold>
    )
  }

  if (phase === 'invalid') {
    return (
      <div className="mx-auto max-w-md px-4 py-20">
        <EmptyState
          icon={Compass}
          title="This invite link doesn’t work"
          description="It may have been disabled or regenerated. Ask your friend for a fresh link."
          action={
            <Button asChild variant="secondary">
              <Link to="/">Go home</Link>
            </Button>
          }
        />
      </div>
    )
  }

  if (phase === 'error') {
    return (
      <div className="mx-auto max-w-md px-4 py-20">
        <ErrorState
          title="Couldn’t connect"
          description="We couldn’t reach the server to open this invite. Check your connection and try again — your link is fine."
          onRetry={retry}
        />
        <div className="mt-4 text-center">
          <Button asChild variant="ghost">
            <Link to="/">Go home</Link>
          </Button>
        </div>
      </div>
    )
  }

  return (
    <InviteScaffold preview={preview}>
      <form onSubmit={join} className="space-y-4">
        <div className="space-y-1.5">
          <Label htmlFor="join-name">What should we call you?</Label>
          <div className="flex items-center gap-3">
            <MemberAvatar name={name || '?'} color={color} size="md" />
            <Input
              id="join-name"
              autoFocus
              maxLength={40}
              placeholder="Your name"
              value={name}
              onChange={(e) => setName(e.target.value)}
            />
          </div>
        </div>

        <div className="space-y-1.5">
          <Label>Pick your color</Label>
          <div className="flex flex-wrap gap-1">
            {MEMBER_COLORS.map((c) => {
              // A colour another member already uses. We dim it as a hint but
              // never block the pick — a large group may have to reuse, and a
              // hard block would be a dead-end (#234).
              const taken = takenColors.includes(c)
              const selected = color === c
              return (
                <button
                  key={c}
                  type="button"
                  aria-label={`Choose color ${c}${taken ? ' (already taken)' : ''}`}
                  aria-pressed={selected}
                  onClick={() => setColor(c)}
                  // 44px tap target (mobile floor) around a smaller visible
                  // dot; the selection ring and focus ring live on the inner
                  // dot so the hit area stays invisible but reachable.
                  className="group flex size-11 cursor-pointer items-center justify-center rounded-full focus-visible:outline-none"
                >
                  <span
                    className={cn(
                      'size-8 rounded-full transition-transform group-hover:scale-110 group-focus-visible:ring-2 group-focus-visible:ring-ink group-focus-visible:ring-offset-2 group-focus-visible:ring-offset-surface',
                      // Dim a taken swatch unless it's the current pick, so the
                      // selected dot always reads at full strength.
                      taken && !selected && 'opacity-50',
                      selected && 'ring-2 ring-ink ring-offset-2 ring-offset-surface'
                    )}
                    style={{ backgroundColor: c }}
                  />
                </button>
              )
            })}
          </div>
          {takenColors.length > 0 && (
            <p className="text-xs text-muted" aria-live="polite">
              Dimmed colors are already taken.
            </p>
          )}
        </div>

        <Button
          type="submit"
          size="lg"
          className="w-full"
          disabled={!name.trim() || phase === 'joining'}
        >
          {phase === 'joining' ? 'Joining…' : 'Join the trip'}
        </Button>
        <p className="text-center text-xs text-muted">
          No account needed — you’ll stay signed in on this device.
        </p>
      </form>
    </InviteScaffold>
  )
}

/**
 * The invite-context card chrome — cover, "You're invited to [trip]", and the
 * trip's destination/dates/member-count meta — shared by the checking phase
 * (where the body is a "getting you in" loader) and the form phase (where the
 * body is the name/colour form). Renders only whitelisted preview fields; the
 * invite code is never shown or logged.
 */
function InviteScaffold({
  preview,
  children,
}: {
  preview: InvitePreview | null
  children: React.ReactNode
}) {
  return (
    <div className="gradient-travel-soft flex min-h-dvh items-center justify-center px-4 py-10">
      <motion.div
        initial={{ opacity: 0, y: 16 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.35, ease: 'easeOut' }}
        className="w-full max-w-md"
      >
        <Card className="overflow-hidden">
          <div className="relative h-32">
            {preview?.cover_url ? (
              <img src={preview.cover_url} alt="" className="h-full w-full object-cover" />
            ) : (
              <div className="gradient-travel h-full w-full" />
            )}
            <div className="absolute inset-x-0 bottom-0 bg-gradient-to-t from-black/60 to-transparent p-4 pt-10">
              <p className="flex items-center gap-1.5 text-xs font-medium text-white/80">
                <PartyPopper className="size-3.5" /> You’re invited to
              </p>
              <p className="font-display text-xl font-bold text-white">
                {preview?.trip_name ?? 'a trip'}
              </p>
            </div>
          </div>

          <div className="space-y-5 p-6">
            <div className="flex flex-wrap gap-x-4 gap-y-1 text-sm text-muted">
              {preview?.destination && (
                <span className="inline-flex items-center gap-1">
                  <MapPin className="size-3.5" /> {preview.destination}
                </span>
              )}
              {(preview?.start_date || preview?.end_date) && (
                <span className="inline-flex items-center gap-1">
                  <CalendarDays className="size-3.5" />
                  {dateRange(preview?.start_date ?? null, preview?.end_date ?? null)}
                </span>
              )}
              {preview && (
                <span className="inline-flex items-center gap-1">
                  <Users className="size-3.5" /> {preview.member_count}{' '}
                  {preview.member_count === 1 ? 'member' : 'members'}
                </span>
              )}
            </div>

            {children}
          </div>
        </Card>
      </motion.div>
    </div>
  )
}
