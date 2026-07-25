// Avatar palette — warm, saturated, readable with white text in both themes.
export const MEMBER_COLORS = [
  '#0f766e', // ocean
  '#d97706', // sunset
  '#0e7490', // sky
  '#7c3aed', // violet
  '#db2777', // magenta
  '#65a30d', // moss
  '#dc2626', // coral
  '#4f46e5', // indigo
] as const

// Neutral fallback for members whose colour is missing (stone-400).
export const FALLBACK_MEMBER_COLOR = '#a8a29e'

// The two foreground inks that ride on a palette colour: white for the darker
// swatches, stone-900 for the lighter ones (sunset/moss). Kept here (not as raw
// literals in components) so the token-lint stays green.
export const ON_MEMBER_COLOR = '#ffffff'
const ON_LIGHT_COLOR = '#1c1917' // stone-900 — the app's darkest ink

/** WCAG relative luminance of a `#rgb` / `#rrggbb` colour (0 = black, 1 = white). */
function relativeLuminance(hex: string): number {
  const h = hex.replace('#', '')
  const full = h.length === 3 ? h.split('').map((c) => c + c).join('') : h
  const [r, g, b] = [0, 2, 4].map((i) => parseInt(full.slice(i, i + 2), 16) / 255)
  const lin = (c: number) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4)
  return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b)
}

/**
 * Picks white or dark ink — whichever has the higher WCAG contrast — for text
 * that sits on a given palette background. White alone fails AA on the lighter
 * palette colours (sunset ~3.2:1, moss ~3.1:1) and on the stone-400 fallback
 * (~2.3:1); this keeps day numbers / avatar initials legible on all of them.
 */
export function onColor(background: string): string {
  const contrast = (a: number, b: number) =>
    (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05)
  const bg = relativeLuminance(background)
  const onWhite = contrast(bg, relativeLuminance(ON_MEMBER_COLOR))
  const onInk = contrast(bg, relativeLuminance(ON_LIGHT_COLOR))
  return onInk > onWhite ? ON_LIGHT_COLOR : ON_MEMBER_COLOR
}

export function randomMemberColor(): string {
  return MEMBER_COLORS[Math.floor(Math.random() * MEMBER_COLORS.length)]
}
