import * as React from 'react'
import { motion } from 'framer-motion'
import { ExternalLink, Lightbulb, Plus, Trash2 } from 'lucide-react'
import { toast } from 'sonner'
import { useTripContext } from '@/hooks/useTrip'
import { useCreateInspiration, useDeleteInspiration, useInspiration } from './api'
import { PageHeader } from '@/components/layout/PageHeader'
import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { MemberAvatar } from '@/components/ui/avatar'
import { EmptyState, Skeleton } from '@/components/ui/misc'
import {
  Dialog, DialogContent, DialogHeader, DialogTitle,
} from '@/components/ui/dialog'
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from '@/components/ui/select'
import { cn } from '@/lib/utils'
import type { InspirationCategory, InspirationItem } from '@/types'

const CATEGORIES: { value: InspirationCategory | 'all'; label: string }[] = [
  { value: 'all', label: 'Everything' },
  { value: 'stay', label: 'Stays' },
  { value: 'food', label: 'Food' },
  { value: 'activities', label: 'Activities' },
  { value: 'places', label: 'Places' },
  { value: 'general', label: 'Other' },
]

function hostOf(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, '')
  } catch {
    return url
  }
}

function IdeaCard({ item }: { item: InspirationItem }) {
  const { trip, me, isOwner, membersById } = useTripContext()
  const deleteItem = useDeleteInspiration(trip.id)
  const author = item.created_by ? membersById.get(item.created_by) : null
  const canDelete = isOwner || item.created_by === me.id

  return (
    <Card className="group mb-4 break-inside-avoid overflow-hidden">
      {item.image_url && (
        <img
          src={item.image_url}
          alt={item.title ?? ''}
          loading="lazy"
          className="max-h-72 w-full object-cover"
          onError={(e) => {
            ;(e.target as HTMLImageElement).style.display = 'none'
          }}
        />
      )}
      <div className="p-4">
        <div className="flex items-start justify-between gap-2">
          <div className="min-w-0">
            {item.title && <p className="font-display text-sm font-semibold">{item.title}</p>}
            {item.url && (
              <a
                href={item.url}
                target="_blank"
                rel="noreferrer noopener"
                className="mt-0.5 inline-flex items-center gap-1 text-xs text-primary hover:underline"
              >
                <ExternalLink className="size-3" /> {hostOf(item.url)}
              </a>
            )}
          </div>
          {canDelete && (
            <Button
              variant="ghost"
              size="icon"
              className="size-7 shrink-0 text-danger opacity-0 transition-opacity group-hover:opacity-100"
              aria-label="Delete idea"
              onClick={() => {
                deleteItem.mutate(item.id)
                toast.success('Idea removed')
              }}
            >
              <Trash2 className="size-4" />
            </Button>
          )}
        </div>
        {item.note && <p className="mt-1.5 text-sm text-muted">{item.note}</p>}
        {author && (
          <p className="mt-2.5 flex items-center gap-1.5 text-xs text-faint">
            <MemberAvatar name={author.display_name} color={author.color} size="xs" />
            {author.display_name}
          </p>
        )}
      </div>
    </Card>
  )
}

export default function InspirationPage() {
  const { trip, me } = useTripContext()
  const inspiration = useInspiration(trip.id)
  const createIdea = useCreateInspiration(trip.id, me.id)

  const [filter, setFilter] = React.useState<InspirationCategory | 'all'>('all')
  const [newOpen, setNewOpen] = React.useState(false)
  const [form, setForm] = React.useState({
    title: '', url: '', image_url: '', note: '', category: 'general' as InspirationCategory,
  })

  const items = (inspiration.data ?? []).filter(
    (i) => filter === 'all' || i.category === filter
  )
  const valid = form.title.trim() || form.url.trim() || form.image_url.trim()

  async function submit(e: React.FormEvent) {
    e.preventDefault()
    if (!valid) return
    await createIdea.mutateAsync({
      title: form.title.trim() || null,
      url: form.url.trim() || null,
      image_url: form.image_url.trim() || null,
      note: form.note.trim() || null,
      category: form.category,
    })
    setForm({ title: '', url: '', image_url: '', note: '', category: 'general' })
    setNewOpen(false)
    toast.success('Pinned to the board')
  }

  return (
    <div>
      <PageHeader
        title="Ideas"
        description="A shared board for hotels, restaurants and things worth doing."
        action={
          <Button onClick={() => setNewOpen(true)}>
            <Plus /> Pin an idea
          </Button>
        }
      />

      <div className="no-print mb-5 flex flex-wrap gap-1.5">
        {CATEGORIES.map((c) => (
          <button
            key={c.value}
            type="button"
            onClick={() => setFilter(c.value)}
            className={cn(
              'cursor-pointer rounded-full px-3.5 py-1.5 text-sm font-medium transition-colors',
              filter === c.value
                ? 'bg-primary text-on-primary'
                : 'bg-sunken text-muted hover:text-ink'
            )}
          >
            {c.label}
          </button>
        ))}
      </div>

      {inspiration.isLoading ? (
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          <Skeleton className="h-56" />
          <Skeleton className="h-40" />
          <Skeleton className="h-48" />
        </div>
      ) : items.length === 0 ? (
        <EmptyState
          icon={Lightbulb}
          title={filter === 'all' ? 'The board is empty' : 'Nothing in this category'}
          description="Paste a link or an image URL — build a moodboard for the trip together."
          action={
            <Button onClick={() => setNewOpen(true)}>
              <Plus /> Pin the first idea
            </Button>
          }
        />
      ) : (
        <motion.div
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          className="columns-1 gap-4 sm:columns-2 lg:columns-3"
        >
          {items.map((item) => (
            <IdeaCard key={item.id} item={item} />
          ))}
        </motion.div>
      )}

      <Dialog open={newOpen} onOpenChange={setNewOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Pin an idea</DialogTitle>
          </DialogHeader>
          <form onSubmit={submit} className="space-y-4">
            <div className="space-y-1.5">
              <Label htmlFor="idea-title">Title</Label>
              <Input
                id="idea-title"
                placeholder="Rooftop izakaya"
                value={form.title}
                onChange={(e) => setForm((f) => ({ ...f, title: e.target.value }))}
                autoFocus
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="idea-url">Link</Label>
              <Input
                id="idea-url"
                type="url"
                placeholder="https://…"
                value={form.url}
                onChange={(e) => setForm((f) => ({ ...f, url: e.target.value }))}
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="idea-img">Image URL</Label>
              <Input
                id="idea-img"
                type="url"
                placeholder="https://…/photo.jpg"
                value={form.image_url}
                onChange={(e) => setForm((f) => ({ ...f, image_url: e.target.value }))}
              />
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1.5">
                <Label>Category</Label>
                <Select
                  value={form.category}
                  onValueChange={(v) => setForm((f) => ({ ...f, category: v as InspirationCategory }))}
                >
                  <SelectTrigger><SelectValue /></SelectTrigger>
                  <SelectContent>
                    {CATEGORIES.filter((c) => c.value !== 'all').map((c) => (
                      <SelectItem key={c.value} value={c.value}>{c.label}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="idea-note">Note</Label>
                <Input
                  id="idea-note"
                  placeholder="Why it's cool"
                  value={form.note}
                  onChange={(e) => setForm((f) => ({ ...f, note: e.target.value }))}
                />
              </div>
            </div>
            <Button type="submit" size="lg" className="w-full" disabled={!valid || createIdea.isPending}>
              Pin it
            </Button>
          </form>
        </DialogContent>
      </Dialog>
    </div>
  )
}
