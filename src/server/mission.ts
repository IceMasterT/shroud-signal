/** Regular (non-boss) wave size, escalating by 1 raider per wave — wave 1 is 3 raiders, wave 7 is 9. */
export function raidersInWave(wave: number): number {
  return 2 + wave
}

/**
 * `active` mid-fight; `lost` the instant the starbase's hull reaches 0,
 * regardless of wave progress; `won` once the final wave (the boss) is
 * cleared with the starbase still standing. Clearing a non-final wave with
 * no NPCs remaining is still `active` — the next wave is about to spawn.
 */
export function evaluateMissionOutcome(
  starbaseHull: number,
  wave: number,
  totalWaves: number,
  npcCountRemaining: number,
): 'active' | 'won' | 'lost' {
  if (starbaseHull <= 0) return 'lost'
  if (wave >= totalWaves && npcCountRemaining === 0) return 'won'
  return 'active'
}
