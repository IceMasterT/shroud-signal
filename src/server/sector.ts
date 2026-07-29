import {realtime, redis} from '@devvit/web/server'
import type {
  PlayerState,
  RealtimeMsg,
  ShipLine,
  WeaponMode,
} from '../shared/api.ts'
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
  OVERCHARGE_DURATION_MS,
  PLASMA_COOLDOWN_MS,
  PLASMA_RANGE,
  SHIP_WEAPONS,
  TENDER_HEAL_AMOUNT,
  TENDER_HEAL_RANGE,
  TORPEDO_COOLDOWN_MS,
  TORPEDO_RANGE,
  TORPEDO_SPEED,
} from '../shared/api.ts'
import {
  abilityReady,
  computeDamage,
  type Mine,
  mineTriggeredBy,
  nearestAlly,
} from './abilities.ts'
import {
  applyPlayerDamageToNpc,
  findClosestNpcInRadius,
  findClosestNpcInRange,
  tickMission,
} from './mission.ts'
import {
  applyDeathPenaltyFor,
  getOrCreatePilotProfile,
  grantCombatReward,
} from './pilot.ts'

const START_HULL = 100
export const WORLD_HALF = 900 // spawn/clamp bounds, world units from sector center

const LASER_HALF_ANGLE = 0.3 // radians either side of facing — ~17°
const LASER_DAMAGE = 20
const HIT_SCORE = 10
const KILL_SCORE = 40

const TORPEDO_DAMAGE = 55
const TORPEDO_IMPACT_RADIUS = 100 // how far off the flight line a target may be and still be caught
const TORPEDO_AIM_HALF_ANGLE = 0.4

// Damage/angle tuning for the battle-arena weapons, mirrored from match.ts's
// own private HITSCAN_TUNING — kept as an independent copy rather than a
// shared export, matching this codebase's existing precedent of sector.ts
// and match.ts each independently declaring baseline tuning (e.g. START_HULL).
const AUTOCANNON_DAMAGE = 14
const AUTOCANNON_HALF_ANGLE = 0.3
const BURST_DAMAGE = 30
const BURST_HALF_ANGLE = 0.35
const PLASMA_DAMAGE = 30
const PLASMA_HALF_ANGLE = 0.25
const FLAK_SHOTGUN_DAMAGE = 38
const FLAK_HALF_ANGLE = 0.5

/** Tuning for every hit-scan (instant, no travel time) weapon. Torpedo is handled separately — it's the only projectile with travel time. Exported so mission.ts's NPCs engage/fire at the exact same range/cooldown/damage a player with the same weapon would. */
export const HITSCAN_TUNING: Record<
  Exclude<WeaponMode, 'torpedo'>,
  {damage: number; cooldownMs: number; range: number; halfAngle: number}
> = {
  laser: {
    damage: LASER_DAMAGE,
    cooldownMs: LASER_COOLDOWN_MS,
    range: LASER_RANGE,
    halfAngle: LASER_HALF_ANGLE,
  },
  autocannon: {
    damage: AUTOCANNON_DAMAGE,
    cooldownMs: AUTOCANNON_COOLDOWN_MS,
    range: AUTOCANNON_RANGE,
    halfAngle: AUTOCANNON_HALF_ANGLE,
  },
  burst: {
    damage: BURST_DAMAGE,
    cooldownMs: BURST_COOLDOWN_MS,
    range: BURST_RANGE,
    halfAngle: BURST_HALF_ANGLE,
  },
  plasma: {
    damage: PLASMA_DAMAGE,
    cooldownMs: PLASMA_COOLDOWN_MS,
    range: PLASMA_RANGE,
    halfAngle: PLASMA_HALF_ANGLE,
  },
  flak: {
    damage: FLAK_SHOTGUN_DAMAGE,
    cooldownMs: FLAK_COOLDOWN_MS,
    range: FLAK_RANGE,
    halfAngle: FLAK_HALF_ANGLE,
  },
}

/** Devvit realtime channel names may only contain letters, numbers, and underscores -- no colons. */
export function sectorChannel(postId: string): string {
  return `sector_${postId}`
}

function playersKey(postId: string): string {
  return `sector:${postId}:players`
}

/** Atomic per-player counters — hull/score are read-modify-write races if
 * kept only in the players-hash JSON blob, so damage and scoring go through
 * `redis.hIncrBy` on these dedicated keys instead. */
function hullKey(postId: string): string {
  return `sector:${postId}:hull`
}

function scoreKey(postId: string): string {
  return `sector:${postId}:score`
}

function killsKey(postId: string): string {
  return `sector:${postId}:kills`
}

function torpedoesKey(postId: string): string {
  return `sector:${postId}:torpedoes`
}

function minesKey(postId: string): string {
  return `sector:${postId}:mines`
}

function leaderboardKey(subredditId: string): string {
  return `leaderboard:${subredditId}`
}

function killsLeaderboardKey(subredditId: string): string {
  return `leaderboard-kills:${subredditId}`
}

/** Sorted set of postIds, scored by last-active timestamp — drives the pulse tick. */
const ACTIVE_SECTORS_KEY = 'active_sectors'
const ACTIVE_SECTOR_MAX_AGE_MS = 24 * 60 * 60 * 1000

function randSpawn(): {x: number; y: number} {
  const a = Math.random() * Math.PI * 2
  const r = 150 + Math.random() * 400
  return {x: Math.round(Math.cos(a) * r), y: Math.round(Math.sin(a) * r)}
}

/** Loads (or creates) a player's state within one sector. The ship line always comes from the pilot's persistent profile, never assigned locally. */
export async function getOrCreatePlayer(
  postId: string,
  userId: string,
  username: string,
  snoovatar: string | undefined,
): Promise<PlayerState> {
  const snoovatarOrNull = snoovatar ?? null
  const existing = await redis.hGet(playersKey(postId), userId)
  // Read the sector's own pre-existing line (if any) before touching the
  // pilot profile, so migration works even if a caller reaches /api/init
  // without going through /api/pilot/profile first — this no longer
  // depends on client call ordering the way it used to.
  const migrateLine = existing
    ? (JSON.parse(existing) as PlayerState).line
    : undefined
  const profile = await getOrCreatePilotProfile(userId, username, migrateLine)
  const line = profile.line ?? 'fighter'
  if (existing) {
    const p = JSON.parse(existing) as PlayerState
    p.username = username
    p.snoovatar = snoovatarOrNull
    p.line = line
    p.lastLaserAt = p.lastLaserAt ?? 0
    p.lastTorpedoAt = p.lastTorpedoAt ?? 0
    p.lastAbilityAt = p.lastAbilityAt ?? 0
    p.abilityActiveUntil = p.abilityActiveUntil ?? 0
    p.team = p.team ?? null
    p.kills = p.kills ?? 0
    await redis.hSet(playersKey(postId), {[userId]: JSON.stringify(p)})
    const [hull, score, kills] = await Promise.all([
      readHull(postId, userId),
      readScore(postId, userId),
      readKills(postId, userId),
    ])
    return {...p, hull, score, kills}
  }
  const spawn = randSpawn()
  const player: PlayerState = {
    userId,
    username,
    snoovatar: snoovatarOrNull,
    line,
    x: spawn.x,
    y: spawn.y,
    rotation: 0,
    hull: START_HULL,
    score: 0,
    kills: 0,
    lastLaserAt: 0,
    lastTorpedoAt: 0,
    lastAbilityAt: 0,
    abilityActiveUntil: 0,
    team: null,
  }
  await Promise.all([
    redis.hSet(playersKey(postId), {[userId]: JSON.stringify(player)}),
    redis.hSet(hullKey(postId), {[userId]: String(START_HULL)}),
    redis.hSet(scoreKey(postId), {[userId]: '0'}),
  ])
  return player
}

/** Best-effort peek at a pre-existing sector player's line, read-only (creates nothing) — used once by the pilot-profile migration path so a player who predates this feature isn't forced through the ship picker again. */
export async function peekSectorLine(
  postId: string,
  userId: string,
): Promise<ShipLine | undefined> {
  const existing = await redis.hGet(playersKey(postId), userId)
  if (!existing) return undefined
  return (JSON.parse(existing) as PlayerState).line
}

async function readHull(postId: string, userId: string): Promise<number> {
  const v = await redis.hGet(hullKey(postId), userId)
  return v === undefined ? START_HULL : Number(v)
}

async function readScore(postId: string, userId: string): Promise<number> {
  const v = await redis.hGet(scoreKey(postId), userId)
  return v === undefined ? 0 : Number(v)
}

async function readKills(postId: string, userId: string): Promise<number> {
  const v = await redis.hGet(killsKey(postId), userId)
  return v === undefined ? 0 : Number(v)
}

/** All other players currently tracked as present in this sector. */
export async function listOtherPlayers(
  postId: string,
  excludeUserId: string,
): Promise<PlayerState[]> {
  const all = await redis.hGetAll(playersKey(postId))
  const out: PlayerState[] = []
  for (const [userId, json] of Object.entries(all ?? {})) {
    if (userId === excludeUserId) continue
    try {
      out.push(JSON.parse(json) as PlayerState)
    } catch {
      // skip malformed entries
    }
  }
  return out
}

/** Persists a position/rotation update and broadcasts it to the sector, then checks whether the new position triggered a mine. */
export async function movePlayer(
  postId: string,
  subredditId: string,
  userId: string,
  x: number,
  y: number,
  rotation: number,
): Promise<PlayerState | undefined> {
  const existing = await redis.hGet(playersKey(postId), userId)
  if (!existing) return undefined
  const player = JSON.parse(existing) as PlayerState
  player.x = Math.max(-WORLD_HALF, Math.min(WORLD_HALF, x))
  player.y = Math.max(-WORLD_HALF, Math.min(WORLD_HALF, y))
  player.rotation = rotation
  await redis.hSet(playersKey(postId), {[userId]: JSON.stringify(player)})
  await broadcast(postId, {type: 'move', player})
  await tickMission(postId)

  const minesRaw = await redis.hGetAll(minesKey(postId))
  const mines: Mine[] = Object.values(minesRaw ?? {}).map(
    json => JSON.parse(json) as Mine,
  )
  // Sector Mode has no teams, so mineTriggeredBy's team check never excludes
  // anyone (every mine is stored with a placeholder team, every player has
  // team: null) — excluding the mine's own owner has to be done explicitly here.
  const triggered = mineTriggeredBy(mines, player)
  if (!triggered || triggered.ownerId === userId) return player
  const deleted = await redis.hDel(minesKey(postId), [triggered.mineId])
  if (deleted === 0) return player // race: already triggered by someone else
  const ownerJson = await redis.hGet(playersKey(postId), triggered.ownerId)
  if (!ownerJson) return player
  const owner = JSON.parse(ownerJson) as PlayerState
  await broadcast(postId, {
    type: 'mine_detonated',
    mineId: triggered.mineId,
    targetUserId: userId,
    x: triggered.x,
    y: triggered.y,
  })
  await applyDamage(
    postId,
    subredditId,
    owner,
    owner.username,
    player,
    TORPEDO_DAMAGE,
  )
  return player
}

/**
 * Activates the caller's ship line's active ability, gated by its own
 * cooldown. Mirrors activateAbility in match.ts, adapted for Sector Mode's
 * flat 100-hull baseline (heals cap at START_HULL, not a per-line max) and
 * lack of teams (mines are placed with a placeholder team and excluded by
 * owner instead, in movePlayer).
 */
export async function activateAbility(
  postId: string,
  userId: string,
): Promise<void> {
  const existing = await redis.hGet(playersKey(postId), userId)
  if (!existing) throw new Error('not in this sector')
  const shooter = JSON.parse(existing) as PlayerState

  const now = Date.now()
  if (!abilityReady(shooter.lastAbilityAt, shooter.line, now)) {
    throw new Error('ability is on cooldown')
  }
  shooter.lastAbilityAt = now

  if (shooter.line === 'fighter' || shooter.line === 'transport') {
    const duration =
      shooter.line === 'fighter' ? OVERCHARGE_DURATION_MS : BULWARK_DURATION_MS
    shooter.abilityActiveUntil = now + duration
  }

  await redis.hSet(playersKey(postId), {[userId]: JSON.stringify(shooter)})

  if (shooter.line === 'tender') {
    const allies = await listOtherPlayers(postId, userId)
    const target = nearestAlly(allies, shooter, TENDER_HEAL_RANGE)
    if (target) {
      const current = await redis.hGet(hullKey(postId), target.userId)
      const healed = Math.min(
        START_HULL,
        Number(current ?? START_HULL) + TENDER_HEAL_AMOUNT,
      )
      await redis.hSet(hullKey(postId), {[target.userId]: String(healed)})
      await broadcast(postId, {
        type: 'heal',
        targetUserId: target.userId,
        healerUserId: userId,
        hull: healed,
      })
    }
  }

  if (shooter.line === 'miner') {
    const mineId = `${now.toString(36)}${Math.random().toString(36).slice(2, 6)}`
    const mine: Mine = {
      mineId,
      ownerId: userId,
      team: 'A', // Sector Mode has no teams; movePlayer excludes self-triggering by ownerId instead.
      x: shooter.x,
      y: shooter.y,
    }
    await redis.hSet(minesKey(postId), {[mineId]: JSON.stringify(mine)})
    await broadcast(postId, {
      type: 'mine_placed',
      mineId,
      ownerId: userId,
      x: shooter.x,
      y: shooter.y,
    })
  }

  await broadcast(postId, {type: 'ability', userId, line: shooter.line})
}

/** Removes a player from the sector's active set and tells everyone else. */
export async function leaveSector(
  postId: string,
  userId: string,
): Promise<void> {
  await redis.hDel(playersKey(postId), [userId])
  await broadcast(postId, {type: 'leave', userId})
}

export async function announceJoin(
  postId: string,
  player: PlayerState,
): Promise<void> {
  await broadcast(postId, {type: 'join', player})
}

/** Adds to a player's score, both in their sector record and the subreddit leaderboard. */
export async function addScore(
  postId: string,
  subredditId: string,
  userId: string,
  username: string,
  amount: number,
): Promise<number> {
  const isActive = await redis.hGet(playersKey(postId), userId)
  const score = await redis.hIncrBy(scoreKey(postId), userId, amount)
  if (isActive) await broadcast(postId, {type: 'score', userId, score})
  await redis.zIncrBy(leaderboardKey(subredditId), username, amount)
  return score
}

/** Adds to a player's kill count, both in their sector record and the subreddit kill leaderboard. */
export async function addKill(
  postId: string,
  subredditId: string,
  userId: string,
  username: string,
): Promise<number> {
  const isActive = await redis.hGet(playersKey(postId), userId)
  const kills = await redis.hIncrBy(killsKey(postId), userId, 1)
  if (isActive) await broadcast(postId, {type: 'kills', userId, kills})
  await redis.zIncrBy(killsLeaderboardKey(subredditId), username, 1)
  return kills
}

export async function topPilots(
  subredditId: string,
  count: number,
): Promise<{username: string; score: number; kills: number}[]> {
  const rows = await redis.zRange(leaderboardKey(subredditId), 0, count - 1, {
    reverse: true,
    by: 'rank',
  })
  const kills = await Promise.all(
    rows.map(r => redis.zScore(killsLeaderboardKey(subredditId), r.member)),
  )
  return rows.map((r, i) => ({
    username: r.member,
    score: r.score,
    kills: kills[i] ?? 0,
  }))
}

/** A torpedo in flight, tracked so a Flak Battery can find and destroy it before it lands. */
type PendingTorpedo = {
  shooterId: string
  x: number
  y: number
  impactX: number
  impactY: number
  firedAt: number
  resolveAt: number
}

/** Scans in-flight torpedoes for one within Flak range (interpolating its current position from firedAt/resolveAt) and destroys it. Returns whether one was found — if so, the Flak shot is consumed and no shotgun blast fires this trigger pull. Sector Mode has no teams, so "not mine" (not "not my team's") is the only exclusion. */
async function tryFlakIntercept(
  postId: string,
  tender: PlayerState,
  now: number,
): Promise<boolean> {
  const raw = await redis.hGetAll(torpedoesKey(postId))
  let bestId: string | undefined
  let bestDist = Infinity
  for (const [torpedoId, json] of Object.entries(raw ?? {})) {
    const t = JSON.parse(json) as PendingTorpedo
    if (t.shooterId === tender.userId) continue
    const span = Math.max(1, t.resolveAt - t.firedAt)
    const frac = Math.min(1, Math.max(0, (now - t.firedAt) / span))
    const curX = t.x + (t.impactX - t.x) * frac
    const curY = t.y + (t.impactY - t.y) * frac
    const dist = Math.hypot(curX - tender.x, curY - tender.y)
    if (dist > FLAK_INTERCEPT_RANGE || dist >= bestDist) continue
    bestDist = dist
    bestId = torpedoId
  }
  if (!bestId) return false
  const deleted = await redis.hDel(torpedoesKey(postId), [bestId])
  if (deleted === 0) return false // race: already resolved or intercepted first
  await broadcast(postId, {
    type: 'flak_intercept',
    userId: tender.userId,
    x: tender.x,
    y: tender.y,
  })
  return true
}

/**
 * Fires the shooter's weapon. Deliberately takes no client-supplied position —
 * it fires from the shooter's own authoritative last-known state (as recorded
 * by `movePlayer`), so a client can't lie about where it is to hit someone out
 * of range. Also enforces the fire cooldown server-side; the client's own
 * cooldown is just for feel and is not trusted.
 *
 * Laser: instant hitscan — the nearest other player within range and within
 * the firing cone takes damage immediately.
 *
 * Torpedo: a genuine travel-time projectile. It flies in a straight line to
 * the nearest roughly-aimed-at target's current distance (or TORPEDO_RANGE
 * if nothing qualifies); impact is resolved after that travel time elapses
 * (a detached `setTimeout` — safe here since this is a long-lived
 * `http.Server` process, not a per-request cold start), and whoever is near
 * the endpoint *at that later moment* takes the hit — not whoever was aimed
 * at when it launched, so it can still be dodged.
 */
export async function fireWeapon(
  postId: string,
  subredditId: string,
  shooterId: string,
  shooterUsername: string,
  requestedMode: WeaponMode,
): Promise<void> {
  const existing = await redis.hGet(playersKey(postId), shooterId)
  if (!existing) return
  const shooter = JSON.parse(existing) as PlayerState

  // Authoritative on the shooter's own line, not whatever the client asked
  // to fire — mirrors fireWeaponInMatch's fallback so a client can't fire a
  // weapon its ship doesn't have. lastLaserAt/lastTorpedoAt are reused as
  // generic primary/secondary weapon-slot cooldown trackers, same as match.ts.
  const weapons = SHIP_WEAPONS[shooter.line]
  const firstWeapon = weapons[0]
  if (!firstWeapon) return // unreachable — every line has at least one weapon
  const mode = weapons.includes(requestedMode) ? requestedMode : firstWeapon

  const now = Date.now()
  const isPrimary = mode === firstWeapon
  const cooldownMs =
    mode === 'torpedo' ? TORPEDO_COOLDOWN_MS : HITSCAN_TUNING[mode].cooldownMs
  if (isPrimary) {
    if (now - (shooter.lastLaserAt ?? 0) < cooldownMs) return
    shooter.lastLaserAt = now
  } else {
    if (now - (shooter.lastTorpedoAt ?? 0) < cooldownMs) return
    shooter.lastTorpedoAt = now
  }
  await redis.hSet(playersKey(postId), {[shooterId]: JSON.stringify(shooter)})

  const {x, y, rotation} = shooter
  const dirX = Math.cos(rotation - Math.PI / 2)
  const dirY = Math.sin(rotation - Math.PI / 2)
  const others = await listOtherPlayers(postId, shooterId)
  await tickMission(postId)

  if (mode === 'flak' && (await tryFlakIntercept(postId, shooter, now))) return

  if (mode !== 'torpedo') {
    const tuning = HITSCAN_TUNING[mode]
    await broadcast(postId, {
      type: 'shot',
      userId: shooterId,
      x,
      y,
      rotation,
      mode,
      travelMs: 0,
    })

    let closest: {player: PlayerState; distance: number} | undefined
    for (const p of others) {
      const dx = p.x - x
      const dy = p.y - y
      const distance = Math.hypot(dx, dy)
      if (distance === 0 || distance > tuning.range) continue
      const dot = (dx / distance) * dirX + (dy / distance) * dirY
      const angle = Math.acos(Math.max(-1, Math.min(1, dot)))
      if (angle > tuning.halfAngle) continue
      if (!closest || distance < closest.distance)
        closest = {player: p, distance}
    }
    const closestNpc = await findClosestNpcInRange(
      postId,
      x,
      y,
      dirX,
      dirY,
      tuning.range,
    )
    const npcDistance = closestNpc
      ? Math.hypot(closestNpc.x - x, closestNpc.y - y)
      : undefined
    if (
      closestNpc &&
      (!closest ||
        (npcDistance !== undefined && npcDistance < closest.distance))
    ) {
      await applyPlayerDamageToNpc(postId, shooterId, closestNpc, tuning.damage)
      return
    }
    if (!closest) return
    await applyDamage(
      postId,
      subredditId,
      shooter,
      shooterUsername,
      closest.player,
      tuning.damage,
    )
    return
  }

  // Stop at the nearest roughly-aimed-at target instead of always flying to
  // TORPEDO_RANGE — otherwise firing at anyone closer than max range
  // overshoots them entirely. Still resolved at arrival time against
  // wherever they've moved to by then, so it stays dodgeable.
  let travelDistance = TORPEDO_RANGE
  let closestDist: number | undefined
  for (const p of others) {
    const dx = p.x - x
    const dy = p.y - y
    const distance = Math.hypot(dx, dy)
    if (distance === 0 || distance > TORPEDO_RANGE) continue
    const dot = (dx / distance) * dirX + (dy / distance) * dirY
    const angle = Math.acos(Math.max(-1, Math.min(1, dot)))
    if (angle > TORPEDO_AIM_HALF_ANGLE) continue
    if (closestDist === undefined || distance < closestDist)
      closestDist = distance
  }
  if (closestDist !== undefined) travelDistance = closestDist

  const travelMs = (travelDistance / TORPEDO_SPEED) * 1000
  const impactX = x + dirX * travelDistance
  const impactY = y + dirY * travelDistance
  const torpedoId = `${now.toString(36)}${Math.random().toString(36).slice(2, 6)}`
  const pending: PendingTorpedo = {
    shooterId,
    x,
    y,
    impactX,
    impactY,
    firedAt: now,
    resolveAt: now + travelMs,
  }
  await redis.hSet(torpedoesKey(postId), {
    [torpedoId]: JSON.stringify(pending),
  })
  await broadcast(postId, {
    type: 'shot',
    userId: shooterId,
    x,
    y,
    rotation,
    mode,
    travelMs,
  })
  setTimeout(() => {
    resolveTorpedoImpact(
      postId,
      subredditId,
      torpedoId,
      shooterId,
      shooterUsername,
      impactX,
      impactY,
    ).catch(err =>
      console.error(
        `torpedo resolution failed; ${err instanceof Error ? err.stack : err}`,
      ),
    )
  }, travelMs)
}

async function resolveTorpedoImpact(
  postId: string,
  subredditId: string,
  torpedoId: string,
  shooterId: string,
  shooterUsername: string,
  impactX: number,
  impactY: number,
): Promise<void> {
  const deleted = await redis.hDel(torpedoesKey(postId), [torpedoId])
  if (deleted === 0) return // intercepted by flak before arrival

  const shooterJson = await redis.hGet(playersKey(postId), shooterId)
  if (!shooterJson) return
  const shooter = JSON.parse(shooterJson) as PlayerState

  const others = await listOtherPlayers(postId, shooterId)
  let closest: {player: PlayerState; distance: number} | undefined
  for (const p of others) {
    const distance = Math.hypot(p.x - impactX, p.y - impactY)
    if (distance > TORPEDO_IMPACT_RADIUS) continue
    if (!closest || distance < closest.distance) closest = {player: p, distance}
  }
  const npc = await findClosestNpcInRadius(
    postId,
    impactX,
    impactY,
    TORPEDO_IMPACT_RADIUS,
  )
  const npcDistance = npc
    ? Math.hypot(npc.x - impactX, npc.y - impactY)
    : undefined
  if (
    npc &&
    (!closest || (npcDistance !== undefined && npcDistance < closest.distance))
  ) {
    await applyPlayerDamageToNpc(postId, shooterId, npc, TORPEDO_DAMAGE)
    return
  }
  if (!closest) {
    await broadcast(postId, {type: 'miss', x: impactX, y: impactY})
    return
  }
  await applyDamage(
    postId,
    subredditId,
    shooter,
    shooterUsername,
    closest.player,
    TORPEDO_DAMAGE,
  )
}

async function applyDamage(
  postId: string,
  subredditId: string,
  shooter: PlayerState,
  shooterUsername: string,
  target: PlayerState,
  baseDamage: number,
): Promise<void> {
  const damage = computeDamage(baseDamage, Date.now(), shooter, target)
  const shooterId = shooter.userId
  const hull = Math.max(
    0,
    await redis.hIncrBy(hullKey(postId), target.userId, -damage),
  )
  await broadcast(postId, {
    type: 'hit',
    targetUserId: target.userId,
    shooterUserId: shooterId,
    hull,
  })

  if (hull > 0) {
    await addScore(postId, subredditId, shooterId, shooterUsername, HIT_SCORE)
    await broadcastPilotReward(postId, shooterId, 'hit')
    return
  }

  await addScore(postId, subredditId, shooterId, shooterUsername, KILL_SCORE)
  await addKill(postId, subredditId, shooterId, shooterUsername)
  await broadcastPilotReward(postId, shooterId, 'kill')
  await applyDeathPenaltyFor(target.userId)
  const spawn = randSpawn()
  await redis.hSet(hullKey(postId), {[target.userId]: String(START_HULL)})
  // `target` came from listOtherPlayers, which returns the raw players-hash
  // blob without merging the authoritative kills counter — re-read it so a
  // player who has kills doesn't have that count clobbered back to stale on
  // their own respawn broadcast.
  const targetKills = await readKills(postId, target.userId)
  const respawned: PlayerState = {
    ...target,
    kills: targetKills,
    hull: START_HULL,
    x: spawn.x,
    y: spawn.y,
    rotation: 0,
  }
  await redis.hSet(playersKey(postId), {
    [target.userId]: JSON.stringify(respawned),
  })
  await broadcast(postId, {type: 'respawn', player: respawned})
}

/**
 * An NPC (never another pilot) damaging a player — same hull/respawn/death-
 * penalty handling as a PvP hit, but with no shooter pilot to score, credit,
 * or reward (NPCs have no profile, so there's no PvP leaderboard score to
 * credit either — hence no subredditId parameter, unlike applyDamage).
 * Exported for mission.ts's reactive tick.
 */
export async function applyNpcDamageToPlayer(
  postId: string,
  npcId: string,
  target: PlayerState,
  damage: number,
): Promise<void> {
  const hull = Math.max(
    0,
    await redis.hIncrBy(hullKey(postId), target.userId, -damage),
  )
  await broadcast(postId, {
    type: 'hit',
    targetUserId: target.userId,
    shooterUserId: npcId,
    hull,
  })
  if (hull > 0) return

  await applyDeathPenaltyFor(target.userId)
  const spawn = randSpawn()
  await redis.hSet(hullKey(postId), {[target.userId]: String(START_HULL)})
  const targetKills = await readKills(postId, target.userId)
  const respawned: PlayerState = {
    ...target,
    kills: targetKills,
    hull: START_HULL,
    x: spawn.x,
    y: spawn.y,
    rotation: 0,
  }
  await redis.hSet(playersKey(postId), {
    [target.userId]: JSON.stringify(respawned),
  })
  await broadcast(postId, {type: 'respawn', player: respawned})
}

/** Grants Sector Mode combat XP/credits and tells the earning pilot's own client so it can show a toast — every other client on the channel gets the same message but ignores it, since the `userId` isn't theirs. */
async function broadcastPilotReward(
  postId: string,
  userId: string,
  kind: 'hit' | 'kill',
): Promise<void> {
  const {xpGained, creditsGained} = await grantCombatReward(userId, kind)
  await broadcast(postId, {
    type: 'pilot_reward',
    userId,
    kind,
    xpGained,
    creditsGained,
  })
}

async function broadcast(postId: string, msg: RealtimeMsg): Promise<void> {
  await realtime.send(sectorChannel(postId), msg)
}

/** Marks a sector as active right now, so the scheduled pulse tick reaches it. */
export async function touchActiveSector(postId: string): Promise<void> {
  await redis.zAdd(ACTIVE_SECTORS_KEY, {member: postId, score: Date.now()})
}

/**
 * Broadcasts an ambient flavor line to every sector active within the last
 * day, and prunes anything older so the set doesn't grow forever.
 */
export async function pulseActiveSectors(text: string): Promise<number> {
  const cutoff = Date.now() - ACTIVE_SECTOR_MAX_AGE_MS
  await redis.zRemRangeByScore(ACTIVE_SECTORS_KEY, 0, cutoff)
  const rows = await redis.zRange(ACTIVE_SECTORS_KEY, 0, -1, {by: 'rank'})
  await Promise.all(rows.map(r => broadcast(r.member, {type: 'pulse', text})))
  return rows.length
}
