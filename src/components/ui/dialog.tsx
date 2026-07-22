import * as React from 'react'
import * as DialogPrimitive from '@radix-ui/react-dialog'
import { X } from 'lucide-react'
import { cn, isMobileViewport } from '@/lib/utils'

export const Dialog = DialogPrimitive.Root
export const DialogTrigger = DialogPrimitive.Trigger
export const DialogClose = DialogPrimitive.Close

/*
  Close-restore bookkeeping (#44). Dialogs here are opened by plain
  state-setting buttons (not DialogPrimitive.Trigger), so Radix's built-in
  restore targets a null triggerRef and focus fell to <body> on close. There
  is also no component-lifecycle moment that reliably precedes React's
  autoFocus, so track the last element focused OUTSIDE any overlay at the
  document level — that element is the opener (or, for dialogs launched from
  a dropdown item, the dropdown's own trigger, which is the right target
  since the item unmounts with the menu).
*/
let lastFocusOutsideOverlays: HTMLElement | null = null
if (typeof document !== 'undefined') {
  document.addEventListener(
    'focusin',
    (e) => {
      const t = e.target
      if (
        t instanceof HTMLElement &&
        !t.closest('[role="dialog"], [role="alertdialog"], [role="menu"], [role="listbox"]')
      ) {
        lastFocusOutsideOverlays = t
      }
    },
    true
  )
}

export function DialogContent({
  className,
  children,
  onOpenAutoFocus,
  onCloseAutoFocus,
  ...props
}: React.ComponentPropsWithoutRef<typeof DialogPrimitive.Content>) {
  const handleCloseAutoFocus = (e: Event) => {
    onCloseAutoFocus?.(e)
    const opener = lastFocusOutsideOverlays
    if (!e.defaultPrevented && opener?.isConnected) {
      e.preventDefault()
      opener.focus()
    }
  }
  // On mobile, opening a sheet must not summon the on-screen keyboard over
  // it: stop Radix from focusing the first tabbable (usually a text input).
  // Focus still moves INSIDE the dialog (#44) — onto the sheet container
  // itself (tabIndex -1 below) — so screen readers and Escape land in the
  // right place without any text control holding focus. Desktop keeps the
  // type-immediately behavior. Radix restores focus to the trigger on close.
  const contentRef = React.useRef<React.ComponentRef<typeof DialogPrimitive.Content>>(null)
  const handleOpenAutoFocus = (e: Event) => {
    onOpenAutoFocus?.(e)
    if (!e.defaultPrevented && isMobileViewport()) {
      e.preventDefault()
      contentRef.current?.focus()
    }
  }
  return (
    <DialogPrimitive.Portal>
      <DialogPrimitive.Overlay className="fixed inset-0 z-50 bg-black/40 backdrop-blur-[2px] data-[state=open]:animate-in data-[state=open]:fade-in-0 data-[state=closed]:animate-out data-[state=closed]:fade-out-0" />
      <DialogPrimitive.Content
        ref={contentRef}
        tabIndex={-1}
        onOpenAutoFocus={handleOpenAutoFocus}
        onCloseAutoFocus={handleCloseAutoFocus}
        className={cn(
          // Bottom sheet on mobile, centered dialog on desktop. The close
          // button lives outside the scrollable inner div (below) so it
          // stays pinned in the corner instead of scrolling away with tall
          // form content — the mobile/desktop switch matches the app's
          // md (768px) breakpoint everywhere else (index.css tap-target
          // floors, TripLayout sidebar/nav), not Tailwind's default sm.
          'fixed z-50 flex flex-col bg-elevated shadow-lift outline-none',
          'inset-x-0 bottom-0 rounded-t-3xl border-t border-line max-h-[92dvh]',
          'md:inset-x-auto md:bottom-auto md:left-1/2 md:top-1/2 md:max-h-[85dvh] md:w-full md:max-w-lg md:-translate-x-1/2 md:-translate-y-1/2 md:rounded-2xl md:border',
          // Mobile: slide up from the bottom edge like a native sheet
          // (no fade — sheets travel, they don't materialize).
          'data-[state=open]:animate-in data-[state=open]:slide-in-from-bottom-[100%] data-[state=open]:duration-300 data-[state=open]:ease-out',
          'data-[state=closed]:animate-out data-[state=closed]:slide-out-to-bottom-[100%] data-[state=closed]:duration-200 data-[state=closed]:ease-in',
          // Desktop: fade + gentle zoom. The slide-from-left-1/2/top-[48%]
          // pair isn't decorative — animate-in's keyframe transform replaces
          // the static centering translate while it runs, so the enter/exit
          // translate must restate ~the same offset or the dialog visibly
          // jumps from the top-left corner to center when the animation ends
          // (same trick shadcn/ui uses for centered dialogs).
          'md:data-[state=open]:slide-in-from-left-1/2 md:data-[state=open]:slide-in-from-top-[48%] md:data-[state=open]:fade-in-0 md:data-[state=open]:zoom-in-95 md:data-[state=open]:duration-200',
          'md:data-[state=closed]:slide-out-to-left-1/2 md:data-[state=closed]:slide-out-to-top-[48%] md:data-[state=closed]:fade-out-0 md:data-[state=closed]:zoom-out-95 md:data-[state=closed]:duration-150',
          className
        )}
        {...props}
      >
        <div
          aria-hidden
          className="mx-auto mb-1 mt-2.5 h-1 w-9 shrink-0 rounded-full bg-line-strong md:hidden"
        />
        <div className="overflow-y-auto overscroll-contain p-5 pt-2.5 pb-[max(1.25rem,env(safe-area-inset-bottom))] md:p-6">
          {children}
        </div>
        <DialogPrimitive.Close
          data-icon-button=""
          className="absolute right-2.5 top-2.5 flex items-center justify-center rounded-lg p-1.5 text-muted transition-colors hover:bg-sunken hover:text-ink md:right-4 md:top-4"
        >
          <X className="size-4" />
          <span className="sr-only">Close</span>
        </DialogPrimitive.Close>
      </DialogPrimitive.Content>
    </DialogPrimitive.Portal>
  )
}

export function DialogHeader({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) {
  return <div className={cn('mb-4 flex flex-col gap-1 pr-10 md:pr-8', className)} {...props} />
}

export const DialogTitle = React.forwardRef<
  React.ComponentRef<typeof DialogPrimitive.Title>,
  React.ComponentPropsWithoutRef<typeof DialogPrimitive.Title>
>(({ className, ...props }, ref) => (
  <DialogPrimitive.Title
    ref={ref}
    className={cn('font-display text-xl font-semibold tracking-tight md:text-lg', className)}
    {...props}
  />
))
DialogTitle.displayName = 'DialogTitle'

export const DialogDescription = React.forwardRef<
  React.ComponentRef<typeof DialogPrimitive.Description>,
  React.ComponentPropsWithoutRef<typeof DialogPrimitive.Description>
>(({ className, ...props }, ref) => (
  <DialogPrimitive.Description
    ref={ref}
    className={cn('text-sm text-muted', className)}
    {...props}
  />
))
DialogDescription.displayName = 'DialogDescription'
