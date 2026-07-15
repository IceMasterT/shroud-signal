import assert from 'node:assert/strict'
import {test} from 'node:test'
import {canJoinLine, maxHullFor} from './abilities.ts'

test('canJoinLine allows up to 2 of the same line', () => {
  assert.equal(canJoinLine([], 'fighter'), true)
  assert.equal(canJoinLine([{line: 'fighter'}], 'fighter'), true)
  assert.equal(
    canJoinLine([{line: 'fighter'}, {line: 'fighter'}], 'fighter'),
    false,
  )
})

test('canJoinLine ignores other lines on the team', () => {
  assert.equal(
    canJoinLine([{line: 'fighter'}, {line: 'fighter'}], 'tender'),
    true,
  )
})

test('maxHullFor scales the 100-hull baseline by the line hull multiplier', () => {
  assert.equal(maxHullFor('transport'), 140)
  assert.equal(maxHullFor('pathfinder'), 70)
  assert.equal(maxHullFor('miner'), 110)
})
