import * as React from 'react'
import { cn } from '@/lib/utils'

export const Input = React.forwardRef<HTMLInputElement, React.InputHTMLAttributes<HTMLInputElement>>(
  ({ className, ...props }, ref) => (
    <input
      ref={ref}
      className={cn(
        'flex h-10 w-full rounded-xl border border-line bg-surface px-3.5 text-sm text-ink placeholder:text-faint',
        'transition-colors focus:border-primary focus:outline-none focus:ring-2 focus:ring-primary/20',
        'disabled:cursor-not-allowed disabled:opacity-50',
        className
      )}
      {...props}
    />
  )
)
Input.displayName = 'Input'

export const Textarea = React.forwardRef<
  HTMLTextAreaElement,
  React.TextareaHTMLAttributes<HTMLTextAreaElement>
>(({ className, ...props }, ref) => (
  <textarea
    ref={ref}
    className={cn(
      'flex min-h-20 w-full rounded-xl border border-line bg-surface px-3.5 py-2.5 text-sm text-ink placeholder:text-faint',
      'transition-colors focus:border-primary focus:outline-none focus:ring-2 focus:ring-primary/20',
      'disabled:cursor-not-allowed disabled:opacity-50 resize-y',
      className
    )}
    {...props}
  />
))
Textarea.displayName = 'Textarea'
