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
/* Shared by Input and by input-shaped triggers (e.g. the DateInput popover
   button) so they can't drift apart visually. */
export const inputClasses = cn(
  'flex h-10 w-full rounded-xl border border-line bg-surface px-3.5 text-sm text-ink placeholder:text-faint',
  'transition-colors hover:border-line-strong focus:border-primary focus:outline-none focus:ring-2 focus:ring-primary/20',
  'aria-invalid:border-danger aria-invalid:ring-2 aria-invalid:ring-danger/10',
  'aria-invalid:focus:border-danger aria-invalid:focus:ring-danger/25',
  'disabled:cursor-not-allowed disabled:opacity-50'
)

export const Input = React.forwardRef<HTMLInputElement, React.InputHTMLAttributes<HTMLInputElement>>(
  ({ className, ...props }, ref) => (
    <input
      ref={ref}
      data-tap-target=""
      className={cn(inputClasses, className)}
      {...props}
    />
  )
)
Input.displayName = 'Input'

/**
 * An Input with a static, non-interactive text affix pinned to its right edge —
 * used to hang a currency code (e.g. `USD`) off an amount field so the unit is
 * visible in the box itself. Number-input spin buttons are already suppressed
 * globally (`index.css`), so the affix never collides with them. The affix is
 * `aria-hidden` because a `<Label>` (or unit context) already names the field
 * for assistive tech; it's purely a visual unit cue.
 */
export const AffixInput = React.forwardRef<
  HTMLInputElement,
  React.InputHTMLAttributes<HTMLInputElement> & { affix: string }
>(({ affix, className, ...props }, ref) => (
  <div className="relative w-full">
    <input
      ref={ref}
      data-tap-target=""
      className={cn(inputClasses, 'pr-14', className)}
      {...props}
    />
    <span
      aria-hidden
      className="pointer-events-none absolute inset-y-0 right-3.5 flex items-center text-xs font-medium tabular-nums text-muted"
    >
      {affix}
    </span>
  </div>
))
AffixInput.displayName = 'AffixInput'

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
