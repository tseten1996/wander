import * as React from 'react'
import { cn } from '@/lib/utils'

/*
  Both controls style `aria-invalid` so a field with a validation error reads
  as broken at the control itself (danger border + soft danger ring), not
  only in the helper text below it. Forms opt in per-field with
  `aria-invalid={error ? true : undefined}` — which also tells screen
  readers the field is invalid, so the visual and a11y signals stay in sync.
  The stacked `aria-invalid:focus:` variants out-rank the plain `focus:`
  styles by selector specificity, so a focused invalid field stays red
  instead of flipping back to the primary teal.
*/
export const Input = React.forwardRef<HTMLInputElement, React.InputHTMLAttributes<HTMLInputElement>>(
  ({ className, ...props }, ref) => (
    <input
      ref={ref}
      data-tap-target=""
      className={cn(
        'flex h-10 w-full rounded-xl border border-line bg-surface px-3.5 text-sm text-ink placeholder:text-faint',
        'transition-colors hover:border-line-strong focus:border-primary focus:outline-none focus:ring-2 focus:ring-primary/20',
        'aria-invalid:border-danger aria-invalid:ring-2 aria-invalid:ring-danger/10',
        'aria-invalid:focus:border-danger aria-invalid:focus:ring-danger/25',
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
      'transition-colors hover:border-line-strong focus:border-primary focus:outline-none focus:ring-2 focus:ring-primary/20',
      'aria-invalid:border-danger aria-invalid:ring-2 aria-invalid:ring-danger/10',
      'aria-invalid:focus:border-danger aria-invalid:focus:ring-danger/25',
      'disabled:cursor-not-allowed disabled:opacity-50 resize-y',
      className
    )}
    {...props}
  />
))
Textarea.displayName = 'Textarea'
