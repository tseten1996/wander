import * as React from 'react'
import L from 'leaflet'
import 'leaflet/dist/leaflet.css'
import { MapPinOff } from 'lucide-react'
import { ITINERARY_META } from './meta'
import { formatTime } from '@/lib/utils'
import { cn } from '@/lib/utils'
import type { ItineraryItem } from '@/types'

/**
 * Map view (#61) — the first slice of the Map-view epic (#60). Renders every
 * itinerary item that has coordinates as a numbered pin on an OpenStreetMap
 * map via Leaflet (no API key, consistent with the free-tier stack), and lists
 * the items that lack coordinates in a clearly-labeled strip so nothing is
 * silently dropped. Clicking a pin (or an unlocated row) opens that item.
 *
 * Leaflet is imported here and this component is lazy-loaded by ItineraryPage,
 * so the map library lands in its own async chunk and never weighs down the
 * initial bundle. Pins are `divIcon`s styled from CSS design tokens — no
 * external marker images are requested (only the OSM tiles themselves, the
 * same keyless-network pattern the app already uses for weather/geocoding).
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

/** A round, numbered pin drawn from design tokens (no raw colours, no image). */
function pinIcon(n: number): L.DivIcon {
  const el = document.createElement('div')
  el.textContent = String(n)
  el.style.cssText = [
    'display:flex',
    'align-items:center',
    'justify-content:center',
    'width:26px',
    'height:26px',
    'border-radius:9999px',
    'background:var(--primary)',
    'color:var(--on-primary)',
    'font-weight:600',
    'font-size:12px',
    'line-height:1',
    'border:2px solid var(--surface)',
    'box-shadow:var(--shadow-soft)',
  ].join(';')
  return L.divIcon({
    className: '',
    html: el.outerHTML,
    iconSize: [26, 26],
    iconAnchor: [13, 13],
    popupAnchor: [0, -13],
  })
}

/** Popup content for a pin — built as DOM (textContent) so user text is safe. */
function popupContent(item: ItineraryItem, onOpen: () => void): HTMLElement {
  const root = document.createElement('div')
  root.style.minWidth = '150px'

  const title = document.createElement('p')
  title.textContent = item.title
  title.style.cssText = 'font-weight:600;font-size:13px;margin:0'
  root.appendChild(title)

  const meta = [
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
    'padding:6px 10px',
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

export default function ItineraryMap({
  items,
  onSelect,
}: {
  items: ItineraryItem[]
  onSelect: (item: ItineraryItem) => void
}) {
  const located = React.useMemo(() => items.filter(isLocated), [items])
  const unlocated = React.useMemo(() => items.filter((i) => !isLocated(i)), [items])
  const hasPins = located.length > 0

  const containerRef = React.useRef<HTMLDivElement | null>(null)
  const mapRef = React.useRef<L.Map | null>(null)
  const layerRef = React.useRef<L.LayerGroup | null>(null)
  // Keep marker/popup click handlers pointing at the latest onSelect without
  // rebuilding every marker when the parent re-renders.
  const onSelectRef = React.useRef(onSelect)
  onSelectRef.current = onSelect

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
    }
  }, [hasPins])

  // (Re)draw pins whenever the located set changes.
  React.useEffect(() => {
    const map = mapRef.current
    const layer = layerRef.current
    if (!map || !layer) return
    layer.clearLayers()
    const points: L.LatLngExpression[] = []
    located.forEach((item, i) => {
      const latlng: L.LatLngExpression = [item.latitude, item.longitude]
      points.push(latlng)
      const marker = L.marker(latlng, {
        icon: pinIcon(i + 1),
        title: item.title,
        keyboard: true,
      })
      marker.bindPopup(() => popupContent(item, () => onSelectRef.current(item)))
      layer.addLayer(marker)
    })
    if (points.length > 0) {
      map.fitBounds(L.latLngBounds(points), { padding: [40, 40], maxZoom: 15 })
    }
    // Content mounts on tab-switch, so the container may have just gained its
    // size — recompute so tiles fill it instead of a 0×0 sliver.
    map.invalidateSize()
  }, [located])

  return (
    <div className="space-y-5">
      {hasPins ? (
        <div
          ref={containerRef}
          role="region"
          aria-label="Map of itinerary locations"
          // `isolate` confines Leaflet's internal high z-index panes to this
          // container's stacking context, so they never paint over app dialogs.
          className="relative isolate h-[22rem] w-full overflow-hidden rounded-2xl border border-line sm:h-[28rem]"
        />
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
                    onClick={() => onSelect(item)}
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
