import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { toast } from 'sonner'
import { supabase } from '@/lib/supabase'
import { friendlyError } from '@/lib/errors'
import { notify } from '@/lib/notify'
import { extractMentionIds, mentionsToPlainText } from '@/features/messages/mentions'
import { tallyCommentActivity, truncateMentionTitle } from './tally'
import type { EntityCommentActivity } from './tally'
import type { Comment, CommentEntityType } from '@/types'

/** A comment thread for one entity (an itinerary item today), oldest-first —
 *  the same order chat renders in. Exported as a plain function so the query
 *  key can be warmed elsewhere without this module losing its role as the only
 *  place that reads the `comments` table. */
export async function fetchComments(
  tripId: string,
  entityType: CommentEntityType,
  entityId: string
): Promise<Comment[]> {
  const { data, error } = await supabase
    .from('comments')
    .select('*')
    .eq('trip_id', tripId)
    .eq('entity_type', entityType)
    .eq('entity_id', entityId)
    .order('created_at', { ascending: true })
  if (error) throw error
  return data as Comment[]
}

export function useComments(
  tripId: string,
  entityType: CommentEntityType,
  entityId: string | null
) {
  return useQuery({
    queryKey: ['comments', tripId, entityType, entityId],
    queryFn: () => fetchComments(tripId, entityType, entityId as string),
    // Only fetch a thread when an entity is actually open (the item dialog).
    enabled: !!entityId,
  })
}

/**
 * Per-entity comment activity for a whole trip, as
 * `entity_id → {count, newestAt, newestBy}`. One cheap query drives every count
 * badge *and* its unread dot (#342): it selects only `entity_id, created_at,
 * member_id` and tallies client-side, so an entity with no comments is absent
 * from the map and renders exactly as today. Keyed under the `comment_counts`
 * prefix (distinct from the per-thread `comments` key) so realtime invalidates
 * both — which is what makes a dot appear live when another member comments.
 */
export async function fetchCommentActivity(
  tripId: string,
  entityType: CommentEntityType
): Promise<Map<string, EntityCommentActivity>> {
  const { data, error } = await supabase
    .from('comments')
    .select('entity_id, created_at, member_id')
    .eq('trip_id', tripId)
    .eq('entity_type', entityType)
  if (error) throw error
  return tallyCommentActivity(
    data as { entity_id: string; created_at: string; member_id: string | null }[]
  )
}

export function useCommentActivity(tripId: string, entityType: CommentEntityType) {
  return useQuery({
    queryKey: ['comment_counts', tripId, entityType],
    queryFn: () => fetchCommentActivity(tripId, entityType),
  })
}

function useInvalidate(
  tripId: string,
  entityType: CommentEntityType,
  entityId: string
) {
  const queryClient = useQueryClient()
  return () => {
    queryClient.invalidateQueries({ queryKey: ['comments', tripId, entityType, entityId] })
    queryClient.invalidateQueries({ queryKey: ['comment_counts', tripId, entityType] })
  }
}

export function useAddComment(
  tripId: string,
  entityType: CommentEntityType,
  entityId: string,
  memberId: string
) {
  const invalidate = useInvalidate(tripId, entityType, entityId)
  return useMutation({
    mutationFn: async (body: string) => {
      const { error } = await supabase.from('comments').insert({
        trip_id: tripId,
        entity_type: entityType,
        entity_id: entityId,
        member_id: memberId,
        body,
      })
      if (error) throw error
      // Ping every member @-mentioned in the comment, reusing the chat path's
      // `mention` notification unchanged (#193). notify() drops the author and
      // duplicates, so a self-mention or a repeated mention is a no-op. The
      // notification points at the item (entity_id) so its inbox row names the
      // plan the discussion is about.
      const mentioned = extractMentionIds(body)
      if (mentioned.length > 0) {
        const plain = mentionsToPlainText(body)
        notify({
          tripId,
          actorId: memberId,
          recipientIds: mentioned,
          type: 'mention',
          entityId,
          title: truncateMentionTitle(plain),
        })
      }
    },
    onSuccess: invalidate,
    onError: (err) => toast.error(friendlyError(err, 'Could not post that comment')),
  })
}

export function useDeleteComment(
  tripId: string,
  entityType: CommentEntityType,
  entityId: string
) {
  const invalidate = useInvalidate(tripId, entityType, entityId)
  return useMutation({
    mutationFn: async (id: string) => {
      const { error } = await supabase.from('comments').delete().eq('id', id)
      if (error) throw error
    },
    onSuccess: invalidate,
    onError: (err) => toast.error(friendlyError(err, 'Could not delete that comment')),
  })
}
