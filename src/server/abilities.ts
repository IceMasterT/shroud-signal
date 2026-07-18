import type {JoinPolicy, PlayerState, ShipLine, Team} from '../shared/api.ts'
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

/**
 * Auto-balances a new scrimmage joiner onto whichever team currently has
 * fewer players. Ties go to team A — deterministic, not random, so
 * auto-assign stays reproducible for testing and doesn't need a seeded RNG.
 */
export function assignAutoTeam(players: Pick<PlayerState, 'team'>[]): Team {
  const countA = players.filter(p => p.team === 'A').length
  const countB = players.filter(p => p.team === 'B').length
  return countA <= countB ? 'A' : 'B'
}

/** Whether a user may join a scrimmage team. Everyone is eligible under 'open'; under 'whitelist', only listed usernames (case-insensitive) or moderators may — everyone else is a spectator. */
export function isEligibleToJoin(
  joinPolicy: JoinPolicy,
  whitelist: string[],
  username: string,
  isModerator: boolean,
): boolean {
  if (joinPolicy === 'open') return true
  if (isModerator) return true
  return whitelist.some(w => w.toLowerCase() === username.toLowerCase())
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

/** Closest non-eliminated ally within range, or undefined if none qualify. */
export function nearestAlly(
  allies: Pick<PlayerState, 'userId' | 'x' | 'y' | 'line'>[],
  healer: Pick<PlayerState, 'userId' | 'x' | 'y'>,
  range: number,
): Pick<PlayerState, 'userId' | 'x' | 'y' | 'line'> | undefined {
  let closest:
    | {p: Pick<PlayerState, 'userId' | 'x' | 'y' | 'line'>; d: number}
    | undefined
  for (const p of allies) {
    if (p.userId === healer.userId) continue
    const d = Math.hypot(p.x - healer.x, p.y - healer.y)
    if (d > range) continue
    if (!closest || d < closest.d) closest = {p, d}
  }
  return closest?.p
}

export type Mine = {
  mineId: string
  ownerId: string
  team: Team
  x: number
  y: number
}

const MINE_BLAST_RADIUS = 70

/** The first enemy mine within blast radius of a mover's new position, if any. */
export function mineTriggeredBy(
  mines: Mine[],
  mover: {team: Team | null; x: number; y: number},
): Mine | undefined {
  for (const m of mines) {
    if (m.team === mover.team) continue
    const distance = Math.hypot(mover.x - m.x, mover.y - m.y)
    if (distance <= MINE_BLAST_RADIUS) return m
  }
  return undefined
}

/**
 * Per-round survival-time credit for the match-level tie-break: the winning
 * team (or both, on a timeout tie) credits the full round duration, but a
 * losing team only credits the time until its last player was actually
 * eliminated — otherwise every round would credit both teams identically
 * and the tie-break could never differentiate them.
 */
export function survivalCredit(
  winner: Team | 'tie',
  elapsedMs: number,
  loserWipedAtMs: number | undefined,
): {creditA: number; creditB: number} {
  if (winner === 'tie') return {creditA: elapsedMs, creditB: elapsedMs}
  const loserCredit = loserWipedAtMs ?? elapsedMs
  return winner === 'A'
    ? {creditA: elapsedMs, creditB: loserCredit}
    : {creditA: loserCredit, creditB: elapsedMs}
}

/**
 * A line can be claimed from a preset's slot list as many times as it
 * appears in that list — e.g. a preset with two 'fighter' slots allows up
 * to 2 fighters on that team, independent of the general 2-per-line cap.
 */
export function canClaimPresetSlot(
  teammates: Pick<PlayerState, 'line'>[],
  slots: ShipLine[],
  line: ShipLine,
): boolean {
  const available = slots.filter(l => l === line).length
  const claimed = teammates.filter(p => p.line === line).length
  return claimed < available
}
