import * as React from 'react'
import { MessageCircle, SendHorizonal, Trash2 } from 'lucide-react'
import { toast } from 'sonner'
import { useTripContext } from '@/hooks/useTrip'
import { Button } from '@/components/ui/button'
import { Textarea } from '@/components/ui/input'
import { MemberAvatar } from '@/components/ui/avatar'
import { ErrorState, Skeleton } from '@/components/ui/misc'
import { MentionText } from '@/features/messages/MentionText'
import {
  applyMention, detectActiveMention, matchMembers, type ActiveMention,
} from '@/features/messages/mentions'
import { cn, timeAgo } from '@/lib/utils'
import { FALLBACK_MEMBER_COLOR } from '@/lib/colors'
import type { Comment, CommentEntityType } from '@/types'
import { useAddComment, useComments, useDeleteComment } from './api'

const COMMENT_MAX_LENGTH = 2000

function CommentRow({
  comment,
  entityType,
  entityId,
}: {
  comment: Comment
  entityType: CommentEntityType
  entityId: string
}) {
  const { trip, me, isOwner, membersById } = useTripContext()
  const deleteComment = useDeleteComment(trip.id, entityType, entityId)
  const author = comment.member_id ? membersById.get(comment.member_id) : null
  const canDelete = isOwner || comment.member_id === me.id

  return (
    <li className="group flex gap-2.5">
      <MemberAvatar
        name={author?.display_name ?? 'Former member'}
        color={author?.color ?? FALLBACK_MEMBER_COLOR}
        size="sm"
        className="mt-0.5 shrink-0"
      />
      <div className="min-w-0 flex-1">
        <p className="mb-0.5 text-xs text-muted">
          <span className="font-medium text-ink-soft">
            {author?.display_name ?? 'Former member'}
          </span>{' '}
          {timeAgo(comment.created_at)}
        </p>
        <div className="whitespace-pre-wrap break-words text-sm text-ink-soft">
          <MentionText content={comment.body} />
        </div>
      </div>
      {canDelete && (
        <Button
          variant="ghost"
          size="icon"
          className="size-9 shrink-0 text-faint transition-opacity md:size-8 md:opacity-0 md:group-hover:opacity-100 md:focus-visible:opacity-100"
          aria-label="Delete comment"
          onClick={() =>
            deleteComment.mutate(comment.id, {
              onSuccess: () => toast.success('Comment deleted'),
            })
          }
        >
          <Trash2 className="size-4" />
        </Button>
      )}
    </li>
  )
}

/**
 * The comment thread + composer for a single trip entity — an itinerary item
 * in slice 1 (#314). Discussion pinned to the plan itself, so "why the beach
 * won" outlives the chat that scrolls away. Reuses the chat's `@`-mention
 * parser (`mentions.ts`) and renderer (`MentionText`) unchanged, and posts
 * through `comments/api.ts`, which reuses the `mention` notification path.
 *
 * Rendered only for an existing entity (the item edit dialog), never in the
 * create flow — a not-yet-saved item has no id to attach a comment to.
 */
export function CommentsSection({
  entityType,
  entityId,
}: {
  entityType: CommentEntityType
  entityId: string
}) {
  const { trip, me, members } = useTripContext()
  const comments = useComments(trip.id, entityType, entityId)
  const addComment = useAddComment(trip.id, entityType, entityId, me.id)

  const [draft, setDraft] = React.useState('')
  const composerRef = React.useRef<HTMLTextAreaElement>(null)

  // @-mention autocomplete (#193), mirroring the chat composer's wiring but
  // trimmed to what a comment box needs. Everyone but yourself is mentionable.
  const [mention, setMention] = React.useState<ActiveMention | null>(null)
  const [mentionIndex, setMentionIndex] = React.useState(0)
  const mentionCandidates = React.useMemo(() => {
    if (!mention) return []
    return matchMembers(members.filter((m) => m.id !== me.id), mention.query).slice(0, 6)
  }, [mention, members, me.id])
  const mentionListboxId = React.useId()
  const mentionOptionId = (i: number) => `${mentionListboxId}-opt-${i}`
  const mentionOpen = mention !== null && mentionCandidates.length > 0

  function syncMention(el: HTMLTextAreaElement) {
    setMention(detectActiveMention(el.value, el.selectionStart ?? el.value.length))
  }

  function pickMention(member: { id: string; display_name: string }) {
    if (!mention) return
    const next = applyMention(draft, mention, member)
    setDraft(next.text)
    setMention(null)
    setMentionIndex(0)
    requestAnimationFrame(() => {
      const el = composerRef.current
      if (el) {
        el.focus()
        el.setSelectionRange(next.caret, next.caret)
      }
    })
  }

  async function post() {
    const body = draft.trim()
    if (!body || body.length > COMMENT_MAX_LENGTH) return
    setDraft('')
    setMention(null)
    try {
      await addComment.mutateAsync(body)
    } catch {
      // useAddComment surfaces a toast; restore the text so it isn't lost,
      // unless the user has already started composing something new.
      setDraft((current) => (current.trim() ? current : body))
    }
  }

  const rows = comments.data ?? []

  return (
    <section aria-label="Comments" className="space-y-3 border-t border-line pt-4">
      <h3 className="flex items-center gap-2 text-sm font-semibold text-ink">
        <MessageCircle className="size-4 text-muted" aria-hidden />
        Comments
        {rows.length > 0 && <span className="text-xs font-normal text-faint">{rows.length}</span>}
      </h3>

      {comments.isLoading ? (
        <div className="space-y-2">
          <Skeleton className="h-10" />
          <Skeleton className="h-10 w-2/3" />
        </div>
      ) : comments.isError ? (
        <ErrorState onRetry={() => comments.refetch()} isRetrying={comments.isFetching} />
      ) : (
        <ul className="space-y-3" aria-live="polite">
          {rows.length === 0 ? (
            <li className="text-sm text-muted">
              No comments yet — start the discussion about this stop.
            </li>
          ) : (
            rows.map((c) => (
              <CommentRow key={c.id} comment={c} entityType={entityType} entityId={entityId} />
            ))
          )}
        </ul>
      )}

      <div className="relative flex items-end gap-2">
        {mentionOpen && (
          <ul
            id={mentionListboxId}
            role="listbox"
            aria-label="Mention a member"
            className="absolute bottom-full left-0 z-20 mb-2 w-64 overflow-hidden rounded-xl border border-line bg-elevated p-1 shadow-lg"
          >
            {mentionCandidates.map((m, i) => (
              <li key={m.id}>
                <button
                  type="button"
                  id={mentionOptionId(i)}
                  role="option"
                  aria-selected={i === mentionIndex}
                  // mousedown (not click) so the textarea keeps focus through
                  // the insert; preventDefault stops the blur.
                  onMouseDown={(e) => {
                    e.preventDefault()
                    pickMention(m)
                  }}
                  onMouseEnter={() => setMentionIndex(i)}
                  className={cn(
                    'flex min-h-11 w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left text-sm md:min-h-0',
                    i === mentionIndex ? 'bg-sunken' : 'hover:bg-sunken'
                  )}
                >
                  <MemberAvatar name={m.display_name} color={m.color} size="sm" />
                  <span className="truncate">{m.display_name}</span>
                </button>
              </li>
            ))}
          </ul>
        )}
        <Textarea
          ref={composerRef}
          placeholder="Add a comment… @ to mention"
          value={draft}
          rows={1}
          role="combobox"
          aria-expanded={mentionOpen}
          aria-autocomplete="list"
          aria-controls={mentionOpen ? mentionListboxId : undefined}
          aria-activedescendant={mentionOpen ? mentionOptionId(mentionIndex) : undefined}
          aria-label="Add a comment"
          aria-invalid={draft.length > COMMENT_MAX_LENGTH}
          className="max-h-40 min-h-11 flex-1 resize-none"
          onChange={(e) => {
            setDraft(e.target.value)
            syncMention(e.target)
            setMentionIndex(0)
          }}
          onSelect={(e) => syncMention(e.currentTarget)}
          onKeyDown={(e) => {
            const picking = mention && mentionCandidates.length > 0
            if (picking) {
              if (e.key === 'ArrowDown') {
                e.preventDefault()
                setMentionIndex((i) => (i + 1) % mentionCandidates.length)
                return
              }
              if (e.key === 'ArrowUp') {
                e.preventDefault()
                setMentionIndex((i) => (i - 1 + mentionCandidates.length) % mentionCandidates.length)
                return
              }
              if (e.key === 'Enter' || e.key === 'Tab') {
                e.preventDefault()
                pickMention(mentionCandidates[mentionIndex])
                return
              }
              if (e.key === 'Escape') {
                e.preventDefault()
                setMention(null)
                return
              }
            }
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault()
              void post()
            }
          }}
        />
        <Button
          size="icon"
          className="size-11 shrink-0 rounded-xl"
          disabled={!draft.trim() || draft.length > COMMENT_MAX_LENGTH || addComment.isPending}
          onClick={post}
          aria-label="Post comment"
        >
          <SendHorizonal />
        </Button>
      </div>
      {draft.length > COMMENT_MAX_LENGTH && (
        <p className="text-xs text-danger">Keep it under {COMMENT_MAX_LENGTH} characters</p>
      )}
    </section>
  )
}
