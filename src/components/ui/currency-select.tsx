import { CURRENCIES } from '@/lib/rates'
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from '@/components/ui/select'

/**
 * A trip-currency picker over the known ISO 4217 codes (the ECB set the
 * Budget's live rates also cover — see `@/lib/rates`). Kept in `components/ui`
 * and sourced from `lib`, so create-trip and Settings share one control and
 * neither re-lists currencies. The value is always a canonical uppercase code,
 * which is what `Intl.NumberFormat` and `formatMoney` expect — so the free-text
 * "any 3 characters" box (which let `XYZ` through) can't recur.
 */
export function CurrencySelect({
  value,
  onValueChange,
  id,
  disabled,
  ariaInvalid,
  ariaLabel,
}: {
  value: string
  onValueChange: (value: string) => void
  id?: string
  disabled?: boolean
  ariaInvalid?: boolean
  ariaLabel?: string
}) {
  return (
    <Select value={value?.toUpperCase()} onValueChange={onValueChange} disabled={disabled}>
      <SelectTrigger id={id} aria-invalid={ariaInvalid} aria-label={ariaLabel}>
        <SelectValue placeholder="Choose a currency" />
      </SelectTrigger>
      <SelectContent>
        {CURRENCIES.map((c) => (
          <SelectItem key={c.code} value={c.code}>
            {c.code} · {c.name}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  )
}
