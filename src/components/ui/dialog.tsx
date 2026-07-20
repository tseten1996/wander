import * as React from 'react'
import * as DialogPrimitive from '@radix-ui/react-dialog'
import { X } from 'lucide-react'
import { cn } from '@/lib/utils'

export const Dialog = DialogPrimitive.Root
export const DialogTrigger = DialogPrimitive.Trigger
export const DialogClose = DialogPrimitive.Close

export function DialogContent({
  className,
  children,
  ...props
}: React.ComponentPropsWithoutRef<typeof DialogPrimitive.Content>) {
  return (
    <DialogPrimitive.Portal>
      <DialogPrimitive.Overlay className="fixed inset-0 z-50 bg-black/40 backdrop-blur-[2px] data-[state=open]:animate-in data-[state=open]:fade-in-0" />
      <DialogPrimitive.Content
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
          className
        )}
        {...props}
      >
        <div className="overflow-y-auto p-6 pb-[max(1.5rem,env(safe-area-inset-bottom))]">
          {children}
        </div>
        <DialogPrimitive.Close
          data-icon-button=""
          className="absolute right-4 top-4 flex items-center justify-center rounded-lg p-1.5 text-muted transition-colors hover:bg-sunken hover:text-ink"
        >
          <X className="size-4" />
          <span className="sr-only">Close</span>
        </DialogPrimitive.Close>
      </DialogPrimitive.Content>
    </DialogPrimitive.Portal>
  )
}

export function DialogHeader({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) {
  return <div className={cn('mb-4 flex flex-col gap-1 pr-8', className)} {...props} />
}

export const DialogTitle = React.forwardRef<
  React.ComponentRef<typeof DialogPrimitive.Title>,
  React.ComponentPropsWithoutRef<typeof DialogPrimitive.Title>
>(({ className, ...props }, ref) => (
  <DialogPrimitive.Title
    ref={ref}
    className={cn('font-display text-lg font-semibold', className)}
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
