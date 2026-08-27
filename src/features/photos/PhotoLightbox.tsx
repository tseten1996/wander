import * as DialogPrimitive from '@radix-ui/react-dialog'
import { Link } from 'react-router-dom'
import { ChevronLeft, ChevronRight, ExternalLink, ImageOff, Trash2, X } from 'lucide-react'
import { MemberAvatar } from '@/components/ui/avatar'
import { timeAgo } from '@/lib/utils'
import type { Member } from '@/types'
import type { GalleryPhoto } from './gallery'

const SOURCE_LABEL: Record<GalleryPhoto['source'], string> = {
  chat: 'From chat',
  inspiration: 'From ideas',
  upload: 'Uploaded',
}

/**
 * Full-bleed viewer for a gallery photo (#294). Like the chat ImageLightbox it is
 * built on the Radix Dialog primitives directly (focus trap, Escape, scroll lock,
 * `aria-modal`) rather than the padded app DialogContent, because a lightbox wants
 * an edge-to-edge image on a dark scrim. It adds a caption bar — who added it,
 * when, a deep-link back to the source, and (for direct uploads the viewer may
 * remove) a delete button — plus prev/next paging with the arrow keys.
 */
export function PhotoLightbox({
  photo,
  tripId,
  member,
  canDelete,
  hasPrev,
  hasNext,
  onPrev,
  onNext,
  onDelete,
  onOpenChange,
}: {
  photo: GalleryPhoto | null
  tripId: string
  member: Member | null
  canDelete: boolean
  hasPrev: boolean
  hasNext: boolean
  onPrev: () => void
  onNext: () => void
  onDelete: (photo: GalleryPhoto) => void
  onOpenChange: (open: boolean) => void
}) {
  return (
    <DialogPrimitive.Root open={photo !== null} onOpenChange={onOpenChange}>
      <DialogPrimitive.Portal>
        <DialogPrimitive.Overlay className="fixed inset-0 z-50 bg-black/80 backdrop-blur-sm data-[state=open]:animate-in data-[state=open]:fade-in-0 data-[state=closed]:animate-out data-[state=closed]:fade-out-0" />
        <DialogPrimitive.Content
          aria-label="Photo preview"
          onKeyDown={(e) => {
            if (e.key === 'ArrowLeft' && hasPrev) onPrev()
            if (e.key === 'ArrowRight' && hasNext) onNext()
          }}
          className="fixed left-1/2 top-1/2 z-50 flex max-h-[92dvh] w-[92vw] max-w-3xl -translate-x-1/2 -translate-y-1/2 flex-col items-center outline-none data-[state=open]:animate-in data-[state=open]:fade-in-0 data-[state=open]:zoom-in-95 data-[state=open]:duration-200 data-[state=closed]:animate-out data-[state=closed]:fade-out-0"
        >
          <DialogPrimitive.Title className="sr-only">Photo preview</DialogPrimitive.Title>

          {photo && (
            <div className="flex max-h-[92dvh] w-full flex-col overflow-hidden rounded-xl bg-surface shadow-lift">
              <div className="relative flex min-h-0 flex-1 items-center justify-center bg-black">
                {photo.url ? (
                  <img
                    src={photo.url}
                    alt={member ? `Shared by ${member.display_name}` : 'Trip photo'}
                    className="max-h-[76dvh] max-w-full object-contain"
                  />
                ) : (
                  <div className="flex flex-col items-center gap-2 px-8 py-20 text-white/70">
                    <ImageOff className="size-8" />
                    <p className="text-sm">This photo is unavailable.</p>
                  </div>
                )}

                {hasPrev && (
                  <button
                    type="button"
                    data-icon-button=""
                    onClick={onPrev}
                    aria-label="Previous photo"
                    className="absolute left-2 top-1/2 flex size-11 -translate-y-1/2 items-center justify-center rounded-full bg-black/50 text-white transition-colors hover:bg-black/70"
                  >
                    <ChevronLeft className="size-6" />
                  </button>
                )}
                {hasNext && (
                  <button
                    type="button"
                    data-icon-button=""
                    onClick={onNext}
                    aria-label="Next photo"
                    className="absolute right-2 top-1/2 flex size-11 -translate-y-1/2 items-center justify-center rounded-full bg-black/50 text-white transition-colors hover:bg-black/70"
                  >
                    <ChevronRight className="size-6" />
                  </button>
                )}
              </div>

              {/* Caption bar: who / when / source, with a back-link and delete. */}
              <div className="flex items-center gap-3 border-t border-line px-4 py-3">
                <div className="flex min-w-0 flex-1 items-center gap-2.5">
                  {member ? (
                    <MemberAvatar name={member.display_name} color={member.color} size="sm" />
                  ) : null}
                  <div className="min-w-0">
                    <p className="truncate text-sm font-medium">
                      {member?.display_name ?? 'A member'}
                    </p>
                    <p className="text-xs text-muted">
                      {SOURCE_LABEL[photo.source]} · {timeAgo(photo.createdAt)}
                    </p>
                  </div>
                </div>
                {photo.source_anchor && (
                  <Link
                    to={`/trip/${tripId}/${photo.source_anchor}`}
                    onClick={() => onOpenChange(false)}
                    className="inline-flex items-center gap-1 rounded-lg px-2.5 py-2 text-xs font-medium text-primary transition-colors hover:bg-primary-faint"
                  >
                    <ExternalLink className="size-3.5" />
                    {photo.source === 'chat' ? 'Open in chat' : 'Open in ideas'}
                  </Link>
                )}
                {canDelete && (
                  <button
                    type="button"
                    data-icon-button=""
                    onClick={() => onDelete(photo)}
                    aria-label="Delete photo"
                    className="flex size-11 items-center justify-center rounded-lg text-danger transition-colors hover:bg-danger-soft md:size-9"
                  >
                    <Trash2 className="size-4" />
                  </button>
                )}
              </div>
            </div>
          )}

          <DialogPrimitive.Close
            data-icon-button=""
            className="absolute -top-12 right-0 flex items-center justify-center rounded-lg bg-black/50 p-2 text-white transition-colors hover:bg-black/70"
          >
            <X className="size-5" />
            <span className="sr-only">Close</span>
          </DialogPrimitive.Close>
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  )
}
