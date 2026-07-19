import * as React from 'react'
import { Slot } from '@radix-ui/react-slot'
import { cva, type VariantProps } from 'class-variance-authority'
import { cn } from '@/lib/utils'

const buttonVariants = cva(
  'inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-xl text-sm font-medium transition-all duration-150 disabled:pointer-events-none disabled:opacity-50 [&_svg]:pointer-events-none [&_svg]:size-4 [&_svg]:shrink-0 active:scale-[0.98] cursor-pointer',
  {
    variants: {
      variant: {
        primary:
          'bg-primary text-on-primary shadow-soft hover:bg-primary-strong',
        secondary:
          'bg-surface text-ink border border-line shadow-soft hover:border-line-strong hover:bg-sunken',
        ghost: 'text-ink-soft hover:bg-sunken hover:text-ink',
        soft: 'bg-primary-faint text-primary hover:bg-primary-soft',
        danger:
          'bg-danger-soft text-danger hover:brightness-95 dark:hover:brightness-125',
        link: 'text-primary underline-offset-4 hover:underline',
      },
      size: {
        sm: 'h-8 px-3 text-xs rounded-lg',
        md: 'h-10 px-4',
        lg: 'h-12 px-6 text-base rounded-2xl',
        icon: 'size-9 rounded-lg',
      },
    },
    defaultVariants: { variant: 'primary', size: 'md' },
  }
)

export interface ButtonProps
  extends React.ButtonHTMLAttributes<HTMLButtonElement>,
    VariantProps<typeof buttonVariants> {
  asChild?: boolean
}

export const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(
  ({ className, variant, size, asChild = false, type, ...props }, ref) => {
    const Comp = asChild ? Slot : 'button'
    return (
      <Comp
        ref={ref}
        type={asChild ? undefined : (type ?? 'button')}
        className={cn(buttonVariants({ variant, size }), className)}
        {...props}
      />
    )
  }
)
Button.displayName = 'Button'
