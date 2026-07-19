import * as React from 'react'
import { motion } from 'framer-motion'
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
import { Label } from '@/components/ui/label'
import { Badge } from '@/components/ui/badge'
import { Progress } from '@/components/ui/progress'
import { MemberAvatar } from '@/components/ui/avatar'
import { EmptyState, Skeleton } from '@/components/ui/misc'
import {
  Dialog, DialogContent, DialogHeader, DialogTitle,
} from '@/components/ui/dialog'
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from '@/components/ui/select'
import { cn, daysUntil, shortDate } from '@/lib/utils'
import type { ChecklistItem } from '@/types'

const UNASSIGNED = 'unassigned'

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

  const [title, setTitle] = React.useState(item?.title ?? '')
  const [notes, setNotes] = React.useState(item?.notes ?? '')
  const [assignee, setAssignee] = React.useState(item?.assignee_id ?? UNASSIGNED)
  const [dueDate, setDueDate] = React.useState(item?.due_date ?? '')

  React.useEffect(() => {
    if (open) {
      setTitle(item?.title ?? '')
      setNotes(item?.notes ?? '')
      setAssignee(item?.assignee_id ?? UNASSIGNED)
      setDueDate(item?.due_date ?? '')
    }
  }, [open, item])

  async function submit(e: React.FormEvent) {
    e.preventDefault()
    if (!title.trim()) return
    const payload = {
      title: title.trim(),
      notes: notes.trim() || null,
      assignee_id: assignee === UNASSIGNED ? null : assignee,
      due_date: dueDate || null,
    }
    if (item) {
      await updateItem.mutateAsync({ id: item.id, ...payload })
    } else {
      await createItem.mutateAsync(payload)
    }
    onOpenChange(false)
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{item ? 'Edit task' : 'New task'}</DialogTitle>
        </DialogHeader>
        <form onSubmit={submit} className="space-y-4">
          <div className="space-y-1.5">
            <Label htmlFor="task-title">Task</Label>
            <Input
              id="task-title"
              placeholder="Book flights"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              autoFocus={!item}
            />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <Label>Assign to</Label>
              <Select value={assignee} onValueChange={setAssignee}>
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
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="task-due">Due date</Label>
              <Input
                id="task-due"
                type="date"
                value={dueDate}
                onChange={(e) => setDueDate(e.target.value)}
              />
            </div>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="task-notes">Notes</Label>
            <Textarea
              id="task-notes"
              placeholder="Confirmation numbers, links…"
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              className="min-h-16"
            />
          </div>
          <Button type="submit" size="lg" className="w-full" disabled={!title.trim()}>
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
