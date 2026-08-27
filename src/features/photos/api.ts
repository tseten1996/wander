import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { toast } from 'sonner'
import { supabase } from '@/lib/supabase'
import { logActivity } from '@/lib/activity'
import { friendlyError } from '@/lib/errors'
import type { TripPhoto } from '@/types'

export type TripPhotoWithUrl = TripPhoto & {
  /** A short-lived signed read URL, resolved by `fetchTripPhotos`. Null if signing
   *  failed → the tile shows the "unavailable" fallback instead of a broken image. */
  image_url?: string | null
}

// ── Direct-upload photos (#294) ──────────────────────────────────────────────
// Uploads reuse the private `chat-images` bucket (#51): same bucket, same
// `<trip_id>/<uuid>.<ext>` path, same Storage RLS. Nothing new is exposed — a
// gallery upload is exactly as private as a chat image (this api.ts is the only
// place the photos feature touches Supabase).
export const PHOTOS_BUCKET = 'chat-images'
const MAX_IMAGE_BYTES = 5 * 1024 * 1024
// Mirrors the bucket's server-side MIME allowlist (see the chat-images migration).
const ALLOWED_IMAGE_TYPES = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp'])
/** Signed URLs live an hour; a page refetch renews them well inside that, so a
 *  photo never blanks out mid-session. */
const SIGNED_URL_TTL_SECONDS = 60 * 60

/** Reject a non-image or oversized file up front. Returns an error string for a
 *  toast, or null when the file is acceptable. */
export function validatePhoto(file: File): string | null {
  if (!ALLOWED_IMAGE_TYPES.has(file.type)) return 'That file isn’t a supported image (PNG, JPEG, GIF, or WebP).'
  if (file.size > MAX_IMAGE_BYTES) return 'That image is over 5 MB — please pick a smaller one.'
  return null
}

/** The trip's directly-uploaded photos, newest first, each with a short-lived
 *  signed read URL resolved in the same round-trip (the bucket is private). */
export async function fetchTripPhotos(tripId: string): Promise<TripPhotoWithUrl[]> {
  const { data, error } = await supabase
    .from('trip_photos')
    .select('*')
    .eq('trip_id', tripId)
    .order('created_at', { ascending: false })
  if (error) throw error
  const rows = data as TripPhotoWithUrl[]
  const paths = [...new Set(rows.map((p) => p.image_path))]
  if (paths.length > 0) {
    // A signing failure must degrade to "image unavailable", never break the whole
    // gallery — so it's caught, not thrown out of the query.
    try {
      const { data: signed } = await supabase.storage
        .from(PHOTOS_BUCKET)
        .createSignedUrls(paths, SIGNED_URL_TTL_SECONDS)
      const urls = new Map((signed ?? []).map((s) => [s.path, s.signedUrl]))
      for (const p of rows) p.image_url = urls.get(p.image_path) ?? null
    } catch {
      /* leave image_url unset → the tile shows the unavailable fallback */
    }
  }
  return rows
}

export function useTripPhotos(tripId: string) {
  return useQuery({
    queryKey: ['trip_photos', tripId],
    queryFn: () => fetchTripPhotos(tripId),
  })
}

export function useUploadPhoto(tripId: string, memberId: string) {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: async (file: File) => {
      // Upload first so the pointer row only ever references an object that exists.
      // The path's first segment is the trip id the Storage RLS checks.
      const ext = file.type.split('/')[1] ?? 'bin'
      const imagePath = `${tripId}/${crypto.randomUUID()}.${ext}`
      const { error: uploadError } = await supabase.storage
        .from(PHOTOS_BUCKET)
        .upload(imagePath, file, { contentType: file.type, upsert: false })
      if (uploadError) throw uploadError
      const { error } = await supabase
        .from('trip_photos')
        .insert({ trip_id: tripId, member_id: memberId, image_path: imagePath })
      if (error) {
        // The insert failed after the upload succeeded — remove the now-orphan
        // object (best effort) so a retry doesn't leave storage littered.
        await supabase.storage.from(PHOTOS_BUCKET).remove([imagePath]).catch(() => {})
        throw error
      }
      logActivity(tripId, memberId, 'added a photo')
    },
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['trip_photos', tripId] }),
    onError: (err) => toast.error(friendlyError(err, 'Could not add that photo')),
  })
}

export function useDeletePhoto(tripId: string) {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: async ({ id, imagePath }: { id: string; imagePath: string }) => {
      // Delete the row first (that's the visible action); then clean up its object
      // best-effort so a Storage hiccup never blocks the delete.
      const { error } = await supabase.from('trip_photos').delete().eq('id', id)
      if (error) throw error
      await supabase.storage.from(PHOTOS_BUCKET).remove([imagePath]).catch(() => {})
    },
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['trip_photos', tripId] }),
    onError: (err) => toast.error(friendlyError(err, 'Could not delete that photo')),
  })
}
