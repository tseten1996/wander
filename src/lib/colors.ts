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

export function randomMemberColor(): string {
  return MEMBER_COLORS[Math.floor(Math.random() * MEMBER_COLORS.length)]
}
