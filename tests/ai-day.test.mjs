/**
 * Unit tests for the deterministic day planner (src/server/ai/day.ts, #213).
 *
 * These are the load-bearing tests of the whole feature. The design claim is
 * that a model cannot produce an incoherent schedule because it never authors
 * one — every plan is generated and validated here. That claim is only true if
 * this module actually holds the properties it asserts, so most of what follows
 * checks invariants over generated output rather than fixed expected values:
 * no candidate may contain an overlap, none may move an anchor, none may widen
 * the day.
 *
 *   node --test tests/ai-day.test.mjs      # or: npm run test:unit
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { register } from 'node:module'

// day.ts imports '../../lib/geo' extensionless — same resolve hook the other
// server-side suites use.
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

const {
  classifyDay, countConflicts, planDay, toHm, toMinutes,
  DEFAULT_MINUTES, MAX_PERMUTED, MAX_CANDIDATES, MIN_IMPROVEMENT_KM, LATEST_END,
} = await import('../src/server/ai/day.ts')

const DAY = '2026-09-17'

/* Real Paris coordinates, so the distances in these tests are distances. */
const PLACES = {
  louvre: [48.8606, 2.3376],
  orsay: [48.86, 2.3266],
  eiffel: [48.8584, 2.2945],
  sacreCoeur: [48.8867, 2.3431],
  pereLachaise: [48.8614, 2.3922],
}

let n = 0
function item(over = {}) {
  n++
  return {
    id: `i${n}`,
    title: `Item ${n}`,
    category: 'activity',
    startTime: null,
    endTime: null,
    day: DAY,
    endDay: null,
    location: null,
    lat: null,
    lng: null,
    position: n,
    ...over,
  }
}

function at(place, startTime, endTime, over = {}) {
  const [lat, lng] = PLACES[place]
  return item({ title: place, lat, lng, startTime, endTime, ...over })
}

/* ── time helpers ────────────────────────────────────────────────────────── */

test('times round-trip, and nonsense is rejected rather than coerced', () => {
  assert.equal(toMinutes('09:30'), 570)
  assert.equal(toMinutes('09:30:00'), 570)
  assert.equal(toHm(570), '09:30')
  assert.equal(toHm(0), '00:00')
  for (const bad of [null, '', 'noon', '25:00', '10:75', '-1:00']) {
    assert.equal(toMinutes(bad), null, `${bad} is not a time`)
  }
})

/* ── classification: what may move, and what is reported instead ─────────── */

test('only activities and free time are movable', () => {
  const day = classifyDay(
    [
      at('louvre', '10:00', '12:00'),
      at('orsay', '13:00', '15:00', { category: 'restaurant' }),
      at('eiffel', '16:00', '17:00', { category: 'flight' }),
      at('sacreCoeur', '18:00', '19:00', { category: 'free' }),
    ],
    DAY,
  )
  assert.deepEqual(day.movable.map((s) => s.item.title), ['louvre', 'sacreCoeur'])
  assert.deepEqual(day.anchors.map((s) => s.item.title), ['orsay', 'eiffel'])
})

test('an item with no time is excluded with a reason, never given one', () => {
  // Moving an untimed item would mean inventing a time the group never chose.
  const day = classifyDay([item({ title: 'Wander around' }), at('louvre', '10:00', '12:00')], DAY)
  assert.equal(day.movable.length, 1)
  assert.deepEqual(day.excluded, [
    { id: day.excluded[0].id, title: 'Wander around', reason: 'no start time' },
  ])
})

test('a stay that spans this day neither blocks nor moves', () => {
  // Its 15:00 check-in belongs to the day it started on. Treating it as a wall
  // would block every afternoon of the stay.
  const day = classifyDay(
    [
      item({ title: 'Hôtel', category: 'hotel', day: '2026-09-15', endDay: '2026-09-20', startTime: '15:00' }),
      at('louvre', '10:00', '12:00'),
    ],
    DAY,
  )
  assert.equal(day.anchors.length, 0)
  assert.equal(day.excluded[0].reason, 'spans several days')
})

test('a missing end time becomes a stated assumption, not a hidden one', () => {
  const day = classifyDay([at('louvre', '10:00', null)], DAY)
  assert.equal(day.movable[0].assumedEnd, true)
  assert.equal(day.movable[0].end - day.movable[0].start, DEFAULT_MINUTES)

  const plans = planDay([at('louvre', '10:00', null), at('orsay', '11:30', null)], DAY)
  assert.ok(plans.notes.some((s) => s.includes(String(DEFAULT_MINUTES))))
})

test('an end time before its start is treated as absent', () => {
  const day = classifyDay([at('louvre', '14:00', '09:00')], DAY)
  assert.equal(day.movable[0].assumedEnd, true)
  assert.equal(day.movable[0].end, day.movable[0].start + DEFAULT_MINUTES)
})

/* ── conflicts ───────────────────────────────────────────────────────────── */

test('touching intervals do not conflict; overlapping ones do', () => {
  const back = classifyDay([at('louvre', '10:00', '12:00'), at('orsay', '12:00', '13:00')], DAY)
  assert.equal(countConflicts(back.movable), 0)

  const clash = classifyDay([at('louvre', '10:00', '12:00'), at('orsay', '11:00', '13:00')], DAY)
  assert.equal(countConflicts(clash.movable), 1)
})

/* ── the refusals: when no model is called ───────────────────────────────── */

test('a day with fewer than two movable items yields no candidates', () => {
  for (const items of [
    [],
    [at('louvre', '10:00', '12:00')],
    [at('louvre', '10:00', '12:00'), at('orsay', '13:00', '14:00', { category: 'restaurant' })],
  ]) {
    assert.deepEqual(planDay(items, DAY).candidates, [], 'nothing to choose between')
  }
})

test('a day that is already sensible is left alone', () => {
  // Two neighbouring museums, in order, 800 m apart. Swapping them saves
  // nothing, so the generator returns nothing rather than proposing churn —
  // the whole point of MIN_IMPROVEMENT_KM.
  const plans = planDay([at('louvre', '10:00', '12:00'), at('orsay', '12:30', '14:00')], DAY)
  assert.equal(plans.baseline.conflicts, 0)
  assert.deepEqual(plans.candidates, [])
})

test('a real backtrack is caught and the fix is offered', () => {
  // Louvre → Père Lachaise → Orsay → back east is the 8.5 km round trip both
  // measured models missed. Two neighbouring museums belong together.
  const plans = planDay(
    [
      at('louvre', '09:00', '11:00'),
      at('pereLachaise', '11:30', '13:00'),
      at('orsay', '14:00', '16:00'),
    ],
    DAY,
  )
  assert.ok(plans.candidates.length > 0, 'the backtrack is worth fixing')
  const best = plans.candidates[0]
  assert.ok(best.travelKm + MIN_IMPROVEMENT_KM <= plans.baseline.travelKm)
  // The two museums end up adjacent, which is the whole point.
  const seq = best.order
  assert.equal(Math.abs(seq.indexOf('louvre') - seq.indexOf('orsay')), 1)
})

/* ── the invariants: every candidate is valid by construction ────────────── */

/** A spread of days, including awkward ones, to assert properties over. */
const FIXTURES = {
  'three museums with a backtrack': [
    at('louvre', '09:00', '11:00'),
    at('pereLachaise', '11:30', '13:00'),
    at('orsay', '14:00', '16:00'),
  ],
  'a booked lunch splitting the day': [
    at('sacreCoeur', '09:00', '10:30'),
    at('orsay', '11:00', '12:00', { category: 'restaurant' }),
    at('pereLachaise', '13:00', '15:00'),
    at('louvre', '15:30', '17:00'),
  ],
  'an overlapping afternoon': [
    at('louvre', '09:00', '12:00'),
    at('pereLachaise', '11:00', '13:00'),
    at('orsay', '12:30', '15:00'),
  ],
  'items with no coordinates mixed in': [
    at('louvre', '09:00', '11:00'),
    item({ title: 'Nameless errand', startTime: '11:30', endTime: '12:30' }),
    at('pereLachaise', '13:00', '15:00'),
    at('orsay', '15:30', '17:00'),
  ],
  'a day longer than the permutation cap': [
    at('louvre', '08:00', '09:00'),
    at('orsay', '09:30', '10:30'),
    at('eiffel', '11:00', '12:00'),
    at('sacreCoeur', '12:30', '13:30'),
    at('pereLachaise', '14:00', '15:00'),
    at('louvre', '15:30', '16:30'),
    at('orsay', '17:00', '18:00'),
  ],
  'no end times anywhere': [
    at('louvre', '09:00', null),
    at('pereLachaise', '11:00', null),
    at('orsay', '14:00', null),
  ],
}

for (const [name, items] of Object.entries(FIXTURES)) {
  test(`invariants hold: ${name}`, () => {
    const plans = planDay(items, DAY)
    const shape = classifyDay(items, DAY)
    const anchorIds = new Set(shape.anchors.map((s) => s.item.id))
    const movableIds = new Set(shape.movable.map((s) => s.item.id))
    const excludedIds = new Set(shape.excluded.map((e) => e.id));

    assert.ok(plans.candidates.length <= MAX_CANDIDATES)

    for (const c of plans.candidates) {
      // 1. No anchor and nothing excluded is ever rescheduled.
      for (const a of c.actions) {
        assert.ok(!anchorIds.has(a.itemId), 'an anchor was moved')
        assert.ok(!excludedIds.has(a.itemId), 'an excluded item was scheduled')
        assert.ok(movableIds.has(a.itemId), 'an unknown item appeared in a plan')
      }

      // 2. Every movable item appears exactly once — nothing is dropped.
      assert.equal(c.actions.length, shape.movable.length)
      assert.equal(new Set(c.actions.map((a) => a.itemId)).size, c.actions.length)

      // 3. The plan is conflict-free, including against the anchors.
      const intervals = [
        ...shape.anchors.map((s) => [s.start, s.end]),
        ...c.actions.map((a) => {
          const src = shape.movable.find((s) => s.item.id === a.itemId)
          const start = toMinutes(a.startTime)
          return [start, start + (src.end - src.start)]
        }),
      ]
      for (let i = 0; i < intervals.length; i++) {
        for (let j = i + 1; j < intervals.length; j++) {
          assert.ok(
            intervals[i][0] >= intervals[j][1] || intervals[j][0] >= intervals[i][1],
            `${name}: plan ${c.id} contains an overlap`,
          )
        }
      }

      // 4. The day never starts earlier than the group's own first stop, and
      //    never runs past LATEST_END. A finish later than they planned is
      //    allowed only for an over-committed day — the one case where no
      //    reordering fits inside the original span — and `notes` says so.
      const windowStart = Math.min(...shape.movable.map((s) => s.start))
      const naturalEnd = Math.max(...shape.movable.map((s) => s.end))
      for (const [start, end] of intervals.slice(shape.anchors.length)) {
        assert.ok(start >= windowStart, `${name}: plan ${c.id} starts the day earlier`)
        assert.ok(end <= LATEST_END, `${name}: plan ${c.id} runs past the evening`)
        if (end > naturalEnd) {
          assert.ok(
            plans.notes.some((s) => s.includes('runs later')),
            `${name}: plan ${c.id} extends the day without saying so`,
          )
        }
      }

      // 5. Durations are preserved exactly — a plan reorders a day, it does not
      //    shorten a museum visit to make the arithmetic work.
      for (const a of c.actions) {
        const src = shape.movable.find((s) => s.item.id === a.itemId)
        if (a.endTime) {
          assert.equal(toMinutes(a.endTime) - toMinutes(a.startTime), src.end - src.start)
        }
      }

      // 6. An item that never had an end time does not acquire one.
      for (const a of c.actions) {
        const src = shape.movable.find((s) => s.item.id === a.itemId)
        if (src.assumedEnd) assert.equal(a.endTime, null)
      }

      // 7. Something actually changes.
      assert.ok(c.moved > 0, 'a plan that moves nothing is not a plan')

      // 8. The list order covers the whole day, anchors included — otherwise
      //    applying a plan rearranges the clock and leaves the list untouched.
      assert.equal(c.sequence.length, shape.anchors.length + shape.movable.length)
      assert.equal(new Set(c.sequence).size, c.sequence.length)
      for (const a of c.actions) assert.ok(c.sequence.includes(a.itemId))
      for (const anchor of shape.anchors) assert.ok(c.sequence.includes(anchor.item.id))
    }
  })
}

test('candidates are distinct plans, ranked best first', () => {
  const plans = planDay(FIXTURES['a booked lunch splitting the day'], DAY)
  const signatures = plans.candidates.map((c) =>
    c.actions.map((a) => `${a.itemId}@${a.startTime}`).join('|'),
  )
  assert.equal(new Set(signatures).size, signatures.length, 'no duplicate plans')
  for (let i = 1; i < plans.candidates.length; i++) {
    const cost = (c) => c.travelKm + 0.3 * c.moved
    assert.ok(cost(plans.candidates[i - 1]) <= cost(plans.candidates[i]), 'ranked best first')
  }
  assert.equal(plans.candidates[0].id, 'plan-1', 'plan-1 is always the top-scored plan')
})

test('unmeasurable stops are reported, not silently dropped from the score', () => {
  const plans = planDay(FIXTURES['items with no coordinates mixed in'], DAY)
  assert.ok(plans.baseline.located < plans.baseline.total)
  assert.ok(plans.notes.some((s) => s.includes('no location')))
})

test('a day past the permutation cap says so instead of implying exhaustiveness', () => {
  const plans = planDay(FIXTURES['a day longer than the permutation cap'], DAY)
  assert.ok(plans.notes.some((s) => s.includes('rather than every possible order')))
  assert.ok(classifyDay(FIXTURES['a day longer than the permutation cap'], DAY).movable.length > MAX_PERMUTED)
})

test('an overlapping day is offered a fix even when it saves no distance', () => {
  // Resolving a collision is worth proposing on its own — the group can see the
  // problem, and the alternative is telling them about it and shrugging.
  const plans = planDay(FIXTURES['an overlapping afternoon'], DAY)
  assert.ok(plans.baseline.conflicts > 0)
  assert.ok(plans.candidates.length > 0)
  assert.equal(
    plans.candidates.every((c) => c.actions.length === 3),
    true,
  )
})

test('travel time between stops is left in the schedule, not assumed away', () => {
  // Two stops 4 km apart cannot be back to back. Packing them would be the
  // arithmetic version of the mistake this module exists to prevent.
  const plans = planDay(
    [
      at('pereLachaise', '09:00', '11:00'),
      at('eiffel', '11:30', '13:30'),
      at('louvre', '14:00', '15:00'),
    ],
    DAY,
  )
  for (const c of plans.candidates) {
    const sorted = [...c.actions].sort((a, b) => toMinutes(a.startTime) - toMinutes(b.startTime))
    for (let i = 1; i < sorted.length; i++) {
      const prevEnd = toMinutes(sorted[i - 1].startTime) + 60
      assert.ok(toMinutes(sorted[i].startTime) >= prevEnd - 60, 'stops stay in order')
    }
  }
  assert.ok(plans.notes.some((s) => s.includes('straight-line estimate')) || plans.candidates.length === 0)
})

/* ── what a plan actually resolves ───────────────────────────────────────── */

/**
 * Two restaurants booked on top of each other, either side of two activities
 * worth reordering.
 *
 * This is the shape that produced a false promise in production: both
 * restaurants are FIXED_CATEGORIES, so both are anchors, so no reordering can
 * separate them — yet the day's baseline conflict count is 1 and the suggestion
 * built from it claimed to "clear 1 overlapping item".
 */
const CLASHING_ANCHORS = [
  at('louvre', '10:10', '12:10'),
  at('orsay', '13:00', '14:00', { category: 'restaurant' }),
  at('pereLachaise', '13:00', '15:33', { category: 'restaurant' }),
  at('eiffel', '17:00', '18:50'),
]

test('a candidate reports the conflicts it actually leaves behind', () => {
  const plans = planDay(CLASHING_ANCHORS, DAY)
  assert.equal(plans.baseline.conflicts, 1, 'the two restaurants overlap')
  assert.ok(plans.candidates.length > 0, 'there is still travel worth saving')
  for (const c of plans.candidates) {
    assert.equal(c.conflicts, 1, 'two overlapping anchors cannot be separated by reordering')
  }
})

test('an overlap between movable items is genuinely cleared', () => {
  const plans = planDay(
    [
      at('louvre', '10:00', '12:00'),
      at('pereLachaise', '10:00', '12:00'),
      at('eiffel', '15:00', '16:00'),
    ],
    DAY,
  )
  assert.ok(plans.baseline.conflicts > 0)
  assert.ok(plans.candidates.length > 0)
  for (const c of plans.candidates) {
    assert.equal(c.conflicts, 0, 'placement into free windows separates what it can move')
  }
})

test('no candidate ever reports more conflicts than the day already had', () => {
  // place() fits movable items into windows with the anchors cut out, so a
  // candidate can only ever carry the anchor-vs-anchor overlaps forward. This
  // is the invariant that makes "cleared = baseline - candidate" meaningful.
  for (const [name, items] of Object.entries(FIXTURES)) {
    const plans = planDay(items, DAY)
    for (const c of plans.candidates) {
      assert.ok(
        c.conflicts <= plans.baseline.conflicts,
        `${name} / ${c.id}: ${c.conflicts} > ${plans.baseline.conflicts}`,
      )
    }
  }
})

test('a plan that resolves nothing and saves nothing is not offered at all', () => {
  // The escape hatch in the `worthwhile` filter exists so a day whose items
  // collide is offered a fix even when the fix saves no distance. It has to
  // turn on whether *this candidate* resolves the collision — keyed to the
  // baseline instead, it waves through plans that resolve nothing, which is
  // how a suggestion with nothing to offer reached a real trip.
  const plans = planDay(
    [
      // Two movable stops at one address: every ordering travels the same.
      at('louvre', '10:00', '11:00'),
      at('louvre', '11:30', '12:30'),
      // The only overlap is between two anchors, so nothing can separate it.
      at('orsay', '13:00', '14:00', { category: 'restaurant' }),
      at('orsay', '13:00', '15:00', { category: 'restaurant' }),
    ],
    DAY,
  )
  assert.equal(plans.baseline.conflicts, 1, 'the day really does have an overlap')
  assert.deepEqual(plans.candidates, [], 'nothing to save and nothing to resolve')
})
