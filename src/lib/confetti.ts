import confetti from 'canvas-confetti'

/** Two-burst celebration; fired once per trip when planning hits 100%. */
export function celebrate() {
  if (matchMedia('(prefers-reduced-motion: reduce)').matches) return
  const opts = { spread: 70, ticks: 120, gravity: 0.9, scalar: 1 }
  confetti({ ...opts, particleCount: 90, origin: { x: 0.2, y: 0.7 }, angle: 60 })
  confetti({ ...opts, particleCount: 90, origin: { x: 0.8, y: 0.7 }, angle: 120 })
}

const KEY = 'wander_celebrated'

export function celebrateOncePerTrip(tripId: string) {
  const seen: string[] = JSON.parse(localStorage.getItem(KEY) ?? '[]')
  if (seen.includes(tripId)) return
  localStorage.setItem(KEY, JSON.stringify([...seen, tripId]))
  celebrate()
}

/** Allow re-celebrating if planning drops below 100% again. */
export function resetCelebration(tripId: string) {
  const seen: string[] = JSON.parse(localStorage.getItem(KEY) ?? '[]')
  if (!seen.includes(tripId)) return
  localStorage.setItem(KEY, JSON.stringify(seen.filter((id) => id !== tripId)))
}
