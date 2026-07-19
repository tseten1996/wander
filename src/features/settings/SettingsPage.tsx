import * as React from 'react'
import { useNavigate, Link } from 'react-router-dom'
import { useQueryClient } from '@tanstack/react-query'
import { useForm } from 'react-hook-form'
import { zodResolver } from '@hookform/resolvers/zod'
import { z } from 'zod'
import {
  Archive, ArchiveRestore, Check, Copy, Download, FileText, Link2, RefreshCw,
  Trash2, Upload, UserMinus, LogOut,
} from 'lucide-react'
import { toast } from 'sonner'
import { supabase } from '@/lib/supabase'
import { useTripContext } from '@/hooks/useTrip'
import { useAuth } from '@/hooks/useAuth'
import { exportTripJson, importTripJson } from '@/lib/export'
import { friendlyError } from '@/lib/errors'
import { MEMBER_COLORS } from '@/lib/colors'
import { cn, randomCode } from '@/lib/utils'
import { PageHeader } from '@/components/layout/PageHeader'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card'
import { Input, Textarea } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Switch } from '@/components/ui/switch'
import { Badge } from '@/components/ui/badge'
import { MemberAvatar } from '@/components/ui/avatar'
import {
  Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle,
} from '@/components/ui/dialog'

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
      .refine((v) => !v || /^https?:\/\/.+/i.test(v), { message: 'Must be a valid http(s) link' }),
    start_date: z.string().optional(),
    end_date: z.string().optional(),
    estimated_budget: z.coerce
      .number({ invalid_type_error: 'Enter a number' })
      .positive('Must be greater than zero')
      .optional()
      .or(z.literal('')),
    currency: z
      .string()
      .trim()
      .min(3, 'Use a 3-letter code (e.g. USD)')
      .max(3, 'Use a 3-letter code (e.g. USD)'),
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
      estimated_budget: trip.estimated_budget ?? '',
      currency: trip.currency,
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
        estimated_budget:
          values.estimated_budget === '' || values.estimated_budget == null
            ? null
            : Number(values.estimated_budget),
        currency: values.currency.trim().toUpperCase(),
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
        <CardDescription>Name, dates, cover photo and budget.</CardDescription>
      </CardHeader>
      <CardContent>
        <form onSubmit={form.handleSubmit(save)} className="space-y-4">
          <div className="grid gap-3 sm:grid-cols-2">
            <div className="space-y-1.5">
              <Label htmlFor="s-name">Trip name</Label>
              <Input id="s-name" {...form.register('name')} />
              {err.name && <p className="text-xs text-danger">{err.name.message}</p>}
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="s-dest">Destination</Label>
              <Input id="s-dest" {...form.register('destination')} />
              {err.destination && <p className="text-xs text-danger">{err.destination.message}</p>}
            </div>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="s-desc">Description</Label>
            <Textarea id="s-desc" className="min-h-16" {...form.register('description')} />
            {err.description && <p className="text-xs text-danger">{err.description.message}</p>}
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="s-cover">Cover photo URL</Label>
            <Input
              id="s-cover"
              type="url"
              placeholder="https://images.unsplash.com/…"
              {...form.register('cover_url')}
            />
            {err.cover_url && <p className="text-xs text-danger">{err.cover_url.message}</p>}
            <p className="text-xs text-faint">
              Tip: right-click any photo on the web and “Copy image address”.
            </p>
          </div>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-4">
            <div className="space-y-1.5">
              <Label htmlFor="s-start">Start</Label>
              <Input id="s-start" type="date" {...form.register('start_date')} />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="s-end">End</Label>
              <Input id="s-end" type="date" {...form.register('end_date')} />
              {err.end_date && <p className="text-xs text-danger">{err.end_date.message}</p>}
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="s-budget">Budget</Label>
              <Input id="s-budget" type="number" min="0" {...form.register('estimated_budget')} />
              {err.estimated_budget && (
                <p className="text-xs text-danger">{err.estimated_budget.message}</p>
              )}
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="s-currency">Currency</Label>
              <Input id="s-currency" maxLength={3} {...form.register('currency')} />
              {err.currency && <p className="text-xs text-danger">{err.currency.message}</p>}
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

/* ── Invite link ────────────────────────────────────────────────────────── */

function InviteCard() {
  const { trip, isOwner } = useTripContext()
  const queryClient = useQueryClient()
  const [copied, setCopied] = React.useState(false)

  const inviteUrl = `${window.location.origin}${window.location.pathname}#/join/${trip.invite_code}`

  async function copy() {
    await navigator.clipboard.writeText(inviteUrl)
    setCopied(true)
    setTimeout(() => setCopied(false), 1500)
    toast.success('Invite link copied')
  }

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

/* ── Members ────────────────────────────────────────────────────────────── */

function MembersCard() {
  const { trip, members, me, isOwner } = useTripContext()
  const { isAnonymous } = useAuth()
  const queryClient = useQueryClient()
  const navigate = useNavigate()

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
      </CardHeader>
      <CardContent className="space-y-1">
        {members.map((m) => (
          <div key={m.id} className="flex items-center gap-3 rounded-xl px-2 py-2 hover:bg-sunken/60">
            <MemberAvatar name={m.display_name} color={m.color} size="md" />
            <div className="min-w-0 flex-1">
              <p className="truncate text-sm font-medium">
                {m.display_name}
                {m.id === me.id && <span className="text-muted"> (you)</span>}
              </p>
            </div>
            {m.role === 'owner' ? (
              <Badge variant="primary">Owner</Badge>
            ) : (
              isOwner && (
                <Button
                  variant="ghost"
                  size="sm"
                  className="text-danger"
                  onClick={() => remove(m.id, m.display_name)}
                >
                  <UserMinus /> Remove
                </Button>
              )
            )}
          </div>
        ))}
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
    </Card>
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
  return (
    <div>
      <PageHeader title="Settings" description="Trip details, members and your profile." />
      <div className="space-y-5">
        {isOwner && <TripInfoCard />}
        <ProfileCard />
        <InviteCard />
        <MembersCard />
        <ExportCard />
        {isOwner && <DangerCard />}
      </div>
    </div>
  )
}
