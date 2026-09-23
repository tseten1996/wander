import * as React from 'react'
import { Controller, useForm } from 'react-hook-form'
import { zodResolver } from '@hookform/resolvers/zod'
import { z } from 'zod'
import { ExternalLink, Heart, MapPin, Pencil, Plus, Trash2 } from 'lucide-react'
import { toast } from 'sonner'
import { useTripContext } from '@/hooks/useTrip'
import {
  useCreateWishlistItem, useDeleteWishlistItem, useUpdateWishlistItem, useWishlist,
  type WishlistInput,
} from './api'
import { safeHttpUrl } from '@/features/stays/StaysCard'
import { Badge, type BadgeProps } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card'
import { Input, Textarea } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { MemberAvatar } from '@/components/ui/avatar'
import { Skeleton, ErrorState } from '@/components/ui/misc'
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from '@/components/ui/select'
import {
  Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle,
} from '@/components/ui/dialog'
import { cn } from '@/lib/utils'
import type { WishlistCategory, WishlistItem } from '@/types'

/** The four wishlist buckets, in display order — slice 1's POI categories plus
 *  `other` for a hand-added place. Labels match the map's `POI_CATEGORY_LABEL`
 *  (colour alone never carries meaning — the word is always shown). */
const CATEGORIES: WishlistCategory[] = ['eat', 'see', 'drink', 'other']
const CATEGORY_LABEL: Record<WishlistCategory, string> = {
  eat: 'Food',
  see: 'Sight',
  drink: 'Drinks',
  other: 'Other',
}
const CATEGORY_BADGE: Record<WishlistCategory, BadgeProps['variant']> = {
  eat: 'primary',
  see: 'accent',
  drink: 'success',
  other: 'neutral',
}

const wishlistSchema = z.object({
  name: z.string().trim().min(1, 'Give it a name').max(120, 'Keep it under 120 characters'),
  category: z.enum(['eat', 'see', 'drink', 'other']),
  note: z.string().trim().max(500, 'Keep it under 500 characters').optional(),
  url: z
    .string()
    .trim()
    .max(2000, 'That link is too long')
    .optional()
    .refine((v) => !v || safeHttpUrl(v) !== null, {
      message: 'Enter a full http(s) link, or leave it blank',
    }),
})

type WishlistFormValues = z.input<typeof wishlistSchema>

const EMPTY: WishlistFormValues = { name: '', category: 'other', note: '', url: '' }

/** Add / edit one saved place by hand — name + category, with an optional note
 *  and link. No coordinate: a hand-added place keeps its name with no pin (the
 *  map "Save to wishlist" path is what carries coordinates). */
function WishlistDialog({
  open, onOpenChange, item,
}: {
  open: boolean
  onOpenChange: (o: boolean) => void
  item?: WishlistItem
}) {
  const { trip, me } = useTripContext()
  const create = useCreateWishlistItem(trip.id, me.id)
  const update = useUpdateWishlistItem(trip.id, me.id)

  const form = useForm<WishlistFormValues>({
    resolver: zodResolver(wishlistSchema),
    defaultValues: EMPTY,
  })

  React.useEffect(() => {
    if (!open) return
    form.reset(
      item
        ? {
            name: item.name,
            category: item.category ?? 'other',
            note: item.note ?? '',
            url: item.url ?? '',
          }
        : EMPTY
    )
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, item])

  async function onSubmit(values: WishlistFormValues) {
    const payload: WishlistInput = {
      name: values.name.trim(),
      category: values.category,
      note: values.note?.trim() || null,
      // Store only a sanitized http(s) link (or null); the schema already
      // rejected anything else, this is the defensive normalisation on save.
      url: safeHttpUrl(values.url),
    }
    try {
      if (item) {
        // A hand-edit keeps whatever pin a map-saved place already carries — the
        // form never touches latitude/longitude — so editing the note never
        // strands the coordinate.
        await update.mutateAsync({ id: item.id, ...payload })
      } else {
        await create.mutateAsync(payload)
      }
      onOpenChange(false)
    } catch {
      // toasted by the mutation's onError
    }
  }

  const err = form.formState.errors

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{item ? 'Edit saved place' : 'Save a place'}</DialogTitle>
          <DialogDescription>
            A place the group wants to go but hasn’t slotted onto a day yet —
            park it here so it doesn’t get lost in the chat.
          </DialogDescription>
        </DialogHeader>
        <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-4">
          <div className="space-y-1.5">
            <Label htmlFor="wishlist-name">Name</Label>
            <Controller
              control={form.control}
              name="name"
              render={({ field }) => (
                <Input
                  id="wishlist-name"
                  placeholder="Blue Bottle Coffee"
                  aria-invalid={err.name ? true : undefined}
                  value={field.value ?? ''}
                  onChange={field.onChange}
                  onBlur={field.onBlur}
                />
              )}
            />
            {err.name && <p className="text-xs text-danger">{err.name.message}</p>}
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="wishlist-category">Category</Label>
            <Controller
              control={form.control}
              name="category"
              render={({ field }) => (
                <Select value={field.value} onValueChange={field.onChange}>
                  <SelectTrigger id="wishlist-category">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {CATEGORIES.map((c) => (
                      <SelectItem key={c} value={c}>
                        {CATEGORY_LABEL[c]}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              )}
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="wishlist-note">Note</Label>
            <Controller
              control={form.control}
              name="note"
              render={({ field }) => (
                <Textarea
                  id="wishlist-note"
                  rows={2}
                  placeholder="Open late — worth a detour"
                  value={field.value ?? ''}
                  onChange={field.onChange}
                  onBlur={field.onBlur}
                />
              )}
            />
            {err.note && <p className="text-xs text-danger">{err.note.message}</p>}
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="wishlist-url">Link</Label>
            <Controller
              control={form.control}
              name="url"
              render={({ field }) => (
                <Input
                  id="wishlist-url"
                  type="url"
                  inputMode="url"
                  placeholder="https://…"
                  aria-invalid={err.url ? true : undefined}
                  value={field.value ?? ''}
                  onChange={field.onChange}
                  onBlur={field.onBlur}
                />
              )}
            />
            {err.url && <p className="text-xs text-danger">{err.url.message}</p>}
          </div>
          <Button type="submit" size="lg" className="w-full" disabled={form.formState.isSubmitting}>
            {item ? 'Save place' : 'Save to wishlist'}
          </Button>
        </form>
      </DialogContent>
    </Dialog>
  )
}

/** Sanitized external link chip. */
function LinkChip({ url }: { url: string }) {
  return (
    <a
      href={url}
      target="_blank"
      rel="noreferrer noopener"
      className="inline-flex max-w-full items-center gap-1.5 rounded-full border border-line bg-surface px-2.5 py-1 text-xs text-muted transition-colors hover:border-line-strong hover:text-ink"
    >
      <ExternalLink className="size-3.5 shrink-0" aria-hidden />
      <span className="truncate">Link</span>
    </a>
  )
}

const ALL = 'all' as const
type Filter = typeof ALL | WishlistCategory

/** The trip's wishlist: a shared shelf of saved-but-unscheduled places (#355,
 *  epic #164 slice 2). Any member saves one — from the map's "Nearby" preview or
 *  by hand; the author or the trip owner can edit or remove it, matching the RLS
 *  on the table (the client is UX; Postgres is the boundary). Scheduling a place
 *  onto a day is deferred to slice 3. */
export function WishlistCard() {
  const { trip, me, isOwner, membersById } = useTripContext()
  const query = useWishlist(trip.id)
  const remove = useDeleteWishlistItem(trip.id, me.id)
  const [addOpen, setAddOpen] = React.useState(false)
  const [editing, setEditing] = React.useState<WishlistItem | null>(null)
  const [filter, setFilter] = React.useState<Filter>(ALL)

  const items = query.data ?? []
  // Only offer filters that have something behind them (an `other`-less shelf
  // never shows an empty Other chip). "All" is always present when > 1 category.
  const presentCategories = React.useMemo(
    () => CATEGORIES.filter((c) => items.some((i) => (i.category ?? 'other') === c)),
    [items]
  )
  const shown = filter === ALL ? items : items.filter((i) => (i.category ?? 'other') === filter)

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Heart className="size-4 text-primary" /> Wishlist
        </CardTitle>
        <CardDescription>
          Places the group wants to go but hasn’t scheduled yet — save the good
          ones here so a “maybe” never gets lost in the chat. Add one by hand, or
          use <span className="font-medium">Save to wishlist</span> on a spot you
          find on the map.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        {query.isLoading ? (
          <Skeleton className="h-16" />
        ) : query.isError ? (
          <ErrorState onRetry={() => query.refetch()} isRetrying={query.isFetching} />
        ) : (
          <>
            {presentCategories.length > 1 && (
              <div className="flex flex-wrap gap-1.5" role="group" aria-label="Filter by category">
                {([ALL, ...presentCategories] as Filter[]).map((c) => {
                  const active = filter === c
                  return (
                    <button
                      key={c}
                      type="button"
                      onClick={() => setFilter(c)}
                      aria-pressed={active}
                      className={cn(
                        'rounded-full border px-3 py-1 text-xs font-medium transition-colors',
                        active
                          ? 'border-primary bg-primary-faint text-primary'
                          : 'border-line text-muted hover:border-line-strong hover:text-ink'
                      )}
                    >
                      {c === ALL ? 'All' : CATEGORY_LABEL[c]}
                    </button>
                  )
                })}
              </div>
            )}
            {shown.length > 0 && (
              <ul className="space-y-2">
                {shown.map((item) => {
                  const canManage = isOwner || item.added_by === me.id
                  const author = item.added_by ? membersById.get(item.added_by) : undefined
                  const url = safeHttpUrl(item.url)
                  const category = item.category ?? 'other'
                  return (
                    <li
                      key={item.id}
                      className="flex items-start gap-3 rounded-xl border border-line bg-sunken/40 px-3 py-2"
                    >
                      <div className="min-w-0 flex-1">
                        <div className="flex flex-wrap items-center gap-2">
                          <p className="min-w-0 break-words text-sm font-medium">{item.name}</p>
                          <Badge variant={CATEGORY_BADGE[category]}>{CATEGORY_LABEL[category]}</Badge>
                        </div>
                        {item.note && (
                          <p className="mt-0.5 break-words text-xs text-muted">{item.note}</p>
                        )}
                        {(item.latitude != null && item.longitude != null) && (
                          <p className="mt-0.5 flex items-center gap-1 text-xs text-faint">
                            <MapPin className="size-3 shrink-0" aria-hidden />
                            <span>Saved from the map</span>
                          </p>
                        )}
                        <div className="mt-1.5 flex flex-wrap items-center gap-2">
                          {url && <LinkChip url={url} />}
                          {author && (
                            <span className="inline-flex items-center gap-1.5 text-xs text-muted">
                              <MemberAvatar name={author.display_name} color={author.color} size="xs" />
                              <span className="truncate">{author.display_name}</span>
                            </span>
                          )}
                        </div>
                      </div>
                      {canManage && (
                        <div className="flex shrink-0 items-center gap-0.5">
                          <Button
                            variant="ghost"
                            size="icon"
                            onClick={() => setEditing(item)}
                            aria-label={`Edit ${item.name}`}
                          >
                            <Pencil />
                          </Button>
                          <Button
                            variant="ghost"
                            size="icon"
                            className="text-danger"
                            onClick={() =>
                              remove.mutate(item, {
                                onSuccess: () => toast.success(`Removed ${item.name}`),
                              })
                            }
                            aria-label={`Remove ${item.name}`}
                          >
                            <Trash2 />
                          </Button>
                        </div>
                      )}
                    </li>
                  )
                })}
              </ul>
            )}
            {items.length === 0 && (
              <p className="text-sm text-muted">
                Nothing saved yet. When someone spots a place worth remembering,
                save it here — then slot it onto a day when the plan firms up.
              </p>
            )}
            {items.length > 0 && shown.length === 0 && (
              <p className="text-sm text-muted">No saved places in this category.</p>
            )}
            <Button variant="secondary" onClick={() => setAddOpen(true)}>
              <Plus /> Save a place
            </Button>
          </>
        )}
      </CardContent>

      <WishlistDialog open={addOpen} onOpenChange={setAddOpen} />
      <WishlistDialog
        open={editing !== null}
        onOpenChange={(o) => !o && setEditing(null)}
        item={editing ?? undefined}
      />
    </Card>
  )
}
