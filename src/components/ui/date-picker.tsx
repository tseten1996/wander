import * as React from 'react'
import {
  addDays, addMonths, eachDayOfInterval, endOfMonth, endOfWeek, format,
  isSameDay, isSameMonth, isToday, isValid, parseISO, startOfMonth, startOfWeek,
} from 'date-fns'
import { CalendarDays, ChevronLeft, ChevronRight } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input, inputClasses } from '@/components/ui/input'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { cn } from '@/lib/utils'

/*
  DateInput — a controlled date field (`yyyy-MM-dd` string value, '' = unset).

  On desktop (md+) it renders an Input-styled trigger that opens a popover
  month calendar; on mobile it stays a native <input type="date">, whose OS
  sheet is the better touch UX. The breakpoint check is JS (matchMedia)
  rather than CSS visibility so the `id` — and with it the <Label htmlFor>
  association — always belongs to the one control actually on screen.
*/

const DESKTOP_QUERY = '(min-width: 768px)'

function useIsDesktop() {
  const [isDesktop, setIsDesktop] = React.useState(
    () => window.matchMedia(DESKTOP_QUERY).matches
  )
  React.useEffect(() => {
    const mql = window.matchMedia(DESKTOP_QUERY)
    const onChange = (e: MediaQueryListEvent) => setIsDesktop(e.matches)
    mql.addEventListener('change', onChange)
    return () => mql.removeEventListener('change', onChange)
  }, [])
  return isDesktop
}

export interface DateInputProps {
  id?: string
  /** Date as `yyyy-MM-dd`, or '' when unset. */
  value: string
  onChange: (value: string) => void
  onBlur?: () => void
  disabled?: boolean
  className?: string
  'aria-invalid'?: boolean
}

export function DateInput(props: DateInputProps) {
  const isDesktop = useIsDesktop()
  if (!isDesktop) {
    const { value, onChange, className, ...rest } = props
    return (
      <Input
        type="date"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className={className}
        {...rest}
      />
    )
  }
  return <DesktopDatePicker {...props} />
}

const WEEKDAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun']

function DesktopDatePicker({
  id, value, onChange, onBlur, disabled, className,
  'aria-invalid': ariaInvalid,
}: DateInputProps) {
  const parsed = value ? parseISO(value) : undefined
  const selected = parsed && isValid(parsed) ? parsed : undefined

  const [open, setOpen] = React.useState(false)
  const [month, setMonth] = React.useState<Date>(() => selected ?? new Date())
  const [focused, setFocused] = React.useState<Date>(() => selected ?? new Date())
  const gridRef = React.useRef<HTMLDivElement>(null)

  const handleOpenChange = (next: boolean) => {
    setOpen(next)
    if (next) {
      const base = selected ?? new Date()
      setMonth(base)
      setFocused(base)
    } else {
      onBlur?.()
    }
  }

  const days = eachDayOfInterval({
    start: startOfWeek(startOfMonth(month), { weekStartsOn: 1 }),
    end: endOfWeek(endOfMonth(month), { weekStartsOn: 1 }),
  })

  const select = (day: Date) => {
    onChange(format(day, 'yyyy-MM-dd'))
    setOpen(false)
  }

  const moveFocus = (next: Date) => {
    setFocused(next)
    if (!isSameMonth(next, month)) setMonth(next)
  }

  // Keep DOM focus on the roving-tabindex day while the popover is open, so
  // arrow keys visibly walk the grid and Enter/Space select the focused day.
  // Deferred a tick: on mouse-open the browser's default click behavior
  // focuses the trigger *after* this effect has run and would win otherwise.
  React.useEffect(() => {
    if (!open) return
    const t = window.setTimeout(() => {
      gridRef.current
        ?.querySelector<HTMLButtonElement>(`[data-day="${format(focused, 'yyyy-MM-dd')}"]`)
        ?.focus()
    }, 0)
    return () => window.clearTimeout(t)
  }, [open, focused, month])

  const onGridKeyDown = (e: React.KeyboardEvent) => {
    const dayDelta: Record<string, number> = {
      ArrowLeft: -1, ArrowRight: 1, ArrowUp: -7, ArrowDown: 7,
    }
    if (e.key in dayDelta) {
      e.preventDefault()
      moveFocus(addDays(focused, dayDelta[e.key]))
    } else if (e.key === 'PageUp' || e.key === 'PageDown') {
      e.preventDefault()
      moveFocus(addMonths(focused, e.key === 'PageUp' ? -1 : 1))
    } else if (e.key === 'Enter' || e.key === ' ') {
      // Select from state, not from the DOM-focused button — the roving
      // focus() is deferred a tick, so under fast keystrokes the previously
      // focused day's button could still hold focus and swallow the key.
      e.preventDefault()
      select(focused)
    }
    // Escape closes via Radix and restores focus to the trigger.
  }

  return (
    <Popover open={open} onOpenChange={handleOpenChange}>
      <PopoverTrigger asChild>
        <button
          type="button"
          id={id}
          disabled={disabled}
          aria-invalid={ariaInvalid}
          className={cn(inputClasses, 'items-center justify-between gap-2 text-left', className)}
        >
          <span className={cn('truncate', !selected && 'text-faint')}>
            {selected ? format(selected, 'EEE, MMM d, yyyy') : 'Pick a date'}
          </span>
          <CalendarDays className="size-4 shrink-0 text-muted" aria-hidden />
        </button>
      </PopoverTrigger>
      <PopoverContent
        align="start"
        className="w-auto p-3"
        onOpenAutoFocus={(e) => e.preventDefault()}
      >
        <div className="mb-2 flex items-center justify-between">
          <p className="px-1 font-display text-sm font-semibold" aria-live="polite">
            {format(month, 'MMMM yyyy')}
          </p>
          <div className="flex gap-1">
            <Button
              variant="ghost" size="icon" className="size-8"
              onClick={() => setMonth((m) => addMonths(m, -1))}
              aria-label="Previous month"
            >
              <ChevronLeft />
            </Button>
            <Button
              variant="ghost" size="icon" className="size-8"
              onClick={() => setMonth((m) => addMonths(m, 1))}
              aria-label="Next month"
            >
              <ChevronRight />
            </Button>
          </div>
        </div>

        <div className="grid grid-cols-7 text-center text-xs font-medium text-faint">
          {WEEKDAYS.map((d) => (
            <div key={d} className="py-1">{d}</div>
          ))}
        </div>
        <div ref={gridRef} onKeyDown={onGridKeyDown} className="grid grid-cols-7 gap-0.5">
          {days.map((day) => {
            const isSelected = selected && isSameDay(day, selected)
            return (
              <button
                key={day.toISOString()}
                type="button"
                data-day={format(day, 'yyyy-MM-dd')}
                tabIndex={isSameDay(day, focused) ? 0 : -1}
                onClick={() => select(day)}
                aria-label={format(day, 'EEEE, MMMM d, yyyy')}
                aria-current={isToday(day) ? 'date' : undefined}
                aria-pressed={isSelected || undefined}
                className={cn(
                  'flex size-9 items-center justify-center rounded-lg text-sm transition-colors',
                  'hover:bg-sunken focus:outline-none focus:ring-2 focus:ring-primary',
                  !isSameMonth(day, month) && 'text-faint/60',
                  isToday(day) && !isSelected && 'font-bold text-primary',
                  isSelected && 'bg-primary font-semibold text-on-primary hover:bg-primary'
                )}
              >
                {format(day, 'd')}
              </button>
            )
          })}
        </div>

        <div className="mt-2 flex items-center justify-between border-t border-line/60 pt-2">
          <Button variant="ghost" size="sm" onClick={() => select(new Date())}>
            Today
          </Button>
          {value && (
            <Button
              variant="ghost" size="sm" className="text-muted"
              onClick={() => { onChange(''); setOpen(false) }}
            >
              Clear
            </Button>
          )}
        </div>
      </PopoverContent>
    </Popover>
  )
}
