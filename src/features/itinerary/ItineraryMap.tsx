import * as React from 'react'
import { useQuery } from '@tanstack/react-query'
import L from 'leaflet'
import 'leaflet/dist/leaflet.css'
import { MapPinOff, Sparkles, X } from 'lucide-react'
import { ITINERARY_META } from './meta'
import { dayInfoFor, type DayInfo } from './days'
import { isSpanning } from './spans'
import { onColor } from '@/lib/colors'
import { formatTime } from '@/lib/utils'
import { cn } from '@/lib/utils'
import { haversineKm } from '@/lib/geo'
import {
  fetchNearbyPlaces, POI_CATEGORY_LABEL, type NearbyPlace, type PoiCategory,
} from '@/lib/places'
import { Button } from '@/components/ui/button'
import { Spinner } from '@/components/ui/misc'
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

// Nearby suggestion pins are deliberately unlike the solid, numbered day pins:
// a hollow ring on a surface fill, tinted per category. Colour is backed up by
// the category word in the preview and the legend, so it never carries meaning
// alone. Tokens only (no raw palette values — see check-invariants token lint).
const NEARBY_CATEGORY_COLOR: Record<PoiCategory, string> = {
  eat: 'var(--primary)',
  see: 'var(--accent)',
  drink: 'var(--success)',
}

/**
 * A hollow, category-tinted ring — visually distinct from the filled day pins so
 * suggestions never read as itinerary stops. Centred in a 44px transparent
 * wrapper to meet the mobile tap-target floor, same as `pinIcon`.
 */
function nearbyPinIcon(category: PoiCategory): L.DivIcon {
  const color = NEARBY_CATEGORY_COLOR[category]
  const wrap = document.createElement('div')
  wrap.style.cssText = 'display:flex;align-items:center;justify-content:center;width:44px;height:44px'

  const el = document.createElement('div')
  el.style.cssText = [
    'width:20px',
    'height:20px',
    'border-radius:9999px',
    'background:var(--surface)',
    `border:3px solid ${color}`,
    'box-shadow:var(--shadow-soft)',
  ].join(';')
  wrap.appendChild(el)

  return L.divIcon({ className: '', html: wrap.outerHTML, iconSize: [44, 44], iconAnchor: [22, 22], popupAnchor: [0, -12] })
}

/** Preview popup for a suggestion — name, category, rough distance, one-tap add. */
function nearbyPopupContent(place: NearbyPlace, distanceKm: number | null, onAdd: () => void): HTMLElement {
  const root = document.createElement('div')
  root.style.minWidth = '160px'

  const title = document.createElement('p')
  title.textContent = place.name
  title.style.cssText = 'font-weight:600;font-size:13px;margin:0'
  root.appendChild(title)

  const distance =
    distanceKm == null
      ? null
      : distanceKm < 1
        ? `~${Math.max(1, Math.round((distanceKm * 1000) / 10) * 10)} m away`
        : `~${distanceKm.toFixed(1)} km away`
  const meta = [POI_CATEGORY_LABEL[place.category], distance].filter(Boolean).join(' · ')
  const sub = document.createElement('p')
  sub.textContent = meta
  sub.style.cssText = 'color:var(--muted);font-size:12px;margin:4px 0 0'
  root.appendChild(sub)

  const btn = document.createElement('button')
  btn.type = 'button'
  btn.textContent = 'Add to itinerary'
  btn.style.cssText = [
    'margin-top:8px',
    'width:100%',
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
  btn.addEventListener('click', onAdd)
  root.appendChild(btn)

  return root
}

/** Legend for the suggestion ring colours, mirroring the category words. */
function NearbyLegend() {
  return (
    <ul aria-label="Nearby suggestion legend" className="flex flex-wrap items-center gap-x-3 gap-y-1.5 text-xs text-muted">
      {(Object.keys(POI_CATEGORY_LABEL) as PoiCategory[]).map((c) => (
        <li key={c} className="flex items-center gap-1.5">
          <span
            aria-hidden
            className="size-3.5 rounded-full border-[3px] bg-surface"
            style={{ borderColor: NEARBY_CATEGORY_COLOR[c] }}
          />
          <span>{POI_CATEGORY_LABEL[c]}</span>
        </li>
      ))}
    </ul>
  )
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
  onAddNearby,
}: {
  items: ItineraryItem[]
  dayIndex: Map<string, DayInfo>
  selectedId: string | null
  /** Set the shared selection (a pin was clicked). */
  onSelectItem: (id: string | null) => void
  /** Open an item's edit dialog (the popup's "Open item" button). */
  onOpenItem: (item: ItineraryItem) => void
  /** One-tap add a found place as a normal itinerary item (name + coords). */
  onAddNearby: (place: NearbyPlace) => void
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
  const onAddNearbyRef = React.useRef(onAddNearby)
  React.useLayoutEffect(() => {
    onSelectRef.current = onSelectItem
    onOpenRef.current = onOpenItem
    onAddNearbyRef.current = onAddNearby
  })

  // ── Nearby "things to do" (epic #164, slice 1) ────────────────────────────
  // A separate marker layer and a self-contained query, so suggestions never
  // touch the itinerary pins' selection sync. `searchCenter` is the point we
  // searched around: it seeds from the map's centre when Nearby is turned on
  // and moves to wherever you tap the map, giving both "around the destination"
  // and "around a tapped location" from one deterministic query key.
  const [nearbyOn, setNearbyOn] = React.useState(false)
  const [searchCenter, setSearchCenter] = React.useState<{ lat: number; lon: number } | null>(null)
  const nearbyLayerRef = React.useRef<L.LayerGroup | null>(null)
  const nearbyOnRef = React.useRef(nearbyOn)
  React.useLayoutEffect(() => {
    nearbyOnRef.current = nearbyOn
  })

  const nearby = useQuery({
    queryKey: ['nearby_places', searchCenter?.lat, searchCenter?.lon],
    queryFn: ({ signal }) => fetchNearbyPlaces(searchCenter!, { radiusMeters: 1500 }, signal),
    enabled: nearbyOn && !!searchCenter,
    staleTime: 30 * 60 * 1000,
    gcTime: 60 * 60 * 1000,
    retry: false,
    refetchOnWindowFocus: false,
  })

  const toggleNearby = React.useCallback(() => {
    setNearbyOn((on) => {
      if (!on) {
        // Seed the search at the current view (which is framed on the trip's
        // pins ≈ the destination) the first time it's opened, then re-open to
        // the last searched point on subsequent toggles.
        const map = mapRef.current
        if (map && !searchCenter) {
          const c = map.getCenter()
          setSearchCenter({ lat: c.lat, lon: c.lng })
        }
      }
      return !on
    })
  }, [searchCenter])

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
    // Suggestion markers live in their own layer, added last so they sit above
    // the itinerary pins and route lines.
    nearbyLayerRef.current = L.layerGroup().addTo(map)
    // Tapping the map while Nearby is on re-searches around that point.
    map.on('click', (e: L.LeafletMouseEvent) => {
      if (nearbyOnRef.current) setSearchCenter({ lat: e.latlng.lat, lon: e.latlng.lng })
    })
    mapRef.current = map
    return () => {
      map.remove()
      mapRef.current = null
      layerRef.current = null
      nearbyLayerRef.current = null
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

    // Day-coloured route lines between consecutive located stops of the same
    // day (issue 123). `located` arrives in (day, position) order, so adjacent
    // entries sharing a day are the legs the list also annotates. Multi-day
    // spans (#166 — a hotel, a rail pass) are dropped from the route first: they
    // anchor to a day but aren't a sequential stop you travel between, so they
    // must not create a bogus leg (they keep their pin below). Drawn first and
    // non-interactive so pins stay on top and remain the only click target;
    // vector paths live below markers in Leaflet's pane order regardless.
    const routeStops = located.filter((l) => !isSpanning(l))
    for (let i = 0; i < routeStops.length - 1; i++) {
      const a = routeStops[i]
      const b = routeStops[i + 1]
      if (a.day == null || a.day !== b.day) continue
      L.polyline(
        [
          [a.latitude, a.longitude],
          [b.latitude, b.longitude],
        ],
        {
          color: dayInfoFor(a, dayIndex).color,
          weight: 3,
          opacity: 0.6,
          dashArray: '6 8',
          interactive: false,
        }
      ).addTo(layer)
    }

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

  // (Re)draw suggestion markers when the results, the toggle, or the searched
  // point changes. Cleared entirely when Nearby is off so turning it off leaves
  // a clean itinerary map.
  const nearbyPlaces = nearby.data
  React.useEffect(() => {
    const map = mapRef.current
    const layer = nearbyLayerRef.current
    if (!map || !layer) return
    layer.clearLayers()
    if (!nearbyOn) return
    const center = searchCenter
    for (const place of nearbyPlaces ?? []) {
      const marker = L.marker([place.lat, place.lon], {
        icon: nearbyPinIcon(place.category),
        title: `${place.name} — ${POI_CATEGORY_LABEL[place.category]}`,
        keyboard: true,
      })
      const distanceKm = center
        ? haversineKm(
            { latitude: center.lat, longitude: center.lon },
            { latitude: place.lat, longitude: place.lon },
          )
        : null
      marker.bindPopup(() =>
        nearbyPopupContent(place, distanceKm, () => {
          onAddNearbyRef.current(place)
          marker.closePopup()
        }),
      )
      marker.addTo(layer)
    }
  }, [nearbyPlaces, nearbyOn, searchCenter])

  return (
    <div className="space-y-4">
      {hasPins ? (
        <>
          <div className="flex flex-wrap items-center justify-between gap-3">
            <DayLegend days={legendDays} />
            <Button
              variant={nearbyOn ? 'secondary' : 'soft'}
              size="sm"
              onClick={toggleNearby}
              aria-pressed={nearbyOn}
            >
              {nearbyOn ? <X /> : <Sparkles />}
              {nearbyOn ? 'Hide nearby' : 'Nearby places'}
            </Button>
          </div>

          {nearbyOn && (
            <div
              className="rounded-xl border border-line bg-sunken/40 px-3 py-2.5 text-xs"
              aria-live="polite"
            >
              {nearby.isLoading ? (
                <span className="flex items-center gap-2 text-muted">
                  <Spinner className="size-4" /> Finding places nearby…
                </span>
              ) : nearby.isError ? (
                <span className="flex flex-wrap items-center gap-x-2 gap-y-1 text-muted">
                  Couldn’t load suggestions right now — the map still works.
                  <button
                    type="button"
                    onClick={() => nearby.refetch()}
                    className="font-medium text-primary underline-offset-2 hover:underline"
                  >
                    Try again
                  </button>
                </span>
              ) : (nearby.data?.length ?? 0) === 0 ? (
                <span className="text-muted">
                  No suggestions here — tap the map to search a different spot.
                </span>
              ) : (
                <div className="space-y-2">
                  <p className="text-muted">
                    {nearby.data!.length} {nearby.data!.length === 1 ? 'place' : 'places'} nearby ·
                    tap a pin to add it · tap the map to search elsewhere
                  </p>
                  <NearbyLegend />
                </div>
              )}
            </div>
          )}

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
