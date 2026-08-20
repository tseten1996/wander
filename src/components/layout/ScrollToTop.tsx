import { useLayoutEffect } from 'react'
import { useLocation, useNavigationType } from 'react-router-dom'

/**
 * Resets the window scroll to the top whenever the route's pathname changes,
 * so switching feature tabs (Checklist → Budget → Itinerary, …) opens the new
 * page at the top instead of inheriting the previous page's scroll offset
 * (#261). The page content scrolls on the document itself — nothing in the
 * layout is an overflow container — so `window.scrollTo` is what actually moves.
 *
 * Design decisions:
 * - `useLayoutEffect` runs before the browser paints, so the old offset is
 *   never shown for a frame before the reset.
 * - Keyed on `pathname` only: in-page state that lives in the query string or
 *   hash (dialogs, filters, within-page tabs) changes `search`/`hash`, not
 *   `pathname`, so it never yanks the page to the top.
 * - POP navigations are exempt, so browser back/forward — and the initial
 *   deep-link load — keep their natural scroll position instead of being
 *   forced to the top.
 * - Instant, never smooth: `window.scrollTo(0, 0)` is a jump, which is also the
 *   correct behavior under `prefers-reduced-motion`.
 *
 * Renders nothing; must live inside the Router so the hooks have context.
 */
export function ScrollToTop() {
  const { pathname } = useLocation()
  const navigationType = useNavigationType()

  useLayoutEffect(() => {
    if (navigationType === 'POP') return
    window.scrollTo(0, 0)
  }, [pathname, navigationType])

  return null
}
