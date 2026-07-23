import * as React from 'react'
import { ImageOff } from 'lucide-react'
import { Input } from '@/components/ui/input'
import { cn } from '@/lib/utils'
import { COVER_PRESETS, presetFor } from './covers'

/*
  Trip cover picker (#47): curated gradient presets + paste-a-URL with live
  preview. Controlled on the single cover_url string — a preset stores its
  SVG data: URI, a pasted link stores the http(s) URL, '' means no cover.
*/

const isHttp = (v: string) => /^https?:\/\//i.test(v)

export function CoverPicker({
  id,
  value,
  onChange,
  'aria-invalid': ariaInvalid,
}: {
  /** id for the paste-URL input, so a <Label htmlFor> can target it. */
  id?: string
  value: string
  onChange: (value: string) => void
  'aria-invalid'?: boolean
}) {
  const [previewFailed, setPreviewFailed] = React.useState(false)
  const preset = presetFor(value)

  return (
    <div className="space-y-2">
      <div className="grid grid-cols-6 gap-2">
        {COVER_PRESETS.map((p) => {
          const selected = value === p.uri
          return (
            <button
              key={p.id}
              type="button"
              title={p.label}
              aria-label={`Cover preset: ${p.label}`}
              aria-pressed={selected}
              onClick={() => onChange(selected ? '' : p.uri)}
              className={cn(
                'h-11 overflow-hidden rounded-lg border transition-all hover:scale-[1.03]',
                selected ? 'border-primary ring-2 ring-primary/40' : 'border-line'
              )}
            >
              <img src={p.uri} alt="" className="h-full w-full object-cover" />
            </button>
          )
        })}
      </div>
      <Input
        id={id}
        inputMode="url"
        placeholder="…or paste an image URL"
        aria-invalid={ariaInvalid}
        value={isHttp(value) ? value : ''}
        onChange={(e) => {
          setPreviewFailed(false)
          onChange(e.target.value)
        }}
      />
      {isHttp(value) &&
        (previewFailed ? (
          <p className="flex items-center gap-1.5 text-xs text-muted">
            <ImageOff className="size-3.5 shrink-0" aria-hidden />
            Couldn’t load that image — check the link.
          </p>
        ) : (
          <img
            src={value}
            alt="Cover preview"
            className="h-24 w-full rounded-xl border border-line object-cover"
            onError={() => setPreviewFailed(true)}
          />
        ))}
      {preset && (
        <p className="text-xs text-faint">
          Using the “{preset.label}” preset — tap it again to remove, or paste an image URL instead.
        </p>
      )}
      {!value && (
        <p className="text-xs text-faint">
          Tip: right-click any photo on the web and “Copy image address”.
        </p>
      )}
    </div>
  )
}
