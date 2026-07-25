import assert from 'node:assert/strict'
import {test} from 'node:test'
import {
  applyDeathPenalty,
  canChooseLine,
  levelForXp,
  xpToNextLevel,
} from './pilot.ts'

test('xpToNextLevel grows with level', () => {
  assert.equal(xpToNextLevel(1), 100)
  assert.equal(xpToNextLevel(2), 263)
})

test('levelForXp stays at level 1 until the first threshold is crossed', () => {
  assert.deepEqual(levelForXp(0), {level: 1, xpIntoLevel: 0, xpToNext: 100})
  assert.deepEqual(levelForXp(99), {level: 1, xpIntoLevel: 99, xpToNext: 100})
})

test('levelForXp advances a level once its threshold is met, carrying the remainder', () => {
  assert.deepEqual(levelForXp(100), {level: 2, xpIntoLevel: 0, xpToNext: 263})
  assert.deepEqual(levelForXp(150), {level: 2, xpIntoLevel: 50, xpToNext: 263})
})

test('applyDeathPenalty takes a flat 10% of current credits', () => {
  assert.equal(applyDeathPenalty(100), 90)
  assert.equal(applyDeathPenalty(0), 0)
})

test('applyDeathPenalty floors the loss, so very low balances are untouched', () => {
  assert.equal(applyDeathPenalty(5), 5)
})

test('canChooseLine is true only before a line has ever been chosen', () => {
  assert.equal(canChooseLine({line: null}), true)
  assert.equal(canChooseLine({line: 'fighter'}), false)
})
