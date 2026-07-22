import * as React from 'react'
import { useLocation } from 'react-router-dom'

const HASH_PREFIX = '#wander-item-'
/** ~2.5s of animation frames — long enough for a lazy page chunk to mount. */
const MAX_FRAMES = 150
const FLASH_MS = 1700

/**
 * Watches the location hash and, when a search result deep-links to an item
 * (`#wander-item-<id>`), scrolls that element into view and flashes it. Mounted
 * once inside the trip shell. Retries across frames because the target page may
 * still be lazy-loading when the hash lands.
 */
export function SearchHighlighter() {
  const { hash, key } = useLocation()

  React.useEffect(() => {
    if (!hash.startsWith(HASH_PREFIX)) return
    const id = hash.slice(1)

    let raf = 0
    let frames = 0
    let flashTimer: ReturnType<typeof setTimeout> | undefined
    let flashed: HTMLElement | null = null

    const reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches

    const attempt = () => {
      const el = document.getElementById(id)
      if (el) {
        el.scrollIntoView({ behavior: reduce ? 'auto' : 'smooth', block: 'center' })
        el.classList.add('search-flash')
        flashed = el
        flashTimer = setTimeout(() => el.classList.remove('search-flash'), FLASH_MS)
        return
      }
      if (frames++ < MAX_FRAMES) raf = requestAnimationFrame(attempt)
    }
    raf = requestAnimationFrame(attempt)

    return () => {
      cancelAnimationFrame(raf)
      if (flashTimer) clearTimeout(flashTimer)
      flashed?.classList.remove('search-flash')
    }
    // `key` changes even when navigating to the same hash twice, so re-running
    // on it lets a repeat selection re-trigger the flash.
  }, [hash, key])

  return null
}

/** Registers ⌘K / Ctrl-K to open search from anywhere in the trip. */
export function useSearchHotkey(onOpen: () => void): void {
  React.useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && !e.altKey && e.key.toLowerCase() === 'k') {
        e.preventDefault()
        onOpen()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onOpen])
}
