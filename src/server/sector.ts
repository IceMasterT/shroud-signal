import {realtime, redis} from '@devvit/web/server'
import type {
  PlayerState,
  RealtimeMsg,
  ShipLine,
  WeaponMode,
} from '../shared/api.ts'
import {
  LASER_COOLDOWN_MS,
  LASER_RANGE,
  SHIP_LINES,
  TORPEDO_COOLDOWN_MS,
  TORPEDO_RANGE,
  TORPEDO_SPEED,
} from '../shared/api.ts'

const START_HULL = 100
const WORLD_HALF = 900 // spawn/clamp bounds, world units from sector center

const LASER_HALF_ANGLE = 0.3 // radians either side of facing — ~17°
const LASER_DAMAGE = 20
const HIT_SCORE = 10
const KILL_SCORE = 40

const TORPEDO_DAMAGE = 45
const TORPEDO_IMPACT_RADIUS = 70 // how far off the flight line a target may be and still be caught

export function sectorChannel(postId: string): string {
  return `sector:${postId}`
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

function leaderboardKey(subredditId: string): string {
  return `leaderboard:${subredditId}`
}

function killsLeaderboardKey(subredditId: string): string {
  return `leaderboard-kills:${subredditId}`
}

/** Sorted set of postIds, scored by last-active timestamp — drives the pulse tick. */
const ACTIVE_SECTORS_KEY = 'active_sectors'
const ACTIVE_SECTOR_MAX_AGE_MS = 24 * 60 * 60 * 1000

/** Stable, deterministic starter-line assignment from a Reddit user id. */
function lineForUser(userId: string): ShipLine {
  let hash = 0
  for (let i = 0; i < userId.length; i++)
    hash = (hash * 31 + userId.charCodeAt(i)) >>> 0
  return SHIP_LINES[hash % SHIP_LINES.length] ?? 'fighter'
}

function randSpawn(): {x: number; y: number} {
  const a = Math.random() * Math.PI * 2
  const r = 150 + Math.random() * 400
  return {x: Math.round(Math.cos(a) * r), y: Math.round(Math.sin(a) * r)}
}

/** Loads (or creates) a player's state within one sector. */
export async function getOrCreatePlayer(
  postId: string,
  userId: string,
  username: string,
  snoovatar: string | undefined,
): Promise<PlayerState> {
  const snoovatarOrNull = snoovatar ?? null
  const existing = await redis.hGet(playersKey(postId), userId)
  if (existing) {
    const p = JSON.parse(existing) as PlayerState
    p.username = username
    p.snoovatar = snoovatarOrNull
    p.lastLaserAt = p.lastLaserAt ?? 0
    p.lastTorpedoAt = p.lastTorpedoAt ?? 0
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
    line: lineForUser(userId),
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

/** Persists a position/rotation update and broadcasts it to the sector. */
export async function movePlayer(
  postId: string,
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
  return player
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
 * Torpedo: a genuine travel-time projectile. It always flies the full
 * TORPEDO_RANGE in a straight line; impact is resolved after that travel
 * time elapses (a detached `setTimeout` — safe here since this is a
 * long-lived `http.Server` process, not a per-request cold start), and
 * whoever is near the endpoint *at that later moment* takes the hit — not
 * whoever was aimed at when it launched, so it can be dodged.
 */
export async function fireWeapon(
  postId: string,
  subredditId: string,
  shooterId: string,
  shooterUsername: string,
  mode: WeaponMode,
): Promise<void> {
  const existing = await redis.hGet(playersKey(postId), shooterId)
  if (!existing) return
  const shooter = JSON.parse(existing) as PlayerState

  const now = Date.now()
  if (mode === 'laser') {
    if (now - (shooter.lastLaserAt ?? 0) < LASER_COOLDOWN_MS) return
    shooter.lastLaserAt = now
  } else {
    if (now - (shooter.lastTorpedoAt ?? 0) < TORPEDO_COOLDOWN_MS) return
    shooter.lastTorpedoAt = now
  }
  await redis.hSet(playersKey(postId), {[shooterId]: JSON.stringify(shooter)})

  const {x, y, rotation} = shooter
  const dirX = Math.cos(rotation - Math.PI / 2)
  const dirY = Math.sin(rotation - Math.PI / 2)

  if (mode === 'laser') {
    await broadcast(postId, {
      type: 'shot',
      userId: shooterId,
      x,
      y,
      rotation,
      mode,
      travelMs: 0,
    })

    const others = await listOtherPlayers(postId, shooterId)
    let closest: {player: PlayerState; distance: number} | undefined
    for (const p of others) {
      const dx = p.x - x
      const dy = p.y - y
      const distance = Math.hypot(dx, dy)
      if (distance === 0 || distance > LASER_RANGE) continue
      const dot = (dx / distance) * dirX + (dy / distance) * dirY
      const angle = Math.acos(Math.max(-1, Math.min(1, dot)))
      if (angle > LASER_HALF_ANGLE) continue
      if (!closest || distance < closest.distance)
        closest = {player: p, distance}
    }
    if (!closest) return
    await applyDamage(
      postId,
      subredditId,
      shooterId,
      shooterUsername,
      closest.player,
      LASER_DAMAGE,
    )
    return
  }

  const travelMs = (TORPEDO_RANGE / TORPEDO_SPEED) * 1000
  const impactX = x + dirX * TORPEDO_RANGE
  const impactY = y + dirY * TORPEDO_RANGE
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
  shooterId: string,
  shooterUsername: string,
  impactX: number,
  impactY: number,
): Promise<void> {
  const others = await listOtherPlayers(postId, shooterId)
  let closest: {player: PlayerState; distance: number} | undefined
  for (const p of others) {
    const distance = Math.hypot(p.x - impactX, p.y - impactY)
    if (distance > TORPEDO_IMPACT_RADIUS) continue
    if (!closest || distance < closest.distance) closest = {player: p, distance}
  }
  if (!closest) {
    await broadcast(postId, {type: 'miss', x: impactX, y: impactY})
    return
  }
  await applyDamage(
    postId,
    subredditId,
    shooterId,
    shooterUsername,
    closest.player,
    TORPEDO_DAMAGE,
  )
}

async function applyDamage(
  postId: string,
  subredditId: string,
  shooterId: string,
  shooterUsername: string,
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
    shooterUserId: shooterId,
    hull,
  })

  if (hull > 0) {
    await addScore(postId, subredditId, shooterId, shooterUsername, HIT_SCORE)
    return
  }

  await addScore(postId, subredditId, shooterId, shooterUsername, KILL_SCORE)
  await addKill(postId, subredditId, shooterId, shooterUsername)
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
