import { CURRENCIES } from '@/lib/rates'
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from './select'

/*
  The picker for a trip's base currency. It offers the same ECB-covered ISO
  4217 set the Budget FX picker uses (`src/lib/rates.ts`) — a single source of
  truth, so any currency a trip can be set to is one the budget converter can
  also handle. Sorted by code for a stable, scannable list.
*/
const OPTIONS = [...CURRENCIES].sort((a, b) => a.code.localeCompare(b.code))

export function CurrencySelect({
  value,
  onValueChange,
  id,
  disabled,
  'aria-invalid': ariaInvalid,
}: {
  value: string
  onValueChange: (code: string) => void
  id?: string
  disabled?: boolean
  'aria-invalid'?: boolean
}) {
  return (
    <Select value={(value || '').toUpperCase()} onValueChange={onValueChange} disabled={disabled}>
      <SelectTrigger id={id} aria-invalid={ariaInvalid} aria-label="Currency">
        <SelectValue placeholder="Choose a currency" />
      </SelectTrigger>
      <SelectContent>
        {OPTIONS.map((c) => (
          <SelectItem key={c.code} value={c.code}>
            {c.code} · {c.name}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  )
}
