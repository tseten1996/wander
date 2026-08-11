import * as React from 'react'
import { defaultTempUnit, type TempUnit } from '@/lib/units'

/*
  Device-local temperature-unit preference (issue #220). Mirrors `useTheme`:
  one localStorage key, read on mount, defaulting from the browser locale on
  first run. This is not trip or server state — it's how *this device* likes to
  read the weather — so it never touches Supabase, RLS, or any table.
*/

const KEY = 'wander_temp_unit'

function initialUnit(): TempUnit {
  try {
    const raw = localStorage.getItem(KEY)
    if (raw === 'C' || raw === 'F') return raw
  } catch {
    // Blocked/broken storage → fall back to the locale default.
  }
  return defaultTempUnit()
}

export function useTempUnit() {
  const [unit, setUnitState] = React.useState<TempUnit>(initialUnit)

  const setUnit = React.useCallback((next: TempUnit) => {
    setUnitState(next)
    try {
      localStorage.setItem(KEY, next)
    } catch {
      /* ignore — the in-memory state still updates for this session */
    }
  }, [])

  return { unit, setUnit }
}
