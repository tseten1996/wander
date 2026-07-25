import * as React from 'react'
import L from 'leaflet'
import 'leaflet/dist/leaflet.css'
import { MapPinOff } from 'lucide-react'
import { ITINERARY_META } from './meta'
import { dayInfoFor, type DayInfo } from './days'
import { onColor } from '@/lib/colors'
import { formatTime } from '@/lib/utils'
import { cn } from '@/lib/utils'
import type { ItineraryItem } from '@/types'

/**
 * Map view — slice 2 of the Map-view epic (#60). Builds on the pins shipped in
 * #61 and adds the two things that turn a picture into a planning surface:
 *
 *  - **Day encoding** — each located item's pin is coloured and numbered by its
 *    itinerary day (see `days.ts`), with a legend, so "what belongs to which
 *    day" is answerable at a glance. Number + colour together keep it legible
 *    without relying on colour alone.
 *  - **Two-way selection sync** — a single "selected item" id is shared with the
 *    list (owned by `ItineraryPage`). Selecting a pin highlights it, pans to it,
 *    and marks the matching list row; selecting a list row pans/highlights the
 *    pin here.
 *
 * Leaflet is imported here and this component is lazy-loaded by ItineraryPage,
 * so the map library lands in its own async chunk. Pins are `divIcon`s styled
 * from palette data / CSS tokens — no external marker images are requested
 * (only the OSM tiles, the same keyless-network pattern used elsewhere).
 */

/** An item is "located" only when both coordinates are real finite numbers. */
function isLocated(
  item: ItineraryItem
): item is ItineraryItem & { latitude: number; longitude: number } {
  return (
    typeof item.latitude === 'number' &&
    typeof item.longitude === 'number' &&
    Number.isFinite(item.latitude) &&
    Number.isFinite(item.longitude)
  )
}

function prefersReducedMotion(): boolean {
  return (
    typeof window !== 'undefined' &&
    typeof window.matchMedia === 'function' &&
    window.matchMedia('(prefers-reduced-motion: reduce)').matches
  )
}

/**
 * A round pin drawn from palette data (no external image). It carries the day
 * *number* (or "·" when the item has no day) over the day *colour*, so the day
 * is encoded twice — colour and glyph — and stays distinguishable for
 * colour-vision deficiency. The visible dot is centred inside a 44px
 * transparent wrapper so the *tap area* meets the mobile 44px floor. A selected
 * pin grows and gains a ring so it reads as the focused one against its peers.
 */
function pinIcon(info: DayInfo, selected: boolean): L.DivIcon {
  const dot = selected ? 32 : 26
  const wrap = document.createElement('div')
  wrap.style.cssText = [
    'display:flex',
    'align-items:center',
    'justify-content:center',
    'width:44px',
    'height:44px',
  ].join(';')

  const el = document.createElement('div')
  el.textContent = info.number != null ? String(info.number) : '·'
  el.style.cssText = [
    'display:flex',
    'align-items:center',
    'justify-content:center',
    `width:${dot}px`,
    `height:${dot}px`,
    'border-radius:9999px',
    `background:${info.color}`,
    `color:${onColor(info.color)}`,
    'font-weight:700',
    'font-size:12px',
    'line-height:1',
    'border:2px solid var(--surface)',
    // Selected pins gain an extra coloured halo on top of the soft shadow.
    selected
      ? `box-shadow:0 0 0 3px var(--surface),0 0 0 5px ${info.color},var(--shadow-lift)`
      : 'box-shadow:var(--shadow-soft)',
  ].join(';')
  wrap.appendChild(el)

  return L.divIcon({
    className: '',
    html: wrap.outerHTML,
    // 44px hit area; anchor at its centre (the dot's centre). The popup points
    // just above the top of the visible dot — i.e. one radius up from centre.
    iconSize: [44, 44],
    iconAnchor: [22, 22],
    popupAnchor: [0, -(dot / 2)],
  })
}

/** Popup content for a pin — built as DOM (textContent) so user text is safe. */
function popupContent(item: ItineraryItem, info: DayInfo, onOpen: () => void): HTMLElement {
  const root = document.createElement('div')
  root.style.minWidth = '150px'

  const title = document.createElement('p')
  title.textContent = item.title
  title.style.cssText = 'font-weight:600;font-size:13px;margin:0'
  root.appendChild(title)

  const meta = [
    info.label,
    item.start_time
      ? `${formatTime(item.start_time)}${item.end_time ? ` – ${formatTime(item.end_time)}` : ''}`
      : null,
    item.location,
  ]
    .filter(Boolean)
    .join(' · ')
  if (meta) {
    const sub = document.createElement('p')
    sub.textContent = meta
    sub.style.cssText = 'color:var(--muted);font-size:12px;margin:4px 0 0'
    root.appendChild(sub)
  }

  const btn = document.createElement('button')
  btn.type = 'button'
  btn.textContent = 'Open item'
  btn.style.cssText = [
    'margin-top:8px',
    'width:100%',
    // ≥44px tall to meet the mobile tap-target floor (box-sizing keeps the
    // padding + min-height honest regardless of Leaflet's popup line-height).
    'box-sizing:border-box',
    'min-height:44px',
    'display:flex',
    'align-items:center',
    'justify-content:center',
    'padding:8px 10px',
    'border-radius:8px',
    'background:var(--primary)',
    'color:var(--on-primary)',
    'font-size:12px',
    'font-weight:600',
    'cursor:pointer',
    'border:0',
  ].join(';')
  btn.addEventListener('click', onOpen)
  root.appendChild(btn)

  return root
}

/** The day legend explaining the pin colours — only the days that have pins. */
function DayLegend({ days }: { days: DayInfo[] }) {
  if (days.length === 0) return null
  return (
    <ul
      aria-label="Map day legend"
      className="flex flex-wrap items-center gap-x-3 gap-y-1.5 text-xs text-muted"
    >
      {days.map((d) => (
        <li key={d.label} className="flex items-center gap-1.5">
          <span
            aria-hidden
            className="flex size-4 items-center justify-center rounded-full text-[9px] font-bold"
            style={{ backgroundColor: d.color, color: onColor(d.color) }}
          >
            {d.number ?? '·'}
          </span>
          <span>{d.label}</span>
        </li>
      ))}
    </ul>
  )
}

export default function ItineraryMap({
  items,
  dayIndex,
  selectedId,
  onSelectItem,
  onOpenItem,
}: {
  items: ItineraryItem[]
  dayIndex: Map<string, DayInfo>
  selectedId: string | null
  /** Set the shared selection (a pin was clicked). */
  onSelectItem: (id: string | null) => void
  /** Open an item's edit dialog (the popup's "Open item" button). */
  onOpenItem: (item: ItineraryItem) => void
}) {
  const located = React.useMemo(() => items.filter(isLocated), [items])
  const unlocated = React.useMemo(() => items.filter((i) => !isLocated(i)), [items])
  const hasPins = located.length > 0

  // Distinct days present among the pins, in day order, for the legend.
  const legendDays = React.useMemo(() => {
    const seen = new Map<string, DayInfo>()
    for (const item of located) {
      const info = dayInfoFor(item, dayIndex)
      seen.set(info.label, info)
    }
    return [...seen.values()].sort((a, b) => {
      // Numbered days first (in order); the "No day" bucket sinks to the end.
      if (a.number == null) return 1
      if (b.number == null) return -1
      return a.number - b.number
    })
  }, [located, dayIndex])

  const containerRef = React.useRef<HTMLDivElement | null>(null)
  const mapRef = React.useRef<L.Map | null>(null)
  const layerRef = React.useRef<L.LayerGroup | null>(null)
  // Markers by item id so the selection effect can restyle / pan to one without
  // rebuilding the whole layer.
  const markersRef = React.useRef<Map<string, { marker: L.Marker; item: ItineraryItem; info: DayInfo }>>(
    new Map()
  )
  // Keep click handlers pointing at the latest callbacks without rebuilding
  // every marker when the parent re-renders.
  const onSelectRef = React.useRef(onSelectItem)
  const onOpenRef = React.useRef(onOpenItem)
  React.useLayoutEffect(() => {
    onSelectRef.current = onSelectItem
    onOpenRef.current = onOpenItem
  })

  // Create the Leaflet map once there is at least one pin to show.
  React.useEffect(() => {
    if (!hasPins || !containerRef.current || mapRef.current) return
    const reduced = prefersReducedMotion()
    const map = L.map(containerRef.current, {
      zoomControl: true,
      attributionControl: true,
      zoomAnimation: !reduced,
      fadeAnimation: !reduced,
      markerZoomAnimation: !reduced,
    })
    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
      attribution:
        '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
      maxZoom: 19,
    }).addTo(map)
    layerRef.current = L.layerGroup().addTo(map)
    mapRef.current = map
    return () => {
      map.remove()
      mapRef.current = null
      layerRef.current = null
      markersRef.current = new Map()
    }
  }, [hasPins])

  // (Re)draw pins whenever the located set or the day encoding changes.
  React.useEffect(() => {
    const map = mapRef.current
    const layer = layerRef.current
    if (!map || !layer) return
    layer.clearLayers()
    markersRef.current = new Map()
    const points: L.LatLngExpression[] = []
    located.forEach((item) => {
      const info = dayInfoFor(item, dayIndex)
      const latlng: L.LatLngExpression = [item.latitude, item.longitude]
      points.push(latlng)
      const marker = L.marker(latlng, {
        icon: pinIcon(info, item.id === selectedId),
        title: `${item.title} — ${info.label}`,
        keyboard: true,
      })
      marker.bindPopup(() => popupContent(item, info, () => onOpenRef.current(item)))
      // Clicking a pin selects it (shared with the list); the popup still opens.
      marker.on('click', () => onSelectRef.current(item.id))
      marker.addTo(layer)
      markersRef.current.set(item.id, { marker, item, info })
    })
    if (points.length > 0) {
      map.fitBounds(L.latLngBounds(points), { padding: [40, 40], maxZoom: 15 })
    }
    // Content mounts on tab-switch, so the container may have just gained its
    // size — recompute so tiles fill it instead of a 0×0 sliver.
    map.invalidateSize()
    // selectedId is intentionally omitted: the selection effect below restyles
    // the affected pins so a selection change doesn't rebuild the whole layer.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [located, dayIndex])

  // Reflect the shared selection: restyle every pin, then pan to / open the
  // selected one. Runs on mount too, so a selection made on the List tab is
  // honoured the moment the map appears.
  React.useEffect(() => {
    const map = mapRef.current
    if (!map) return
    markersRef.current.forEach(({ marker, item, info }) => {
      const selected = item.id === selectedId
      marker.setIcon(pinIcon(info, selected))
      marker.setZIndexOffset(selected ? 1000 : 0)
    })
    if (selectedId) {
      const entry = markersRef.current.get(selectedId)
      if (entry) {
        map.panTo(entry.marker.getLatLng(), { animate: !prefersReducedMotion() })
        entry.marker.openPopup()
      }
    }
  }, [selectedId, located])

  return (
    <div className="space-y-4">
      {hasPins ? (
        <>
          <DayLegend days={legendDays} />
          <div
            ref={containerRef}
            role="region"
            aria-label="Map of itinerary locations"
            // `isolate` confines Leaflet's internal high z-index panes to this
            // container's stacking context, so they never paint over app dialogs.
            className="relative isolate h-[22rem] w-full overflow-hidden rounded-2xl border border-line sm:h-[28rem]"
          />
        </>
      ) : (
        <div className="flex flex-col items-center gap-2 rounded-2xl border border-dashed border-line bg-sunken/40 px-6 py-12 text-center">
          <MapPinOff className="size-7 text-faint" aria-hidden />
          <p className="text-sm font-medium">No pinned locations yet</p>
          <p className="max-w-xs text-xs text-muted">
            Pick a place from the suggestions in an item’s Location field and it’ll
            appear here on the map.
          </p>
        </div>
      )}

      {unlocated.length > 0 && (
        <section aria-label="Itinerary items without a location">
          <h3 className="mb-2 flex items-baseline gap-2 text-sm font-semibold">
            No location yet
            <span className="text-xs font-normal text-faint">
              {unlocated.length} {unlocated.length === 1 ? 'item' : 'items'}
            </span>
          </h3>
          <ul className="space-y-2">
            {unlocated.map((item) => {
              const meta = ITINERARY_META[item.category]
              return (
                <li key={item.id}>
                  <button
                    type="button"
                    onClick={() => onOpenItem(item)}
                    className="flex w-full items-center gap-3 rounded-xl border border-line bg-surface p-3 text-left transition-colors hover:border-line-strong"
                  >
                    <span
                      className={cn(
                        'flex size-9 shrink-0 items-center justify-center rounded-lg',
                        meta.chip
                      )}
                    >
                      <meta.icon className="size-4.5" />
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-sm font-medium">{item.title}</span>
                      <span className="block truncate text-xs text-muted">
                        {item.location || 'Add a location to pin it'}
                      </span>
                    </span>
                  </button>
                </li>
              )
            })}
          </ul>
        </section>
      )}
    </div>
  )
}
