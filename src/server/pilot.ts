import type {ShipLine} from '../shared/api.ts'

/** XP required to advance from `level` to `level + 1` — a gentle, ever-slowing climb rather than linear or explosive. */
export function xpToNextLevel(level: number): number {
  return Math.floor(100 * Math.pow(level, 1.4))
}

/** Turns a raw lifetime XP total into a displayable level and progress toward the next one. */
export function levelForXp(totalXp: number): {
  level: number
  xpIntoLevel: number
  xpToNext: number
} {
  let level = 1
  let remaining = totalXp
  let need = xpToNextLevel(level)
  while (remaining >= need) {
    remaining -= need
    level += 1
    need = xpToNextLevel(level)
  }
  return {level, xpIntoLevel: remaining, xpToNext: need}
}

const DEATH_PENALTY_PCT = 0.1

/** A flat percentage of current credits, floored at 0 — scales with a pilot's wealth instead of becoming trivial or crushing at the extremes. */
export function applyDeathPenalty(credits: number): number {
  return Math.max(0, credits - Math.floor(credits * DEATH_PENALTY_PCT))
}

/** One ship line per pilot, chosen once — no respeccing. */
export function canChooseLine(profile: {line: ShipLine | null}): boolean {
  return profile.line === null
}
