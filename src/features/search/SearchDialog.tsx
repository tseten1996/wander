import * as React from 'react'
import { useNavigate } from 'react-router-dom'
import { Search, CornerDownLeft } from 'lucide-react'
import { Dialog, DialogContent, DialogTitle } from '@/components/ui/dialog'
import { cn } from '@/lib/utils'
import { MIN_QUERY_LENGTH, useTripSearch, type SearchResult } from './useTripSearch'

/** Renders `text` with the first case-insensitive match of `query` marked. */
function Highlighted({ text, query }: { text: string; query: string }) {
  const q = query.trim()
  const i = q ? text.toLowerCase().indexOf(q.toLowerCase()) : -1
  if (i < 0) return <>{text}</>
  return (
    <>
      {text.slice(0, i)}
      <mark className="rounded bg-accent-soft px-0.5 text-ink">{text.slice(i, i + q.length)}</mark>
      {text.slice(i + q.length)}
    </>
  )
}

export function SearchDialog({
  open,
  onOpenChange,
  tripId,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  tripId: string
}) {
  const navigate = useNavigate()
  const inputRef = React.useRef<HTMLInputElement>(null)
  const [query, setQuery] = React.useState('')
  const [active, setActive] = React.useState(0)

  const { groups, total } = useTripSearch(tripId, query)
  const flat = React.useMemo(() => groups.flatMap((g) => g.results), [groups])

  // Fresh state + focus each time the palette opens.
  React.useEffect(() => {
    if (open) {
      setQuery('')
      setActive(0)
      requestAnimationFrame(() => inputRef.current?.focus())
    }
  }, [open])

  // Reset the cursor to the top whenever the result set changes.
  React.useEffect(() => {
    setActive(0)
  }, [query])

  // Keep the active option scrolled into view.
  React.useEffect(() => {
    if (flat.length) document.getElementById(`search-opt-${active}`)?.scrollIntoView({ block: 'nearest' })
  }, [active, flat.length])

  const trimmed = query.trim()
  const tooShort = trimmed.length < MIN_QUERY_LENGTH

  function go(result: SearchResult) {
    onOpenChange(false)
    navigate(`/trip/${tripId}/${result.route}#${result.anchorId}`)
  }

  function onKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
    if (e.key === 'ArrowDown') {
      e.preventDefault()
      setActive((i) => (flat.length ? Math.min(i + 1, flat.length - 1) : 0))
    } else if (e.key === 'ArrowUp') {
      e.preventDefault()
      setActive((i) => Math.max(i - 1, 0))
    } else if (e.key === 'Enter') {
      e.preventDefault()
      const result = flat[active]
      if (result) go(result)
    }
  }

  // Running index across all groups so keyboard selection maps to a flat list.
  let flatIndex = -1

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="md:max-w-xl">
        <DialogTitle className="sr-only">Search this trip</DialogTitle>

        {/* Pinned search field — bleeds to the sheet edges and stays put while
            results scroll beneath it. */}
        <div className="sticky top-0 z-10 -mx-5 -mt-2.5 border-b border-line bg-elevated px-5 pb-3 pt-2.5 md:-mx-6 md:-mt-6 md:px-6 md:pt-6">
          <div className="relative flex items-center">
            <Search className="pointer-events-none absolute left-3 size-4 text-muted" />
            <input
              ref={inputRef}
              type="text"
              role="combobox"
              aria-expanded={!tooShort}
              aria-controls="search-results"
              aria-activedescendant={flat.length ? `search-opt-${active}` : undefined}
              aria-label="Search this trip"
              placeholder="Search polls, chat, checklist, notes, ideas…"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={onKeyDown}
              className={cn(
                'h-11 w-full rounded-xl border border-line bg-surface pl-9 pr-3 text-sm text-ink placeholder:text-faint',
                'transition-colors focus:border-primary focus:outline-none focus:ring-2 focus:ring-primary/20'
              )}
            />
          </div>
        </div>

        <div id="search-results" role="listbox" aria-label="Search results" className="pt-3">
          {tooShort ? (
            <p className="px-1 py-8 text-center text-sm text-muted">
              Type to search across polls, chat, checklist, notes and ideas.
              <span className="mt-1 block text-xs text-faint">
                Covers the sections you’ve opened this visit.
              </span>
            </p>
          ) : total === 0 ? (
            <div className="px-1 py-8 text-center">
              <p className="text-sm text-muted">
                No matches for “<span className="text-ink-soft">{trimmed}</span>”.
              </p>
              <p className="mt-1 text-xs text-faint">
                Search only covers sections you’ve opened this visit.
              </p>
            </div>
          ) : (
            <div className="space-y-4">
              {groups.map((group) => (
                <div key={group.kind}>
                  <div className="mb-1 flex items-center gap-1.5 px-1 text-xs font-medium text-faint">
                    <group.icon className="size-3.5" />
                    {group.label}
                  </div>
                  <div className="space-y-0.5">
                    {group.results.map((result) => {
                      flatIndex += 1
                      const index = flatIndex
                      const isActive = index === active
                      return (
                        <button
                          key={result.id}
                          id={`search-opt-${index}`}
                          type="button"
                          role="option"
                          aria-selected={isActive}
                          onClick={() => go(result)}
                          onMouseMove={() => setActive(index)}
                          className={cn(
                            'flex w-full items-center gap-2 rounded-xl px-3 py-2.5 text-left transition-colors',
                            isActive ? 'bg-sunken' : 'hover:bg-sunken/60'
                          )}
                        >
                          <span className="min-w-0 flex-1">
                            <span className="block truncate text-sm font-medium text-ink">
                              <Highlighted text={result.title} query={trimmed} />
                            </span>
                            {result.snippet && (
                              <span className="mt-0.5 block truncate text-xs text-muted">
                                <Highlighted text={result.snippet} query={trimmed} />
                              </span>
                            )}
                          </span>
                          {isActive && (
                            <CornerDownLeft className="size-4 shrink-0 text-faint" aria-hidden />
                          )}
                        </button>
                      )
                    })}
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      </DialogContent>
    </Dialog>
  )
}
