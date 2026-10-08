/**
 * End-to-end verification of the email notification pipeline (epic #181).
 *
 * WHY THIS EXISTS. The email channel is tested in two places that never meet:
 * tests/email.test.mjs covers the TypeScript (rendering, the retry
 * classification, the drain's ordering rules) with stubs, and
 * supabase/tests/rls_policies_test.sql covers the database (who may queue what,
 * and who may never read an address). Both can pass while the join between them
 * is broken — a renamed RPC argument, a `claim_email_batch` column the drain
 * reads under a different name, or the deep-link builder in the migration
 * drifting from src/features/notifications/route.ts. This script exercises the
 * seam: the REAL SQL functions driving the REAL drain code.
 *
 * The only simulated component is api.resend.com, replaced by a fetch
 * interceptor that asserts the outgoing request is what Resend's API expects.
 * Nothing is ever sent, and no credential is needed.
 *
 * HOW TO RUN. Needs a throwaway Postgres with the baseline + migrations already
 * applied — exactly what scripts/run-rls-tests.sh sets up:
 *
 *   DATABASE_URL=postgres://… bash scripts/run-rls-tests.sh
 *   DATABASE_URL=postgres://… node scripts/verify-email-pipeline.mjs
 *
 * It seeds its own fixtures under a dedicated trip id and removes them on the
 * way out, so it is safe to re-run. It must NOT be pointed at a live project:
 * it writes rows, and the service-role-only functions it calls are reached here
 * as the database superuser.
 */
import { execFileSync } from 'node:child_process'
import { register } from 'node:module'

const DB = process.env.DATABASE_URL
if (!DB) {
  console.error('DATABASE_URL is not set — see the header for how to run this.')
  process.exit(2)
}

// The drain imports './render' and './provider' extensionless, which Node's
// type-stripping loader will not resolve on its own. Same resolve hook the
// unit tests use.
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

const { drainOnce } = await import('../src/server/email/drain.ts')
const { resendProvider } = await import('../src/server/email/provider.ts')

const sql = (query) =>
  execFileSync('psql', ['-tA', '--no-psqlrc', '-v', 'ON_ERROR_STOP=1', DB, '-c', query], {
    encoding: 'utf8',
  }).trim()

/**
 * Read one column of THIS script's outbox row.
 *
 * Every assertion goes through here rather than `select … from email_outbox`,
 * because an unscoped query returns one line per row and a leftover row from
 * another fixture then fails a check that is actually fine — which is exactly
 * what happened the first time this script was run against a dirty database.
 */
const ours = (expr) =>
  sql(`select ${expr} from email_outbox where notification_id = '${NOTIFICATION}'`)

/* ── fixtures ─────────────────────────────────────────────────────────────── */

const TRIP = '22220000-0000-4000-8000-0000000000e1'
const ACTOR_USER = '11110000-0000-4000-8000-0000000000e1'
const RECIP_USER = '11110000-0000-4000-8000-0000000000e2'
const RECIP_MEMBER = '33330000-0000-4000-8000-0000000000e2'
const NOTIFICATION = '44440000-0000-4000-8000-0000000000e1'
const APP_ORIGIN = 'https://tseten1996.github.io/wander'

// chat_reads, email_prefs, messages and outbox rows all cascade from the trip
// or the members it owns, so deleting the trip and the two users is enough.
const cleanup = () =>
  sql(`
    delete from public.trips where id = '${TRIP}';
    delete from auth.users where id in ('${ACTOR_USER}', '${RECIP_USER}');
  `)

function seed() {
  cleanup()
  sql(`
    insert into auth.users (id, instance_id, aud, role, email, encrypted_password, email_confirmed_at)
    values
      ('${ACTOR_USER}','00000000-0000-0000-0000-000000000000','authenticated','authenticated','pipeline-actor@wander.test','',now()),
      ('${RECIP_USER}','00000000-0000-0000-0000-000000000000','authenticated','authenticated','pipeline-recipient@wander.test','',now());

    insert into public.trips (id, owner_id, name, invite_code, invite_enabled)
    values ('${TRIP}','${ACTOR_USER}','Kyoto in Autumn','pipelineverify1',true);

    insert into public.members (id, trip_id, user_id, display_name, role)
    values ('${RECIP_MEMBER}','${TRIP}','${RECIP_USER}','Priya','member');
  `)

  // The recipient opts in AS THEMSELVES, through RLS — not as superuser — so
  // the self-owned insert policy is part of what this verifies.
  sql(`
    begin;
    set local role authenticated;
    select set_config('request.jwt.claims','{"sub":"${RECIP_USER}","role":"authenticated"}',true);
    insert into public.email_prefs (member_id, trip_id, enabled) values ('${RECIP_MEMBER}','${TRIP}',true);
    commit;
  `)
}

/** Exactly what src/lib/notify.ts does: mint the id, insert, hand it over. */
function notifyAndEnqueue() {
  return sql(`
    begin;
    set local role authenticated;
    select set_config('request.jwt.claims','{"sub":"${ACTOR_USER}","role":"authenticated"}',true);
    insert into public.notifications (id, trip_id, recipient_id, actor_id, type, title)
    values ('${NOTIFICATION}','${TRIP}','${RECIP_MEMBER}',
            (select id from public.members where trip_id='${TRIP}' and role='owner'),
            'mention','are we still locking in the Arashiyama morning?');
    select enqueue_emails_for_notifications(array['${NOTIFICATION}']::uuid[]);
    commit;
  `)
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => /^\d+$/.test(l))
    .pop()
}

/* ── the queue, as the Pages Function builds it ───────────────────────────── */

// Same two RPCs, same argument names, same contract as
// functions/api/email-drain.ts — over psql instead of supabase-js.
const queue = {
  async enqueueDigests() {
    return Number(sql('select enqueue_chat_digests()')) || 0
  },
  async claim(limit) {
    return JSON.parse(sql(`select coalesce(json_agg(t), '[]') from claim_email_batch(${limit}) t`))
  },
  async markResult(id, sent, error, terminal) {
    const err = error ? `'${String(error).replace(/'/g, "''")}'` : 'null'
    sql(`select mark_email_result('${id}'::uuid, ${sent}, ${err}, ${!!terminal})`)
  },
}

/* ── run ──────────────────────────────────────────────────────────────────── */

const checks = []
const check = (name, ok) => checks.push([name, !!ok])

const captured = []
globalThis.fetch = async (url, init) => {
  captured.push({ url, init })
  return { ok: true, status: 200, json: async () => ({ id: 'resend-simulated' }) }
}
const provider = resendProvider('re_simulated_key_not_real', {
  from: 'Wander <trips@example-verified.test>',
})
const drain = () => drainOnce(queue, provider, { appOrigin: APP_ORIGIN })

try {
  seed()

  // `claim_email_batch` hands out every due row, so the report counts below
  // are only meaningful when nothing else is queued. Fail loudly rather than
  // reporting a confusing mix of someone else's rows as ours.
  const existing = sql('select count(*) from email_outbox')
  if (existing !== '0') {
    console.error(
      `email_outbox already holds ${existing} row(s). This script needs a database ` +
        `with an empty outbox — see the header. Nothing was changed.`,
    )
    process.exit(2)
  }

  const queued = notifyAndEnqueue()
  check('enqueue returned a count, not a row', queued === '1')
  check(
    'the address was resolved server-side into the outbox',
    sql(`select to_email from email_outbox where notification_id='${NOTIFICATION}'`) ===
      'pipeline-recipient@wander.test',
  )

  // 1. The send delay must hold the row back.
  const early = await drain()
  check('nothing is claimable before the send delay elapses', early.claimed === 0)
  check('no provider call was made', captured.length === 0)

  // 2. Reading it in the app during the window must cancel the email outright.
  sql(`update notifications set read_at = now() where id='${NOTIFICATION}'`)
  sql(`update email_outbox set send_after = now() - interval '1 second'
       where notification_id = '${NOTIFICATION}'`)
  const afterRead = await drain()
  check('a read notification is never claimed', afterRead.claimed === 0)
  check('no provider call for a read notification', captured.length === 0)
  check(
    'the read row is retired as sent, with the reason recorded',
    ours('state') === 'sent' && ours('last_error') === 'skipped: read in app',
  )

  // 3. The real thing: unread, window elapsed.
  sql(`update notifications set read_at = null where id='${NOTIFICATION}'`)
  sql(`update email_outbox
       set state='pending', sent_at=null, last_error=null, attempts=0,
           send_after = now() - interval '1 second'
       where notification_id = '${NOTIFICATION}'`)
  const report = await drain()
  check('one row claimed', report.claimed === 1)
  check('one row sent', report.sent === 1)
  check('exactly one provider call', captured.length === 1)
  check('the attempt was charged at claim time', ours('attempts') === '1')
  // Asserted as two separate reads rather than one concatenation: Postgres
  // renders a boolean as 'true' inside `||` but as 't' as a bare column, and
  // guessing which applies is how this check failed the first time.
  check('the row is marked sent', ours('state') === 'sent')
  check('and carries a sent_at timestamp', ours('sent_at') !== '')
  check('the drain report carries no address', !JSON.stringify(report).includes('@'))

  // 4. The request Resend would actually receive.
  const body = JSON.parse(captured[0].init.body)
  check('posted to the Resend endpoint', captured[0].url === 'https://api.resend.com/emails')
  check('bearer auth is set', captured[0].init.headers.authorization.startsWith('Bearer '))
  check('addressed to the confirmed address', body.to[0] === 'pipeline-recipient@wander.test')
  check('the actor name was resolved from the members row', !body.subject.startsWith('Someone'))
  check('the subject names the actor and the trip',
    /mentioned you · Kyoto in Autumn$/.test(body.subject))
  check('both html and text parts are present', !!body.html && !!body.text)
  // The migration builds the deep link in SQL; route.ts builds it in TS. This
  // is the assertion that catches them drifting apart.
  const expectedLink = `${APP_ORIGIN}/#/trip/${TRIP}/chat?n=${NOTIFICATION}`
  check('the link is absolute and targets the chat tab', body.html.includes(expectedLink))
  check('the text part carries the same link', body.text.includes(expectedLink))
  check('List-Unsubscribe matches the footer link',
    body.headers['List-Unsubscribe'] === `<${expectedLink}>`)

  // 5. A permanent provider failure must not cost five sends.
  sql(`update email_outbox set state='pending', sent_at=null, attempts=0,
       send_after = now() - interval '1 second'
       where notification_id = '${NOTIFICATION}'`)
  globalThis.fetch = async () => ({ ok: false, status: 422, text: async () => 'invalid `to`' })
  const rejected = await drain()
  check('a 422 is reported as dropped, not retrying', rejected.dropped === 1)
  check('and the row is terminal, not left pending', ours('state') === 'failed')

  /* ── the chat digest path ──────────────────────────────────────────────── */

  // Clear the notification row so the digest is the only thing in flight.
  sql(`delete from email_outbox where notification_id = '${NOTIFICATION}'`)
  captured.length = 0
  globalThis.fetch = async (url, init) => {
    captured.push({ url, init })
    return { ok: true, status: 200, json: async () => ({ id: 'resend-simulated' }) }
  }

  // The recipient opts into the digest, as themselves, and is behind: the
  // actor's message below lands after their read marker.
  sql(`
    begin;
    set local role authenticated;
    select set_config('request.jwt.claims','{"sub":"${RECIP_USER}","role":"authenticated"}',true);
    update email_prefs set chat_digest = true;
    insert into chat_reads (member_id, trip_id, last_read_at)
    values ('${RECIP_MEMBER}','${TRIP}', now() - interval '2 days');
    commit;
  `)
  sql(`
    insert into messages (trip_id, member_id, content)
    select '${TRIP}', m.id, 'message ' || g
    from members m, generate_series(1, 3) g
    where m.trip_id = '${TRIP}' and m.role = 'owner';
  `)

  const digestReport = await drain()
  check('the drain queued one digest', digestReport.digestsQueued === 1)
  check('and sent it', digestReport.sent === 1)

  const digestBody = JSON.parse(captured[0].init.body)
  check('the digest counts only the other member\'s messages',
    /^3 messages in the trip chat/.test(digestBody.subject))
  check('the digest subject names the trip',
    digestBody.subject.endsWith('· Kyoto in Autumn'))
  check('the digest names no actor', !digestBody.html.includes('Someone'))
  check('the digest links to the chat tab with no notification id',
    digestBody.html.includes(`${APP_ORIGIN}/#/trip/${TRIP}/chat"`))
  check('the digest went to the confirmed address',
    digestBody.to[0] === 'pipeline-recipient@wander.test')

  // The throttle, and the catch-up withdrawal.
  const throttled = await drain()
  check('the interval throttle blocks an immediate second digest',
    throttled.digestsQueued === 0)

  sql(`update email_prefs set last_digest_at = null`)
  sql(`delete from email_outbox where kind = 'chat_digest'`)
  const requeued = await drain()
  check('a digest is queued again once the throttle is cleared',
    requeued.digestsQueued === 1)

  sql(`update email_prefs set last_digest_at = null`)
  sql(`delete from email_outbox where kind = 'chat_digest'`)
  // Queue one, then have the reader catch up before the next pass claims it.
  sql('select enqueue_chat_digests()')
  sql(`update chat_reads set last_read_at = now() where member_id = '${RECIP_MEMBER}'`)
  const caughtUp = await drain()
  check('a caught-up reader is never mailed a digest', caughtUp.sent === 0)
  check('and the digest row is retired as skipped',
    sql(`select state || '|' || last_error from email_outbox where kind = 'chat_digest'`) ===
      'sent|skipped: read in app')

  console.log(`\nemail pipeline — real SQL functions driving the real drain code`)
  console.log(`  notification: ${body.subject}`)
  console.log(`  digest:       ${digestBody.subject}`)
  console.log(`  link:         ${expectedLink}\n`)
  for (const [name, ok] of checks) console.log(`  ${ok ? 'ok  ' : 'FAIL'}  ${name}`)

  const failed = checks.filter(([, ok]) => !ok)
  console.log(
    failed.length === 0
      ? `\nemail pipeline: ${checks.length}/${checks.length} passed`
      : `\nemail pipeline: ${failed.length}/${checks.length} FAILED`,
  )
  process.exitCode = failed.length === 0 ? 0 : 1
} finally {
  cleanup()
}
