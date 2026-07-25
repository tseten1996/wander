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

// Text colour that sits on any member/day palette colour above — the palette
// is chosen to stay readable behind white in both themes. Lives here (not as a
// raw literal in a component) so the token-lint stays green; JSX can also just
// use the `text-white` utility.
export const ON_MEMBER_COLOR = '#ffffff'

export function randomMemberColor(): string {
  return MEMBER_COLORS[Math.floor(Math.random() * MEMBER_COLORS.length)]
}
