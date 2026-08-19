import * as React from 'react'
import { Input } from '@/components/ui/input'
import { normalizeQuery, searchPlaces, type PlaceSuggestion } from '@/lib/geocode'
import { cn } from '@/lib/utils'

export interface PlaceAutocompleteProps
  extends Omit<React.InputHTMLAttributes<HTMLInputElement>, 'value' | 'onChange'> {
  value: string
  onChange: (value: string) => void
  /**
   * Fired when the user picks a suggestion (not on plain typing), carrying the
   * chosen place's coordinates alongside its label. Callers that need the
   * lat/lon — e.g. the itinerary form persisting a pin for the Map view (#61) —
   * opt in with this; the plain destination fields ignore it. Manual typing
   * emits only `onChange`, so a caller can treat "onChange without a following
   * onSelectPlace" as "coordinates no longer apply".
   */
  onSelectPlace?: (place: PlaceSuggestion) => void
}

/*
  Repeat lookups are common — retyping a city, reopening the same item, two
  members planning the same place — and Photon is a free shared service, so
  identical queries are served from memory instead of refetched. Small bounded
  LRU: the cap matters more than the hit rate, since this lives for the tab's
  lifetime.
*/
const CACHE_LIMIT = 50
const suggestionCache = new Map<string, PlaceSuggestion[]>()

/*
  Keyed on the NORMALISED query, shared with the edge cache (#257). Keyed on the
  raw string, `Kyoto`, `kyoto` and `Kyoto ` were three entries and three
  metered lookups — and case varies constantly when several people type the
  same destination.
*/
function cacheGet(query: string): PlaceSuggestion[] | undefined {
  const key = normalizeQuery(query)
  const hit = suggestionCache.get(key)
  if (!hit) return undefined
  // Touch: delete + re-set moves the key to the end of the insertion order,
  // so the eviction below always drops the least-recently-used entry.
  suggestionCache.delete(key)
  suggestionCache.set(key, hit)
  return hit
}

function cacheSet(query: string, results: PlaceSuggestion[]): void {
  suggestionCache.set(normalizeQuery(query), results)
  if (suggestionCache.size > CACHE_LIMIT) {
    const oldest = suggestionCache.keys().next().value
    if (oldest !== undefined) suggestionCache.delete(oldest)
  }
}

/*
  A plain controlled text input first — typing always works — with debounced
  suggestions from a free, keyless geocoder layered on top. Selecting a
  suggestion just normalizes the text to "City, Country"; a slow/unreachable
  geocoder or zero matches silently closes the dropdown rather than blocking
  or erroring the field, since free text is always a valid value here.

  The list is deliberately hard to summon by accident. It opens only in
  response to the user's own typing (`queryable`), which is what keeps it from
  (a) reopening on the label `select()` just wrote back into `value`, and
  (b) popping up over an untouched form when `form.reset()` fills the field
  with an existing item's location.
*/
export function PlaceAutocomplete({
  value, onChange, onSelectPlace, className, id, onFocus, onBlur, ...rest
}: PlaceAutocompleteProps) {
  const [suggestions, setSuggestions] = React.useState<PlaceSuggestion[]>([])
  const [open, setOpen] = React.useState(false)
  const [activeIndex, setActiveIndex] = React.useState(-1)
  /*
    True only between a real keystroke and the next select/blur/Escape. Every
    other way `value` can change — a parent reset, a programmatic prefill, the
    label written by `select()` — leaves it false, so the effect below skips
    both the fetch and the open.
  */
  const [queryable, setQueryable] = React.useState(false)
  const containerRef = React.useRef<HTMLDivElement>(null)
  const requestId = React.useRef(0)

  const close = React.useCallback(() => {
    setOpen(false)
    setQueryable(false)
    setActiveIndex(-1)
  }, [])

  React.useEffect(() => {
    const query = value.trim()
    if (!queryable || query.length < 3) {
      setSuggestions([])
      setOpen(false)
      setActiveIndex(-1)
      return
    }

    // Served from memory: no debounce, no request, no flicker.
    const cached = cacheGet(query)
    if (cached) {
      setSuggestions(cached)
      setOpen(cached.length > 0)
      setActiveIndex(-1)
      return
    }

    const id = ++requestId.current
    const controller = new AbortController()
    const timer = window.setTimeout(() => {
      searchPlaces(query, controller.signal)
        .then((results) => {
          cacheSet(query, results)
          if (id !== requestId.current) return
          setSuggestions(results)
          setOpen(results.length > 0)
          setActiveIndex(-1)
        })
        .catch(() => {
          if (id !== requestId.current) return
          setSuggestions([])
          setOpen(false)
          setActiveIndex(-1)
        })
    }, 300)
    return () => {
      window.clearTimeout(timer)
      controller.abort()
    }
  }, [value, queryable])

  React.useEffect(() => {
    if (!open) return
    function onPointerDown(e: PointerEvent) {
      if (!containerRef.current?.contains(e.target as Node)) close()
    }
    document.addEventListener('pointerdown', onPointerDown)
    return () => document.removeEventListener('pointerdown', onPointerDown)
  }, [open, close])

  function select(s: PlaceSuggestion) {
    onChange(s.label)
    onSelectPlace?.(s)
    setSuggestions([])
    close()
  }

  function onKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
    if (!open || suggestions.length === 0) return
    if (e.key === 'ArrowDown') {
      e.preventDefault()
      setActiveIndex((i) => (i + 1) % suggestions.length)
    } else if (e.key === 'ArrowUp') {
      e.preventDefault()
      setActiveIndex((i) => (i <= 0 ? suggestions.length - 1 : i - 1))
    } else if (e.key === 'Enter' && activeIndex >= 0) {
      e.preventDefault()
      select(suggestions[activeIndex])
    } else if (e.key === 'Escape') {
      /*
        Escape dismisses the suggestions, not the surrounding dialog. Radix's
        dismissable layer listens on document in the CAPTURE phase, so it has
        already seen this event by now and stopPropagation here would be too
        late — DialogContent instead declines the dismiss while a combobox
        reads as expanded (see dialog.tsx). This handler is the other half of
        that: it collapses the list, which flips aria-expanded back to false
        so the next Escape closes the dialog as usual.
      */
      e.preventDefault()
      close()
    }
  }

  const listboxId = id ? `${id}-listbox` : undefined
  const optionId = (i: number) => (id ? `${id}-option-${i}` : undefined)

  return (
    <div ref={containerRef} className="relative">
      <Input
        id={id}
        value={value}
        onChange={(e) => {
          // The only path that arms the dropdown — see `queryable` above.
          setQueryable(true)
          onChange(e.target.value)
        }}
        onKeyDown={onKeyDown}
        onFocus={(e) => {
          if (suggestions.length > 0) setOpen(true)
          onFocus?.(e)
        }}
        onBlur={(e) => {
          // Options preventDefault on mousedown, so picking one never blurs
          // the input — reaching here means focus genuinely left the field
          // (tab away, keyboard dismissed) and a floating list would be stale.
          close()
          onBlur?.(e)
        }}
        role="combobox"
        aria-expanded={open}
        aria-autocomplete="list"
        aria-controls={open ? listboxId : undefined}
        aria-activedescendant={open && activeIndex >= 0 ? optionId(activeIndex) : undefined}
        autoComplete="off"
        className={className}
        {...rest}
      />
      {open && (
        <ul
          id={listboxId}
          role="listbox"
          className={cn(
            'absolute z-50 mt-1 w-full overflow-y-auto rounded-xl border border-line',
            'bg-elevated p-1 shadow-lift',
            // Shorter on phones: the field sits above Cost/Link/Notes and the
            // submit button in a bottom sheet, and a tall panel buries them.
            'max-h-52 md:max-h-60'
          )}
        >
          {suggestions.map((s, i) => (
            /*
              role="option" belongs on the direct children of the listbox, and
              options are not tabbable — focus stays in the input and moves
              via aria-activedescendant. min-h-11 keeps each row at the 44px
              mobile tap floor.
            */
            <li
              key={`${s.label}-${s.lat}-${s.lon}`}
              id={optionId(i)}
              role="option"
              aria-selected={i === activeIndex}
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => select(s)}
              className={cn(
                'flex min-h-11 cursor-pointer items-center rounded-lg px-3 py-2 text-sm',
                'transition-colors hover:bg-sunken md:min-h-0',
                i === activeIndex && 'bg-sunken'
              )}
            >
              <span className="truncate">{s.label}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}
