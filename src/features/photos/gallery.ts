import type { InspirationItem } from '@/types'
import type { MessageWithReactions } from '@/features/messages/api'
import type { TripPhotoWithUrl } from './api'
import { searchAnchorId } from '@/features/search/anchor'

/** Where a gallery photo came from — drives its badge, back-link and delete
 *  affordance. */
export type PhotoSource = 'chat' | 'inspiration' | 'upload'

/** One image in the aggregated gallery, normalised from its source row. */
export interface GalleryPhoto {
  /** Stable key across sources (`<source>-<row id>`). */
  key: string
  /** Resolved image URL: a signed URL for chat/upload, the pasted URL for an
   *  inspiration image. `null` means "known but unavailable" (signing failed). */
  url: string | null
  source: PhotoSource
  /** Who added it (`members.id`), or null if unknown / the member left. */
  memberId: string | null
  /** ISO timestamp the image entered the trip. */
  createdAt: string
  /** Trip-relative deep-link to the source item (`chat#…` / `ideas#…`), or null
   *  for a direct upload, which has no other home than the gallery. */
  source_anchor: string | null
  /** Direct uploads carry their pointer id + object path so the gallery can
   *  delete them; undefined for aggregated chat/inspiration images. */
  photoId?: string
  imagePath?: string
}

/** A calendar day's worth of photos, newest day first. */
export interface PhotoDay {
  /** `YYYY-MM-DD`, the local calendar day of every photo in `photos`. */
  date: string
  photos: GalleryPhoto[]
}

/** Local calendar day (`YYYY-MM-DD`) for an ISO timestamp — the grouping key. */
function dayKey(iso: string): string {
  const d = new Date(iso)
  const y = d.getFullYear()
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return `${y}-${m}-${day}`
}

/**
 * Merge the trip's three image sources — chat images, inspiration-board images,
 * and direct gallery uploads — into one list, newest first, grouped by calendar
 * day. Pure: it derives entirely from rows the feature hooks already hold, so the
 * gallery adds no Supabase access of its own beyond the uploads query.
 */
export function buildGallery(
  messages: MessageWithReactions[],
  inspiration: InspirationItem[],
  uploads: TripPhotoWithUrl[]
): PhotoDay[] {
  const photos: GalleryPhoto[] = []

  for (const m of messages) {
    if (!m.image_path) continue
    photos.push({
      key: `chat-${m.id}`,
      url: m.image_url ?? null,
      source: 'chat',
      memberId: m.member_id,
      createdAt: m.created_at,
      source_anchor: `chat#${searchAnchorId(m.id)}`,
    })
  }

  for (const i of inspiration) {
    if (!i.image_url) continue
    photos.push({
      key: `insp-${i.id}`,
      url: i.image_url,
      source: 'inspiration',
      memberId: i.created_by,
      createdAt: i.created_at,
      source_anchor: `ideas#${searchAnchorId(i.id)}`,
    })
  }

  for (const p of uploads) {
    photos.push({
      key: `upload-${p.id}`,
      url: p.image_url ?? null,
      source: 'upload',
      memberId: p.member_id,
      createdAt: p.created_at,
      source_anchor: null,
      photoId: p.id,
      imagePath: p.image_path,
    })
  }

  photos.sort((a, b) => b.createdAt.localeCompare(a.createdAt))

  const days: PhotoDay[] = []
  let current: PhotoDay | null = null
  for (const photo of photos) {
    const date = dayKey(photo.createdAt)
    if (!current || current.date !== date) {
      current = { date, photos: [] }
      days.push(current)
    }
    current.photos.push(photo)
  }
  return days
}
