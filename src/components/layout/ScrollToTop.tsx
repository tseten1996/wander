import * as React from 'react'
import { useLocation, useNavigationType } from 'react-router-dom'

/**
 * Resets the window scroll to the top whenever the route changes (#261).
 *
 * Every feature tab is its own route, and the app otherwise has no scroll
 * handling — so switching from a deep-scrolled page opened the next one mid-
 * scroll instead of at the top (most visibly on mobile). This lives inside the
 * router (mounted once in main.tsx) and is intentionally state-free.
 *
 * Why the details matter:
 * - Keyed on `pathname` only, so in-page changes that don't navigate — a dialog
 *   opening, a list updating, a within-page tab — never move the scroll.
 * - `useLayoutEffect` runs before the browser paints, so the previous page's
 *   offset is never shown for a frame on the new page.
 * - POP navigations are exempt: browser back/forward (and the initial load,
 *   which is also a POP) restore the position the user is returning to rather
 *   than being yanked to the top.
 * - The jump is instant, never smooth — the correct behaviour for a navigation
 *   reset and for `prefers-reduced-motion` alike.
 */
export function ScrollToTop() {
  const { pathname } = useLocation()
  const navigationType = useNavigationType()

  React.useLayoutEffect(() => {
    if (navigationType === 'POP') return
    window.scrollTo(0, 0)
  }, [pathname, navigationType])

  return null
}
