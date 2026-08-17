import * as React from 'react'
import L from 'leaflet'
import 'leaflet/dist/leaflet.css'
import type { RecapStop } from '@/features/dashboard/recap'

/**
 * Read-only "places visited" map — slice 3 of the recap epic (#205, #248).
 *
 * Draws the trip's located stops as ordered, numbered pins joined by a route
 * line, auto-bounded to fit. It is the recap counterpart to the editable
 * `ItineraryMap`: same keyless OSM raster tiles, same lazy Leaflet chunk (both
 * are `React.lazy`-loaded, so Leaflet + its CSS never enter the initial
 * bundle), but deliberately stripped of every editing affordance — no
 * selection sync, no "Nearby" search, no "open item" / "add" buttons, no
 * drag. A pin's only interaction is a tap that shows the place name. Pins carry
 * their 1-based visit order as a glyph over the primary token colour, so the
 * order reads without relying on colour alone.
 *
 * The caller filters to located stops (`locatedStops`) and only mounts this
 * when there are at least two — fewer degrades to the stats-only recap with no
 * empty map frame — so this component assumes a non-empty, ordered list.
 */

function prefersReducedMotion(): boolean {
  return (
    typeof window !== 'undefined' &&
    typeof window.matchMedia === 'function' &&
    window.matchMedia('(prefers-reduced-motion: reduce)').matches
  )
}

/** Resolve a design token to its computed colour, so Leaflet's SVG route stroke
 *  gets a real colour value rather than an unresolved `var()`. Read from the
 *  live stylesheet — no raw palette value ever appears in this file (token
 *  lint), and both themes resolve correctly. Falls back to the bare `var()`
 *  reference (which suffices for the HTML divIcon fills) only in the degenerate
 *  case where the custom property is not yet computed. */
function token(name: string): string {
  if (typeof window !== 'undefined') {
    const v = getComputedStyle(document.documentElement).getPropertyValue(name).trim()
    if (v) return v
  }
  return `var(${name})`
}

/** A numbered visit-order pin, drawn from tokens (no external image), centred in
 *  a 44px transparent wrapper so the tap area meets the mobile floor. */
function orderPin(n: number, fill: string, on: string, ring: string): L.DivIcon {
  const wrap = document.createElement('div')
  wrap.style.cssText = 'display:flex;align-items:center;justify-content:center;width:44px;height:44px'

  const el = document.createElement('div')
  el.textContent = String(n)
  el.style.cssText = [
    'display:flex',
    'align-items:center',
    'justify-content:center',
    'width:26px',
    'height:26px',
    'border-radius:9999px',
    `background:${fill}`,
    `color:${on}`,
    'font-weight:700',
    'font-size:12px',
    'line-height:1',
    `border:2px solid ${ring}`,
    'box-shadow:var(--shadow-soft)',
  ].join(';')
  wrap.appendChild(el)

  return L.divIcon({
    className: '',
    html: wrap.outerHTML,
    iconSize: [44, 44],
    iconAnchor: [22, 22],
    popupAnchor: [0, -13],
  })
}

/** Popup content for a pin — the place name only, built as DOM (textContent) so
 *  user text is safe. Read-only: no buttons, nothing to open or add. */
function popupContent(stop: RecapStop): HTMLElement {
  const root = document.createElement('div')
  root.style.minWidth = '120px'
  const title = document.createElement('p')
  title.textContent = stop.title
  title.style.cssText = 'font-weight:600;font-size:13px;margin:0'
  root.appendChild(title)
  return root
}

export default function RecapMap({ stops }: { stops: RecapStop[] }) {
  const containerRef = React.useRef<HTMLDivElement | null>(null)
  const mapRef = React.useRef<L.Map | null>(null)

  React.useEffect(() => {
    if (!containerRef.current || mapRef.current || stops.length === 0) return
    const reduced = prefersReducedMotion()
    const fill = token('--primary')
    const on = token('--on-primary')
    const ring = token('--surface')

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

    const points: L.LatLngExpression[] = stops.map((s) => [s.latitude, s.longitude])

    // The route: one line through the stops in visit order. Drawn first and
    // non-interactive so the pins stay on top and are the only tap target.
    if (points.length >= 2) {
      L.polyline(points, {
        color: fill,
        weight: 3,
        opacity: 0.6,
        dashArray: '6 8',
        interactive: false,
      }).addTo(map)
    }

    stops.forEach((stop, i) => {
      const marker = L.marker([stop.latitude, stop.longitude], {
        icon: orderPin(i + 1, fill, on, ring),
        title: `${i + 1}. ${stop.title}`,
        keyboard: true,
      })
      marker.bindPopup(() => popupContent(stop))
      marker.addTo(map)
    })

    map.fitBounds(L.latLngBounds(points), { padding: [40, 40], maxZoom: 15 })
    // The container may have just been mounted/shown — recompute so tiles fill
    // it instead of a 0×0 sliver.
    map.invalidateSize()
    mapRef.current = map

    return () => {
      map.remove()
      mapRef.current = null
    }
  }, [stops])

  return (
    <div
      ref={containerRef}
      role="region"
      aria-label="Map of places visited"
      // `isolate` confines Leaflet's internal high z-index panes to this
      // container's stacking context, so they never paint over app dialogs.
      className="relative isolate h-[20rem] w-full overflow-hidden rounded-2xl border border-line sm:h-[26rem]"
    />
  )
}
