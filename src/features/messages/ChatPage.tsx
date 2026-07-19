import * as React from 'react'
import { motion } from 'framer-motion'
import {
  CornerUpLeft, MessageCircle, MoreHorizontal, Pencil, Pin, PinOff,
  SendHorizonal, SmilePlus, Trash2, X,
} from 'lucide-react'
import { format, isSameDay, parseISO } from 'date-fns'
import { useTripContext } from '@/hooks/useTrip'
import {
  useDeleteMessage, useEditMessage, useMessages, useSendMessage,
  useSetPinned, useToggleReaction, type MessageWithReactions,
} from './api'
import { Button } from '@/components/ui/button'
import { Textarea } from '@/components/ui/input'
import { MemberAvatar } from '@/components/ui/avatar'
import { EmptyState, Skeleton } from '@/components/ui/misc'
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { cn } from '@/lib/utils'

const EMOJI = ['👍', '❤️', '😂', '😮', '🎉', '🤔']

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

function Bubble({
  message,
  byId,
  onReply,
}: {
  message: MessageWithReactions
  byId: Map<string, MessageWithReactions>
  onReply: (m: MessageWithReactions) => void
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
    <div className={cn('group flex gap-2.5', mine && 'flex-row-reverse')}>
      <MemberAvatar
        name={author?.display_name ?? 'Left the trip'}
        color={author?.color ?? '#a8a29e'}
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
            <span className="line-clamp-2">{repliedTo.content}</span>
          </div>
        )}

        {editing ? (
          <div className="space-y-2">
            <Textarea
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              className="min-h-16 text-left"
              autoFocus
            />
            <div className={cn('flex gap-2', mine && 'justify-end')}>
              <Button size="sm" variant="ghost" onClick={() => setEditing(false)}>
                Cancel
              </Button>
              <Button
                size="sm"
                disabled={!draft.trim()}
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
          <div
            className={cn(
              'inline-block whitespace-pre-wrap break-words rounded-2xl px-3.5 py-2 text-left text-sm',
              mine
                ? 'rounded-tr-sm bg-primary text-on-primary'
                : 'rounded-tl-sm border border-line bg-surface'
            )}
          >
            {message.content}
          </div>
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
            {mine && (
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
                <DropdownMenuItem destructive onClick={() => deleteMessage.mutate(message.id)}>
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
  const { trip, me, membersById } = useTripContext()
  const messages = useMessages(trip.id)
  const sendMessage = useSendMessage(trip.id, me.id)

  const [draft, setDraft] = React.useState('')
  const [replyTo, setReplyTo] = React.useState<MessageWithReactions | null>(null)
  const bottomRef = React.useRef<HTMLDivElement>(null)
  const count = messages.data?.length ?? 0

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
    if (!content) return
    setDraft('')
    const reply = replyTo?.id ?? null
    setReplyTo(null)
    await sendMessage.mutateAsync({ content, replyTo: reply })
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
                {m.content}
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
                <Bubble message={m} byId={byId} onReply={setReplyTo} />
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
      >
        {replyTo && (
          <div className="mb-2 flex items-center justify-between rounded-lg bg-sunken px-3 py-1.5 text-xs">
            <span className="line-clamp-1 text-muted">
              Replying to <strong>{replyAuthor?.display_name ?? 'someone'}</strong>: {replyTo.content}
            </span>
            <Button variant="ghost" size="icon" className="size-6" onClick={() => setReplyTo(null)} aria-label="Cancel reply">
              <X className="size-3.5" />
            </Button>
          </div>
        )}
        <div className="flex items-end gap-2">
          <Textarea
            placeholder="Message the group…"
            value={draft}
            rows={1}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault()
                void send()
              }
            }}
            className="max-h-40 min-h-11 flex-1 resize-none"
          />
          <Button
            size="icon"
            className="size-11 rounded-xl"
            disabled={!draft.trim() || sendMessage.isPending}
            onClick={send}
            aria-label="Send message"
          >
            <SendHorizonal />
          </Button>
        </div>
      </motion.div>
    </div>
  )
}
