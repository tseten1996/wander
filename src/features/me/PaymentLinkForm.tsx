import * as React from 'react'
import { useForm } from 'react-hook-form'
import { zodResolver } from '@hookform/resolvers/zod'
import { z } from 'zod'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { normalizePaymentLink } from '@/features/budget/paymentLink'
import type { Member } from '@/types'
import { useUpdateMemberPaymentLink } from './api'

/*
  The editor for a member's own payment link (#347). Mirrors MemberDatesForm
  (#286): a self-edit on the `members` row through the same column-level grant.
  The stored value is normalized to an `https:` URL client-side (and re-checked
  at render before it becomes a link), so a pasted `javascript:`/`data:` value
  can never become a live href on the settle-up card.
*/

const schema = z.object({
  // Blank is allowed (it clears the link). A non-blank value must normalize to a
  // safe https URL — the same normalization the value is stored with.
  payment_link: z
    .string()
    .trim()
    .max(2000, 'That link is too long')
    .optional()
    .refine((v) => !v || normalizePaymentLink(v) !== null, {
      message: 'Enter a full https link (PayPal.me, Venmo, Revolut, …), or leave it blank',
    }),
})

type FormValues = { payment_link?: string }

export function PaymentLinkForm({ member, actorId }: { member: Member; actorId: string }) {
  const update = useUpdateMemberPaymentLink(member.trip_id)
  const form = useForm<FormValues>({
    resolver: zodResolver(schema),
    defaultValues: { payment_link: member.payment_link ?? '' },
  })

  // Keep the field in sync when the underlying row changes (realtime, or a save
  // that normalized the value). `form` is stable across renders.
  React.useEffect(() => {
    form.reset({ payment_link: member.payment_link ?? '' })
  }, [member.payment_link, form])

  async function persist(payment_link: string | null) {
    try {
      await update.mutateAsync({ memberId: member.id, payment_link, actorId })
      toast.success(payment_link ? 'Payment link saved' : 'Payment link cleared')
    } catch {
      /* rollback + error toast handled in the mutation's onError */
    }
  }

  const submit = (values: FormValues) =>
    // Store the normalized form, never the raw paste — validation guaranteed it
    // normalizes (or is blank → cleared).
    persist(values.payment_link ? normalizePaymentLink(values.payment_link) : null)

  const clear = () => {
    form.reset({ payment_link: '' })
    void persist(null)
  }

  const err = form.formState.errors
  const hasLink = !!member.payment_link

  return (
    <form onSubmit={form.handleSubmit(submit)} className="space-y-4">
      <div className="space-y-1.5">
        <Label htmlFor={`payment-link-${member.id}`}>Payment link</Label>
        <Input
          id={`payment-link-${member.id}`}
          type="url"
          inputMode="url"
          autoComplete="off"
          placeholder="paypal.me/you, venmo.com/u/you, revolut.me/you…"
          aria-invalid={err.payment_link ? true : undefined}
          {...form.register('payment_link')}
        />
        {err.payment_link && <p className="text-xs text-danger">{err.payment_link.message}</p>}
      </div>
      <p className="text-xs text-muted">
        Optional. When you’re owed money, this is the link the “Pay” button on
        settle-up opens — with the amount already filled in where your payment app
        supports it. Only people on this trip can see it.
      </p>
      <div className="flex flex-wrap gap-2">
        <Button type="submit" disabled={form.formState.isSubmitting}>
          {form.formState.isSubmitting ? 'Saving…' : 'Save link'}
        </Button>
        {hasLink && (
          <Button type="button" variant="ghost" onClick={clear} disabled={form.formState.isSubmitting}>
            Clear
          </Button>
        )}
      </div>
    </form>
  )
}
