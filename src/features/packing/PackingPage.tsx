import * as React from 'react'
import { motion } from 'framer-motion'
import {
  FileText, Luggage, Plus, Shirt, Smartphone, Sparkles, X, type LucideIcon,
} from 'lucide-react'
import { useTripContext } from '@/hooks/useTrip'
import {
  useAddPackingItem, useDeletePackingItem, usePacking, useTogglePacked,
} from './api'
import { PageHeader } from '@/components/layout/PageHeader'
import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'
import { Checkbox } from '@/components/ui/checkbox'
import { Input } from '@/components/ui/input'
import { Progress } from '@/components/ui/progress'
import { Skeleton } from '@/components/ui/misc'
import { cn } from '@/lib/utils'
import type { PackingCategory, PackingItem } from '@/types'

const CATEGORIES: { value: PackingCategory; label: string; icon: LucideIcon }[] = [
  { value: 'clothes', label: 'Clothes', icon: Shirt },
  { value: 'toiletries', label: 'Toiletries', icon: Sparkles },
  { value: 'electronics', label: 'Electronics', icon: Smartphone },
  { value: 'documents', label: 'Documents', icon: FileText },
  { value: 'misc', label: 'Miscellaneous', icon: Luggage },
]

function CategorySection({
  category,
  items,
  index,
}: {
  category: (typeof CATEGORIES)[number]
  items: PackingItem[]
  index: number
}) {
  const { trip, me, isOwner } = useTripContext()
  const addItem = useAddPackingItem(trip.id, me.id)
  const togglePacked = useTogglePacked(trip.id)
  const deleteItem = useDeletePackingItem(trip.id)
  const [draft, setDraft] = React.useState('')

  const packed = items.filter((i) => i.packed).length

  async function add(e: React.FormEvent) {
    e.preventDefault()
    const name = draft.trim()
    if (!name) return
    setDraft('')
    await addItem.mutateAsync({ name, category: category.value })
  }

  return (
    <motion.div
      initial={{ opacity: 0, y: 10 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.25, delay: index * 0.05 }}
    >
      <Card className="p-4">
        <div className="flex items-center gap-2.5">
          <span className="flex size-8 items-center justify-center rounded-lg bg-primary-faint text-primary">
            <category.icon className="size-4" />
          </span>
          <h2 className="font-display font-semibold">{category.label}</h2>
          {items.length > 0 && (
            <span className="ml-auto text-xs tabular-nums text-muted">
              {packed}/{items.length}
            </span>
          )}
        </div>
        {items.length > 0 && (
          <Progress
            value={(packed / items.length) * 100}
            className="mt-2.5 h-1.5"
            label={`${category.label} packed`}
          />
        )}

        <div className="mt-3 space-y-0.5">
          {items.map((item) => {
            const canDelete = isOwner || item.added_by === me.id
            return (
              <div
                key={item.id}
                className="group flex items-center gap-2.5 rounded-lg px-1.5 py-1.5 transition-colors hover:bg-sunken/60"
              >
                <Checkbox
                  checked={item.packed}
                  onCheckedChange={() => togglePacked.mutate(item)}
                  aria-label={`Mark ${item.name} ${item.packed ? 'unpacked' : 'packed'}`}
                />
                <span
                  className={cn(
                    'flex-1 text-sm',
                    item.packed && 'text-faint line-through'
                  )}
                >
                  {item.name}
                </span>
                {canDelete && (
                  <button
                    type="button"
                    onClick={() => deleteItem.mutate(item.id)}
                    className="cursor-pointer text-faint opacity-0 transition-opacity hover:text-danger group-hover:opacity-100"
                    aria-label={`Delete ${item.name}`}
                  >
                    <X className="size-4" />
                  </button>
                )}
              </div>
            )
          })}
        </div>

        <form onSubmit={add} className="mt-2 flex gap-2">
          <Input
            placeholder={`Add to ${category.label.toLowerCase()}…`}
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            className="h-9 text-sm"
          />
          <Button type="submit" size="icon" variant="soft" disabled={!draft.trim()} aria-label="Add item">
            <Plus />
          </Button>
        </form>
      </Card>
    </motion.div>
  )
}

export default function PackingPage() {
  const { trip } = useTripContext()
  const packing = usePacking(trip.id)

  const items = packing.data ?? []
  const packed = items.filter((i) => i.packed).length

  return (
    <div>
      <PageHeader
        title="Packing"
        description={
          items.length > 0
            ? `${packed} of ${items.length} items packed — ${
                packed === items.length ? 'ready to go! 🧳' : 'keep going.'
              }`
            : 'A shared list so nobody forgets the adapter.'
        }
      />
      {packing.isLoading ? (
        <div className="grid gap-4 md:grid-cols-2">
          <Skeleton className="h-48" />
          <Skeleton className="h-48" />
        </div>
      ) : (
        <div className="grid items-start gap-4 md:grid-cols-2">
          {CATEGORIES.map((c, i) => (
            <CategorySection
              key={c.value}
              category={c}
              items={items.filter((item) => item.category === c.value)}
              index={i}
            />
          ))}
        </div>
      )}
    </div>
  )
}
