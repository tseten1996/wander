import { cn, initials } from '@/lib/utils'

interface MemberAvatarProps {
  name: string
  color: string
  size?: 'xs' | 'sm' | 'md' | 'lg'
  className?: string
}

const sizes = {
  xs: 'size-5 text-[9px]',
  sm: 'size-7 text-[11px]',
  md: 'size-9 text-xs',
  lg: 'size-14 text-lg',
}

/** Colored-initials avatar; no image uploads keeps joining instant & free. */
export function MemberAvatar({ name, color, size = 'md', className }: MemberAvatarProps) {
  return (
    <span
      title={name}
      className={cn(
        'inline-flex shrink-0 select-none items-center justify-center rounded-full font-semibold text-white ring-2 ring-surface',
        sizes[size],
        className
      )}
      style={{ backgroundColor: color }}
    >
      {initials(name)}
    </span>
  )
}

export function AvatarStack({
  members,
  max = 4,
  size = 'sm',
}: {
  members: { display_name: string; color: string }[]
  max?: number
  size?: 'xs' | 'sm' | 'md'
}) {
  const shown = members.slice(0, max)
  const extra = members.length - shown.length
  return (
    <span className="flex items-center -space-x-1.5">
      {shown.map((m, i) => (
        <MemberAvatar key={i} name={m.display_name} color={m.color} size={size} />
      ))}
      {extra > 0 && (
        <span
          className={cn(
            'inline-flex items-center justify-center rounded-full bg-sunken font-medium text-muted ring-2 ring-surface',
            sizes[size]
          )}
        >
          +{extra}
        </span>
      )}
    </span>
  )
}
