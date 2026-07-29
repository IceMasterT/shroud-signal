import assert from 'node:assert/strict'
import {test} from 'node:test'
import {evaluateMissionOutcome, raidersInWave} from './mission.ts'

test('raidersInWave escalates by 1 raider per wave, starting at 3', () => {
  assert.equal(raidersInWave(1), 3)
  assert.equal(raidersInWave(2), 4)
  assert.equal(raidersInWave(7), 9)
})

test('evaluateMissionOutcome is lost once the starbase hull hits 0, regardless of wave progress', () => {
  assert.equal(evaluateMissionOutcome(0, 2, 5, 3), 'lost')
  assert.equal(evaluateMissionOutcome(-5, 5, 5, 0), 'lost')
})

test('evaluateMissionOutcome is won only once the final wave is cleared with hull remaining', () => {
  assert.equal(evaluateMissionOutcome(100, 5, 5, 0), 'won')
  assert.equal(evaluateMissionOutcome(1, 5, 5, 0), 'won')
})

test('evaluateMissionOutcome stays active mid-fight and between waves', () => {
  assert.equal(evaluateMissionOutcome(100, 1, 5, 3), 'active')
  assert.equal(evaluateMissionOutcome(100, 3, 5, 0), 'active') // wave cleared, not the last one
  assert.equal(evaluateMissionOutcome(100, 5, 5, 2), 'active') // final wave, not yet cleared
})
