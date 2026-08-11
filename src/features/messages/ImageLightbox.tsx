import * as DialogPrimitive from '@radix-ui/react-dialog'
import { X } from 'lucide-react'

/**
 * Full-bleed image viewer for a chat image (#51). Built on the Radix Dialog
 * primitives directly rather than the app's DialogContent, because that one is
 * a padded card/bottom-sheet — a lightbox wants an edge-to-edge image on a dark
 * scrim. Radix gives us the focus trap, Escape-to-close, scroll lock, and
 * `aria-modal`; a pointer-down on the overlay (outside the image) closes it.
 */
export function ImageLightbox({
  src,
  open,
  onOpenChange,
}: {
  src: string | null
  open: boolean
  onOpenChange: (open: boolean) => void
}) {
  return (
    <DialogPrimitive.Root open={open} onOpenChange={onOpenChange}>
      <DialogPrimitive.Portal>
        <DialogPrimitive.Overlay className="fixed inset-0 z-50 bg-black/80 backdrop-blur-sm data-[state=open]:animate-in data-[state=open]:fade-in-0 data-[state=closed]:animate-out data-[state=closed]:fade-out-0" />
        <DialogPrimitive.Content
          aria-label="Image preview"
          className="fixed left-1/2 top-1/2 z-50 flex max-h-[92dvh] max-w-[92vw] -translate-x-1/2 -translate-y-1/2 outline-none data-[state=open]:animate-in data-[state=open]:fade-in-0 data-[state=open]:zoom-in-95 data-[state=open]:duration-200 data-[state=closed]:animate-out data-[state=closed]:fade-out-0"
        >
          <DialogPrimitive.Title className="sr-only">Image preview</DialogPrimitive.Title>
          {src && (
            <img
              src={src}
              alt="Shared in chat"
              className="max-h-[92dvh] max-w-full rounded-xl object-contain shadow-lift"
            />
          )}
          <DialogPrimitive.Close
            data-icon-button=""
            className="absolute right-2 top-2 flex items-center justify-center rounded-lg bg-black/50 p-2 text-white transition-colors hover:bg-black/70"
          >
            <X className="size-5" />
            <span className="sr-only">Close</span>
          </DialogPrimitive.Close>
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  )
}
