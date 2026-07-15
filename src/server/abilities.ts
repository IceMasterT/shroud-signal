import type {PlayerState, ShipLine} from '../shared/api.ts'
import {SHIP_STATS} from '../shared/api.ts'

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
