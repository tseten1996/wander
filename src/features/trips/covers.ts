/*
  Curated cover gradients (#47). Each preset is a tiny SVG encoded as a data:
  URI and stored in trips.cover_url — every existing render site is already
  an <img src={cover_url}>, so presets work everywhere (home cards, dashboard
  hero, join preview) with no schema or renderer changes, and they survive
  JSON export/import like any other cover value. No API keys anywhere.
*/

export interface CoverPreset {
  id: string
  label: string
  uri: string
}

function gradientUri(from: string, to: string): string {
  const svg =
    `<svg xmlns='http://www.w3.org/2000/svg' width='800' height='400'>` +
    `<defs><linearGradient id='g' x1='0' y1='0' x2='1' y2='1'>` +
    `<stop offset='0' stop-color='${from}'/><stop offset='1' stop-color='${to}'/>` +
    `</linearGradient></defs>` +
    `<rect width='800' height='400' fill='url(%23g)'/></svg>`
  return `data:image/svg+xml,${svg.replace(/</g, '%3C').replace(/>/g, '%3E').replace(/'/g, '%27')}`
}

// Hues picked to sit comfortably with the app palette (ocean teal, sunset
// amber) plus a few travel moods. Order = display order.
export const COVER_PRESETS: CoverPreset[] = [
  { id: 'ocean', label: 'Ocean', uri: gradientUri('#0f766e', '#38bdf8') },
  { id: 'sunset', label: 'Sunset', uri: gradientUri('#f59e0b', '#be123c') },
  { id: 'dusk', label: 'Dusk', uri: gradientUri('#6366f1', '#1e1b4b') },
  { id: 'forest', label: 'Forest', uri: gradientUri('#047857', '#a3e635') },
  { id: 'blossom', label: 'Blossom', uri: gradientUri('#ec4899', '#7c3aed') },
  { id: 'dunes', label: 'Dunes', uri: gradientUri('#eab308', '#92400e') },
]

export const isPresetCover = (value: string | null | undefined): boolean =>
  !!value && value.startsWith('data:image/svg+xml,')

export const presetFor = (value: string | null | undefined): CoverPreset | undefined =>
  COVER_PRESETS.find((p) => p.uri === value)
