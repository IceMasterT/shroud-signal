import {realtime, redis} from '@devvit/web/server'
import type {
  Mission,
  MissionRsp,
  NpcState,
  SectorTheme,
  WeaponMode,
} from '../shared/api.ts'
import {HITSCAN_TUNING, WORLD_HALF, sectorChannel} from './sector.ts'

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
