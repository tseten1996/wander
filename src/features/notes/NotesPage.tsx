import * as React from 'react'
import { motion } from 'framer-motion'
import Markdown from 'react-markdown'
import { useForm } from 'react-hook-form'
import { zodResolver } from '@hookform/resolvers/zod'
import { z } from 'zod'
import { NotebookPen, Pin, PinOff, Plus, Trash2 } from 'lucide-react'
import { toast } from 'sonner'
import { useTripContext } from '@/hooks/useTrip'
import { useCreateNote, useDeleteNote, useNotes, useUpdateNote } from './api'
import { PageHeader } from '@/components/layout/PageHeader'
import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'
import { Input, Textarea } from '@/components/ui/input'
import { EmptyState, ErrorState, Skeleton } from '@/components/ui/misc'
import { Dialog, DialogContent } from '@/components/ui/dialog'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { MemberAvatar } from '@/components/ui/avatar'
import { timeAgo } from '@/lib/utils'
import type { Note } from '@/types'

const noteSchema = z.object({
  title: z.string().trim().max(200, 'Keep it under 200 characters'),
  content: z.string().trim().max(20000, 'Keep it under 20,000 characters'),
})

type NoteFormValues = z.input<typeof noteSchema>

/** Shared markdown renderer with sensible typography inside cards. */
function NoteMarkdown({ children }: { children: string }) {
  return (
    <div className="space-y-2 text-sm leading-relaxed [&_a]:text-primary [&_a]:underline [&_code]:rounded [&_code]:bg-sunken [&_code]:px-1 [&_code]:py-0.5 [&_code]:text-xs [&_h1]:font-display [&_h1]:text-lg [&_h1]:font-bold [&_h2]:font-display [&_h2]:text-base [&_h2]:font-semibold [&_h3]:font-semibold [&_li]:ml-4 [&_ol]:list-decimal [&_ul]:list-disc">
      <Markdown>{children}</Markdown>
    </div>
  )
}

function NoteDialog({
  note,
  open,
  onOpenChange,
}: {
  note: Note | null // null = new note
  open: boolean
  onOpenChange: (o: boolean) => void
}) {
  const { trip, me } = useTripContext()
  const createNote = useCreateNote(trip.id, me.id)
  const updateNote = useUpdateNote(trip.id)

  const empty: NoteFormValues = { title: '', content: '' }
  const form = useForm<NoteFormValues>({
    resolver: zodResolver(noteSchema),
    defaultValues: empty,
  })

  React.useEffect(() => {
    if (open) form.reset(note ? { title: note.title, content: note.content } : empty)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, note])

  const content = form.watch('content')
  const err = form.formState.errors

  async function onSubmit(values: NoteFormValues) {
    const payload = { title: values.title.trim() || 'Untitled', content: values.content.trim() }
    try {
      if (note) await updateNote.mutateAsync({ id: note.id, ...payload })
      else await createNote.mutateAsync(payload)
      onOpenChange(false)
    } catch {
      // toasted by the mutation's onError
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="md:max-w-2xl">
        <form className="space-y-4" onSubmit={form.handleSubmit(onSubmit)}>
          <div>
            <Input
              placeholder="Note title"
              className="border-0 bg-transparent px-0 font-display text-xl font-bold focus:ring-0"
              {...form.register('title')}
            />
            {err.title && <p className="text-xs text-danger">{err.title.message}</p>}
          </div>
          <Tabs defaultValue="write">
            <TabsList>
              <TabsTrigger value="write">Write</TabsTrigger>
              <TabsTrigger value="preview">Preview</TabsTrigger>
            </TabsList>
            <TabsContent value="write" className="mt-3">
              <Textarea
                placeholder={'Markdown supported…\n\n## Restaurant ideas\n- Ichiran ramen\n- [Tsukiji market](https://example.com)'}
                className="min-h-64 font-mono text-sm"
                aria-invalid={!!err.content}
                {...form.register('content')}
              />
              {err.content && <p className="mt-1 text-xs text-danger">{err.content.message}</p>}
            </TabsContent>
            <TabsContent value="preview" className="mt-3">
              <div className="min-h-64 rounded-xl border border-line p-4">
                {content.trim() ? (
                  <NoteMarkdown>{content}</NoteMarkdown>
                ) : (
                  <p className="text-sm text-faint">Nothing to preview yet.</p>
                )}
              </div>
            </TabsContent>
          </Tabs>
          <Button type="submit" size="lg" className="w-full" disabled={form.formState.isSubmitting}>
            {note ? 'Save note' : 'Create note'}
          </Button>
        </form>
      </DialogContent>
    </Dialog>
  )
}

export default function NotesPage() {
  const { trip, me, isOwner, membersById } = useTripContext()
  const notes = useNotes(trip.id)
  const updateNote = useUpdateNote(trip.id)
  const deleteNote = useDeleteNote(trip.id)

  const [editing, setEditing] = React.useState<Note | null>(null)
  const [dialogOpen, setDialogOpen] = React.useState(false)

  function openNote(note: Note | null) {
    setEditing(note)
    setDialogOpen(true)
  }

  return (
    <div>
      <PageHeader
        title="Notes"
        description="Shared scratchpad — links, phone numbers, restaurant lists. Markdown works."
        action={
          <Button onClick={() => openNote(null)}>
            <Plus /> New note
          </Button>
        }
      />
      {notes.isLoading ? (
        <div className="grid gap-4 md:grid-cols-2">
          <Skeleton className="h-40" />
          <Skeleton className="h-40" />
        </div>
      ) : notes.isError ? (
        <ErrorState onRetry={() => notes.refetch()} isRetrying={notes.isFetching} />
      ) : notes.data!.length === 0 ? (
        <EmptyState
          icon={NotebookPen}
          title="No notes yet"
          description="Collect the stuff that doesn't fit anywhere else — everyone can read and edit."
          action={
            <Button onClick={() => openNote(null)}>
              <Plus /> Write the first note
            </Button>
          }
        />
      ) : (
        <div className="grid items-start gap-4 md:grid-cols-2">
          {notes.data!.map((note, i) => {
            const author = note.created_by ? membersById.get(note.created_by) : null
            const canDelete = isOwner || note.created_by === me.id
            return (
              <motion.div
                key={note.id}
                className="min-w-0"
                initial={{ opacity: 0, y: 10 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ duration: 0.25, delay: Math.min(i * 0.04, 0.3) }}
              >
                <Card
                  className="group cursor-pointer p-5 transition-all hover:-translate-y-0.5 hover:shadow-lift"
                  onClick={() => openNote(note)}
                >
                  <div className="flex items-start justify-between gap-2">
                    <h3 className="min-w-0 flex-1 break-words font-display font-semibold">
                      {note.pinned && <Pin className="mr-1.5 inline size-3.5 text-accent" />}
                      {note.title}
                    </h3>
                    <div
                      className="flex shrink-0 gap-0.5 transition-opacity md:opacity-0 md:group-hover:opacity-100 md:focus-within:opacity-100"
                      onClick={(e) => e.stopPropagation()}
                    >
                      <Button
                        variant="ghost"
                        size="icon"
                        className="size-9 md:size-7"
                        aria-label={note.pinned ? 'Unpin note' : 'Pin note'}
                        onClick={() => updateNote.mutate({ id: note.id, pinned: !note.pinned })}
                      >
                        {note.pinned ? <PinOff className="size-4" /> : <Pin className="size-4" />}
                      </Button>
                      {canDelete && (
                        <Button
                          variant="ghost"
                          size="icon"
                          className="size-9 text-danger md:size-7"
                          aria-label="Delete note"
                          onClick={() => {
                            deleteNote.mutate(note.id)
                            toast.success('Note deleted')
                          }}
                        >
                          <Trash2 className="size-4" />
                        </Button>
                      )}
                    </div>
                  </div>
                  <div className="mt-2 max-h-40 overflow-hidden [mask-image:linear-gradient(to_bottom,black_70%,transparent)]">
                    <NoteMarkdown>{note.content || '_Empty note_'}</NoteMarkdown>
                  </div>
                  <p className="mt-3 flex items-center gap-1.5 text-xs text-faint">
                    {author && (
                      <MemberAvatar name={author.display_name} color={author.color} size="xs" />
                    )}
                    updated {timeAgo(note.updated_at)}
                  </p>
                </Card>
              </motion.div>
            )
          })}
        </div>
      )}
      <NoteDialog note={editing} open={dialogOpen} onOpenChange={setDialogOpen} />
    </div>
  )
}
