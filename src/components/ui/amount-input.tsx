import * as React from 'react'
import { cn } from '@/lib/utils'
import { inputClasses } from './input'

/*
  A numeric Input with the currency it's denominated in shown as a trailing
  affix, so an amount box is never a naked number a member has to guess the
  unit of. The affix is a token-styled `text-muted` code (e.g. "JPY"), not a
  symbol — a code is unambiguous where "$" is not — and it's wired to the field
  via `aria-describedby`, so a screen reader announces the currency after the
  label. `pr-14` keeps typed digits clear of the affix.
*/
export const AmountInput = React.forwardRef<
  HTMLInputElement,
  React.InputHTMLAttributes<HTMLInputElement> & { currency: string }
>(({ currency, className, 'aria-describedby': describedBy, ...props }, ref) => {
  const affixId = React.useId()
  return (
    <div className="relative">
      <input
        ref={ref}
        data-tap-target=""
        className={cn(inputClasses, 'pr-14', className)}
        aria-describedby={[describedBy, affixId].filter(Boolean).join(' ') || undefined}
        {...props}
      />
      <span
        id={affixId}
        className="pointer-events-none absolute inset-y-0 right-3.5 flex items-center text-xs font-medium text-muted"
      >
        {currency.toUpperCase()}
      </span>
    </div>
  )
})
AmountInput.displayName = 'AmountInput'
