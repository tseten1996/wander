import * as React from 'react'
import { motion } from 'framer-motion'
import { Controller, useForm } from 'react-hook-form'
import { zodResolver } from '@hookform/resolvers/zod'
import { z } from 'zod'
import { CalendarClock, ListChecks, MoreHorizontal, Pencil, Plus, Trash2 } from 'lucide-react'
import { toast } from 'sonner'
import { useTripContext } from '@/hooks/useTrip'
import {
  useChecklist, useCreateChecklistItem, useDeleteChecklistItem, useToggleDone,
  useUpdateChecklistItem,
} from './api'
import { PageHeader } from '@/components/layout/PageHeader'
import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'
import { Checkbox } from '@/components/ui/checkbox'
import { Input, Textarea } from '@/components/ui/input'
import { DateInput } from '@/components/ui/date-picker'
import { Label } from '@/components/ui/label'
import { Badge } from '@/components/ui/badge'
import { Progress } from '@/components/ui/progress'
import { MemberAvatar } from '@/components/ui/avatar'
import { EmptyState, ErrorState, Skeleton } from '@/components/ui/misc'
import {
  Dialog, DialogContent, DialogHeader, DialogTitle,
} from '@/components/ui/dialog'
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from '@/components/ui/select'
import { searchAnchorId } from '@/features/search/anchor'
import { cn, daysUntil, isMobileViewport, shortDate } from '@/lib/utils'
import type { ChecklistItem } from '@/types'

const UNASSIGNED = 'unassigned'

const checklistSchema = z.object({
  title: z.string().trim().min(1, 'Give it a title').max(200, 'Keep it under 200 characters'),
  assignee_id: z.string(),
  due_date: z.string().optional().nullable(),
  notes: z.string().trim().max(2000, 'Keep it under 2000 characters').optional().nullable(),
})

type ChecklistFormValues = z.input<typeof checklistSchema>

function ItemRow({ item, index }: { item: ChecklistItem; index: number }) {
  const { trip, me, isOwner, membersById } = useTripContext()
  const toggleDone = useToggleDone(trip.id, me.id)
  const deleteItem = useDeleteChecklistItem(trip.id)
  const [editOpen, setEditOpen] = React.useState(false)

  const assignee = item.assignee_id ? membersById.get(item.assignee_id) : null
  const overdue = !item.done && item.due_date && daysUntil(item.due_date) < 0
  const dueSoon = !item.done && item.due_date && !overdue && daysUntil(item.due_date) <= 3
  const canDelete = isOwner || item.created_by === me.id

  return (
    <motion.div
      layout
      id={searchAnchorId(item.id)}
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.2, delay: Math.min(index * 0.03, 0.25) }}
      className="group flex items-start gap-3 rounded-xl px-3 py-2.5 transition-colors hover:bg-sunken/60"
    >
      <Checkbox
        checked={item.done}
        onCheckedChange={() => toggleDone.mutate(item)}
        aria-label={`Mark "${item.title}" ${item.done ? 'not done' : 'done'}`}
        className="mt-0.5"
      />
      <div className="min-w-0 flex-1">
        <p className={cn('text-sm font-medium', item.done && 'text-faint line-through')}>
          {item.title}
        </p>
        {item.notes && <p className="mt-0.5 text-xs text-muted">{item.notes}</p>}
        <div className="mt-1 flex flex-wrap items-center gap-1.5">
          {item.due_date && (
            <Badge variant={overdue ? 'danger' : dueSoon ? 'accent' : 'neutral'}>
              <CalendarClock /> {shortDate(item.due_date)}
              {overdue && ' · overdue'}
            </Badge>
          )}
        </div>
      </div>
      {assignee && (
        <MemberAvatar name={assignee.display_name} color={assignee.color} size="sm" className="mt-0.5" />
      )}
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button
            variant="ghost"
            size="icon"
            className="transition-opacity md:opacity-0 md:group-hover:opacity-100 md:data-[state=open]:opacity-100"
            aria-label="Task actions"
          >
            <MoreHorizontal />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          <DropdownMenuItem onClick={() => setEditOpen(true)}>
            <Pencil /> Edit
          </DropdownMenuItem>
          {canDelete && (
            <DropdownMenuItem
              destructive
              onClick={() => {
                deleteItem.mutate(item.id)
                toast.success('Task deleted')
              }}
            >
              <Trash2 /> Delete
            </DropdownMenuItem>
          )}
        </DropdownMenuContent>
      </DropdownMenu>
      <ItemDialog open={editOpen} onOpenChange={setEditOpen} item={item} />
    </motion.div>
  )
}

function ItemDialog({
  open,
  onOpenChange,
  item,
}: {
  open: boolean
  onOpenChange: (o: boolean) => void
  item?: ChecklistItem
}) {
  const { trip, me, members } = useTripContext()
  const createItem = useCreateChecklistItem(trip.id, me.id)
  const updateItem = useUpdateChecklistItem(trip.id)

  const empty: ChecklistFormValues = {
    title: '',
    assignee_id: UNASSIGNED,
    due_date: '',
    notes: '',
  }
  const form = useForm<ChecklistFormValues>({
    resolver: zodResolver(checklistSchema),
    defaultValues: empty,
  })

  React.useEffect(() => {
    if (open) {
      form.reset(
        item
          ? {
              title: item.title,
              assignee_id: item.assignee_id ?? UNASSIGNED,
              due_date: item.due_date ?? '',
              notes: item.notes ?? '',
            }
          : empty
      )
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, item])

  async function onSubmit(values: ChecklistFormValues) {
    const payload = {
      title: values.title.trim(),
      notes: values.notes?.trim() || null,
      assignee_id: values.assignee_id === UNASSIGNED ? null : values.assignee_id,
      due_date: values.due_date || null,
    }
    try {
      if (item) await updateItem.mutateAsync({ id: item.id, ...payload })
      else await createItem.mutateAsync(payload)
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
          <DialogTitle>{item ? 'Edit task' : 'New task'}</DialogTitle>
        </DialogHeader>
        <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-4">
          <div className="space-y-1.5">
            <Label htmlFor="task-title">Task</Label>
            <Input
              id="task-title"
              placeholder="Book flights"
              autoFocus={!item && !isMobileViewport()}
              {...form.register('title')}
            />
            {err.title && <p className="text-xs text-danger">{err.title.message}</p>}
          </div>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <div className="space-y-1.5">
              <Label>Assign to</Label>
              <Controller
                control={form.control}
                name="assignee_id"
                render={({ field }) => (
                  <Select value={field.value} onValueChange={field.onChange}>
                    <SelectTrigger>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value={UNASSIGNED}>Anyone</SelectItem>
                      {members.map((m) => (
                        <SelectItem key={m.id} value={m.id}>
                          {m.display_name}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                )}
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="task-due">Due date</Label>
              <Controller
                control={form.control}
                name="due_date"
                render={({ field }) => (
                  <DateInput
                    id="task-due"
                    value={field.value ?? ''}
                    onChange={field.onChange}
                    onBlur={field.onBlur}
                  />
                )}
              />
            </div>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="task-notes">Notes</Label>
            <Textarea
              id="task-notes"
              placeholder="Confirmation numbers, links…"
              className="min-h-16"
              {...form.register('notes')}
            />
            {err.notes && <p className="text-xs text-danger">{err.notes.message}</p>}
          </div>
          <Button type="submit" size="lg" className="w-full" disabled={form.formState.isSubmitting}>
            {item ? 'Save changes' : 'Add task'}
          </Button>
        </form>
      </DialogContent>
    </Dialog>
  )
}

export default function ChecklistPage() {
  const { trip } = useTripContext()
  const checklist = useChecklist(trip.id)
  const [newOpen, setNewOpen] = React.useState(false)

  const items = checklist.data ?? []
  const open = items.filter((i) => !i.done)
  const done = items.filter((i) => i.done)
  const pct = items.length === 0 ? 0 : Math.round((done.length / items.length) * 100)

  return (
    <div>
      <PageHeader
        title="Checklist"
        description="Everything that needs to happen before takeoff."
        action={
          <Button onClick={() => setNewOpen(true)}>
            <Plus /> New task
          </Button>
        }
      />

      {items.length > 0 && (
        <Card className="mb-5 p-4">
          <div className="flex items-center justify-between text-sm">
            <span className="font-medium">
              {done.length} of {items.length} done
            </span>
            <span className="font-display font-bold text-primary">{pct}%</span>
          </div>
          <Progress value={pct} className="mt-2" label="Checklist progress" />
        </Card>
      )}

      {checklist.isLoading ? (
        <div className="space-y-3">
          <Skeleton className="h-14" />
          <Skeleton className="h-14" />
          <Skeleton className="h-14" />
        </div>
      ) : checklist.isError ? (
        <ErrorState onRetry={() => checklist.refetch()} isRetrying={checklist.isFetching} />
      ) : items.length === 0 ? (
        <EmptyState
          icon={ListChecks}
          title="Nothing on the list"
          description="Flights, bookings, insurance, tickets — add the tasks and assign owners."
          action={
            <Button onClick={() => setNewOpen(true)}>
              <Plus /> Add the first task
            </Button>
          }
        />
      ) : (
        <Card className="divide-y divide-line/60 p-2">
          {open.map((item, i) => (
            <ItemRow key={item.id} item={item} index={i} />
          ))}
          {done.length > 0 && open.length > 0 && <div className="!border-0 pt-1" />}
          {done.map((item, i) => (
            <ItemRow key={item.id} item={item} index={i} />
          ))}
        </Card>
      )}

      <ItemDialog open={newOpen} onOpenChange={setNewOpen} />
    </div>
  )
}
