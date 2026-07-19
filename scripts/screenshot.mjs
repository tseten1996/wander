/**
 * PR screenshot harness.
 *
 * Signs into the app as an invisible anonymous user, joins the permanent
 * demo trip ("Kyoto in Autumn") via its invite code, captures the given
 * routes at desktop + mobile sizes, then removes its own membership so
 * "Screenshot Bot" never piles up in the member list.
 *
 * Usage:
 *   npm run build && npm run preview &        # serves on :4173
 *   ROUTES="/trip/{trip},/trip/{trip}/polls" node scripts/screenshot.mjs
 *
 * Env:
 *   BASE_URL     app under test        (default http://localhost:4173)
 *   ROUTES       comma-separated hash routes; "{trip}" -> demo trip id
 *                (default: home + trip overview)
 *   OUT_DIR      output directory      (default docs/screenshots)
 *   COLOR_SCHEME light | dark          (default light)
 */
import { mkdirSync } from 'node:fs'
import { chromium } from 'playwright'

const BASE_URL = process.env.BASE_URL ?? 'http://localhost:4173'
const OUT_DIR = process.env.OUT_DIR ?? 'docs/screenshots'
const COLOR_SCHEME = process.env.COLOR_SCHEME === 'dark' ? 'dark' : 'light'
const ROUTES = (process.env.ROUTES ?? '/,/trip/{trip}')
  .split(',').map((r) => r.trim()).filter(Boolean)

const SUPABASE_URL = 'https://qqmfxbcroxunvtgxxray.supabase.co'
const SUPABASE_KEY = 'sb_publishable_TJuVLg5h31V-kg3gX36vUQ_wKR-Ga2_'
const DEMO_INVITE = 'demoinvite2026'

// 1. Anonymous session (same mechanism the join flow uses)
const signup = await fetch(`${SUPABASE_URL}/auth/v1/signup`, {
  method: 'POST',
  headers: { apikey: SUPABASE_KEY, 'Content-Type': 'application/json' },
  body: '{}',
})
const session = await signup.json()
if (!session.access_token) {
  throw new Error(`Anonymous sign-in failed (is it enabled?): ${JSON.stringify(session)}`)
}
const authHeaders = {
  apikey: SUPABASE_KEY,
  Authorization: `Bearer ${session.access_token}`,
  'Content-Type': 'application/json',
}

// 2. Join the demo trip
const joinRes = await fetch(`${SUPABASE_URL}/rest/v1/rpc/join_trip`, {
  method: 'POST',
  headers: authHeaders,
  body: JSON.stringify({
    p_invite_code: DEMO_INVITE,
    p_display_name: 'Screenshot Bot',
    p_color: '#78716c',
  }),
})
const tripId = await joinRes.json()
if (typeof tripId !== 'string') {
  throw new Error(`Could not join demo trip: ${JSON.stringify(tripId)}`)
}

// 3. Capture
mkdirSync(OUT_DIR, { recursive: true })
const browser = await chromium.launch()
const written = []
try {
  for (const [device, viewport] of [
    ['desktop', { width: 1280, height: 800 }],
    ['mobile', { width: 390, height: 844 }],
  ]) {
    const context = await browser.newContext({
      viewport,
      deviceScaleFactor: 2,
      colorScheme: COLOR_SCHEME,
    })
    // Hand the app our session before it boots
    await context.addInitScript(
      ([key, value, theme]) => {
        localStorage.setItem(key, value)
        localStorage.setItem('wander_theme', theme)
      },
      ['wander_auth', JSON.stringify(session), COLOR_SCHEME]
    )
    const page = await context.newPage()
    for (const route of ROUTES) {
      const path = route.replaceAll('{trip}', tripId)
      await page.goto(`${BASE_URL}/#${path}`, { waitUntil: 'networkidle' })
      await page.waitForTimeout(1800) // data fetch + entrance animations
      const slug = path.replaceAll('/', '_').replace(/[^a-zA-Z0-9_-]/g, '') || 'home'
      const file = `${OUT_DIR}/${device}${slug}.png`
      await page.screenshot({ path: file, fullPage: device === 'desktop' })
      written.push(file)
      console.log('captured', file)
    }
    await context.close()
  }
} finally {
  await browser.close()
  // 4. Leave the trip so the bot member doesn't accumulate
  await fetch(
    `${SUPABASE_URL}/rest/v1/members?trip_id=eq.${tripId}&user_id=eq.${session.user.id}`,
    { method: 'DELETE', headers: authHeaders }
  )
}
console.log(`\n${written.length} screenshots -> ${OUT_DIR}`)
