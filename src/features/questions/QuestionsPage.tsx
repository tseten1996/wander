import * as React from 'react'
import { motion } from 'framer-motion'
import {
  CheckCircle2, CircleHelp, MoreHorizontal, Plus, RotateCcw, Trash2,
} from 'lucide-react'
import { toast } from 'sonner'
import { useTripContext } from '@/hooks/useTrip'
import {
  useAnswerQuestion, useCreateQuestion, useDeleteQuestion, useQuestions,
  useReopenQuestion,
} from './api'
import { PageHeader } from '@/components/layout/PageHeader'
import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'
import { Input, Textarea } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { MemberAvatar } from '@/components/ui/avatar'
import { EmptyState, Skeleton } from '@/components/ui/misc'
import {
  Dialog, DialogContent, DialogHeader, DialogTitle,
} from '@/components/ui/dialog'
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { timeAgo } from '@/lib/utils'
import type { Question } from '@/types'

function QuestionCard({ question, index }: { question: Question; index: number }) {
  const { trip, me, isOwner, membersById } = useTripContext()
  const answerQuestion = useAnswerQuestion(trip.id, me.id)
  const reopen = useReopenQuestion(trip.id)
  const deleteQuestion = useDeleteQuestion(trip.id)

  const [answering, setAnswering] = React.useState(false)
  const [answer, setAnswer] = React.useState(question.answer ?? '')
  const author = question.member_id ? membersById.get(question.member_id) : null
  const canDelete = isOwner || question.member_id === me.id

  return (
    <motion.div
      initial={{ opacity: 0, y: 10 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.25, delay: Math.min(index * 0.04, 0.3) }}
    >
      <Card className="p-5">
        <div className="flex items-start gap-3">
          {question.answered ? (
            <CheckCircle2 className="mt-0.5 size-5 shrink-0 text-success" />
          ) : (
            <CircleHelp className="mt-0.5 size-5 shrink-0 text-accent" />
          )}
          <div className="min-w-0 flex-1">
            <p className="font-medium">{question.title}</p>
            {question.body && <p className="mt-1 text-sm text-muted">{question.body}</p>}
            <p className="mt-1.5 flex items-center gap-1.5 text-xs text-faint">
              {author && (
                <>
                  <MemberAvatar name={author.display_name} color={author.color} size="xs" />
                  {author.display_name} ·
                </>
              )}
              {timeAgo(question.created_at)}
            </p>

            {question.answered && question.answer && (
              <div className="mt-3 rounded-xl bg-success-soft/60 px-3.5 py-2.5 text-sm">
                <span className="font-medium text-success">Answer: </span>
                {question.answer}
              </div>
            )}

            {answering && (
              <div className="mt-3 space-y-2">
                <Textarea
                  placeholder="Write the answer…"
                  value={answer}
                  onChange={(e) => setAnswer(e.target.value)}
                  autoFocus
                />
                <div className="flex gap-2">
                  <Button size="sm" variant="ghost" onClick={() => setAnswering(false)}>
                    Cancel
                  </Button>
                  <Button
                    size="sm"
                    onClick={() => {
                      answerQuestion.mutate({ question, answer: answer.trim() || null })
                      setAnswering(false)
                    }}
                  >
                    Mark answered
                  </Button>
                </div>
              </div>
            )}
          </div>

          <div className="flex shrink-0 items-center gap-1">
            {!question.answered && !answering && (
              <Button size="sm" variant="soft" onClick={() => setAnswering(true)}>
                Answer
              </Button>
            )}
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button variant="ghost" size="icon" aria-label="Question actions">
                  <MoreHorizontal />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                {question.answered && (
                  <DropdownMenuItem onClick={() => reopen.mutate(question.id)}>
                    <RotateCcw /> Reopen
                  </DropdownMenuItem>
                )}
                {canDelete && (
                  <DropdownMenuItem
                    destructive
                    onClick={() => {
                      deleteQuestion.mutate(question.id)
                      toast.success('Question deleted')
                    }}
                  >
                    <Trash2 /> Delete
                  </DropdownMenuItem>
                )}
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
        </div>
      </Card>
    </motion.div>
  )
}

export default function QuestionsPage() {
  const { trip, me } = useTripContext()
  const questions = useQuestions(trip.id)
  const createQuestion = useCreateQuestion(trip.id, me.id)

  const [newOpen, setNewOpen] = React.useState(false)
  const [title, setTitle] = React.useState('')
  const [body, setBody] = React.useState('')

  const open = (questions.data ?? []).filter((q) => !q.answered)
  const answered = (questions.data ?? []).filter((q) => q.answered)

  async function submit(e: React.FormEvent) {
    e.preventDefault()
    if (!title.trim()) return
    await createQuestion.mutateAsync({ title: title.trim(), body: body.trim() })
    setTitle('')
    setBody('')
    setNewOpen(false)
    toast.success('Question posted')
  }

  return (
    <div>
      <PageHeader
        title="Questions"
        description="Who's driving? Who books the flights? Get it answered, once."
        action={
          <Button onClick={() => setNewOpen(true)}>
            <Plus /> Ask
          </Button>
        }
      />

      {questions.isLoading ? (
        <div className="space-y-3">
          <Skeleton className="h-24" />
          <Skeleton className="h-24" />
        </div>
      ) : questions.data!.length === 0 ? (
        <EmptyState
          icon={CircleHelp}
          title="No questions yet"
          description="Passport reminders, who's booking what, dietary stuff — ask it here so it doesn't get lost."
          action={
            <Button onClick={() => setNewOpen(true)}>
              <Plus /> Ask the first question
            </Button>
          }
        />
      ) : (
        <div className="space-y-6">
          {open.length > 0 && (
            <div className="space-y-3">
              {open.map((q, i) => (
                <QuestionCard key={q.id} question={q} index={i} />
              ))}
            </div>
          )}
          {answered.length > 0 && (
            <div>
              <h2 className="mb-3 text-sm font-semibold text-muted">
                Answered ({answered.length})
              </h2>
              <div className="space-y-3 opacity-90">
                {answered.map((q, i) => (
                  <QuestionCard key={q.id} question={q} index={i} />
                ))}
              </div>
            </div>
          )}
        </div>
      )}

      <Dialog open={newOpen} onOpenChange={setNewOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Ask the group</DialogTitle>
          </DialogHeader>
          <form onSubmit={submit} className="space-y-4">
            <div className="space-y-1.5">
              <Label htmlFor="q-title">Question</Label>
              <Input
                id="q-title"
                placeholder="Who's booking the Airbnb?"
                value={title}
                onChange={(e) => setTitle(e.target.value)}
                autoFocus
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="q-body">Details (optional)</Label>
              <Textarea
                id="q-body"
                placeholder="Any context that helps…"
                value={body}
                onChange={(e) => setBody(e.target.value)}
              />
            </div>
            <Button type="submit" size="lg" className="w-full" disabled={!title.trim() || createQuestion.isPending}>
              Post question
            </Button>
          </form>
        </DialogContent>
      </Dialog>
    </div>
  )
}
