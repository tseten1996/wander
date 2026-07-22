import * as React from 'react'
import { ExternalLink, MapPin } from 'lucide-react'
import { cn } from '@/lib/utils'

export function hostOf(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, '')
  } catch {
    return url
  }
}

/**
 * Find http(s) URLs pasted into free text (title/notes). Trailing sentence
 * punctuation is stripped so "…see https://foo.com/menu." links cleanly.
 */
export function extractUrls(text: string | null | undefined): string[] {
  if (!text) return []
  return (text.match(/https?:\/\/[^\s<>"')\]]+/gi) ?? []).map((u) =>
    u.replace(/[.,;:!?]+$/, '')
  )
}

export function mapsUrl(location: string): string {
  return `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(location)}`
}

const chipClasses = cn(
  'inline-flex max-w-full items-center gap-1.5 rounded-full border border-line bg-surface px-2.5 py-1',
  'text-xs text-muted transition-colors hover:border-line-strong hover:text-ink'
)

/** Favicon + hostname pill that opens the link in a new tab. */
export function LinkChip({ url }: { url: string }) {
  const [iconFailed, setIconFailed] = React.useState(false)
  const host = hostOf(url)
  return (
    <a
      href={url}
      target="_blank"
      rel="noreferrer noopener"
      aria-label={`Open link on ${host}`}
      className={chipClasses}
    >
      {iconFailed ? (
        <ExternalLink className="size-3.5 shrink-0" aria-hidden />
      ) : (
        <img
          src={`https://www.google.com/s2/favicons?domain=${encodeURIComponent(host)}&sz=32`}
          alt=""
          loading="lazy"
          className="size-3.5 shrink-0 rounded-sm"
          onError={() => setIconFailed(true)}
        />
      )}
      <span className="truncate">{host}</span>
    </a>
  )
}

/** "Open in Google Maps" pill built from the item's free-text location. */
export function MapsChip({ location }: { location: string }) {
  return (
    <a
      href={mapsUrl(location)}
      target="_blank"
      rel="noreferrer noopener"
      aria-label={`Open ${location} in Google Maps`}
      className={chipClasses}
    >
      <MapPin className="size-3.5 shrink-0 text-primary" aria-hidden />
      <span className="truncate">Open in Google Maps</span>
    </a>
  )
}
