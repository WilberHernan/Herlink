import assert from 'node:assert/strict'
import test from 'node:test'
import {mouseEventKind, stripMouseReports} from './use-mouse-click.js'

test('mouseEventKind: SGR button 0 is a plain press', () => {
  assert.equal(mouseEventKind('0'), 'click')
})

test('mouseEventKind: wheel-up (64) and wheel-down (65) map to their directions', () => {
  // up = toward index 0, down = toward the higher indexes; app.tsx turns these
  // into -1/+1 via pickerWheelStep
  assert.equal(mouseEventKind('64'), 'wheel-up')
  assert.equal(mouseEventKind('65'), 'wheel-down')
})

test('mouseEventKind: unknown buttons yield no event (drag/hover codes are ignored)', () => {
  assert.equal(mouseEventKind('32'), undefined)
  assert.equal(mouseEventKind('68'), undefined)
})

test('stripMouseReports: SGR reports leaked into text-input are dropped', () => {
  assert.equal(stripMouseReports(`my\u001B[<0;34;12Mtext`), 'mytext')
  assert.equal(stripMouseReports(`\u001B[<65;10;5Mplain`), 'plain')
})