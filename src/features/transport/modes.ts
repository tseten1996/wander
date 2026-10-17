import { Bus, Car, Plane, Ship, TrainFront } from 'lucide-react'
import type { TransportMode } from '@/types'

/** The five transport modes, in display order, with their icon and label. The
 *  single source for the editor's select options, the card icon, the readable
 *  mode name, the calendar day surface, and the day-of Today card (#405). Kept in
 *  its own icon-only module so a light consumer (the eagerly-bundled dashboard)
 *  can read the map without pulling in the TransportCard editor's form code. */
export const MODES: { value: TransportMode; label: string; Icon: typeof Plane }[] = [
  { value: 'flight', label: 'Flight', Icon: Plane },
  { value: 'train', label: 'Train', Icon: TrainFront },
  { value: 'bus', label: 'Bus', Icon: Bus },
  { value: 'car', label: 'Car', Icon: Car },
  { value: 'ferry', label: 'Ferry', Icon: Ship },
]

export const MODE_MAP = Object.fromEntries(MODES.map((m) => [m.value, m])) as Record<
  TransportMode,
  (typeof MODES)[number]
>
