/**
 * The pure core of the email notification channel (epic #181).
 *
 * Three modules, three different reasons to test them here rather than in the
 * RLS suite (which covers the database half — who may queue what, and who may
 * never read an address):
 *
 *   render.ts   — every value in a notification email is member-authored free
 *                 text landing in an HTML document. Escaping is the whole test.
 *   provider.ts — the retryable/permanent split decides whether a bad address
 *                 costs one send or five, and whether a rate limit loses mail.
 *   drain.ts    — the ordering rules that keep the queue correct when a send
 *                 fails, throws, or the process dies mid-batch.
 *
 *   node --test tests/email.test.mjs      # or: npm run test:unit
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { register } from 'node:module'

// drain.ts imports './render' and './provider' extensionless, which Node's
// type-stripping loader will not resolve on its own. Same resolve hook as
// tests/ai-handler.test.mjs — supply the '.ts' and let stripping do the rest.
register(
  'data:text/javascript,' +
    encodeURIComponent(`
export async function resolve(specifier, context, nextResolve) {
  if (/^\\.\\.?\\//.test(specifier) && !/\\.[cm]?[jt]sx?$/i.test(specifier)) {
    try { return await nextResolve(specifier + '.ts', context) } catch {}
  }
  return nextResolve(specifier, context)
}`),
)

const { escapeHtml, clamp, subjectFor, absoluteLink, renderEmail, isDigest, pluralMessages } =
  await import('../src/server/email/render.ts')
const { isRetryableStatus, resendProvider, unsubscribeTarget } = await import(
  '../src/server/email/provider.ts'
)
const { drainOnce, DEFAULT_LIMIT } = await import('../src/server/email/drain.ts')

/** A representative queued job; override per test. */
const job = (over = {}) => ({
  id: 'ob-1',
  to_email: 'friend@example.com',
  kind: 'notification',
  type: 'mention',
  subject_title: 'are we still doing Kyoto?',
  trip_name: 'Kyoto in Autumn',
  actor_name: 'Tenzin',
  deep_link: '#/trip/t1/chat?n=n1',
  attempts: 0,
  ...over,
})

/* ── render: escaping ─────────────────────────────────────────────────────── */

test('escapeHtml neutralizes every character that can break out of markup', () => {
  assert.equal(
    escapeHtml(`<script>alert("x")&'`),
    '&lt;script&gt;alert(&quot;x&quot;)&amp;&#39;',
  )
})

test('escapeHtml escapes ampersands before the entities it introduces', () => {
  // Naive ordering would turn `<` into `&lt;` and then re-escape that `&`,
  // producing `&amp;lt;` — visible garbage in the email.
  assert.equal(escapeHtml('&<'), '&amp;&lt;')
})

test('a trip name carrying markup renders as text, not as an element', () => {
  const { html } = renderEmail(
    job({ trip_name: '<img src=x onerror=alert(1)>', subject_title: null }),
    'https://app.test',
  )
  assert.ok(!html.includes('<img src=x'), 'raw tag must not survive into the document')
  assert.ok(html.includes('&lt;img src=x onerror=alert(1)&gt;'))
})

test('a quote in member text is neutralized, so it cannot open an attribute', () => {
  const { html } = renderEmail(
    job({ subject_title: '" onmouseover="alert(1)' }),
    'https://app.test',
  )
  // The payload's *text* legitimately survives — what must not survive is a
  // usable quote character, which is what would let it break out of an
  // attribute if this value ever moved into one.
  assert.ok(!html.includes('" onmouseover="'), 'a raw quote pair must not survive')
  assert.ok(html.includes('&quot; onmouseover=&quot;alert(1)'))
})

test('the preheader is escaped too — it is the first member text in the document', () => {
  const { html } = renderEmail(job({ subject_title: '<b>bold</b>' }), 'https://app.test')
  const preheader = html.slice(html.indexOf('display:none'), html.indexOf('</div>'))
  assert.ok(!preheader.includes('<b>'))
  assert.ok(preheader.includes('&lt;b&gt;'))
})

/* ── render: clamping ─────────────────────────────────────────────────────── */

test('clamp leaves short text untouched and trims it', () => {
  assert.equal(clamp('  hello  ', 20), 'hello')
})

test('clamp cuts at a word boundary when one is late enough in the string', () => {
  assert.equal(clamp('the quick brown fox jumps', 20), 'the quick brown fox…')
})

test('clamp hard-cuts a single long word rather than returning almost nothing', () => {
  // The word boundary is at index 0, far before the 60% threshold, so falling
  // back to it would return just "a…".
  const out = clamp(`a ${'x'.repeat(40)}`, 20)
  assert.equal(out.length, 21)
  assert.ok(out.endsWith('…'))
})

test('a pasted wall of text cannot produce an unbounded subject line', () => {
  const subject = subjectFor(job({ trip_name: 'T'.repeat(5000) }))
  assert.ok(subject.length < 120, `subject was ${subject.length} chars`)
})

/* ── render: subject and body ─────────────────────────────────────────────── */

test('the subject leads with the actor and ends with the trip', () => {
  assert.equal(subjectFor(job()), 'Tenzin mentioned you · Kyoto in Autumn')
})

test('each event type gets its own verb', () => {
  const verb = (type) => subjectFor(job({ type })).split(' · ')[0]
  assert.equal(verb('checklist_assigned'), 'Tenzin assigned you a task')
  assert.equal(verb('poll_opened'), 'Tenzin opened a poll')
  assert.equal(verb('expense_owed'), 'Tenzin added an expense you owe on')
  assert.equal(verb('mention'), 'Tenzin mentioned you')
})

test('an unknown type degrades to a neutral sentence rather than "undefined"', () => {
  // A type added to the database before this renderer knows about it must not
  // ship the word "undefined" to a member's inbox.
  const subject = subjectFor(job({ type: 'something_new' }))
  assert.equal(subject, 'Tenzin needs you · Kyoto in Autumn')
})

test('a departed actor reads neutrally instead of rendering a null', () => {
  // actor_id is set null when a member leaves, so the event stands with no name.
  assert.equal(subjectFor(job({ actor_name: null })), 'Someone mentioned you · Kyoto in Autumn')
  assert.equal(subjectFor(job({ actor_name: '   ' })), 'Someone mentioned you · Kyoto in Autumn')
})

test('the message always carries a plain-text alternative', () => {
  const { text } = renderEmail(job(), 'https://app.test')
  assert.ok(text.includes('Tenzin mentioned you in the trip chat.'))
  assert.ok(text.includes('https://app.test/#/trip/t1/chat?n=n1'))
  assert.ok(!text.includes('<'), 'the text part must not contain markup')
})

test('a job with no title renders without an empty quote block', () => {
  const { html, text } = renderEmail(job({ subject_title: null }), 'https://app.test')
  assert.ok(!html.includes('border-left'), 'the quote block should be absent')
  assert.ok(!text.includes('“”'))
})

/* ── render: links ────────────────────────────────────────────────────────── */

test('absoluteLink joins an origin and a hash route without doubling slashes', () => {
  assert.equal(absoluteLink('https://app.test/', '#/trip/t1/chat'), 'https://app.test/#/trip/t1/chat')
  assert.equal(absoluteLink('https://app.test', '#/trip/t1/chat'), 'https://app.test/#/trip/t1/chat')
  assert.equal(absoluteLink('https://app.test///', '#/x'), 'https://app.test/#/x')
})

test('absoluteLink tolerates a stored route that lost its leading hash', () => {
  assert.equal(absoluteLink('https://app.test', '/trip/t1/chat'), 'https://app.test/#/trip/t1/chat')
})

test('links are absolute — a relative one is a dead end in an email client', () => {
  const { html } = renderEmail(job(), 'https://you.github.io/wander')
  assert.ok(html.includes('href="https://you.github.io/wander/#/trip/t1/chat?n=n1"'))
})

/* ── provider: the retry classification ───────────────────────────────────── */

test('rate limits and provider outages are retryable', () => {
  for (const status of [429, 500, 502, 503, 504]) {
    assert.equal(isRetryableStatus(status), true, `${status} should be retryable`)
  }
})

test('a malformed request or bad address is permanent, not retryable', () => {
  // The whole point: a 422 will be rejected identically forever, so retrying
  // it four more times only burns quota and delays the rest of the queue.
  for (const status of [400, 404, 409, 422]) {
    assert.equal(isRetryableStatus(status), false, `${status} should be permanent`)
  }
})

test('an auth failure is retryable so a rotated key drains the backlog', () => {
  assert.equal(isRetryableStatus(401), true)
  assert.equal(isRetryableStatus(403), true)
})

test('the provider reports a 2xx as sent and carries the provider id', async () => {
  const calls = []
  globalThis.fetch = async (url, init) => {
    calls.push({ url, init })
    return { ok: true, status: 200, json: async () => ({ id: 'resend-123' }) }
  }
  const result = await resendProvider('key_abc', { from: 'Wander <t@w.test>' }).send({
    to: 'a@b.test',
    subject: 's',
    html: '<p>h</p>',
    text: 't',
  })
  assert.deepEqual(result, { ok: true, id: 'resend-123', retryable: false })
  const body = JSON.parse(calls[0].init.body)
  assert.deepEqual(body.to, ['a@b.test'])
  assert.equal(body.from, 'Wander <t@w.test>')
  assert.equal(calls[0].init.headers.authorization, 'Bearer key_abc')
})

test('a 2xx with an unreadable body is still a successful send', async () => {
  globalThis.fetch = async () => ({
    ok: true,
    status: 200,
    json: async () => {
      throw new Error('not json')
    },
  })
  const result = await resendProvider('k', { from: 'f' }).send({
    to: 'a@b.test',
    subject: 's',
    html: 'h',
    text: 't',
  })
  assert.equal(result.ok, true, 'the message was accepted; the body is incidental')
})

test('a provider error keeps a slice of its own words for last_error', async () => {
  globalThis.fetch = async () => ({
    ok: false,
    status: 422,
    text: async () => 'invalid `to` field',
  })
  const result = await resendProvider('k', { from: 'f' }).send({
    to: 'nope',
    subject: 's',
    html: 'h',
    text: 't',
  })
  assert.equal(result.ok, false)
  assert.equal(result.retryable, false)
  assert.match(result.error, /resend 422: invalid `to` field/)
})

test('a thrown fetch (timeout, DNS) is retryable', async () => {
  globalThis.fetch = async () => {
    throw new Error('The operation was aborted due to timeout')
  }
  const result = await resendProvider('k', { from: 'f' }).send({
    to: 'a@b.test',
    subject: 's',
    html: 'h',
    text: 't',
  })
  assert.equal(result.ok, false)
  assert.equal(result.retryable, true)
})

test('reply_to is sent only when configured', async () => {
  const bodies = []
  globalThis.fetch = async (_u, init) => {
    bodies.push(JSON.parse(init.body))
    return { ok: true, status: 200, json: async () => ({}) }
  }
  const mail = { to: 'a@b.test', subject: 's', html: 'h', text: 't' }
  await resendProvider('k', { from: 'f' }).send(mail)
  await resendProvider('k', { from: 'f', replyTo: 'r@w.test' }).send(mail)
  assert.ok(!('reply_to' in bodies[0]))
  assert.equal(bodies[1].reply_to, 'r@w.test')
})

test('List-Unsubscribe points at the same URL the footer link does', () => {
  const { html } = renderEmail(job(), 'https://app.test')
  assert.equal(unsubscribeTarget(html), 'https://app.test/#/trip/t1/chat?n=n1')
})

test('unsubscribeTarget degrades to empty rather than throwing on odd input', () => {
  assert.equal(unsubscribeTarget('<p>no links here</p>'), '')
})

/* ── drain: the ordering and bookkeeping rules ────────────────────────────── */

/** A queue stub that records every markResult call. */
function stubQueue(jobs) {
  const marks = []
  return {
    marks,
    claimedWith: [],
    async claim(limit) {
      this.claimedWith.push(limit)
      return jobs
    },
    async markResult(id, sent, error, terminal) {
      marks.push({ id, sent, error, terminal: !!terminal })
    },
  }
}

const okProvider = { async send() { return { ok: true, id: 'x', retryable: false } } }

test('an empty queue is a no-op that reports zeroes', async () => {
  const queue = stubQueue([])
  const report = await drainOnce(queue, okProvider, { appOrigin: 'https://app.test' })
  assert.deepEqual(report, { digestsQueued: 0, claimed: 0, sent: 0, retrying: 0, dropped: 0 })
  assert.equal(queue.marks.length, 0)
})

test('a successful batch marks every row sent', async () => {
  const jobs = [job({ id: 'a' }), job({ id: 'b' }), job({ id: 'c' })]
  const queue = stubQueue(jobs)
  const report = await drainOnce(queue, okProvider, { appOrigin: 'https://app.test' })
  assert.deepEqual(report, { digestsQueued: 0, claimed: 3, sent: 3, retrying: 0, dropped: 0 })
  assert.deepEqual(
    queue.marks.map((m) => [m.id, m.sent]).sort(),
    [['a', true], ['b', true], ['c', true]],
  )
})

test('a permanent failure is marked TERMINAL so it stops consuming attempts', async () => {
  const queue = stubQueue([job({ id: 'bad' })])
  const provider = {
    async send() {
      return { ok: false, error: 'resend 422', retryable: false }
    },
  }
  const report = await drainOnce(queue, provider, { appOrigin: 'https://app.test' })
  assert.deepEqual(report, { digestsQueued: 0, claimed: 1, sent: 0, retrying: 0, dropped: 1 })
  assert.deepEqual(queue.marks, [
    { id: 'bad', sent: false, error: 'resend 422', terminal: true },
  ])
})

test('a transient failure is NOT terminal, so the next run retries it', async () => {
  const queue = stubQueue([job({ id: 'slow' })])
  const provider = {
    async send() {
      return { ok: false, error: 'resend 429', retryable: true }
    },
  }
  const report = await drainOnce(queue, provider, { appOrigin: 'https://app.test' })
  assert.deepEqual(report, { digestsQueued: 0, claimed: 1, sent: 0, retrying: 1, dropped: 0 })
  assert.equal(queue.marks[0].terminal, false)
})

test('a throw inside one send does not strand the rest of the batch', async () => {
  const jobs = [job({ id: 'a' }), job({ id: 'boom' }), job({ id: 'c' })]
  const queue = stubQueue(jobs)
  const provider = {
    async send({ to }) {
      if (to === 'boom@example.com') throw new Error('kaboom')
      return { ok: true, retryable: false }
    },
  }
  jobs[1].to_email = 'boom@example.com'
  const report = await drainOnce(queue, provider, { appOrigin: 'https://app.test' })
  assert.equal(report.claimed, 3)
  assert.equal(report.sent, 2, 'the two healthy rows still went out')
  assert.equal(report.retrying, 1)
  const boom = queue.marks.find((m) => m.id === 'boom')
  assert.equal(boom.sent, false)
  assert.equal(boom.terminal, false, 'our own bug should not discard a real notification')
  assert.match(boom.error, /drain error: kaboom/)
})

test('a drain survives markResult itself failing', async () => {
  const queue = {
    async claim() {
      return [job({ id: 'a' })]
    },
    async markResult() {
      throw new Error('db unreachable')
    },
  }
  const provider = {
    async send() {
      throw new Error('send blew up')
    },
  }
  // Both the send and the bookkeeping fail; the pass must still return a
  // report rather than rejecting and failing the whole scheduled run.
  const report = await drainOnce(queue, provider, { appOrigin: 'https://app.test' })
  assert.deepEqual(report, { digestsQueued: 0, claimed: 1, sent: 0, retrying: 1, dropped: 0 })
})

test('the claim limit is clamped to a sane range', async () => {
  for (const [asked, expected] of [
    [undefined, DEFAULT_LIMIT],
    [0, 1],
    [-5, 1],
    [10, 10],
    [9999, 200],
  ]) {
    const queue = stubQueue([])
    await drainOnce(queue, okProvider, { appOrigin: 'https://app.test', limit: asked })
    assert.equal(queue.claimedWith[0], expected, `limit ${asked}`)
  }
})

test('concurrency is bounded and every job is still delivered exactly once', async () => {
  const jobs = Array.from({ length: 20 }, (_, i) => job({ id: `j${i}` }))
  const queue = stubQueue(jobs)
  let inFlight = 0
  let peak = 0
  const provider = {
    async send() {
      inFlight++
      peak = Math.max(peak, inFlight)
      await new Promise((r) => setTimeout(r, 1))
      inFlight--
      return { ok: true, retryable: false }
    },
  }
  const report = await drainOnce(queue, provider, {
    appOrigin: 'https://app.test',
    concurrency: 3,
  })
  assert.equal(report.sent, 20)
  assert.ok(peak <= 3, `peak concurrency was ${peak}`)
  assert.equal(new Set(queue.marks.map((m) => m.id)).size, 20, 'no job sent twice')
})

/* ── render: the chat digest shape ───────────────────────────────────────── */

/** A queued chat digest — no actor, no type, no title, a count instead. */
const digest = (over = {}) => ({
  id: 'ob-d1',
  to_email: 'friend@example.com',
  kind: 'chat_digest',
  type: null,
  subject_title: null,
  trip_name: 'Kyoto in Autumn',
  actor_name: null,
  deep_link: '#/trip/t1/chat',
  digest_count: 7,
  attempts: 0,
  ...over,
})

test('isDigest distinguishes the two shapes', () => {
  assert.equal(isDigest(digest()), true)
  assert.equal(isDigest(job()), false)
  // A row written before digests existed has no kind and is a notification.
  assert.equal(isDigest({ ...job(), kind: undefined }), false)
})

test('pluralMessages agrees with itself at the boundary', () => {
  assert.equal(pluralMessages(1), '1 message')
  assert.equal(pluralMessages(2), '2 messages')
  assert.equal(pluralMessages(0), '0 messages')
})

test('a digest subject leads with the count, not an actor', () => {
  // The count is the entire decision the recipient makes from the subject.
  assert.equal(subjectFor(digest()), '7 messages in the trip chat · Kyoto in Autumn')
})

test('a digest of one message reads naturally', () => {
  assert.equal(subjectFor(digest({ digest_count: 1 })), '1 message in the trip chat · Kyoto in Autumn')
  const { text } = renderEmail(digest({ digest_count: 1 }), 'https://app.test')
  assert.ok(text.includes('There’s a new message in the trip chat.'))
})

test('a digest never says "Someone" — it has no actor by nature', () => {
  const { subject, text, html } = renderEmail(digest(), 'https://app.test')
  for (const part of [subject, text, html]) {
    assert.ok(!part.includes('Someone'), 'a digest must not invent an actor')
  }
})

test('a digest with a missing count still renders sensibly', () => {
  // Defensive: the column is NOT NULL for digests, but a renderer that emits
  // "null messages" would be worse than one that assumes at least one.
  assert.equal(subjectFor(digest({ digest_count: null })), '1 message in the trip chat · Kyoto in Autumn')
  assert.equal(subjectFor(digest({ digest_count: 0 })), '1 message in the trip chat · Kyoto in Autumn')
})

test('a digest links to the chat tab with no notification id', () => {
  const { html } = renderEmail(digest(), 'https://app.test')
  assert.ok(html.includes('href="https://app.test/#/trip/t1/chat"'))
  assert.ok(!html.includes('?n='), 'there is no single notification to point at')
})

test('a digest has its own call to action', () => {
  const { html } = renderEmail(digest(), 'https://app.test')
  assert.ok(html.includes('Catch up on the chat'))
})

test('a digest carries no quote block — there is no single message to quote', () => {
  const { html } = renderEmail(digest(), 'https://app.test')
  assert.ok(!html.includes('border-left'))
})

test('a malicious trip name is escaped in a digest too', () => {
  const { html } = renderEmail(
    digest({ trip_name: '<script>alert(1)</script>' }),
    'https://app.test',
  )
  assert.ok(!html.includes('<script>'))
  assert.ok(html.includes('&lt;script&gt;'))
})

/* ── drain: the digest enqueue step ──────────────────────────────────────── */

test('the drain enqueues digests before it claims', async () => {
  const order = []
  const queue = {
    async enqueueDigests() { order.push('enqueue'); return 3 },
    async claim() { order.push('claim'); return [] },
    async markResult() {},
  }
  const report = await drainOnce(queue, okProvider, { appOrigin: 'https://app.test' })
  // Order matters: a digest queued after the claim would wait a whole interval.
  assert.deepEqual(order, ['enqueue', 'claim'])
  assert.equal(report.digestsQueued, 3)
})

test('a failing digest enqueue does not stop event emails going out', async () => {
  const queue = {
    async enqueueDigests() { throw new Error('rpc exploded') },
    async claim() { return [job({ id: 'a' })] },
    marks: [],
    async markResult(id, sent) { this.marks.push([id, sent]) },
  }
  const report = await drainOnce(queue, okProvider, { appOrigin: 'https://app.test' })
  assert.equal(report.digestsQueued, 0)
  assert.equal(report.sent, 1, 'the unrelated notification email still sent')
})

test('a queue without enqueueDigests still works', async () => {
  // The method is optional so a caller that has not migrated keeps working.
  const queue = stubQueue([job({ id: 'a' })])
  const report = await drainOnce(queue, okProvider, { appOrigin: 'https://app.test' })
  assert.equal(report.digestsQueued, 0)
  assert.equal(report.sent, 1)
})

test('a digest is delivered through the same drain as a notification', async () => {
  const sent = []
  const queue = {
    async enqueueDigests() { return 1 },
    async claim() { return [digest({ id: 'd1' }), job({ id: 'n1' })] },
    async markResult() {},
  }
  const provider = {
    async send(mail) { sent.push(mail.subject); return { ok: true, retryable: false } },
  }
  const report = await drainOnce(queue, provider, { appOrigin: 'https://app.test' })
  assert.equal(report.sent, 2)
  assert.ok(sent.some((s) => s.startsWith('7 messages in the trip chat')))
  assert.ok(sent.some((s) => s.startsWith('Tenzin mentioned you')))
})

test('a drain report never carries an address', async () => {
  // The report is logged to a public CI run, so this is a real constraint and
  // not a stylistic one.
  const queue = stubQueue([job({ to_email: 'private@person.test' })])
  const report = await drainOnce(queue, okProvider, { appOrigin: 'https://app.test' })
  assert.ok(!JSON.stringify(report).includes('private@person.test'))
  assert.deepEqual(Object.keys(report).sort(),
    ['claimed', 'digestsQueued', 'dropped', 'retrying', 'sent'])
})
