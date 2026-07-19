import {
  Plane, BedDouble, Ticket, UtensilsCrossed, Bus, Sun as SunIcon,
  type LucideIcon,
} from 'lucide-react'
import type { ItineraryCategory } from '@/types'

export const ITINERARY_META: Record<
  ItineraryCategory,
  { label: string; icon: LucideIcon; chip: string }
> = {
  flight: { label: 'Flight', icon: Plane, chip: 'bg-sky-500/15 text-sky-600 dark:text-sky-400' },
  hotel: { label: 'Stay', icon: BedDouble, chip: 'bg-violet-500/15 text-violet-600 dark:text-violet-400' },
  activity: { label: 'Activity', icon: Ticket, chip: 'bg-primary-faint text-primary' },
  restaurant: { label: 'Food', icon: UtensilsCrossed, chip: 'bg-accent-soft text-accent' },
  transport: { label: 'Transport', icon: Bus, chip: 'bg-stone-500/15 text-stone-600 dark:text-stone-400' },
  free: { label: 'Free time', icon: SunIcon, chip: 'bg-success-soft text-success' },
}
