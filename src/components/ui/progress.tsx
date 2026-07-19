import { cn } from '@/lib/utils'

interface ProgressProps {
  value: number // 0..100
  className?: string
  barClassName?: string
  label?: string
}

export function Progress({ value, className, barClassName, label }: ProgressProps) {
  const clamped = Math.max(0, Math.min(100, value))
  return (
    <div
      role="progressbar"
      aria-valuenow={Math.round(clamped)}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-label={label}
      className={cn('h-2 w-full overflow-hidden rounded-full bg-sunken', className)}
    >
      <div
        className={cn('h-full rounded-full bg-primary transition-all duration-500', barClassName)}
        style={{ width: `${clamped}%` }}
      />
    </div>
  )
}
