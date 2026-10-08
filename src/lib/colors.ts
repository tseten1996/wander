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

/**
 * A member colour for a joining friend: random among the palette swatches no
 * existing member has taken yet, so they stay visually distinct — the
 * accountless-identity wedge (#234). Random (not deterministic "first free") so
 * two people joining at once don't collide on the same swatch, falls back to a
 * fully random palette colour once every swatch is taken so joining never
 * dead-ends on colour, and with no argument is just a random palette colour.
 */
export function firstFreeMemberColor(taken: readonly string[] = []): string {
  const free = MEMBER_COLORS.filter((c) => !taken.includes(c))
  const pool = free.length ? free : MEMBER_COLORS
  return pool[Math.floor(Math.random() * pool.length)]
}

/**
 * The palette a notification email may use (epic #181, the email channel).
 *
 * An email cannot read a stylesheet: mail clients strip `<link>`, most strip
 * `<style>`, and none support custom properties — so inline hex is the only
 * thing that renders everywhere. These values therefore have to be duplicated
 * out of src/index.css, and they live *here* rather than in the renderer
 * because this is one of the three files the token lint recognises as a
 * palette source. That keeps "colour values live in one place" true for email
 * too, instead of making the renderer a fourth exception.
 *
 * Mirrors the app's own tokens: teal-600 primary (the same colour as the
 * manifest's theme_color and the link-preview card), stone-900 ink, stone-600
 * muted, the cream page background, and the stone-200 hairline.
 */
export const EMAIL_COLORS = {
  primary: '#0f766e',
  ink: '#1c1917',
  muted: '#57534e',
  page: '#faf9f7',
  border: '#e7e5e4',
  surface: '#ffffff',
} as const
