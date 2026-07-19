import * as React from 'react'
import { useNavigate, useParams, Link } from 'react-router-dom'
import { motion } from 'framer-motion'
import { CalendarDays, Compass, MapPin, PartyPopper, Users } from 'lucide-react'
import { toast } from 'sonner'
import { supabase } from '@/lib/supabase'
import { useAuth } from '@/hooks/useAuth'
import { MEMBER_COLORS, randomMemberColor } from '@/lib/colors'
import { dateRange, cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { PageLoader, EmptyState } from '@/components/ui/misc'
import { MemberAvatar } from '@/components/ui/avatar'
import type { InvitePreview } from '@/types'

type Phase = 'checking' | 'form' | 'joining' | 'invalid'

export default function JoinPage() {
  const { code } = useParams<{ code: string }>()
  const navigate = useNavigate()
  const { ensureSession } = useAuth()

  const [phase, setPhase] = React.useState<Phase>('checking')
  const [preview, setPreview] = React.useState<InvitePreview | null>(null)
  const [name, setName] = React.useState('')
  const [color, setColor] = React.useState(() => randomMemberColor())

  // 1) Silently create/reuse a session. 2) If this device is already a member,
  // join_trip is idempotent and we go straight in. 3) Otherwise show the
  // 15-second name form alongside a preview of what you're joining.
  React.useEffect(() => {
    let cancelled = false
    async function check() {
      if (!code) return setPhase('invalid')
      try {
        await ensureSession()
        const { data: tripId, error } = await supabase.rpc('join_trip', {
          p_invite_code: code,
          p_display_name: '',
        })
        if (cancelled) return
        if (!error && tripId) {
          navigate(`/trip/${tripId}`, { replace: true })
          return
        }
        if (error?.message.includes('NAME_REQUIRED')) {
          const { data } = await supabase.rpc('get_invite_preview', { p_invite_code: code })
          if (cancelled) return
          setPreview((data?.[0] as InvitePreview) ?? null)
          setPhase('form')
          return
        }
        setPhase('invalid')
      } catch {
        if (!cancelled) setPhase('invalid')
      }
    }
    check()
    return () => {
      cancelled = true
    }
  }, [code, ensureSession, navigate])

  async function join(e: React.FormEvent) {
    e.preventDefault()
    if (!name.trim() || !code) return
    setPhase('joining')
    const { data: tripId, error } = await supabase.rpc('join_trip', {
      p_invite_code: code,
      p_display_name: name.trim(),
      p_color: color,
    })
    if (error || !tripId) {
      setPhase('form')
      toast.error('Could not join — the invite may have been disabled.')
      return
    }
    toast.success(`Welcome aboard, ${name.trim()}!`)
    navigate(`/trip/${tripId}`, { replace: true })
  }

  if (phase === 'checking') return <PageLoader />

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
                <div className="flex flex-wrap gap-2">
                  {MEMBER_COLORS.map((c) => (
                    <button
                      key={c}
                      type="button"
                      aria-label={`Choose color ${c}`}
                      onClick={() => setColor(c)}
                      className={cn(
                        'size-8 cursor-pointer rounded-full transition-transform hover:scale-110',
                        color === c && 'ring-2 ring-ink ring-offset-2 ring-offset-surface'
                      )}
                      style={{ backgroundColor: c }}
                    />
                  ))}
                </div>
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
          </div>
        </Card>
      </motion.div>
    </div>
  )
}
