import * as React from 'react'
import { motion } from 'framer-motion'
import { Controller, useForm } from 'react-hook-form'
import { zodResolver } from '@hookform/resolvers/zod'
import { z } from 'zod'
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

const urlOrEmpty = z
  .string()
  .trim()
  .max(2000, 'That link is too long')
  .optional()
  .refine((v) => !v || /^https?:\/\/.+/i.test(v), { message: 'Must be a valid http(s) link' })

const ideaSchema = z
  .object({
    title: z.string().trim().max(120, 'Keep it under 120 characters').optional(),
    url: urlOrEmpty,
    image_url: urlOrEmpty,
    note: z.string().trim().max(500, 'Keep it under 500 characters').optional(),
    category: z.enum(['stay', 'food', 'activities', 'places', 'general']),
  })
  .refine((v) => v.title?.trim() || v.url?.trim() || v.image_url?.trim(), {
    message: 'Add a title, link or image',
    path: ['title'],
  })

type IdeaFormValues = z.input<typeof ideaSchema>

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
              className="size-9 shrink-0 text-danger transition-opacity md:size-7 md:opacity-0 md:group-hover:opacity-100"
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
  const emptyIdea: IdeaFormValues = { title: '', url: '', image_url: '', note: '', category: 'general' }
  const form = useForm<IdeaFormValues>({
    resolver: zodResolver(ideaSchema),
    defaultValues: emptyIdea,
  })

  const items = (inspiration.data ?? []).filter(
    (i) => filter === 'all' || i.category === filter
  )

  async function onSubmit(values: IdeaFormValues) {
    try {
      await createIdea.mutateAsync({
        title: values.title?.trim() || null,
        url: values.url?.trim() || null,
        image_url: values.image_url?.trim() || null,
        note: values.note?.trim() || null,
        category: values.category as InspirationCategory,
      })
      form.reset(emptyIdea)
      setNewOpen(false)
      toast.success('Pinned to the board')
    } catch {
      // toasted by the mutation's onError
    }
  }

  const err = form.formState.errors

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

      <Dialog
        open={newOpen}
        onOpenChange={(o) => {
          setNewOpen(o)
          if (!o) form.reset(emptyIdea)
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Pin an idea</DialogTitle>
          </DialogHeader>
          <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-4">
            <div className="space-y-1.5">
              <Label htmlFor="idea-title">Title</Label>
              <Input
                id="idea-title"
                placeholder="Rooftop izakaya"
                autoFocus
                {...form.register('title')}
              />
              {err.title && <p className="text-xs text-danger">{err.title.message}</p>}
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="idea-url">Link</Label>
              <Input id="idea-url" type="url" placeholder="https://…" {...form.register('url')} />
              {err.url && <p className="text-xs text-danger">{err.url.message}</p>}
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="idea-img">Image URL</Label>
              <Input
                id="idea-img"
                type="url"
                placeholder="https://…/photo.jpg"
                {...form.register('image_url')}
              />
              {err.image_url && <p className="text-xs text-danger">{err.image_url.message}</p>}
            </div>
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              <div className="space-y-1.5">
                <Label>Category</Label>
                <Controller
                  control={form.control}
                  name="category"
                  render={({ field }) => (
                    <Select value={field.value} onValueChange={field.onChange}>
                      <SelectTrigger><SelectValue /></SelectTrigger>
                      <SelectContent>
                        {CATEGORIES.filter((c) => c.value !== 'all').map((c) => (
                          <SelectItem key={c.value} value={c.value}>{c.label}</SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  )}
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="idea-note">Note</Label>
                <Input id="idea-note" placeholder="Why it's cool" {...form.register('note')} />
                {err.note && <p className="text-xs text-danger">{err.note.message}</p>}
              </div>
            </div>
            <Button type="submit" size="lg" className="w-full" disabled={createIdea.isPending}>
              Pin it
            </Button>
          </form>
        </DialogContent>
      </Dialog>
    </div>
  )
}
