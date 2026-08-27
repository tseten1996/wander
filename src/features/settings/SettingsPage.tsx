import * as React from 'react'
import { useNavigate, Link } from 'react-router-dom'
import { useQueryClient } from '@tanstack/react-query'
import { Controller, useForm } from 'react-hook-form'
import { zodResolver } from '@hookform/resolvers/zod'
import { z } from 'zod'
import {
  Archive, ArchiveRestore, CalendarClock, Check, Copy, CopyPlus, Download,
  FileText, GitMerge, Globe, Link2, RefreshCw, Sparkles, Trash2, Upload,
  UserMinus, LogOut,
} from 'lucide-react'
import { toast } from 'sonner'
import { supabase } from '@/lib/supabase'
import { useTripContext } from '@/hooks/useTrip'
import { useAuth } from '@/hooks/useAuth'
import { useTempUnit } from '@/hooks/useTempUnit'
import type { TempUnit } from '@/lib/units'
import { exportTripJson, importTripJson } from '@/lib/export'
import { friendlyError } from '@/lib/errors'
import { useInviteLink } from '@/lib/invite'
import { tripShareUrl, tripRecapUrl } from '@/lib/share'
import { MEMBER_COLORS } from '@/lib/colors'
import { cn, randomCode, shortDate } from '@/lib/utils'
import { PageHeader } from '@/components/layout/PageHeader'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card'
import { Input, Textarea } from '@/components/ui/input'
import { PlaceAutocomplete } from '@/components/ui/place-autocomplete'
import { DateInput } from '@/components/ui/date-picker'
import { MemberDatesForm } from '@/features/me/MemberDatesForm'
import { DestinationsCard } from '@/features/destinations/DestinationsCard'
import { TripPreferencesCard } from '@/features/preferences/TripPreferencesCard'
import { CoverPicker } from '@/features/trips/CoverPicker'
import { DuplicateTripDialog } from '@/features/trips/DuplicateTripDialog'
import { isPresetCover } from '@/features/trips/covers'
import { Label } from '@/components/ui/label'
import { Switch } from '@/components/ui/switch'
import { Badge } from '@/components/ui/badge'
import { MemberAvatar } from '@/components/ui/avatar'
import {
  Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle,
} from '@/components/ui/dialog'
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from '@/components/ui/select'
import type { Member } from '@/types'

/* ── Trip info (owner only) ─────────────────────────────────────────────── */

const tripInfoSchema = z
  .object({
    name: z.string().trim().min(1, 'Give the trip a name').max(80, 'Keep it under 80 characters'),
    destination: z.string().trim().max(120, 'Keep it under 120 characters').optional(),
    description: z.string().trim().max(2000, 'Keep it under 2000 characters').optional(),
    cover_url: z
      .string()
      .trim()
      .max(2000, 'That link is too long')
      .optional()
      .refine((v) => !v || /^https?:\/\/.+/i.test(v) || isPresetCover(v), {
        message: 'Must be a valid http(s) link',
      }),
    start_date: z.string().optional(),
    end_date: z.string().optional(),
  })
  .refine((v) => !v.start_date || !v.end_date || v.end_date >= v.start_date, {
    message: 'End date is before the start date',
    path: ['end_date'],
  })

type TripInfoFormValues = z.input<typeof tripInfoSchema>

function TripInfoCard() {
  const { trip } = useTripContext()
  const queryClient = useQueryClient()
  const form = useForm<TripInfoFormValues>({
    resolver: zodResolver(tripInfoSchema),
    defaultValues: {
      name: trip.name,
      destination: trip.destination ?? '',
      description: trip.description ?? '',
      cover_url: trip.cover_url ?? '',
      start_date: trip.start_date ?? '',
      end_date: trip.end_date ?? '',
    },
  })

  async function save(values: TripInfoFormValues) {
    const { error } = await supabase
      .from('trips')
      .update({
        name: values.name.trim(),
        destination: values.destination?.trim() || null,
        description: values.description?.trim() || null,
        cover_url: values.cover_url?.trim() || null,
        start_date: values.start_date || null,
        end_date: values.end_date || null,
      })
      .eq('id', trip.id)
    if (error) toast.error(friendlyError(error, 'Could not save the trip details'))
    else {
      toast.success('Trip updated')
      void queryClient.invalidateQueries({ queryKey: ['trip', trip.id] })
    }
  }

  const err = form.formState.errors

  return (
    <Card>
      <CardHeader>
        <CardTitle>Trip details</CardTitle>
        <CardDescription>Name, dates and cover photo.</CardDescription>
      </CardHeader>
      <CardContent>
        <form onSubmit={form.handleSubmit(save)} className="space-y-4">
          <div className="grid gap-3 sm:grid-cols-2">
            <div className="space-y-1.5">
              <Label htmlFor="s-name">Trip name</Label>
              <Input id="s-name" aria-invalid={err.name ? true : undefined} {...form.register('name')} />
              {err.name && <p className="text-xs text-danger">{err.name.message}</p>}
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="s-dest">Destination</Label>
              <Controller
                control={form.control}
                name="destination"
                render={({ field }) => (
                  <PlaceAutocomplete
                    id="s-dest"
                    aria-invalid={err.destination ? true : undefined}
                    value={field.value ?? ''}
                    onChange={field.onChange}
                    onBlur={field.onBlur}
                  />
                )}
              />
              {err.destination && <p className="text-xs text-danger">{err.destination.message}</p>}
            </div>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="s-desc">Description</Label>
            <Textarea
              id="s-desc"
              className="min-h-16"
              aria-invalid={err.description ? true : undefined}
              {...form.register('description')}
            />
            {err.description && <p className="text-xs text-danger">{err.description.message}</p>}
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="s-cover">Cover</Label>
            <Controller
              control={form.control}
              name="cover_url"
              render={({ field }) => (
                <CoverPicker
                  id="s-cover"
                  value={field.value ?? ''}
                  onChange={field.onChange}
                  aria-invalid={err.cover_url ? true : undefined}
                />
              )}
            />
            {err.cover_url && <p className="text-xs text-danger">{err.cover_url.message}</p>}
          </div>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <div className="space-y-1.5">
              <Label htmlFor="s-start">Start</Label>
              <Controller
                control={form.control}
                name="start_date"
                render={({ field }) => (
                  <DateInput
                    id="s-start"
                    value={field.value ?? ''}
                    onChange={field.onChange}
                    onBlur={field.onBlur}
                  />
                )}
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="s-end">End</Label>
              <Controller
                control={form.control}
                name="end_date"
                render={({ field }) => (
                  <DateInput
                    id="s-end"
                    value={field.value ?? ''}
                    onChange={field.onChange}
                    onBlur={field.onBlur}
                    aria-invalid={err.end_date ? true : undefined}
                  />
                )}
              />
              {err.end_date && <p className="text-xs text-danger">{err.end_date.message}</p>}
            </div>
          </div>
          <Button type="submit" disabled={form.formState.isSubmitting}>
            {form.formState.isSubmitting ? 'Saving…' : 'Save changes'}
          </Button>
        </form>
      </CardContent>
    </Card>
  )
}

/* ── My profile ─────────────────────────────────────────────────────────── */

function ProfileCard() {
  const { trip, me } = useTripContext()
  const queryClient = useQueryClient()
  const [name, setName] = React.useState(me.display_name)
  const [color, setColor] = React.useState(me.color)
  const [nameError, setNameError] = React.useState<string | null>(null)
  const [saving, setSaving] = React.useState(false)

  async function save() {
    const trimmed = name.trim()
    if (!trimmed) {
      setNameError('Give yourself a name')
      return
    }
    setNameError(null)
    setSaving(true)
    const { error } = await supabase
      .from('members')
      .update({ display_name: trimmed, color })
      .eq('id', me.id)
    setSaving(false)
    if (error) toast.error(friendlyError(error, 'Could not update your profile'))
    else {
      toast.success('Profile updated')
      void queryClient.invalidateQueries({ queryKey: ['members', trip.id] })
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>Your profile</CardTitle>
        <CardDescription>How you appear to the group in this trip.</CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="flex items-center gap-3">
          <MemberAvatar name={name || '?'} color={color} size="lg" />
          <div className="max-w-xs flex-1 space-y-1.5">
            <Input
              value={name}
              maxLength={40}
              aria-invalid={nameError ? true : undefined}
              onChange={(e) => {
                setName(e.target.value)
                if (nameError) setNameError(null)
              }}
            />
            {nameError && <p className="text-xs text-danger">{nameError}</p>}
          </div>
        </div>
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
        <Button onClick={save} disabled={saving}>
          {saving ? 'Saving…' : 'Save profile'}
        </Button>
      </CardContent>
    </Card>
  )
}

/* ── Device preferences (this device only) ──────────────────────────────── */

function PreferencesCard() {
  const { unit, setUnit } = useTempUnit()
  const options: { value: TempUnit; label: string }[] = [
    { value: 'C', label: '°C' },
    { value: 'F', label: '°F' },
  ]

  return (
    <Card>
      <CardHeader>
        <CardTitle>Preferences</CardTitle>
        <CardDescription>Display settings saved on this device only.</CardDescription>
      </CardHeader>
      <CardContent>
        <div className="flex items-center justify-between gap-4">
          <div className="min-w-0">
            <p className="text-sm font-medium">Temperature</p>
            <p className="text-xs text-muted">
              Units for the weather shown in the calendar, itinerary and packing tips.
            </p>
          </div>
          <div
            role="radiogroup"
            aria-label="Temperature unit"
            className="flex shrink-0 gap-1 rounded-xl bg-sunken p-1"
          >
            {options.map((o) => {
              const selected = unit === o.value
              return (
                <button
                  key={o.value}
                  type="button"
                  role="radio"
                  aria-checked={selected}
                  onClick={() => setUnit(o.value)}
                  className={cn(
                    'flex min-h-11 min-w-11 cursor-pointer items-center justify-center rounded-lg px-3 text-sm font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/50',
                    selected
                      ? 'bg-surface text-ink shadow-soft'
                      : 'text-muted hover:text-ink'
                  )}
                >
                  {o.label}
                </button>
              )
            })}
          </div>
        </div>
      </CardContent>
    </Card>
  )
}

/* ── Invite link ────────────────────────────────────────────────────────── */

function InviteCard() {
  const { trip, isOwner } = useTripContext()
  const queryClient = useQueryClient()
  const { url: inviteUrl, copied, copy } = useInviteLink(trip)

  async function regenerate() {
    const { error } = await supabase
      .from('trips')
      .update({ invite_code: randomCode() })
      .eq('id', trip.id)
    if (error) toast.error(friendlyError(error, 'Could not regenerate the invite link'))
    else {
      toast.success('New invite link generated — old links no longer work')
      void queryClient.invalidateQueries({ queryKey: ['trip', trip.id] })
    }
  }

  async function setEnabled(enabled: boolean) {
    const { error } = await supabase
      .from('trips')
      .update({ invite_enabled: enabled })
      .eq('id', trip.id)
    if (error) toast.error(friendlyError(error, 'Could not update invite settings'))
    else void queryClient.invalidateQueries({ queryKey: ['trip', trip.id] })
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Link2 className="size-4 text-primary" /> Invite friends
        </CardTitle>
        <CardDescription>
          Anyone with this link can join in seconds — no account needed.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        <div className="flex gap-2">
          <Input readOnly value={trip.invite_enabled ? inviteUrl : 'Invites are disabled'} className="font-mono text-xs" />
          <Button variant="secondary" size="icon" onClick={copy} disabled={!trip.invite_enabled} aria-label="Copy invite link">
            {copied ? <Check className="text-success" /> : <Copy />}
          </Button>
        </div>
        {isOwner && (
          <div className="flex flex-wrap items-center gap-4">
            <label className="flex cursor-pointer items-center gap-2 text-sm">
              <Switch checked={trip.invite_enabled} onCheckedChange={setEnabled} />
              Invite link active
            </label>
            <Button variant="ghost" size="sm" onClick={regenerate}>
              <RefreshCw /> Regenerate link
            </Button>
          </div>
        )}
      </CardContent>
    </Card>
  )
}

/* ── Public share link (owner only) ─────────────────────────────────────── */

function PublicShareCard() {
  const { trip } = useTripContext()
  const queryClient = useQueryClient()
  const [busy, setBusy] = React.useState(false)
  const [copied, setCopied] = React.useState(false)
  const copyTimer = React.useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  React.useEffect(() => () => clearTimeout(copyTimer.current), [])

  const shareUrl = tripShareUrl(trip)
  const enabled = !!trip.share_token

  async function setShare(next: boolean) {
    setBusy(true)
    const { error } = await supabase.rpc('set_trip_share', {
      p_trip_id: trip.id,
      p_enabled: next,
    })
    setBusy(false)
    if (error) {
      toast.error(friendlyError(error, 'Could not update the share link'))
      return
    }
    toast.success(next ? 'Public share link is on' : 'Public share link turned off — old links no longer work')
    void queryClient.invalidateQueries({ queryKey: ['trip', trip.id] })
  }

  async function copy() {
    if (!shareUrl) return
    try {
      await navigator.clipboard.writeText(shareUrl)
      setCopied(true)
      clearTimeout(copyTimer.current)
      copyTimer.current = setTimeout(() => setCopied(false), 1500)
      toast.success('Share link copied')
    } catch {
      toast.error('Could not copy the link — try again')
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Globe className="size-4 text-primary" /> Public share link
        </CardTitle>
        <CardDescription>
          Share a read-only view of the itinerary with someone who shouldn’t
          edit — a parent, a maybe-friend. They see the plan only; no chat, no
          edits, no way to join. Turning it off breaks the link instantly.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        <label className="flex cursor-pointer items-center gap-2 text-sm">
          <Switch
            checked={enabled}
            disabled={busy}
            onCheckedChange={setShare}
            aria-label="Read-only share link active"
          />
          Read-only share link active
        </label>
        {enabled && shareUrl && (
          <div className="flex gap-2">
            <Input readOnly value={shareUrl} className="font-mono text-xs" aria-label="Public share link" />
            <Button variant="secondary" size="icon" onClick={copy} aria-label="Copy share link">
              {copied ? <Check className="text-success" /> : <Copy />}
            </Button>
          </div>
        )}
      </CardContent>
    </Card>
  )
}

/* ── Public recap link (owner only) ─────────────────────────────────────── */

function RecapShareCard() {
  const { trip } = useTripContext()
  const queryClient = useQueryClient()
  const [busy, setBusy] = React.useState(false)
  const [copied, setCopied] = React.useState(false)
  const copyTimer = React.useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  React.useEffect(() => () => clearTimeout(copyTimer.current), [])

  const recapUrl = tripRecapUrl(trip)
  const enabled = trip.recap_shared

  async function setShare(next: boolean) {
    setBusy(true)
    const { error } = await supabase.rpc('set_trip_recap_share', {
      p_trip_id: trip.id,
      p_enabled: next,
    })
    setBusy(false)
    if (error) {
      toast.error(friendlyError(error, 'Could not update the recap link'))
      return
    }
    toast.success(next ? 'Public recap link is on' : 'Public recap link turned off')
    void queryClient.invalidateQueries({ queryKey: ['trip', trip.id] })
  }

  async function copy() {
    if (!recapUrl) return
    try {
      await navigator.clipboard.writeText(recapUrl)
      setCopied(true)
      clearTimeout(copyTimer.current)
      copyTimer.current = setTimeout(() => setCopied(false), 1500)
      toast.success('Recap link copied')
    } catch {
      toast.error('Could not copy the link — try again')
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Sparkles className="size-4 text-primary" /> Public recap link
        </CardTitle>
        <CardDescription>
          Share a read-only recap of your finished trip — the days, stops and
          places you went — with anyone, even friends who weren’t there. No
          budget figures, no chat, no member details. It goes live once the trip
          has ended.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        <label className="flex cursor-pointer items-center gap-2 text-sm">
          <Switch
            checked={enabled}
            disabled={busy}
            onCheckedChange={setShare}
            aria-label="Public recap link active"
          />
          Public recap link active
        </label>
        {enabled && recapUrl && (
          <div className="flex gap-2">
            <Input readOnly value={recapUrl} className="font-mono text-xs" aria-label="Public recap link" />
            <Button variant="secondary" size="icon" onClick={copy} aria-label="Copy recap link">
              {copied ? <Check className="text-success" /> : <Copy />}
            </Button>
          </div>
        )}
        {enabled && !recapUrl && (
          <p className="text-xs text-muted">
            Turn on the <span className="font-medium">public share link</span> above
            to activate the recap link — it reuses the same share token.
          </p>
        )}
      </CardContent>
    </Card>
  )
}

/* ── Members ────────────────────────────────────────────────────────────── */

/** Short "when this member is on the trip" label, or null when they're here the
 *  whole trip (no dates set) — #286. */
function memberDatesLabel(m: Member): string | null {
  if (m.arrives_on && m.departs_on) return `${shortDate(m.arrives_on)} – ${shortDate(m.departs_on)}`
  if (m.arrives_on) return `Arrives ${shortDate(m.arrives_on)}`
  if (m.departs_on) return `Leaves ${shortDate(m.departs_on)}`
  return null
}

function MembersCard() {
  const { trip, members, me, isOwner } = useTripContext()
  const { isAnonymous } = useAuth()
  const queryClient = useQueryClient()
  const navigate = useNavigate()
  // The member the owner is about to merge away (the stale duplicate). null =
  // dialog closed.
  const [mergeDup, setMergeDup] = React.useState<Member | null>(null)
  // The member whose trip dates the owner is editing inline. null = collapsed.
  const [editingDates, setEditingDates] = React.useState<string | null>(null)

  async function remove(memberId: string, name: string) {
    const { error } = await supabase.from('members').delete().eq('id', memberId)
    if (error) toast.error(friendlyError(error, 'Could not remove that member'))
    else {
      toast.success(`${name} removed from the trip`)
      void queryClient.invalidateQueries({ queryKey: ['members', trip.id] })
    }
  }

  async function leave() {
    const { error } = await supabase.from('members').delete().eq('id', me.id)
    if (error) toast.error(friendlyError(error, 'Could not leave the trip'))
    else navigate('/')
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>Members ({members.length})</CardTitle>
        {isOwner && members.length > 2 && (
          <CardDescription>
            If someone re-joined and appears twice, merge their duplicate into
            their real profile to move their messages, votes and lists across.
          </CardDescription>
        )}
      </CardHeader>
      <CardContent className="space-y-1">
        {members.map((m) => {
          const datesLabel = memberDatesLabel(m)
          const editing = editingDates === m.id
          return (
            <div key={m.id} className="rounded-xl px-2 py-2 hover:bg-sunken/60">
              <div className="flex items-center gap-3">
                <MemberAvatar name={m.display_name} color={m.color} size="md" />
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-medium">
                    {m.display_name}
                    {m.id === me.id && <span className="text-muted"> (you)</span>}
                  </p>
                  {datesLabel && (
                    <p className="truncate text-xs text-muted">{datesLabel}</p>
                  )}
                </div>
                <div className="flex shrink-0 items-center gap-1">
                  {isOwner && (
                    <Button
                      variant="ghost"
                      size="sm"
                      aria-expanded={editing}
                      onClick={() => setEditingDates(editing ? null : m.id)}
                    >
                      <CalendarClock /> Dates
                    </Button>
                  )}
                  {m.role === 'owner' ? (
                    <Badge variant="primary">Owner</Badge>
                  ) : (
                    isOwner && (
                      <>
                        {members.length > 2 && (
                          <Button variant="ghost" size="sm" onClick={() => setMergeDup(m)}>
                            <GitMerge /> Merge
                          </Button>
                        )}
                        <Button
                          variant="ghost"
                          size="sm"
                          className="text-danger"
                          onClick={() => remove(m.id, m.display_name)}
                        >
                          <UserMinus /> Remove
                        </Button>
                      </>
                    )
                  )}
                </div>
              </div>
              {isOwner && editing && (
                <div className="mt-3 border-t border-line pt-3">
                  <MemberDatesForm trip={trip} member={m} actorId={me.id} isSelf={m.id === me.id} />
                </div>
              )}
            </div>
          )
        })}
        {!isOwner && (
          <div className="pt-2">
            <Button variant="danger" size="sm" onClick={leave}>
              <LogOut /> Leave this trip
            </Button>
            {isAnonymous && (
              <p className="mt-2 text-xs text-faint">
                Heads up: without an account you can only rejoin with a fresh invite link.
              </p>
            )}
          </div>
        )}
      </CardContent>

      <MergeMemberDialog
        duplicate={mergeDup}
        candidates={members.filter((m) => m.id !== mergeDup?.id)}
        onOpenChange={(open) => !open && setMergeDup(null)}
      />
    </Card>
  )
}

/* ── Merge a duplicate member into a surviving one (owner only) ──────────── */

function MergeMemberDialog({
  duplicate,
  candidates,
  onOpenChange,
}: {
  duplicate: Member | null
  /** Every other member the duplicate could be merged into. */
  candidates: Member[]
  onOpenChange: (open: boolean) => void
}) {
  const { trip } = useTripContext()
  const queryClient = useQueryClient()
  const [survivorId, setSurvivorId] = React.useState('')
  const [merging, setMerging] = React.useState(false)

  // Reset the picked survivor whenever the dialog opens for a new duplicate.
  React.useEffect(() => {
    if (duplicate) setSurvivorId('')
  }, [duplicate])

  async function confirmMerge() {
    if (!duplicate || !survivorId) return
    const survivor = candidates.find((m) => m.id === survivorId)
    setMerging(true)
    const { error } = await supabase.rpc('merge_member', {
      p_trip_id: trip.id,
      p_duplicate: duplicate.id,
      p_survivor: survivorId,
    })
    setMerging(false)
    if (error) {
      toast.error(friendlyError(error, 'Could not merge those members'))
      return
    }
    toast.success(
      `${duplicate.display_name} merged into ${survivor?.display_name ?? 'the surviving member'}`
    )
    // The merge rewrote authorship across many tables (messages, votes,
    // checklist, itinerary, budget, activity…), so refresh everything rather
    // than guess every affected key — same blanket refresh as import.
    void queryClient.invalidateQueries()
    onOpenChange(false)
  }

  return (
    <Dialog open={!!duplicate} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Merge “{duplicate?.display_name}” into…</DialogTitle>
          <DialogDescription>
            Everything “{duplicate?.display_name}” posted — messages, votes,
            checklist, itinerary and budget entries — moves to the member you
            pick, then the duplicate is removed. This can’t be undone.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-3">
          <Label htmlFor="merge-survivor">Keep as</Label>
          <Select value={survivorId} onValueChange={setSurvivorId}>
            <SelectTrigger id="merge-survivor" aria-label="Surviving member">
              <SelectValue placeholder="Choose the member to keep" />
            </SelectTrigger>
            <SelectContent>
              {candidates.map((m) => (
                <SelectItem key={m.id} value={m.id}>
                  {m.display_name}
                  {m.role === 'owner' ? ' (owner)' : ''}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <div className="flex justify-end gap-2 pt-1">
            <Button variant="secondary" onClick={() => onOpenChange(false)} disabled={merging}>
              Cancel
            </Button>
            <Button onClick={confirmMerge} disabled={!survivorId || merging}>
              {merging ? 'Merging…' : 'Merge members'}
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  )
}

/* ── Export / import ────────────────────────────────────────────────────── */

function ExportCard() {
  const { trip, me, isOwner } = useTripContext()
  const queryClient = useQueryClient()
  const fileRef = React.useRef<HTMLInputElement>(null)
  const [busy, setBusy] = React.useState(false)

  async function doExport() {
    setBusy(true)
    try {
      await exportTripJson(trip.id, trip.name)
      toast.success('Export downloaded')
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Export failed')
    } finally {
      setBusy(false)
    }
  }

  async function doImport(file: File) {
    setBusy(true)
    try {
      const n = await importTripJson(trip.id, me.id, file)
      toast.success(`Imported ${n} items`)
      void queryClient.invalidateQueries()
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Import failed')
    } finally {
      setBusy(false)
      if (fileRef.current) fileRef.current.value = ''
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>Export & backup</CardTitle>
        <CardDescription>
          Print a beautiful trip summary, or move your data anywhere as JSON.
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-wrap gap-2">
        <Button variant="secondary" asChild>
          <Link to={`/trip/${trip.id}/print`}>
            <FileText /> Trip summary (PDF)
          </Link>
        </Button>
        <Button variant="secondary" onClick={doExport} disabled={busy}>
          <Download /> Export JSON
        </Button>
        {isOwner && (
          <>
            <Button variant="secondary" onClick={() => fileRef.current?.click()} disabled={busy}>
              <Upload /> Import JSON
            </Button>
            <input
              ref={fileRef}
              type="file"
              accept="application/json"
              className="hidden"
              onChange={(e) => {
                const f = e.target.files?.[0]
                if (f) void doImport(f)
              }}
            />
          </>
        )}
      </CardContent>
    </Card>
  )
}

/* ── Reuse this trip (duplicate) ────────────────────────────────────────── */

function ReuseCard() {
  const { trip } = useTripContext()
  const [open, setOpen] = React.useState(false)

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <CopyPlus className="size-4 text-primary" /> Reuse this trip
        </CardTitle>
        <CardDescription>
          Planning another trip with the same crew? Copy this one’s itinerary,
          lists and budget into a fresh trip you own — a head start instead of a
          blank slate.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <Button variant="secondary" onClick={() => setOpen(true)}>
          <CopyPlus /> Duplicate trip
        </Button>
      </CardContent>
      <DuplicateTripDialog trip={trip} open={open} onOpenChange={setOpen} />
    </Card>
  )
}

/* ── Danger zone (owner) ────────────────────────────────────────────────── */

function DangerCard() {
  const { trip } = useTripContext()
  const queryClient = useQueryClient()
  const navigate = useNavigate()
  const [confirmOpen, setConfirmOpen] = React.useState(false)
  const [confirmText, setConfirmText] = React.useState('')

  async function setArchived(archived: boolean) {
    const { error } = await supabase.from('trips').update({ archived }).eq('id', trip.id)
    if (error) toast.error(friendlyError(error, 'Could not update the trip'))
    else {
      toast.success(archived ? 'Trip archived' : 'Trip restored')
      void queryClient.invalidateQueries({ queryKey: ['trip', trip.id] })
    }
  }

  async function deleteTrip() {
    const { error } = await supabase.from('trips').delete().eq('id', trip.id)
    if (error) toast.error(friendlyError(error, 'Could not delete the trip'))
    else {
      toast.success('Trip deleted')
      navigate('/')
    }
  }

  return (
    <Card className="border-danger/30">
      <CardHeader>
        <CardTitle className="text-danger">Danger zone</CardTitle>
      </CardHeader>
      <CardContent className="flex flex-wrap gap-2">
        <Button variant="secondary" onClick={() => setArchived(!trip.archived)}>
          {trip.archived ? <ArchiveRestore /> : <Archive />}
          {trip.archived ? 'Unarchive trip' : 'Archive trip'}
        </Button>
        <Button variant="danger" onClick={() => setConfirmOpen(true)}>
          <Trash2 /> Delete trip
        </Button>
      </CardContent>

      <Dialog open={confirmOpen} onOpenChange={setConfirmOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Delete “{trip.name}”?</DialogTitle>
            <DialogDescription>
              This permanently deletes the trip for everyone — polls, messages,
              itinerary, everything. There is no undo.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-3">
            <Label htmlFor="confirm-name">Type the trip name to confirm</Label>
            <Input
              id="confirm-name"
              value={confirmText}
              onChange={(e) => setConfirmText(e.target.value)}
              placeholder={trip.name}
            />
            <Button
              variant="danger"
              className="w-full"
              disabled={confirmText !== trip.name}
              onClick={deleteTrip}
            >
              I understand — delete this trip
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    </Card>
  )
}

export default function SettingsPage() {
  const { isOwner } = useTripContext()
  const { isAnonymous } = useAuth()
  return (
    <div>
      <PageHeader title="Settings" description="Trip details, members and your profile." />
      <div className="space-y-5">
        {isOwner && <TripInfoCard />}
        {isOwner && <DestinationsCard />}
        {/* Group-owned travel preferences — editable by every member (#268). */}
        <TripPreferencesCard />
        <ProfileCard />
        <PreferencesCard />
        <InviteCard />
        {isOwner && <PublicShareCard />}
        {isOwner && <RecapShareCard />}
        <MembersCard />
        <ExportCard />
        {/* Duplicating creates a NEW trip owned by the caller; only real
            (non-anonymous) users can own trips, matching create-trip. */}
        {!isAnonymous && <ReuseCard />}
        {isOwner && <DangerCard />}
      </div>
    </div>
  )
}
