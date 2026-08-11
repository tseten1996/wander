import * as React from 'react'
import { motion } from 'framer-motion'
import {
  CornerUpLeft, ImagePlus, MessageCircle, MoreHorizontal, Pencil, Pin, PinOff,
  SendHorizonal, SmilePlus, Trash2, X,
} from 'lucide-react'
import { format, isSameDay, parseISO } from 'date-fns'
import { toast } from 'sonner'
import { useTripContext } from '@/hooks/useTrip'
import {
  useDeleteMessage, useEditMessage, useMessages, useSendMessage,
  useSetPinned, useToggleReaction, validateChatImage, type MessageWithReactions,
} from './api'
import { ImageLightbox } from './ImageLightbox'
import { Button } from '@/components/ui/button'
import { Textarea } from '@/components/ui/input'
import { MemberAvatar } from '@/components/ui/avatar'
import { EmptyState, ErrorState, Skeleton } from '@/components/ui/misc'
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { searchAnchorId } from '@/features/search/anchor'
import { cn } from '@/lib/utils'
import { FALLBACK_MEMBER_COLOR } from '@/lib/colors'
import { MentionText } from './MentionText'
import {
  applyMention, detectActiveMention, matchMembers, mentionsToPlainText,
  type ActiveMention,
} from './mentions'

const EMOJI = ['👍', '❤️', '😂', '😮', '🎉', '🤔']
const MESSAGE_MAX_LENGTH = 4000

function Reactions({
  message,
  onToggle,
}: {
  message: MessageWithReactions
  onToggle: (emoji: string) => void
}) {
  const { me, membersById } = useTripContext()
  const grouped = new Map<string, { count: number; mine: boolean; names: string[] }>()
  for (const r of message.message_reactions) {
    const g = grouped.get(r.emoji) ?? { count: 0, mine: false, names: [] }
    g.count++
    if (r.member_id === me.id) g.mine = true
    const name = membersById.get(r.member_id)?.display_name
    if (name) g.names.push(name)
    grouped.set(r.emoji, g)
  }
  if (grouped.size === 0) return null
  return (
    <div className="mt-1.5 flex flex-wrap gap-1">
      {[...grouped.entries()].map(([emoji, g]) => (
        <button
          key={emoji}
          type="button"
          title={g.names.join(', ')}
          onClick={() => onToggle(emoji)}
          className={cn(
            'inline-flex cursor-pointer items-center gap-1 rounded-full border px-2 py-0.5 text-xs transition-colors',
            g.mine
              ? 'border-primary bg-primary-faint text-primary'
              : 'border-line bg-surface text-muted hover:border-line-strong'
          )}
        >
          {emoji} {g.count}
        </button>
      ))}
    </div>
  )
}

function ChatImage({ src, onOpen }: { src?: string | null; onOpen: () => void }) {
  // The signed URL rides with the message (see useMessages), so it's resolved
  // by the time this renders; a missing one is an honest fallback (a signing
  // error, or an object the viewer's membership can't read).
  if (!src) {
    return (
      <div className="flex h-32 w-48 items-center justify-center rounded-2xl border border-line bg-sunken text-xs text-muted">
        Image unavailable
      </div>
    )
  }
  return (
    <button
      type="button"
      onClick={onOpen}
      aria-label="Open image"
      className="block cursor-zoom-in overflow-hidden rounded-2xl border border-line bg-sunken transition-shadow hover:shadow-soft focus:outline-none focus-visible:ring-2 focus-visible:ring-primary/40"
    >
      <img
        src={src}
        alt="Shared in chat"
        loading="lazy"
        className="max-h-72 w-auto max-w-full object-cover"
      />
    </button>
  )
}

function Bubble({
  message,
  byId,
  onReply,
  onOpenImage,
}: {
  message: MessageWithReactions
  byId: Map<string, MessageWithReactions>
  onReply: (m: MessageWithReactions) => void
  onOpenImage: (src: string) => void
}) {
  const { trip, me, isOwner, membersById } = useTripContext()
  const editMessage = useEditMessage(trip.id)
  const deleteMessage = useDeleteMessage(trip.id)
  const setPinned = useSetPinned(trip.id)
  const toggleReaction = useToggleReaction(trip.id, me.id)

  const [editing, setEditing] = React.useState(false)
  const [draft, setDraft] = React.useState(message.content)

  const author = message.member_id ? membersById.get(message.member_id) : null
  const mine = message.member_id === me.id
  const repliedTo = message.reply_to ? byId.get(message.reply_to) : null
  const repliedAuthor = repliedTo?.member_id ? membersById.get(repliedTo.member_id) : null

  return (
    <div id={searchAnchorId(message.id)} className={cn('group flex gap-2.5', mine && 'flex-row-reverse')}>
      <MemberAvatar
        name={author?.display_name ?? 'Left the trip'}
        color={author?.color ?? FALLBACK_MEMBER_COLOR}
        size="sm"
        className="mt-1"
      />
      <div className={cn('min-w-0 max-w-[78%]', mine && 'items-end text-right')}>
        <p className={cn('mb-0.5 text-xs text-muted', mine && 'text-right')}>
          <span className="font-medium text-ink-soft">{author?.display_name ?? 'Former member'}</span>{' '}
          {format(parseISO(message.created_at), 'p')}
          {message.edited_at && <span className="italic"> · edited</span>}
          {message.pinned && <Pin className="ml-1 inline size-3 text-accent" />}
        </p>

        {repliedTo && (
          <div
            className={cn(
              'mb-1 rounded-lg border-l-2 border-primary/50 bg-sunken px-2.5 py-1.5 text-left text-xs text-muted',
              mine && 'ml-auto'
            )}
          >
            <span className="font-medium">{repliedAuthor?.display_name ?? 'Someone'}: </span>
            <span className="line-clamp-2">{mentionsToPlainText(repliedTo.content)}</span>
          </div>
        )}

        {message.image_path && (
          <div className={cn('mb-1', mine && 'flex justify-end')}>
            <ChatImage
              src={message.image_url}
              onOpen={() => message.image_url && onOpenImage(message.image_url)}
            />
          </div>
        )}

        {editing ? (
          <div className="space-y-2">
            <Textarea
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              className="min-h-16 text-left"
              aria-invalid={draft.length > MESSAGE_MAX_LENGTH}
              autoFocus
            />
            {draft.length > MESSAGE_MAX_LENGTH && (
              <p className="text-left text-xs text-danger">
                Keep it under {MESSAGE_MAX_LENGTH} characters
              </p>
            )}
            <div className={cn('flex gap-2', mine && 'justify-end')}>
              <Button size="sm" variant="ghost" onClick={() => setEditing(false)}>
                Cancel
              </Button>
              <Button
                size="sm"
                disabled={!draft.trim() || draft.length > MESSAGE_MAX_LENGTH}
                onClick={() => {
                  editMessage.mutate({ id: message.id, content: draft.trim() })
                  setEditing(false)
                }}
              >
                Save
              </Button>
            </div>
          </div>
        ) : (
          message.content && (
            <div
              className={cn(
                'inline-block whitespace-pre-wrap break-words rounded-2xl px-3.5 py-2 text-left text-sm',
                mine
                  ? 'rounded-tr-sm bg-primary text-on-primary'
                  : 'rounded-tl-sm border border-line bg-surface'
              )}
            >
              <MentionText content={message.content} onPrimary={mine} />
            </div>
          )
        )}

        <Reactions message={message} onToggle={(emoji) => toggleReaction.mutate({ message, emoji })} />
      </div>

      {/* Hover on desktop, always tappable on mobile */}
      <div className={cn('flex items-start gap-0.5 self-center transition-opacity md:opacity-0 md:group-hover:opacity-100 md:focus-within:opacity-100')}>
        <Popover>
          <PopoverTrigger asChild>
            <Button variant="ghost" size="icon" className="size-9 md:size-7" aria-label="React">
              <SmilePlus className="size-4" />
            </Button>
          </PopoverTrigger>
          <PopoverContent className="w-auto p-2">
            <div className="flex gap-1">
              {EMOJI.map((e) => (
                <button
                  key={e}
                  type="button"
                  className="flex size-9 cursor-pointer items-center justify-center rounded-lg text-lg transition-transform hover:scale-125"
                  onClick={() => toggleReaction.mutate({ message, emoji: e })}
                >
                  {e}
                </button>
              ))}
            </div>
          </PopoverContent>
        </Popover>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button variant="ghost" size="icon" className="size-9 md:size-7" aria-label="Message actions">
              <MoreHorizontal className="size-4" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align={mine ? 'end' : 'start'}>
            <DropdownMenuItem onClick={() => onReply(message)}>
              <CornerUpLeft /> Reply
            </DropdownMenuItem>
            {mine && message.content && (
              <DropdownMenuItem onClick={() => { setDraft(message.content); setEditing(true) }}>
                <Pencil /> Edit
              </DropdownMenuItem>
            )}
            {isOwner && (
              <DropdownMenuItem
                onClick={() => setPinned.mutate({ id: message.id, pinned: !message.pinned })}
              >
                {message.pinned ? <PinOff /> : <Pin />}
                {message.pinned ? 'Unpin' : 'Pin'}
              </DropdownMenuItem>
            )}
            {(mine || isOwner) && (
              <>
                <DropdownMenuSeparator />
                <DropdownMenuItem
                  destructive
                  onClick={() => deleteMessage.mutate({ id: message.id, imagePath: message.image_path })}
                >
                  <Trash2 /> Delete
                </DropdownMenuItem>
              </>
            )}
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
    </div>
  )
}

export default function ChatPage() {
  const { trip, me, members, membersById } = useTripContext()
  const messages = useMessages(trip.id)
  const sendMessage = useSendMessage(trip.id, me.id)

  const [draft, setDraft] = React.useState('')
  const [replyTo, setReplyTo] = React.useState<MessageWithReactions | null>(null)
  // A pending image attachment (#51): the File to upload on the next send.
  const [attachment, setAttachment] = React.useState<File | null>(null)
  const [lightbox, setLightbox] = React.useState<string | null>(null)
  const bottomRef = React.useRef<HTMLDivElement>(null)
  const composerRef = React.useRef<HTMLTextAreaElement>(null)
  const fileInputRef = React.useRef<HTMLInputElement>(null)
  const count = messages.data?.length ?? 0

  function attachImage(file: File | null | undefined) {
    if (!file) return
    const problem = validateChatImage(file)
    if (problem) {
      toast.error(problem)
      return
    }
    setAttachment(file)
  }

  // @-mention autocomplete (#193): the active `@query` under the caret and the
  // highlighted candidate. Everyone but yourself is mentionable.
  const [mention, setMention] = React.useState<ActiveMention | null>(null)
  const [mentionIndex, setMentionIndex] = React.useState(0)
  const mentionCandidates = React.useMemo(() => {
    if (!mention) return []
    return matchMembers(members.filter((m) => m.id !== me.id), mention.query).slice(0, 6)
  }, [mention, members, me.id])
  // Stable ids so the composer can announce the active option to screen readers
  // via aria-activedescendant (mirrors place-autocomplete's combobox wiring).
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
    // Restore focus and caret after React re-renders the controlled textarea.
    requestAnimationFrame(() => {
      const el = composerRef.current
      if (el) {
        el.focus()
        el.setSelectionRange(next.caret, next.caret)
      }
    })
  }

  React.useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth', block: 'end' })
  }, [count])

  const byId = React.useMemo(
    () => new Map((messages.data ?? []).map((m) => [m.id, m])),
    [messages.data]
  )
  const pinned = (messages.data ?? []).filter((m) => m.pinned)
  const replyAuthor = replyTo?.member_id ? membersById.get(replyTo.member_id) : null

  async function send() {
    const content = draft.trim()
    if (content.length > MESSAGE_MAX_LENGTH) return
    // Send when there's text, an image, or both — but never an empty message.
    if (!content && !attachment) return
    const previousReplyTo = replyTo
    const reply = replyTo?.id ?? null
    const sendingFile = attachment
    // Optimistically clear the typed context so a successful send feels instant.
    // The image chip stays until the upload resolves (it's mid-flight), then
    // clears on success — on failure it's left so the user can retry.
    setDraft('')
    setReplyTo(null)
    setMention(null)
    try {
      await sendMessage.mutateAsync({ content, replyTo: reply, image: sendingFile })
      // Only drop the attachment if the user hasn't swapped in a new one since.
      setAttachment((current) => (current === sendingFile ? null : current))
    } catch {
      // The send failed (useSendMessage already surfaces a toast). Restore the
      // user's typed text and reply context so their input isn't lost — but only
      // if they haven't started composing something new in the meantime.
      setDraft((current) => (current.trim() ? current : content))
      setReplyTo((current) => current ?? previousReplyTo)
    }
  }

  return (
    <div className="flex h-[calc(100dvh-10.5rem)] flex-col md:h-[calc(100dvh-7rem)]">
      <div className="mb-3">
        <h1 className="font-display text-2xl font-bold tracking-tight md:text-3xl">Chat</h1>
      </div>

      {pinned.length > 0 && (
        <div className="mb-3 space-y-1 rounded-xl border border-accent/30 bg-accent-soft/50 p-3">
          {pinned.map((m) => (
            <p key={m.id} className="flex items-start gap-1.5 text-xs text-ink-soft">
              <Pin className="mt-0.5 size-3 shrink-0 text-accent" />
              <span className="line-clamp-1">
                <strong>{(m.member_id && membersById.get(m.member_id)?.display_name) ?? 'Someone'}:</strong>{' '}
                {mentionsToPlainText(m.content)}
              </span>
            </p>
          ))}
        </div>
      )}

      <div className="scrollbar-thin flex-1 space-y-4 overflow-y-auto pb-4 pr-1">
        {messages.isLoading ? (
          <div className="space-y-3">
            <Skeleton className="h-14 w-2/3" />
            <Skeleton className="ml-auto h-14 w-2/3" />
            <Skeleton className="h-14 w-1/2" />
          </div>
        ) : messages.isError ? (
          <ErrorState onRetry={() => messages.refetch()} isRetrying={messages.isFetching} />
        ) : messages.data!.length === 0 ? (
          <EmptyState
            icon={MessageCircle}
            title="Say hi 👋"
            description="This is your group's planning chat. Way better than 400 unread messages."
          />
        ) : (
          messages.data!.map((m, i) => {
            const prev = messages.data![i - 1]
            const newDay =
              !prev || !isSameDay(parseISO(prev.created_at), parseISO(m.created_at))
            return (
              <React.Fragment key={m.id}>
                {newDay && (
                  <div className="flex items-center gap-3 py-1">
                    <div className="h-px flex-1 bg-line" />
                    <span className="text-xs font-medium text-faint">
                      {format(parseISO(m.created_at), 'EEEE, MMM d')}
                    </span>
                    <div className="h-px flex-1 bg-line" />
                  </div>
                )}
                <Bubble message={m} byId={byId} onReply={setReplyTo} onOpenImage={setLightbox} />
              </React.Fragment>
            )
          })
        )}
        <div ref={bottomRef} />
      </div>

      <motion.div
        initial={{ opacity: 0, y: 8 }}
        animate={{ opacity: 1, y: 0 }}
        className="border-t border-line pt-3"
        // Claim file drags so the browser doesn't navigate to the dropped image
        // (dragover must preventDefault for a drop to fire at all).
        onDragOver={(e) => {
          if (e.dataTransfer.types.includes('Files')) e.preventDefault()
        }}
        onDrop={(e) => {
          if (!e.dataTransfer.types.includes('Files')) return
          e.preventDefault()
          attachImage(e.dataTransfer.files[0])
        }}
      >
        {replyTo && (
          <div className="mb-2 flex items-center justify-between rounded-lg bg-sunken px-3 py-1.5 text-xs">
            <span className="line-clamp-1 text-muted">
              Replying to <strong>{replyAuthor?.display_name ?? 'someone'}</strong>: {mentionsToPlainText(replyTo.content)}
            </span>
            <Button variant="ghost" size="icon" className="size-6" onClick={() => setReplyTo(null)} aria-label="Cancel reply">
              <X className="size-3.5" />
            </Button>
          </div>
        )}
        {attachment && (
          <div className="mb-2 inline-flex max-w-full items-center gap-2 rounded-xl border border-line bg-surface py-1.5 pl-3 pr-2 text-xs text-ink-soft">
            <ImagePlus className="size-4 shrink-0 text-muted" />
            <span className="truncate">{attachment.name}</span>
            <Button
              variant="ghost"
              size="icon"
              className="size-7 shrink-0"
              onClick={() => setAttachment(null)}
              aria-label="Remove image"
            >
              <X className="size-3.5" />
            </Button>
          </div>
        )}
        <input
          ref={fileInputRef}
          type="file"
          accept="image/png,image/jpeg,image/gif,image/webp"
          className="hidden"
          onChange={(e) => {
            attachImage(e.target.files?.[0])
            // Reset so picking the same file again still fires onChange.
            e.target.value = ''
          }}
        />
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
                    // mousedown (not click) so the textarea keeps focus/selection
                    // through the insert; preventDefault stops the blur.
                    onMouseDown={(e) => {
                      e.preventDefault()
                      pickMention(m)
                    }}
                    onMouseEnter={() => setMentionIndex(i)}
                    className={cn(
                      // min-h-11 keeps each row at the 44px mobile tap floor.
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
          <Button
            variant="ghost"
            size="icon"
            className="size-11 shrink-0 rounded-xl"
            onClick={() => fileInputRef.current?.click()}
            aria-label="Attach an image"
          >
            <ImagePlus />
          </Button>
          <Textarea
            ref={composerRef}
            placeholder="Message the group…"
            value={draft}
            rows={1}
            role="combobox"
            aria-expanded={mentionOpen}
            aria-autocomplete="list"
            aria-controls={mentionOpen ? mentionListboxId : undefined}
            aria-activedescendant={mentionOpen ? mentionOptionId(mentionIndex) : undefined}
            onChange={(e) => {
              setDraft(e.target.value)
              syncMention(e.target)
              setMentionIndex(0)
            }}
            onPaste={(e) => {
              // Pasting an image from the clipboard attaches it (desktop).
              const file = [...e.clipboardData.items]
                .find((it) => it.kind === 'file' && it.type.startsWith('image/'))
                ?.getAsFile()
              if (file) {
                e.preventDefault()
                attachImage(file)
              }
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
                void send()
              }
            }}
            aria-invalid={draft.length > MESSAGE_MAX_LENGTH}
            className="max-h-40 min-h-11 flex-1 resize-none"
          />
          <Button
            size="icon"
            className="size-11 shrink-0 rounded-xl"
            disabled={
              (!draft.trim() && !attachment) ||
              draft.length > MESSAGE_MAX_LENGTH ||
              sendMessage.isPending
            }
            onClick={send}
            aria-label="Send message"
          >
            <SendHorizonal />
          </Button>
        </div>
        {draft.length > MESSAGE_MAX_LENGTH && (
          <p className="mt-1 text-xs text-danger">Keep it under {MESSAGE_MAX_LENGTH} characters</p>
        )}
      </motion.div>

      <ImageLightbox src={lightbox} open={lightbox !== null} onOpenChange={(o) => !o && setLightbox(null)} />
    </div>
  )
}
