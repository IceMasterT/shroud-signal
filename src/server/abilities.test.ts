import assert from 'node:assert/strict'
import {test} from 'node:test'
import {
  abilityReady,
  assignAutoTeam,
  canClaimPresetSlot,
  canJoinLine,
  computeDamage,
  isEligibleToJoin,
  maxHullFor,
  mineTriggeredBy,
  nearestAlly,
  survivalCredit,
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

test('assignAutoTeam picks the team with fewer players', () => {
  assert.equal(assignAutoTeam([]), 'A')
  assert.equal(assignAutoTeam([{team: 'A'}]), 'B')
  assert.equal(assignAutoTeam([{team: 'A'}, {team: 'B'}, {team: 'B'}]), 'A')
})

test('assignAutoTeam breaks ties toward team A', () => {
  assert.equal(
    assignAutoTeam([{team: 'A'}, {team: 'B'}, {team: 'A'}, {team: 'B'}]),
    'A',
  )
})

test('assignAutoTeam ignores unassigned (null-team) players', () => {
  assert.equal(assignAutoTeam([{team: null}, {team: null}]), 'A')
})

test('isEligibleToJoin allows anyone when the policy is open', () => {
  assert.equal(isEligibleToJoin('open', [], 'anyone', false), true)
})

test('isEligibleToJoin restricts to the whitelist (case-insensitive)', () => {
  assert.equal(isEligibleToJoin('whitelist', ['alice'], 'Alice', false), true)
  assert.equal(isEligibleToJoin('whitelist', ['alice'], 'bob', false), false)
})

test('isEligibleToJoin matches case-insensitively even when the whitelist entry itself has mixed case', () => {
  assert.equal(isEligibleToJoin('whitelist', ['Alice'], 'alice', false), true)
})

test('isEligibleToJoin always allows moderators under a whitelist', () => {
  assert.equal(isEligibleToJoin('whitelist', [], 'anymod', true), true)
})

test('maxHullFor scales the 100-hull baseline by the line hull multiplier', () => {
  assert.equal(maxHullFor('transport'), 110)
  assert.equal(maxHullFor('pathfinder'), 90)
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
  assert.equal(computeDamage(20, 1000, shooter, target), 12) // 20*1.0*0.6=12
})

test('computeDamage ignores expired ability windows', () => {
  const shooter = {line: 'fighter' as const, abilityActiveUntil: 500}
  const target = {line: 'miner' as const, abilityActiveUntil: 0}
  assert.equal(computeDamage(20, 1000, shooter, target), 23) // now(1000) >= 500, no bonus
})

test('nearestAlly picks the closest ally within range and excludes self', () => {
  const healer = {userId: 'me', x: 0, y: 0, line: 'tender' as const}
  const far = {userId: 'far', x: 200, y: 0, line: 'fighter' as const}
  const near = {userId: 'near', x: 50, y: 0, line: 'miner' as const}
  const self = {userId: 'me', x: 0, y: 0, line: 'tender' as const}
  assert.equal(nearestAlly([far, near, self], healer, 300)?.userId, 'near')
})

test('nearestAlly returns undefined when nobody is in range', () => {
  const healer = {userId: 'me', x: 0, y: 0, line: 'tender' as const}
  const far = {userId: 'far', x: 1000, y: 0, line: 'fighter' as const}
  assert.equal(nearestAlly([far], healer, 300), undefined)
})

test('mineTriggeredBy ignores mines placed by your own team', () => {
  const mines = [{mineId: 'm1', ownerId: 'x', team: 'A' as const, x: 0, y: 0}]
  assert.equal(mineTriggeredBy(mines, {team: 'A', x: 0, y: 0}), undefined)
})

test('mineTriggeredBy detonates when an enemy is within blast radius', () => {
  const mines = [
    {mineId: 'm1', ownerId: 'x', team: 'A' as const, x: 100, y: 100},
  ]
  assert.equal(
    mineTriggeredBy(mines, {team: 'B', x: 140, y: 100})?.mineId,
    'm1',
  )
})

test('mineTriggeredBy ignores mines out of blast radius', () => {
  const mines = [{mineId: 'm1', ownerId: 'x', team: 'A' as const, x: 0, y: 0}]
  assert.equal(mineTriggeredBy(mines, {team: 'B', x: 500, y: 500}), undefined)
})

test('canClaimPresetSlot allows a line up to how many times it appears in the slot list', () => {
  const slots = ['fighter', 'fighter', 'tender'] as const
  assert.equal(canClaimPresetSlot([], [...slots], 'fighter'), true)
  assert.equal(
    canClaimPresetSlot([{line: 'fighter'}], [...slots], 'fighter'),
    true,
  )
  assert.equal(
    canClaimPresetSlot(
      [{line: 'fighter'}, {line: 'fighter'}],
      [...slots],
      'fighter',
    ),
    false,
  )
})

test('canClaimPresetSlot rejects a line not present in the slot list at all', () => {
  const slots = ['fighter', 'fighter', 'tender'] as const
  assert.equal(canClaimPresetSlot([], [...slots], 'miner'), false)
})

test('survivalCredit gives both teams the full round on a timeout tie', () => {
  assert.deepEqual(survivalCredit('tie', 5000, undefined), {
    creditA: 5000,
    creditB: 5000,
  })
})

test('survivalCredit gives the winner the full round and the loser only their wipe time', () => {
  assert.deepEqual(survivalCredit('A', 5000, 3200), {
    creditA: 5000,
    creditB: 3200,
  })
  assert.deepEqual(survivalCredit('B', 5000, 1800), {
    creditA: 1800,
    creditB: 5000,
  })
})

test('survivalCredit falls back to the full round when the loser was never actually wiped', () => {
  assert.deepEqual(survivalCredit('A', 5000, undefined), {
    creditA: 5000,
    creditB: 5000,
  })
})
