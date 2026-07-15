import assert from 'node:assert/strict'
import {test} from 'node:test'
import {
  abilityReady,
  canJoinLine,
  computeDamage,
  maxHullFor,
  nearestAlly,
} from './abilities.ts'

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

test('abilityReady is false before cooldown elapses, true after', () => {
  assert.equal(abilityReady(1000, 'fighter', 1000), false)
  assert.equal(abilityReady(1000, 'fighter', 20999), false)
  assert.equal(abilityReady(1000, 'fighter', 21000), true)
})

test('computeDamage applies the shooter line multiplier', () => {
  const shooter = {line: 'transport' as const, abilityActiveUntil: 0}
  const target = {line: 'miner' as const, abilityActiveUntil: 0}
  assert.equal(computeDamage(20, 1000, shooter, target), 17) // 20 * 0.85 = 17
})

test('computeDamage applies Fighter Overcharge while active', () => {
  const shooter = {line: 'fighter' as const, abilityActiveUntil: 5000}
  const target = {line: 'miner' as const, abilityActiveUntil: 0}
  assert.equal(computeDamage(20, 1000, shooter, target), 35) // 20*1.15*1.5=34.5 -> 35
})

test('computeDamage applies Transport Bulwark on the target while active', () => {
  const shooter = {line: 'miner' as const, abilityActiveUntil: 0}
  const target = {line: 'transport' as const, abilityActiveUntil: 5000}
  assert.equal(computeDamage(20, 1000, shooter, target), 10) // 20*1.0*0.5=10
})

test('computeDamage ignores expired ability windows', () => {
  const shooter = {line: 'fighter' as const, abilityActiveUntil: 500}
  const target = {line: 'miner' as const, abilityActiveUntil: 0}
  assert.equal(computeDamage(20, 1000, shooter, target), 23) // now(1000) >= 500, no bonus
})

test('nearestAlly picks the closest ally within range and excludes self', () => {
  const healer = {userId: 'me', x: 0, y: 0}
  const far = {userId: 'far', x: 200, y: 0}
  const near = {userId: 'near', x: 50, y: 0}
  const self = {userId: 'me', x: 0, y: 0}
  assert.equal(nearestAlly([far, near, self], healer, 300)?.userId, 'near')
})

test('nearestAlly returns undefined when nobody is in range', () => {
  const healer = {userId: 'me', x: 0, y: 0}
  const far = {userId: 'far', x: 1000, y: 0}
  assert.equal(nearestAlly([far], healer, 300), undefined)
})
