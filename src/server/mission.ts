import {realtime, redis} from '@devvit/web/server'
import type {
  Mission,
  MissionRsp,
  NpcState,
  PlayerState,
  SectorTheme,
  WeaponMode,
} from '../shared/api.ts'
import {grantCombatReward} from './pilot.ts'
import {
  applyNpcDamageToPlayer,
  HITSCAN_TUNING,
  listOtherPlayers,
  sectorChannel,
  WORLD_HALF,
} from './sector.ts'

function missionKey(postId: string): string {
  return `sector:${postId}:mission`
}

function npcsKey(postId: string): string {
  return `sector:${postId}:npcs`
}

/** Dedicated atomic key, same reason player hull/credits/XP are: two players damaging the same NPC "simultaneously" must never lose a hit. */
function npcHullKey(postId: string): string {
  return `sector:${postId}:npc-hull`
}

/** Dedicated atomic key for the same reason — multiple raiders reaching the starbase in the same tick window must never lose damage. */
function starbaseHullKey(postId: string): string {
  return `sector:${postId}:starbase-hull`
}

/** Claim key for "who gets to advance the wave" — see spawnNextWaveIfClear in Task 5. */
function waveClaimKey(postId: string): string {
  return `sector:${postId}:wave-claim`
}

/** Atomic per-time-window claim so only one concurrent caller actually runs a given tick — see tickMission. */
function tickClaimKey(postId: string): string {
  return `sector:${postId}:tick-claim`
}

const STARBASE_MAX_HULL = 500
const RAIDER_HULL = 60
const CAPITAL_HULL = 400
const CAPITAL_DAMAGE_MUL = 2
const NPC_MOVE_UNITS_PER_SEC = 150
const NPC_AGGRO_RANGE_MUL = 1.5 // an NPC notices a player before it's literally in firing range
const RAIDER_WEAPONS: readonly Exclude<WeaponMode, 'torpedo'>[] = [
  'autocannon',
  'burst',
  'plasma',
  'flak',
]
const CAPITAL_WEAPON: Exclude<WeaponMode, 'torpedo'> = 'plasma'
const MIN_TOTAL_WAVES = 3
const MAX_TOTAL_WAVES = 8

/** Only one theme exists today — a plain function (not a weighted table) until a second theme gives this something to actually choose between. */
export function pickSectorTheme(): SectorTheme {
  return 'starbase-defense'
}

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

function randomTotalWaves(): number {
  return (
    MIN_TOTAL_WAVES +
    Math.floor(Math.random() * (MAX_TOTAL_WAVES - MIN_TOTAL_WAVES + 1))
  )
}

function randEdgeSpawn(): {x: number; y: number} {
  const edge = Math.floor(Math.random() * 4)
  const along = (Math.random() - 0.5) * 2 * WORLD_HALF
  if (edge === 0) return {x: along, y: -WORLD_HALF} // top
  if (edge === 1) return {x: along, y: WORLD_HALF} // bottom
  if (edge === 2) return {x: -WORLD_HALF, y: along} // left
  return {x: WORLD_HALF, y: along} // right
}

function makeNpc(kind: 'raider' | 'capital'): NpcState {
  const spawn = randEdgeSpawn()
  const weapon =
    kind === 'capital'
      ? CAPITAL_WEAPON
      : (RAIDER_WEAPONS[Math.floor(Math.random() * RAIDER_WEAPONS.length)] ??
        'autocannon')
  const maxHull = kind === 'capital' ? CAPITAL_HULL : RAIDER_HULL
  return {
    npcId: `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`,
    kind,
    x: spawn.x,
    y: spawn.y,
    rotation: 0,
    hull: maxHull,
    maxHull,
    weapon,
    lastFiredAt: 0,
    targetUserId: null,
  }
}

/** Spawns the NPCs for `wave` — a single capital ship on the final wave, otherwise `raidersInWave(wave)` raiders. Writes them into the npcs hash and seeds their hull in the dedicated atomic key. */
async function spawnWave(
  postId: string,
  wave: number,
  totalWaves: number,
): Promise<void> {
  const isBossWave = wave >= totalWaves
  const npcs = isBossWave
    ? [makeNpc('capital')]
    : Array.from({length: raidersInWave(wave)}, () => makeNpc('raider'))
  const blob: Record<string, string> = {}
  const hulls: Record<string, string> = {}
  for (const npc of npcs) {
    blob[npc.npcId] = JSON.stringify(npc)
    hulls[npc.npcId] = String(npc.hull)
  }
  await Promise.all([
    redis.hSet(npcsKey(postId), blob),
    redis.hSet(npcHullKey(postId), hulls),
  ])
}

async function readNpcs(postId: string): Promise<NpcState[]> {
  const raw = await redis.hGetAll(npcsKey(postId))
  const hulls = await redis.hGetAll(npcHullKey(postId))
  const out: NpcState[] = []
  for (const [npcId, json] of Object.entries(raw ?? {})) {
    try {
      const npc = JSON.parse(json) as NpcState
      npc.hull = Number(hulls?.[npcId] ?? npc.hull)
      out.push(npc)
    } catch {
      // skip malformed entries
    }
  }
  return out
}

async function readStarbaseHull(postId: string): Promise<number> {
  const v = await redis.get(starbaseHullKey(postId))
  return v === undefined ? STARBASE_MAX_HULL : Number(v)
}

async function toMissionRsp(
  postId: string,
  mission: Mission,
): Promise<MissionRsp> {
  const [npcs, starbaseHull] = await Promise.all([
    readNpcs(postId),
    readStarbaseHull(postId),
  ])
  return {...mission, npcs, starbaseHull}
}

/** Loads a sector's mission, or creates and spawns wave 1 if none exists yet — called on every /api/init for a themed sector. */
export async function getOrCreateMission(
  postId: string,
  theme: SectorTheme,
): Promise<MissionRsp> {
  const existing = await redis.get(missionKey(postId))
  if (existing) return toMissionRsp(postId, JSON.parse(existing) as Mission)

  const totalWaves = randomTotalWaves()
  const mission: Mission = {
    theme,
    wave: 1,
    totalWaves,
    participants: [],
    status: 'active',
    starbaseMaxHull: STARBASE_MAX_HULL,
    lastTickAt: Date.now(),
  }
  await Promise.all([
    redis.set(missionKey(postId), JSON.stringify(mission)),
    redis.set(starbaseHullKey(postId), String(STARBASE_MAX_HULL)),
    spawnWave(postId, 1, totalWaves),
  ])
  return toMissionRsp(postId, mission)
}

async function broadcastMission(
  postId: string,
  mission: MissionRsp,
): Promise<void> {
  await realtime.send(sectorChannel(postId), {type: 'mission_state', mission})
}

/** Closest alive NPC within range and roughly facing the shooter's aim direction — mirrors fireWeapon's own player-targeting loop in sector.ts, over NPCs instead. No aiming cone beyond a generous check, since a shooter's own cone check already happened before this is called. */
export async function findClosestNpcInRange(
  postId: string,
  x: number,
  y: number,
  dirX: number,
  dirY: number,
  range: number,
): Promise<NpcState | undefined> {
  const npcs = await readNpcs(postId)
  let closest: {npc: NpcState; distance: number} | undefined
  for (const npc of npcs) {
    const dx = npc.x - x
    const dy = npc.y - y
    const distance = Math.hypot(dx, dy)
    if (distance === 0 || distance > range) continue
    const dot = (dx / distance) * dirX + (dy / distance) * dirY
    const angle = Math.acos(Math.max(-1, Math.min(1, dot)))
    if (angle > 0.5) continue // generous cone — same order as the weapons' own halfAngle values
    if (!closest || distance < closest.distance) closest = {npc, distance}
  }
  return closest?.npc
}

/** Closest alive NPC within a plain radius, no facing/cone check — for torpedo impact resolution, which has a fixed impact point, not a shooter aiming. Mirrors the existing player-side torpedo-impact loop in sector.ts, which is likewise cone-free. */
export async function findClosestNpcInRadius(
  postId: string,
  x: number,
  y: number,
  radius: number,
): Promise<NpcState | undefined> {
  const npcs = await readNpcs(postId)
  let closest: {npc: NpcState; distance: number} | undefined
  for (const npc of npcs) {
    const distance = Math.hypot(npc.x - x, npc.y - y)
    if (distance > radius) continue
    if (!closest || distance < closest.distance) closest = {npc, distance}
  }
  return closest?.npc
}

/**
 * If the npcs hash is now empty, either spawns the next wave or resolves the
 * mission as won. Race-guarded: only the request whose hIncrBy on this wave's
 * claim key returns 1 actually performs the spawn/resolve — every other
 * concurrent caller that also just cleared the last NPC of the wave sees a
 * higher number and backs out, so a wave is never skipped or double-spawned.
 */
async function spawnNextWaveIfClear(
  postId: string,
  mission: Mission,
): Promise<Mission> {
  const remaining = await redis.hLen(npcsKey(postId))
  if (remaining > 0) return mission

  const claimed = await redis.hIncrBy(
    waveClaimKey(postId),
    String(mission.wave),
    1,
  )
  if (claimed !== 1) return mission // another request already advancing this wave

  const starbaseHull = await readStarbaseHull(postId)
  const outcome = evaluateMissionOutcome(
    starbaseHull,
    mission.wave,
    mission.totalWaves,
    0,
  )
  // Either terminal outcome resolves the mission without spawning further —
  // the starbase could have been destroyed by the same volley that killed
  // the wave's last NPC, so 'won' is never assumed just because the wave's
  // clear condition on its own would say so.
  if (outcome !== 'active') {
    const resolved: Mission = {...mission, status: outcome}
    await redis.set(missionKey(postId), JSON.stringify(resolved))
    return resolved
  }
  const nextWave = mission.wave + 1
  await spawnWave(postId, nextWave, mission.totalWaves)
  const advanced: Mission = {...mission, wave: nextWave}
  await redis.set(missionKey(postId), JSON.stringify(advanced))
  return advanced
}

/** A player's shot lands on an NPC — hull decrement (atomic), death/reward/wave-advance on a kill, always ends by broadcasting the fresh mission state. */
export async function applyPlayerDamageToNpc(
  postId: string,
  shooterUserId: string,
  npc: NpcState,
  damage: number,
): Promise<void> {
  const existingRaw = await redis.get(missionKey(postId))
  if (!existingRaw) return
  let mission = JSON.parse(existingRaw) as Mission
  if (mission.status !== 'active') return

  const hull = Math.max(
    0,
    await redis.hIncrBy(npcHullKey(postId), npc.npcId, -damage),
  )
  if (!mission.participants.includes(shooterUserId)) {
    mission = {
      ...mission,
      participants: [...mission.participants, shooterUserId],
    }
    await redis.set(missionKey(postId), JSON.stringify(mission))
  }

  if (hull > 0) {
    await broadcastMission(postId, await toMissionRsp(postId, mission))
    return
  }

  const removed = await redis.hDel(npcsKey(postId), [npc.npcId])
  await redis.hDel(npcHullKey(postId), [npc.npcId])
  if (removed !== 1) {
    // Another concurrent hit already claimed this kill — this shot landed on an already-dead NPC.
    await broadcastMission(postId, await toMissionRsp(postId, mission))
    return
  }

  await grantCombatReward(
    shooterUserId,
    npc.kind === 'capital' ? 'kill' : 'hit',
  )
  mission = await spawnNextWaveIfClear(postId, mission)
  await broadcastMission(postId, await toMissionRsp(postId, mission))
}

const MIN_TICK_INTERVAL_MS = 200 // caps how often the reactive tick actually does work, however often movePlayer/fireWeapon fire
const MAX_TICK_DT_SEC = 0.5 // guards against a huge jump if a sector goes quiet for a while

function nearestPlayer(
  npc: NpcState,
  players: PlayerState[],
  range: number,
): PlayerState | undefined {
  let closest: {player: PlayerState; distance: number} | undefined
  for (const p of players) {
    const distance = Math.hypot(p.x - npc.x, p.y - npc.y)
    if (distance > range) continue
    if (!closest || distance < closest.distance) closest = {player: p, distance}
  }
  return closest?.player
}

/**
 * Runs on every movePlayer/fireWeapon call in a themed sector — there is no
 * dedicated scheduler. Moves each alive NPC a step toward its target (the
 * nearest aggro'd player, or the starbase at the origin if none is close
 * enough) and fires if already in range with its cooldown elapsed.
 */
export async function tickMission(postId: string): Promise<void> {
  const existingRaw = await redis.get(missionKey(postId))
  if (!existingRaw) return
  let mission = JSON.parse(existingRaw) as Mission
  if (mission.status !== 'active') return

  const now = Date.now()
  const windowId = Math.floor(now / MIN_TICK_INTERVAL_MS)
  const claimed = await redis.hSetNX(
    tickClaimKey(postId),
    String(windowId),
    '1',
  )
  if (claimed !== 1) return // another concurrent caller already ticked this window
  await redis.hDel(tickClaimKey(postId), [String(windowId - 1)]) // bound the hash to ~1-2 fields, self-pruning

  const dt = Math.min(
    Math.max((now - mission.lastTickAt) / 1000, 0),
    MAX_TICK_DT_SEC,
  )
  mission = {...mission, lastTickAt: now}
  await redis.set(missionKey(postId), JSON.stringify(mission))

  const [npcs, players] = await Promise.all([
    readNpcs(postId),
    listOtherPlayers(postId, ''), // no "self" from the tick's perspective — '' excludes no real userId, so this returns every player in the sector
  ])
  if (npcs.length === 0) return

  for (const npc of npcs) {
    const tuning = HITSCAN_TUNING[npc.weapon]
    const aggroRange = tuning.range * NPC_AGGRO_RANGE_MUL
    const target = nearestPlayer(npc, players, aggroRange)
    const targetX = target ? target.x : 0
    const targetY = target ? target.y : 0
    npc.targetUserId = target ? target.userId : null

    const dx = targetX - npc.x
    const dy = targetY - npc.y
    const distance = Math.hypot(dx, dy)
    const step = NPC_MOVE_UNITS_PER_SEC * dt
    if (distance > step && distance > 0) {
      npc.x += (dx / distance) * step
      npc.y += (dy / distance) * step
    } else {
      npc.x = targetX
      npc.y = targetY
    }
    npc.rotation = Math.atan2(dy, dx) + Math.PI / 2

    const withinRange = distance <= tuning.range
    const cooledDown = now - npc.lastFiredAt >= tuning.cooldownMs
    if (withinRange && cooledDown) {
      npc.lastFiredAt = now
      const damage =
        npc.kind === 'capital'
          ? tuning.damage * CAPITAL_DAMAGE_MUL
          : tuning.damage
      if (target) {
        await applyNpcDamageToPlayer(postId, npc.npcId, target, damage)
      } else {
        await redis.incrBy(starbaseHullKey(postId), -damage)
      }
    }
    if ((await redis.hGet(npcsKey(postId), npc.npcId)) !== undefined) {
      await redis.hSet(npcsKey(postId), {[npc.npcId]: JSON.stringify(npc)})
    }
  }

  const starbaseHull = await readStarbaseHull(postId)
  const outcome = evaluateMissionOutcome(
    Math.max(0, starbaseHull),
    mission.wave,
    mission.totalWaves,
    npcs.length,
  )
  if (outcome === 'lost') {
    mission = {...mission, status: 'lost'}
    await redis.set(missionKey(postId), JSON.stringify(mission))
  }

  await broadcastMission(postId, await toMissionRsp(postId, mission))
}
