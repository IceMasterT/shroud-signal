import type {PlayerState, ShipLine} from '../shared/api.ts'
import {
  ABILITY_COOLDOWN_MS,
  BULWARK_DAMAGE_MUL,
  OVERCHARGE_DAMAGE_MUL,
  SHIP_STATS,
} from '../shared/api.ts'

// Mirrors match.ts's own START_HULL — kept local rather than shared/imported,
// matching the existing precedent of sector.ts and match.ts each independently
// declaring the same 100-hull baseline.
const START_HULL = 100

/** A team may not have more than 2 players on the same ship line. */
export function canJoinLine(
  teammates: Pick<PlayerState, 'line'>[],
  line: ShipLine,
): boolean {
  return teammates.filter(p => p.line === line).length < 2
}

/** A ship line's actual max hull, scaled from the shared 100-hull baseline. */
export function maxHullFor(line: ShipLine): number {
  return Math.round(START_HULL * SHIP_STATS[line].hullMul)
}

/** True once a line's ability cooldown has elapsed since it was last used. */
export function abilityReady(
  lastAbilityAt: number,
  line: ShipLine,
  now: number,
): boolean {
  return now - lastAbilityAt >= ABILITY_COOLDOWN_MS[line]
}

/**
 * Final damage for one hit: base damage scaled by the shooter's line, then
 * Fighter's Overcharge (if active) and Transport's Bulwark (if the target
 * has it active) apply on top.
 */
export function computeDamage(
  baseDamage: number,
  now: number,
  shooter: Pick<PlayerState, 'line' | 'abilityActiveUntil'>,
  target: Pick<PlayerState, 'line' | 'abilityActiveUntil'>,
): number {
  let dmg = baseDamage * SHIP_STATS[shooter.line].dmgMul
  if (shooter.line === 'fighter' && now < shooter.abilityActiveUntil) {
    dmg *= OVERCHARGE_DAMAGE_MUL
  }
  if (target.line === 'transport' && now < target.abilityActiveUntil) {
    dmg *= BULWARK_DAMAGE_MUL
  }
  return Math.max(1, Math.round(dmg))
}
