import { readFile, mkdir } from 'node:fs/promises'
import { chromium } from 'playwright'
import { createSupabaseStub, resolveAuth, SUPABASE_HOST } from '/home/user/wander/scripts/screenshot-mock.mjs'

const BASE_URL = 'http://localhost:4173'
const OUT_DIR = process.env.OUT_DIR || '/tmp/shots384full'
const fixture = JSON.parse(await readFile('/home/user/wander/scripts/fixtures/384-chip-tap-targets.json', 'utf8'))
const session = resolveAuth(fixture.auth)
const tripId = fixture.auth.tripId
const stub = createSupabaseStub(fixture)
await mkdir(OUT_DIR, { recursive: true })

const browser = await chromium.launch({ executablePath: process.env.PLAYWRIGHT_CHROMIUM_PATH })
const context = await browser.newContext({
  viewport: { width: 375, height: 900 },
  deviceScaleFactor: 2,
  colorScheme: 'light',
  reducedMotion: 'reduce',
})
await context.route((url) => url.hostname === SUPABASE_HOST, stub)
await context.routeWebSocket((url) => url.hostname === SUPABASE_HOST, () => {})
await context.addInitScript(
  ([value, theme]) => {
    localStorage.setItem('wander_auth', value)
    localStorage.setItem('wander_theme', theme)
  },
  [JSON.stringify(session), 'light']
)

for (const [route, name] of [
  [`/trip/${tripId}/calendar`, 'calendar-chips'],
  [`/trip/${tripId}/itinerary`, 'wishlist-pills'],
]) {
  const page = await context.newPage()
  await page.goto(`${BASE_URL}/#${route}`, { waitUntil: 'networkidle' })
  await page.waitForTimeout(1500)
  const file = `${OUT_DIR}/mobile-${name}.png`
  await page.screenshot({ path: file, fullPage: true })
  console.log('captured', file)
  await page.close()
}
await context.close()
await browser.close()
