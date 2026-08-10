import { useTripContext } from '@/hooks/useTrip'
import { cn } from '@/lib/utils'
import { parseMentions } from './mentions'

/**
 * Renders chat message content, turning `@[Name](id)` tokens into inline
 * mention chips (#193). Each mention is resolved by id to the live member so a
 * renamed member's chip updates; a mention of a member who has since left falls
 * back to the snapshotted name. The chip addressed to the *current* member is
 * visually distinct (a ring) so they can see at a glance they're the one being
 * pinged.
 *
 * `onPrimary` tunes the palette for the sender's own bubble, whose background
 * is the primary colour, keeping chips legible there.
 */
export function MentionText({ content, onPrimary = false }: { content: string; onPrimary?: boolean }) {
  const { me, membersById } = useTripContext()
  const segments = parseMentions(content)

  return (
    <>
      {segments.map((seg, i) => {
        if (seg.type === 'text') return <span key={i}>{seg.value}</span>
        const member = membersById.get(seg.memberId)
        const isMe = seg.memberId === me.id
        return (
          <span
            key={i}
            data-mention={isMe ? 'me' : ''}
            className={cn(
              'rounded px-1 font-semibold',
              onPrimary ? 'bg-on-primary/20 text-on-primary' : 'bg-primary-faint text-primary',
              isMe && 'ring-1 ring-current'
            )}
          >
            @{member?.display_name ?? seg.name}
          </span>
        )
      })}
    </>
  )
}
