#!/usr/bin/env node
/**
 * Mint the Gmail refresh token the email drain needs (epic #181).
 *
 * WHY THIS EXISTS. Everything else about turning on email notifications is
 * pasting values into a settings page. This one step is an OAuth consent flow,
 * which is the kind of thing people put off for a week — and the usual advice
 * ("just use the OAuth Playground") hands your refresh token to a third-party
 * web page. This does it locally: nothing leaves your machine except the
 * standard exchange with Google, and the token is printed to your terminal.
 *
 * Dependency-free on purpose — node:http and node:crypto only, so it runs on a
 * clean checkout with no install step.
 *
 * ── Setup, once ──────────────────────────────────────────────────────────────
 *
 *  1. Google Cloud console → create (or pick) a project.
 *  2. APIs & Services → Library → enable the **Gmail API**.
 *  3. APIs & Services → OAuth consent screen → set it up as **External**, and
 *     add your own Google account under **Test users**. You do NOT need to
 *     publish or get verified: a test user can consent indefinitely, and this
 *     app has exactly one user — you.
 *  4. Credentials → Create credentials → **OAuth client ID** → application
 *     type **Desktop app**. Copy the client ID and client secret.
 *
 * ── Run ──────────────────────────────────────────────────────────────────────
 *
 *   GMAIL_CLIENT_ID=... GMAIL_CLIENT_SECRET=... node scripts/gmail-refresh-token.mjs
 *
 * It prints a URL, waits for you to approve it in a browser, and prints the
 * refresh token. Put that in Cloudflare as GMAIL_REFRESH_TOKEN (a secret), with
 * the client id and secret alongside — see docs/ARCHITECTURE.md §7.
 *
 * ── The scope ────────────────────────────────────────────────────────────────
 *
 * Only `gmail.send`. It is the narrowest scope that can send, and it CANNOT
 * read, search or delete mail — so the token this prints, if it ever leaked,
 * could send mail as you but never read your inbox. That is a deliberate
 * choice over the broader `https://mail.google.com/` that most guides suggest.
 */
import { createServer } from 'node:http'
import { createHash, randomBytes } from 'node:crypto'
import { pathToFileURL } from 'node:url'

const CLIENT_ID = process.env.GMAIL_CLIENT_ID
const CLIENT_SECRET = process.env.GMAIL_CLIENT_SECRET
const SCOPE = 'https://www.googleapis.com/auth/gmail.send'
const AUTH_ENDPOINT = 'https://accounts.google.com/o/oauth2/v2/auth'
const TOKEN_ENDPOINT = 'https://oauth2.googleapis.com/token'
/** 0 = let the OS pick a free port; a fixed port collides and needs sudo <1024. */
const PORT = Number(process.env.PORT || 0)

/* ── pure helpers (exported for tests) ───────────────────────────────────── */

/** base64url of raw bytes — the encoding every OAuth parameter uses. */
export const base64url = (buf) =>
  buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')

/**
 * A PKCE verifier/challenge pair (S256).
 *
 * Not strictly required for a Desktop client that also sends a secret, but a
 * "Desktop app" secret is not actually secret — it ships to users — so PKCE is
 * what really binds the authorization code to this process. Cheap, so there is
 * no reason to skip it.
 */
export function pkcePair(bytes = randomBytes(32)) {
  const verifier = base64url(bytes)
  const challenge = base64url(createHash('sha256').update(verifier).digest())
  return { verifier, challenge }
}

/**
 * The consent URL.
 *
 * `access_type=offline` AND `prompt=consent` are both load-bearing: without
 * offline there is no refresh token at all, and without prompt=consent Google
 * returns one only on the FIRST ever authorization — so anyone re-running this
 * after a mistake gets an access token and no refresh token, with no error to
 * explain why. That single omission is the most common way this flow wastes an
 * afternoon.
 */
export function buildAuthUrl({ clientId, redirectUri, challenge, state }) {
  const params = new URLSearchParams({
    client_id: clientId,
    redirect_uri: redirectUri,
    response_type: 'code',
    scope: SCOPE,
    access_type: 'offline',
    prompt: 'consent',
    code_challenge: challenge,
    code_challenge_method: 'S256',
    state,
  })
  return `${AUTH_ENDPOINT}?${params.toString()}`
}

/**
 * Pull the code out of the redirect Google sends back, rejecting anything that
 * does not match the state we issued (CSRF, or a stale browser tab from an
 * earlier run hitting this server).
 */
export function readCallback(url, expectedState) {
  const q = new URL(url, 'http://127.0.0.1').searchParams
  if (q.get('error')) return { error: q.get('error') }
  if (q.get('state') !== expectedState) return { error: 'state mismatch' }
  const code = q.get('code')
  return code ? { code } : { error: 'no code in callback' }
}

/* ── the flow ────────────────────────────────────────────────────────────── */

async function main() {
  if (!CLIENT_ID || !CLIENT_SECRET) {
    console.error(
      'Set GMAIL_CLIENT_ID and GMAIL_CLIENT_SECRET first. See the header of this\n' +
        'file for how to create them (Google Cloud → Credentials → Desktop app).',
    )
    process.exit(2)
  }

  const { verifier, challenge } = pkcePair()
  const state = base64url(randomBytes(16))

  // Resolve the code through a one-shot loopback server. Google permits any
  // 127.0.0.1 port for a Desktop client, which is why no redirect URI has to be
  // registered up front.
  //
  // `redirectUri` is declared out here rather than stashed on the promise: the
  // token exchange must repeat it verbatim or Google rejects the code, and the
  // port is only known once the OS has assigned one.
  let redirectUri = ''
  const result = await new Promise((resolve) => {
    const server = createServer((req, res) => {
      // Ignore the favicon (and anything else a browser fetches on its own):
      // responding to one must not end the flow before the real callback.
      if (req.url === '/favicon.ico') {
        res.writeHead(404).end()
        return
      }
      const outcome = readCallback(req.url, state)
      res.writeHead(outcome.code ? 200 : 400, { 'content-type': 'text/html; charset=utf-8' })
      res.end(
        outcome.code
          ? '<h2>Approved.</h2><p>You can close this tab and return to the terminal.</p>'
          : `<h2>Something went wrong.</h2><p>${outcome.error}</p>`,
      )
      server.close()
      resolve(outcome)
    })
    server.on('error', (err) => resolve({ error: `local server: ${err.message}` }))
    server.listen(PORT, '127.0.0.1', () => {
      redirectUri = `http://127.0.0.1:${server.address().port}`
      console.log('\nOpen this URL and approve access:\n')
      console.log(buildAuthUrl({ clientId: CLIENT_ID, redirectUri, challenge, state }))
      console.log('\nWaiting for the redirect…')
    })
  })

  if (result.error) {
    console.error(`\nFailed: ${result.error}`)
    process.exit(1)
  }
  const res = await fetch(TOKEN_ENDPOINT, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: CLIENT_ID,
      client_secret: CLIENT_SECRET,
      code: result.code,
      code_verifier: verifier,
      grant_type: 'authorization_code',
      redirect_uri: redirectUri,
    }).toString(),
  })

  const body = await res.json().catch(() => ({}))
  if (!res.ok) {
    console.error(`\nToken exchange failed (${res.status}): ${JSON.stringify(body)}`)
    process.exit(1)
  }
  if (!body.refresh_token) {
    // Almost always a missing prompt=consent on a re-authorization, which this
    // script sets — so if it happens, the client was likely authorized by some
    // other tool first. Revoking the app's access and re-running clears it.
    console.error(
      '\nGoogle returned no refresh_token. Revoke this app under\n' +
        'myaccount.google.com → Security → Third-party access, then re-run.',
    )
    process.exit(1)
  }

  console.log('\n─────────────────────────────────────────────────────────────')
  console.log('GMAIL_REFRESH_TOKEN (store as a SECRET, never commit it):\n')
  console.log(body.refresh_token)
  console.log('\nScope granted:', body.scope || SCOPE)
  console.log('─────────────────────────────────────────────────────────────')
  console.log(
    '\nNext: set GMAIL_CLIENT_ID, GMAIL_CLIENT_SECRET and GMAIL_REFRESH_TOKEN\n' +
      'in Cloudflare Pages (production), with EMAIL_ENABLED=true and EMAIL_FROM\n' +
      'set to the Google account you just approved. See docs/ARCHITECTURE.md §7.',
  )
}

// Only run the flow when invoked directly, so the pure helpers above can be
// imported by tests without opening a socket. Compared as resolved file URLs —
// a basename comparison matches any similarly-named script in another folder.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main()
}
