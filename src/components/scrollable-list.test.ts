import assert from 'node:assert/strict'
import test from 'node:test'
import {deriveScrollIndex} from './scrollable-list.js'

// Walking the selection one step at a time from 0 with a 4-row window over 10
// items: the window's top edge advances only once the selection exits the
// bottom, so the highlight stays visible at every step (and never rotates).
const walkDown = (stepCount: number, items = 10, limit = 4) => {
  const sequence: number[] = []
  let prev = 0
  for (let selected = 0; selected <= stepCount; selected++) {
    prev = deriveScrollIndex(selected, limit, items, prev)
    sequence.push(prev)
  }
  return sequence
}

test('deriveScrollIndex: a list no longer than the limit never scrolls', () => {
  assert.equal(deriveScrollIndex(5, 8, 5, 2), 0)
  assert.equal(deriveScrollIndex(0, 8, 8, 4), 0)
})

test('deriveScrollIndex: selection inside the window keeps the window put', () => {
  const windows = walkDown(3)
  assert.deepEqual(windows, [0, 0, 0, 0])
})

test('deriveScrollIndex: moving past the window bottom advances the window (selection stays visible)', () => {
  // window 0..3 → 1..4 → 2..5 → … → 6..9, one slot per overflow
  assert.deepEqual(walkDown(9), [0, 0, 0, 0, 1, 2, 3, 4, 5, 6])
  // the top row changes as the list advances
  const slice = (selected: number) => {
    let prev = 0
    ;[...Array<number>(selected)].forEach((_, i) => {
      prev = deriveScrollIndex(i + 1, 4, 10, prev)
    })
    return prev
  }
  assert.equal(slice(4), 1, 'selected=4 shows window starting at 1')
  assert.equal(slice(9), 6, 'selected=9 shows the last window 6..9')
})

test('deriveScrollIndex: scrolling back up is sticky — the window only snaps once the selection exits the top', () => {
  // walking down to the end, then back up to 0: the window edge follows the
  // cursor lazily (stays while the selection is inside, snaps only when it
  // would leave) — exactly the opposite rotation of SelectInput's circular wrap
  let prev = 0
  for (let selected = 0; selected <= 9; selected++) prev = deriveScrollIndex(selected, 4, 10, prev)
  assert.equal(prev, 6, 'at the end the window is 6..9')
  const up: number[] = []
  for (let selected = 9; selected >= 0; selected--) {
    prev = deriveScrollIndex(selected, 4, 10, prev)
    up.push(prev)
  }
  assert.deepEqual(up, [6, 6, 6, 6, 5, 4, 3, 2, 1, 0])
})

test('deriveScrollIndex: every step keeps the selection inside the visible window', () => {
  for (let items = 1; items <= 12; items++) {
    for (let limit = 1; limit <= items; limit++) {
      let prev = 0
      for (let selected = 0; selected < items; selected++) {
        prev = deriveScrollIndex(selected, limit, items, prev)
        assert.ok(
          selected >= prev && selected < prev + limit,
          `items=${items} limit=${limit} selected=${selected} scroll=${prev} — selection must stay visible`,
        )
      }
    }
  }
})

test('deriveScrollIndex: a large jump repositions the window directly (no per-step crawl)', () => {
  // 0 → 9 in one event: the window jumps to the last one straight away
  assert.equal(deriveScrollIndex(9, 4, 10, 0), 6)
})

test('deriveScrollIndex: the scroll offset is clamped to a real range', () => {
  assert.equal(deriveScrollIndex(0, 4, 10, 100), 0)
  assert.equal(deriveScrollIndex(9, 4, 10, 100), 6)
  assert.equal(deriveScrollIndex(0, 4, 10, -5), 0)
})