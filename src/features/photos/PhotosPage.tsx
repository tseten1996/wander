import * as React from 'react'
import { motion } from '@/lib/motion'
import { ImageOff, ImagePlus, Images } from 'lucide-react'
import { toast } from 'sonner'
import { useTripContext } from '@/hooks/useTrip'
import { useMessages } from '@/features/messages/api'
import { useInspiration } from '@/features/inspiration/api'
import { useTripPhotos, useUploadPhoto, useDeletePhoto, validatePhoto } from './api'
import { buildGallery, type GalleryPhoto } from './gallery'
import { PhotoLightbox } from './PhotoLightbox'
import { PageHeader } from '@/components/layout/PageHeader'
import { Button } from '@/components/ui/button'
import { EmptyState, ErrorState, Skeleton } from '@/components/ui/misc'
import { longDate } from '@/lib/utils'

/** A single grid tile — its own component so a failed image load is isolated to
 *  the tile and never breaks the surrounding grid. */
function PhotoTile({
  photo,
  dayLabel,
  onOpen,
}: {
  photo: GalleryPhoto
  dayLabel: string
  onOpen: () => void
}) {
  const [broken, setBroken] = React.useState(false)
  const unavailable = photo.url === null || broken

  return (
    <button
      type="button"
      onClick={onOpen}
      // Every tile would otherwise read the identical "Open photo"; naming the
      // day it belongs to makes the grid distinguishable when tabbed (#327).
      aria-label={`Open photo from ${dayLabel}`}
      className="group relative aspect-square overflow-hidden rounded-xl bg-sunken outline-none ring-primary/60 focus-visible:ring-2"
    >
      {unavailable ? (
        <span className="flex size-full items-center justify-center text-faint">
          <ImageOff className="size-6" />
        </span>
      ) : (
        <img
          src={photo.url ?? undefined}
          alt=""
          loading="lazy"
          onError={() => setBroken(true)}
          className="size-full object-cover transition-transform duration-200 group-hover:scale-105 motion-reduce:transition-none motion-reduce:group-hover:scale-100"
        />
      )}
    </button>
  )
}

export default function PhotosPage() {
  const { trip, me, isOwner, membersById } = useTripContext()
  const messages = useMessages(trip.id)
  const inspiration = useInspiration(trip.id)
  const uploads = useTripPhotos(trip.id)
  const uploadPhoto = useUploadPhoto(trip.id, me.id)
  const deletePhoto = useDeletePhoto(trip.id)

  const fileInput = React.useRef<HTMLInputElement>(null)
  const [selectedKey, setSelectedKey] = React.useState<string | null>(null)

  const days = React.useMemo(
    () => buildGallery(messages.data ?? [], inspiration.data ?? [], uploads.data ?? []),
    [messages.data, inspiration.data, uploads.data]
  )
  // Flat, newest-first order backing the lightbox's prev/next paging.
  const flat = React.useMemo(() => days.flatMap((d) => d.photos), [days])
  const selectedIndex = selectedKey ? flat.findIndex((p) => p.key === selectedKey) : -1
  const selected = selectedIndex >= 0 ? flat[selectedIndex] : null

  // Initial load: wait for all three sources to settle before deciding empty vs
  // full, so the empty state never flashes while chat/inspiration are still in
  // flight. If every source failed there's nothing to show — surface the error.
  const isLoading = messages.isLoading || inspiration.isLoading || uploads.isLoading
  const allError = messages.isError && inspiration.isError && uploads.isError

  function onPickFile(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0]
    e.target.value = '' // let the same file be re-picked after a failed upload
    if (!file) return
    const problem = validatePhoto(file)
    if (problem) {
      toast.error(problem)
      return
    }
    uploadPhoto.mutate(file, { onSuccess: () => toast.success('Photo added') })
  }

  const uploadAction = (
    <>
      <input
        ref={fileInput}
        type="file"
        accept="image/png,image/jpeg,image/gif,image/webp"
        className="hidden"
        onChange={onPickFile}
      />
      <Button onClick={() => fileInput.current?.click()} disabled={uploadPhoto.isPending}>
        <ImagePlus /> {uploadPhoto.isPending ? 'Adding…' : 'Add photo'}
      </Button>
    </>
  )

  return (
    <div>
      <PageHeader
        title="Photos"
        description="Every image from the trip — shared in chat, pinned to ideas, or added here — in one place."
        action={uploadAction}
      />

      {isLoading ? (
        <div className="grid grid-cols-3 gap-2 sm:grid-cols-4 lg:grid-cols-5">
          {Array.from({ length: 10 }).map((_, i) => (
            <Skeleton key={i} className="aspect-square rounded-xl" />
          ))}
        </div>
      ) : allError ? (
        <ErrorState
          onRetry={() => {
            messages.refetch()
            inspiration.refetch()
            uploads.refetch()
          }}
          isRetrying={messages.isFetching || inspiration.isFetching || uploads.isFetching}
        />
      ) : flat.length === 0 ? (
        <EmptyState
          icon={Images}
          title="No photos yet"
          description="Photos shared in chat or pinned to the ideas board show up here automatically — or add one straight to the gallery."
          action={uploadAction}
        />
      ) : (
        <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} className="space-y-7">
          {days.map((day) => {
            const dayLabel = longDate(day.date)
            return (
              <section key={day.date}>
                <h2 className="mb-2.5 text-sm font-semibold text-muted">{dayLabel}</h2>
                <div className="grid grid-cols-3 gap-2 sm:grid-cols-4 lg:grid-cols-5">
                  {day.photos.map((photo) => (
                    <PhotoTile
                      key={photo.key}
                      photo={photo}
                      dayLabel={dayLabel}
                      onOpen={() => setSelectedKey(photo.key)}
                    />
                  ))}
                </div>
              </section>
            )
          })}
        </motion.div>
      )}

      <PhotoLightbox
        photo={selected}
        tripId={trip.id}
        member={selected?.memberId ? membersById.get(selected.memberId) ?? null : null}
        canDelete={
          !!selected &&
          selected.source === 'upload' &&
          (isOwner || selected.memberId === me.id)
        }
        hasPrev={selectedIndex > 0}
        hasNext={selectedIndex >= 0 && selectedIndex < flat.length - 1}
        onPrev={() => {
          if (selectedIndex > 0) setSelectedKey(flat[selectedIndex - 1].key)
        }}
        onNext={() => {
          if (selectedIndex >= 0 && selectedIndex < flat.length - 1)
            setSelectedKey(flat[selectedIndex + 1].key)
        }}
        onDelete={(photo) => {
          if (!photo.photoId || !photo.imagePath) return
          deletePhoto.mutate(
            { id: photo.photoId, imagePath: photo.imagePath },
            {
              onSuccess: () => {
                toast.success('Photo removed')
                setSelectedKey(null)
              },
            }
          )
        }}
        onOpenChange={(open) => !open && setSelectedKey(null)}
      />
    </div>
  )
}
