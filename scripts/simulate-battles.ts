/**
 * Standalone balance/hardening tool — NOT part of the shipped build or test
 * suite. Simulates full Last One Standing matches (best-of-3, 10v10 max)
 * using the exact same pure combat math the server uses (computeDamage,
 * maxHullFor, mineTriggeredBy, nearestAlly, survivalCredit) plus a
 * physically-consistent re-implementation of the client's movement model,
 * so win-rate / damage-output numbers reflect the real tuning constants.
 *
 * Run: node --experimental-strip-types --no-warnings=ExperimentalWarning scripts/simulate-battles.ts
 */
import {
  abilityReady,
  canJoinLine,
  computeDamage,
  maxHullFor,
  mineTriggeredBy,
  nearestAlly,
  survivalCredit,
} from '../src/server/abilities.ts'
import {
  AUTOCANNON_COOLDOWN_MS,
  AUTOCANNON_RANGE,
  BULWARK_DURATION_MS,
  BURST_COOLDOWN_MS,
  BURST_RANGE,
  FLAK_COOLDOWN_MS,
  FLAK_INTERCEPT_RANGE,
  FLAK_RANGE,
  LASER_COOLDOWN_MS,
  LASER_RANGE,
  MATCH_ROUNDS_TO_WIN,
  MISSILE_COOLDOWN_MS,
  MISSILE_SPEED,
  OVERCHARGE_DURATION_MS,
  PLASMA_COOLDOWN_MS,
  PLASMA_RANGE,
  type PresetId,
  ROUND_MAX_MS,
  SHIP_LINES,
  SHIP_STATS,
  SHIP_WEAPONS,
  SQUAD_PRESETS,
  TENDER_HEAL_AMOUNT,
  TENDER_HEAL_RANGE,
  TORPEDO_RANGE,
  type WeaponMode,
} from '../src/shared/api.ts'

// ── Tuning mirrored from src/client/battle.ts / src/server/match.ts ────────
const THRUST = 340
const DRAG = 0.985
const MAX_SPEED = 260
const TURN_SPEED = 3.6
const TICK_MS = 150
const TORPEDO_IMPACT_RADIUS = 100
const TORPEDO_AIM_HALF_ANGLE = 0.5 // more lenient than laser — impact radius forgives imprecision

const HITSCAN_TUNING: Record<
  Exclude<WeaponMode, 'torpedo'>,
  {damage: number; cooldownMs: number; range: number; halfAngle: number}
> = {
  laser: {
    damage: 14,
    cooldownMs: LASER_COOLDOWN_MS,
    range: LASER_RANGE,
    halfAngle: 0.3,
  },
  autocannon: {
    damage: 14,
    cooldownMs: AUTOCANNON_COOLDOWN_MS,
    range: AUTOCANNON_RANGE,
    halfAngle: 0.3,
  },
  burst: {
    damage: 30,
    cooldownMs: BURST_COOLDOWN_MS,
    range: BURST_RANGE,
    halfAngle: 0.35,
  },
  plasma: {
    damage: 30,
    cooldownMs: PLASMA_COOLDOWN_MS,
    range: PLASMA_RANGE,
    halfAngle: 0.25,
  },
  flak: {
    damage: 38,
    cooldownMs: FLAK_COOLDOWN_MS,
    range: FLAK_RANGE,
    halfAngle: 0.5,
  },
}
const TORPEDO_DAMAGE = 55

let rngState = 0x1234_5678
function rng(): number {
  // xorshift32 — deterministic across runs when seeded, avoids Math.random's
  // non-reproducibility so a suspicious result can be re-run identically.
  rngState ^= rngState << 13
  rngState ^= rngState >>> 17
  rngState ^= rngState << 5
  rngState >>>= 0
  return rngState / 0xffffffff
}

type Line = (typeof SHIP_LINES)[number]
type Team = 'A' | 'B'

type SimPlayer = {
  id: string
  line: Line
  team: Team
  x: number
  y: number
  rotation: number
  velX: number
  velY: number
  hull: number
  maxHull: number
  lastLaserAt: number
  lastTorpedoAt: number
  lastAbilityAt: number
  abilityActiveUntil: number
  alive: boolean
  kills: number
  damageDealt: number
  damageTaken: number
}

type Mine = {mineId: string; ownerId: string; team: Team; x: number; y: number}
type PendingTorpedo = {
  firedAtTick: number
  resolveAtTick: number
  shooterId: string
  shooterTeam: Team
  x: number
  y: number
  impactX: number
  impactY: number
}

function randSpawn(side: Team): {x: number; y: number} {
  const baseX = side === 'A' ? -500 : 500
  const a = rng() * Math.PI * 2
  const r = 80 + rng() * 220
  return {x: baseX + Math.cos(a) * r, y: Math.sin(a) * r}
}

function makePlayer(id: string, line: Line, team: Team): SimPlayer {
  const maxHull = maxHullFor(line)
  const spawn = randSpawn(team)
  return {
    id,
    line,
    team,
    x: spawn.x,
    y: spawn.y,
    rotation: 0,
    velX: 0,
    velY: 0,
    hull: maxHull,
    maxHull,
    lastLaserAt: -Infinity,
    lastTorpedoAt: -Infinity,
    lastAbilityAt: -Infinity,
    abilityActiveUntil: 0,
    alive: true,
    kills: 0,
    damageDealt: 0,
    damageTaken: 0,
  }
}

function nearestEnemy(p: SimPlayer, all: SimPlayer[]): SimPlayer | undefined {
  let best: SimPlayer | undefined
  let bestD = Infinity
  for (const o of all) {
    if (!o.alive || o.team === p.team) continue
    const d = Math.hypot(o.x - p.x, o.y - p.y)
    if (d < bestD) {
      bestD = d
      best = o
    }
  }
  return best
}

function angleTo(p: SimPlayer, target: SimPlayer): number {
  const dirX = Math.cos(p.rotation - Math.PI / 2)
  const dirY = Math.sin(p.rotation - Math.PI / 2)
  const dx = target.x - p.x
  const dy = target.y - p.y
  const dist = Math.hypot(dx, dy)
  if (dist === 0) return 0
  const dot = Math.max(-1, Math.min(1, (dx / dist) * dirX + (dy / dist) * dirY))
  return Math.acos(dot)
}

function applyDamage(
  shooter: SimPlayer,
  target: SimPlayer,
  baseDamage: number,
  now: number,
): void {
  const dmg = computeDamage(baseDamage, now, shooter, target)
  target.hull = Math.max(0, target.hull - dmg)
  shooter.damageDealt += dmg
  target.damageTaken += dmg
  if (target.hull === 0 && target.alive) {
    target.alive = false
    shooter.kills++
  }
}

/** Finds the nearest in-flight enemy torpedo (interpolating its current position from firedAtTick/resolveAtTick) within Flak range and destroys it. Mirrors match.ts's tryFlakIntercept. */
function tryFlakIntercept(
  pendingTorpedoes: PendingTorpedo[],
  tender: SimPlayer,
  now: number,
): boolean {
  let bestIdx = -1
  let bestDist = Infinity
  for (let i = 0; i < pendingTorpedoes.length; i++) {
    const t = pendingTorpedoes[i]
    if (!t || t.shooterTeam === tender.team) continue
    const span = Math.max(1, (t.resolveAtTick - t.firedAtTick) * TICK_MS)
    const elapsed = now - t.firedAtTick * TICK_MS
    const frac = Math.min(1, Math.max(0, elapsed / span))
    const curX = t.x + (t.impactX - t.x) * frac
    const curY = t.y + (t.impactY - t.y) * frac
    const dist = Math.hypot(curX - tender.x, curY - tender.y)
    if (dist > FLAK_INTERCEPT_RANGE || dist >= bestDist) continue
    bestDist = dist
    bestIdx = i
  }
  if (bestIdx === -1) return false
  pendingTorpedoes.splice(bestIdx, 1)
  return true
}

type RoundResult = {
  winner: Team | 'tie'
  elapsedMs: number
  wipedAt: Map<Team, number>
}

function simulateRound(players: SimPlayer[]): RoundResult {
  for (const p of players) {
    const maxHull = maxHullFor(p.line)
    const spawn = randSpawn(p.team)
    p.x = spawn.x
    p.y = spawn.y
    p.rotation = 0
    p.velX = 0
    p.velY = 0
    p.hull = maxHull
    p.maxHull = maxHull
    p.lastAbilityAt = -Infinity
    p.abilityActiveUntil = 0
    p.alive = true
  }

  const mines: Mine[] = []
  const pendingTorpedoes: PendingTorpedo[] = []
  const wipedAt = new Map<Team, number>()
  const dt = TICK_MS / 1000

  let tick = 0
  const maxTicks = Math.ceil(ROUND_MAX_MS / TICK_MS)
  for (; tick < maxTicks; tick++) {
    const now = tick * TICK_MS

    for (const p of players) {
      if (!p.alive) continue
      const target = nearestEnemy(p, players)
      if (!target) continue

      const spd = SHIP_SPEED[p.line]
      const dx = target.x - p.x
      const dy = target.y - p.y
      const desired = Math.atan2(dy, dx) + Math.PI / 2
      let diff = desired - p.rotation
      diff = Math.atan2(Math.sin(diff), Math.cos(diff))
      const maxTurn = TURN_SPEED * dt
      p.rotation += Math.max(-maxTurn, Math.min(maxTurn, diff))

      const dirX = Math.cos(p.rotation - Math.PI / 2)
      const dirY = Math.sin(p.rotation - Math.PI / 2)
      p.velX = (p.velX + dirX * THRUST * spd * dt) * DRAG
      p.velY = (p.velY + dirY * THRUST * spd * dt) * DRAG
      const speed = Math.hypot(p.velX, p.velY)
      const cap = MAX_SPEED * spd
      if (speed > cap) {
        p.velX = (p.velX / speed) * cap
        p.velY = (p.velY / speed) * cap
      }
      p.x += p.velX * dt
      p.y += p.velY * dt

      // Mine trigger check on move
      const triggered = mineTriggeredBy(mines, p)
      if (triggered) {
        const idx = mines.indexOf(triggered)
        if (idx >= 0) mines.splice(idx, 1)
        const owner = players.find(o => o.id === triggered.ownerId)
        if (owner?.alive) applyDamage(owner, p, TORPEDO_DAMAGE, now)
      }
      if (!p.alive) continue

      const angle = angleTo(p, target)
      const distance = Math.hypot(dx, dy)
      const weapons = SHIP_WEAPONS[p.line] // Fighter carries two; everyone else carries one

      for (const mode of weapons) {
        const isPrimary = mode === weapons[0]
        const lastAt = isPrimary ? p.lastLaserAt : p.lastTorpedoAt

        if (mode === 'torpedo') {
          if (
            distance <= TORPEDO_RANGE &&
            angle <= TORPEDO_AIM_HALF_ANGLE &&
            now - lastAt >= MISSILE_COOLDOWN_MS
          ) {
            if (isPrimary) p.lastLaserAt = now
            else p.lastTorpedoAt = now
            // Stop at the target's actual distance, not always full
            // TORPEDO_RANGE — matches the server fix (overshooting close
            // targets was the bug).
            const travelMs = (distance / MISSILE_SPEED) * 1000
            pendingTorpedoes.push({
              firedAtTick: tick,
              resolveAtTick: tick + Math.round(travelMs / TICK_MS),
              shooterId: p.id,
              shooterTeam: p.team,
              x: p.x,
              y: p.y,
              impactX: p.x + dirX * distance,
              impactY: p.y + dirY * distance,
            })
          }
          continue
        }

        const tuning = HITSCAN_TUNING[mode]
        if (now - lastAt < tuning.cooldownMs) continue

        if (mode === 'flak' && tryFlakIntercept(pendingTorpedoes, p, now)) {
          if (isPrimary) p.lastLaserAt = now
          else p.lastTorpedoAt = now
          continue // Flak Battery shot down a missile instead of firing this trigger pull
        }

        if (distance <= tuning.range && angle <= tuning.halfAngle) {
          if (isPrimary) p.lastLaserAt = now
          else p.lastTorpedoAt = now
          applyDamage(p, target, tuning.damage, now)
        }
      }

      if (abilityReady(p.lastAbilityAt, p.line, now)) {
        useAbility(p, players, mines, now)
      }
    }

    // Resolve torpedoes whose travel time has elapsed
    for (let i = pendingTorpedoes.length - 1; i >= 0; i--) {
      const t = pendingTorpedoes[i]
      if (!t || t.resolveAtTick > tick) continue
      pendingTorpedoes.splice(i, 1)
      const shooter = players.find(o => o.id === t.shooterId)
      if (!shooter?.alive) continue
      let closest: {p: SimPlayer; d: number} | undefined
      for (const o of players) {
        if (!o.alive || o.team === t.shooterTeam) continue
        const d = Math.hypot(o.x - t.impactX, o.y - t.impactY)
        if (d > TORPEDO_IMPACT_RADIUS) continue
        if (!closest || d < closest.d) closest = {p: o, d}
      }
      if (closest) applyDamage(shooter, closest.p, TORPEDO_DAMAGE, now)
    }

    const aliveA = players.some(p => p.team === 'A' && p.alive)
    const aliveB = players.some(p => p.team === 'B' && p.alive)
    if (!aliveA || !aliveB) {
      if (!aliveA) wipedAt.set('A', now)
      if (!aliveB) wipedAt.set('B', now)
      const winner: Team | 'tie' =
        !aliveA && !aliveB ? 'tie' : aliveA ? 'A' : 'B'
      return {winner, elapsedMs: now, wipedAt}
    }
  }
  return {winner: 'tie', elapsedMs: ROUND_MAX_MS, wipedAt}
}

const SHIP_SPEED: Record<Line, number> = Object.fromEntries(
  SHIP_LINES.map(l => [l, SHIP_STATS[l].speedMul]),
) as Record<Line, number>

function useAbility(
  p: SimPlayer,
  players: SimPlayer[],
  mines: Mine[],
  now: number,
): void {
  p.lastAbilityAt = now
  if (p.line === 'fighter') {
    p.abilityActiveUntil = now + OVERCHARGE_DURATION_MS
  } else if (p.line === 'transport') {
    p.abilityActiveUntil = now + BULWARK_DURATION_MS
  } else if (p.line === 'tender') {
    const allies = players.filter(o => o.alive && o.team === p.team)
    const target = nearestAlly(allies, p, TENDER_HEAL_RANGE)
    if (target) {
      const t = players.find(o => o.id === target.userId)
      if (t) t.hull = Math.min(t.maxHull, t.hull + TENDER_HEAL_AMOUNT)
    }
  } else if (p.line === 'miner') {
    mines.push({
      mineId: `${p.id}-${now}`,
      ownerId: p.id,
      team: p.team,
      x: p.x,
      y: p.y,
    })
  }
  // pathfinder: no simulated combat effect — see readme note in report.
}

function decideSeriesWinner(
  round: number,
  roundWinsA: number,
  roundWinsB: number,
  survivalMsA: number,
  survivalMsB: number,
): Team | 'tie' | null {
  if (roundWinsA >= MATCH_ROUNDS_TO_WIN) return 'A'
  if (roundWinsB >= MATCH_ROUNDS_TO_WIN) return 'B'
  if (round >= 3) {
    if (roundWinsA !== roundWinsB) return roundWinsA > roundWinsB ? 'A' : 'B'
    if (survivalMsA === survivalMsB) return 'tie'
    return survivalMsA > survivalMsB ? 'A' : 'B'
  }
  return null
}

type MatchResult = {
  winner: Team | 'tie'
  rounds: number
  players: SimPlayer[]
}

function simulateMatch(compA: Line[], compB: Line[]): MatchResult {
  const players: SimPlayer[] = [
    ...compA.map((line, i) => makePlayer(`A${i}`, line, 'A')),
    ...compB.map((line, i) => makePlayer(`B${i}`, line, 'B')),
  ]
  let round = 1
  let roundWinsA = 0
  let roundWinsB = 0
  let survivalMsA = 0
  let survivalMsB = 0

  for (;;) {
    const result = simulateRound(players)
    if (result.winner === 'A') roundWinsA++
    else if (result.winner === 'B') roundWinsB++

    const loser =
      result.winner === 'A' ? 'B' : result.winner === 'B' ? 'A' : null
    const loserWipedAtMs = loser ? result.wipedAt.get(loser) : undefined
    const {creditA, creditB} = survivalCredit(
      result.winner,
      result.elapsedMs,
      loserWipedAtMs,
    )
    survivalMsA += creditA
    survivalMsB += creditB

    const seriesWinner = decideSeriesWinner(
      round,
      roundWinsA,
      roundWinsB,
      survivalMsA,
      survivalMsB,
    )
    if (seriesWinner) return {winner: seriesWinner, rounds: round, players}
    round++
    if (round > 3) return {winner: 'tie', rounds: round, players} // safety valve, should be unreachable
  }
}

// ── Composition generators ──────────────────────────────────────────────
function randomComposition(size: number, capped: boolean): Line[] {
  const comp: Line[] = []
  const counts: Record<Line, number> = Object.fromEntries(
    SHIP_LINES.map(l => [l, 0]),
  ) as Record<Line, number>
  while (comp.length < size) {
    const line = SHIP_LINES[Math.floor(rng() * SHIP_LINES.length)] as Line
    if (
      capped &&
      !canJoinLine(
        comp.map(l => ({line: l})),
        line,
      )
    )
      continue
    comp.push(line)
    counts[line]++
  }
  return comp
}

// ── Run ──────────────────────────────────────────────────────────────────
const PLAYER_CAP = 10 // MAX_PLAYER_CAP from challenge.ts — "max multiplayer"

type LineStats = {
  matches: number
  wins: number
  kills: number
  deaths: number
  damageDealt: number
  damageTaken: number
}
function freshStats(): Record<Line, LineStats> {
  return Object.fromEntries(
    SHIP_LINES.map(l => [
      l,
      {
        matches: 0,
        wins: 0,
        kills: 0,
        deaths: 0,
        damageDealt: 0,
        damageTaken: 0,
      },
    ]),
  ) as Record<Line, LineStats>
}

function recordMatch(
  stats: Record<Line, LineStats>,
  result: MatchResult,
): void {
  for (const p of result.players) {
    const s = stats[p.line]
    s.matches++
    if (p.team === result.winner) s.wins++
    s.kills += p.kills
    if (!p.alive) s.deaths++
    s.damageDealt += p.damageDealt
    s.damageTaken += p.damageTaken
  }
}

console.log(
  '=== Phase 1: 100 random-composition 10v10 matches (capped: max 2/line, the default rule) ===',
)
const randomStats = freshStats()
let errors = 0
const anomalies: string[] = []
const N_RANDOM = 50
for (let i = 0; i < N_RANDOM; i++) {
  try {
    const compA = randomComposition(PLAYER_CAP, true)
    const compB = randomComposition(PLAYER_CAP, true)
    const result = simulateMatch(compA, compB)
    recordMatch(randomStats, result)
    for (const p of result.players) {
      if (p.hull < 0)
        anomalies.push(`match ${i}: ${p.id} negative hull ${p.hull}`)
      if (!Number.isFinite(p.x) || !Number.isFinite(p.y))
        anomalies.push(`match ${i}: ${p.id} non-finite position`)
      if (Number.isNaN(p.hull)) anomalies.push(`match ${i}: ${p.id} NaN hull`)
    }
  } catch (err) {
    errors++
    console.error(`match ${i} threw:`, err)
  }
}
console.log(
  `Completed ${N_RANDOM} matches, ${errors} threw, ${anomalies.length} state anomalies.`,
)
if (anomalies.length) console.log(anomalies.slice(0, 10).join('\n'))

function printStats(label: string, stats: Record<Line, LineStats>): void {
  console.log(`\n--- ${label} ---`)
  console.log(
    'line'.padEnd(11),
    'matches'.padStart(8),
    'win%'.padStart(7),
    'kd'.padStart(6),
    'dmg/match'.padStart(10),
    'taken/match'.padStart(12),
  )
  for (const line of SHIP_LINES) {
    const s = stats[line]
    if (s.matches === 0) continue
    const winPct = ((s.wins / s.matches) * 100).toFixed(1)
    const kd = (s.kills / Math.max(1, s.deaths)).toFixed(2)
    const dmgPerMatch = (s.damageDealt / s.matches).toFixed(0)
    const takenPerMatch = (s.damageTaken / s.matches).toFixed(0)
    console.log(
      line.padEnd(11),
      String(s.matches).padStart(8),
      `${winPct}%`.padStart(7),
      kd.padStart(6),
      dmgPerMatch.padStart(10),
      takenPerMatch.padStart(12),
    )
  }
}
printStats('Phase 1: random capped compositions', randomStats)

console.log(
  '\n=== Phase 2: mono-line stack vs balanced-mix stress test (custom rule, no cap) ===',
)
const stackStats = freshStats()
const STACK_RUNS_PER_LINE = 40
for (const line of SHIP_LINES) {
  for (let run = 0; run < STACK_RUNS_PER_LINE; run++) {
    const compA: Line[] = Array(PLAYER_CAP).fill(line)
    const compB = randomComposition(PLAYER_CAP, true) // balanced mix, capped
    const result = simulateMatch(compA, compB)
    recordMatch(stackStats, result)
  }
}
printStats('Phase 2: 10-stack vs balanced mix', stackStats)

console.log(
  '\n=== Phase 3: mono-line vs mono-line round robin (custom rule, no cap) ===',
)
const mirrorStats: Record<string, {aWins: number; total: number}> = {}
const PAIR_RUNS = 30
for (let i = 0; i < SHIP_LINES.length; i++) {
  for (let j = i + 1; j < SHIP_LINES.length; j++) {
    const lineA = SHIP_LINES[i] as Line
    const lineB = SHIP_LINES[j] as Line
    const key = `${lineA} vs ${lineB}`
    let aWins = 0
    for (let run = 0; run < PAIR_RUNS; run++) {
      const compA: Line[] = Array(PLAYER_CAP).fill(lineA)
      const compB: Line[] = Array(PLAYER_CAP).fill(lineB)
      const result = simulateMatch(compA, compB)
      if (result.winner === 'A') aWins++
    }
    mirrorStats[key] = {aWins, total: PAIR_RUNS}
  }
}
for (const [key, {aWins, total}] of Object.entries(mirrorStats)) {
  console.log(`${key.padEnd(28)} ${key.split(' vs ')[0]} won ${aWins}/${total}`)
}

function checkAnomalies(label: string, i: number, result: MatchResult): void {
  for (const p of result.players) {
    if (p.hull < 0)
      anomalies.push(`${label} ${i}: ${p.id} negative hull ${p.hull}`)
    if (!Number.isFinite(p.x) || !Number.isFinite(p.y))
      anomalies.push(`${label} ${i}: ${p.id} non-finite position`)
    if (Number.isNaN(p.hull)) anomalies.push(`${label} ${i}: ${p.id} NaN hull`)
  }
}

console.log(
  '\n=== Phase 4: 50 full matches per squad preset vs a random balanced mix ===',
)
const PRESET_RUNS = 50
const presetStats: Record<PresetId, LineStats> = {
  balanced: {
    matches: 0,
    wins: 0,
    kills: 0,
    deaths: 0,
    damageDealt: 0,
    damageTaken: 0,
  },
  aggro: {
    matches: 0,
    wins: 0,
    kills: 0,
    deaths: 0,
    damageDealt: 0,
    damageTaken: 0,
  },
  turtle: {
    matches: 0,
    wins: 0,
    kills: 0,
    deaths: 0,
    damageDealt: 0,
    damageTaken: 0,
  },
  recon: {
    matches: 0,
    wins: 0,
    kills: 0,
    deaths: 0,
    damageDealt: 0,
    damageTaken: 0,
  },
}
for (const presetId of Object.keys(SQUAD_PRESETS) as PresetId[]) {
  const slots = SQUAD_PRESETS[presetId].slice(0, PLAYER_CAP)
  let wins = 0
  for (let i = 0; i < PRESET_RUNS; i++) {
    try {
      const compB = randomComposition(PLAYER_CAP, true)
      const result = simulateMatch(slots, compB)
      if (result.winner === 'A') wins++
      const s = presetStats[presetId]
      s.matches++
      if (result.winner === 'A') s.wins++
      for (const p of result.players.slice(0, PLAYER_CAP)) {
        s.kills += p.kills
        if (!p.alive) s.deaths++
        s.damageDealt += p.damageDealt
        s.damageTaken += p.damageTaken
      }
      checkAnomalies(`preset ${presetId}`, i, result)
    } catch (err) {
      errors++
      console.error(`preset ${presetId} match ${i} threw:`, err)
    }
  }
  console.log(
    `${presetId.padEnd(10)} won ${wins}/${PRESET_RUNS} vs random balanced-mix opponents`,
  )
}

console.log(
  '\n=== Phase 5: 50 full matches, fully custom (unrestricted) mixed compositions on both sides ===',
)
const customStats = freshStats()
const N_CUSTOM = 50
for (let i = 0; i < N_CUSTOM; i++) {
  try {
    const compA = randomComposition(PLAYER_CAP, false)
    const compB = randomComposition(PLAYER_CAP, false)
    const result = simulateMatch(compA, compB)
    recordMatch(customStats, result)
    checkAnomalies('custom', i, result)
  } catch (err) {
    errors++
    console.error(`custom match ${i} threw:`, err)
  }
}
printStats('Phase 5: custom unrestricted compositions', customStats)

console.log(
  '\n=== Phase 6: Tender paired with allies (2x Tender + 8x line X) vs random balanced mix ===',
)
console.log(
  "Compare against Phase 2's solo 10x-stack win rate for the same line — the delta is what Tender's heal is actually worth with real allies to support.",
)
const DUO_RUNS = 30
for (const line of SHIP_LINES) {
  if (line === 'tender') continue
  const comp: Line[] = [
    ...(Array(2).fill('tender') as Line[]),
    ...(Array(8).fill(line) as Line[]),
  ]
  let wins = 0
  let tenderKills = 0
  let tenderDeaths = 0
  let tenderDmgTaken = 0
  let partnerKills = 0
  let partnerDeaths = 0
  for (let i = 0; i < DUO_RUNS; i++) {
    const compB = randomComposition(PLAYER_CAP, true)
    const result = simulateMatch(comp, compB)
    if (result.winner === 'A') wins++
    for (const p of result.players.slice(0, PLAYER_CAP)) {
      if (p.line === 'tender') {
        tenderKills += p.kills
        if (!p.alive) tenderDeaths++
        tenderDmgTaken += p.damageTaken
      } else {
        partnerKills += p.kills
        if (!p.alive) partnerDeaths++
      }
    }
  }
  const soloWinPct = (
    (stackStats[line].wins / stackStats[line].matches) *
    100
  ).toFixed(1)
  console.log(
    `2x Tender + 8x ${line.padEnd(10)} won ${wins}/${DUO_RUNS} (${((wins / DUO_RUNS) * 100).toFixed(1)}%) vs random mix` +
      ` — solo 10x ${line} stack won ${soloWinPct}% (Phase 2) — ${partnerKills} partner kills, ${partnerDeaths} partner deaths, ${tenderKills} Tender kills, ${tenderDeaths} Tender deaths, ${(tenderDmgTaken / (DUO_RUNS * 2)).toFixed(0)} dmg taken/Tender/match`,
  )
}

console.log(
  `\n${anomalies.length} total state anomalies across all phases, ${errors} matches threw.`,
)
if (anomalies.length) console.log(anomalies.slice(0, 20).join('\n'))

console.log(
  `\nTotal matches simulated: ${N_RANDOM + SHIP_LINES.length * STACK_RUNS_PER_LINE + Object.keys(mirrorStats).length * PAIR_RUNS + Object.keys(SQUAD_PRESETS).length * PRESET_RUNS + N_CUSTOM + (SHIP_LINES.length - 1) * DUO_RUNS}`,
)
