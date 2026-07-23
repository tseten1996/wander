import * as React from 'react'
import { Input } from '@/components/ui/input'
import { searchPlaces, type PlaceSuggestion } from '@/lib/geocode'
import { cn } from '@/lib/utils'

export interface PlaceAutocompleteProps
  extends Omit<React.InputHTMLAttributes<HTMLInputElement>, 'value' | 'onChange'> {
  value: string
  onChange: (value: string) => void
}

/*
  A plain controlled text input first — typing always works — with debounced
  suggestions from a free, keyless geocoder layered on top. Selecting a
  suggestion just normalizes the text to "City, Country"; a slow/unreachable
  geocoder or zero matches silently closes the dropdown rather than blocking
  or erroring the field, since free text is always a valid value here.
*/
export function PlaceAutocomplete({
  value, onChange, className, id, onFocus, onBlur, ...rest
}: PlaceAutocompleteProps) {
  const [suggestions, setSuggestions] = React.useState<PlaceSuggestion[]>([])
  const [open, setOpen] = React.useState(false)
  const [activeIndex, setActiveIndex] = React.useState(-1)
  const containerRef = React.useRef<HTMLDivElement>(null)
  const requestId = React.useRef(0)

  React.useEffect(() => {
    const query = value.trim()
    if (query.length < 3) {
      setSuggestions([])
      setOpen(false)
      return
    }
    const id = ++requestId.current
    const controller = new AbortController()
    const timer = window.setTimeout(() => {
      searchPlaces(query, controller.signal)
        .then((results) => {
          if (id !== requestId.current) return
          setSuggestions(results)
          setOpen(results.length > 0)
          setActiveIndex(-1)
        })
        .catch(() => {
          if (id !== requestId.current) return
          setSuggestions([])
          setOpen(false)
        })
    }, 300)
    return () => {
      window.clearTimeout(timer)
      controller.abort()
    }
  }, [value])

  React.useEffect(() => {
    if (!open) return
    function onPointerDown(e: PointerEvent) {
      if (!containerRef.current?.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener('pointerdown', onPointerDown)
    return () => document.removeEventListener('pointerdown', onPointerDown)
  }, [open])

  function select(s: PlaceSuggestion) {
    onChange(s.label)
    setOpen(false)
    setSuggestions([])
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
      setOpen(false)
    }
  }

  const listboxId = id ? `${id}-listbox` : undefined

  return (
    <div ref={containerRef} className="relative">
      <Input
        id={id}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={onKeyDown}
        onFocus={(e) => {
          if (suggestions.length > 0) setOpen(true)
          onFocus?.(e)
        }}
        onBlur={onBlur}
        role="combobox"
        aria-expanded={open}
        aria-autocomplete="list"
        aria-controls={listboxId}
        autoComplete="off"
        className={className}
        {...rest}
      />
      {open && (
        <ul
          id={listboxId}
          role="listbox"
          className="absolute z-50 mt-1 max-h-60 w-full overflow-y-auto rounded-xl border border-line bg-elevated p-1 shadow-lift"
        >
          {suggestions.map((s, i) => (
            <li key={`${s.label}-${s.lat}-${s.lon}`}>
              <button
                type="button"
                role="option"
                aria-selected={i === activeIndex}
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => select(s)}
                className={cn(
                  'w-full truncate rounded-lg px-3 py-2 text-left text-sm hover:bg-sunken',
                  i === activeIndex && 'bg-sunken'
                )}
              >
                {s.label}
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}
