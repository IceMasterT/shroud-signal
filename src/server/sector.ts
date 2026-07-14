import {realtime, redis} from '@devvit/web/server'
import type {PlayerState, RealtimeMsg, ShipLine} from '../shared/api.ts'
import {SHIP_LINES} from '../shared/api.ts'

const START_HULL = 100
const WORLD_HALF = 900 // spawn/clamp bounds, world units from sector center

export function sectorChannel(postId: string): string {
  return `sector:${postId}`
}

function playersKey(postId: string): string {
  return `sector:${postId}:players`
}

function leaderboardKey(subredditId: string): string {
  return `leaderboard:${subredditId}`
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
    await redis.hSet(playersKey(postId), {[userId]: JSON.stringify(p)})
    return p
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
  }
  await redis.hSet(playersKey(postId), {[userId]: JSON.stringify(player)})
  return player
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
  const existing = await redis.hGet(playersKey(postId), userId)
  let score = amount
  if (existing) {
    const player = JSON.parse(existing) as PlayerState
    player.score += amount
    score = player.score
    await redis.hSet(playersKey(postId), {[userId]: JSON.stringify(player)})
    await broadcast(postId, {type: 'score', userId, score})
  }
  await redis.zIncrBy(leaderboardKey(subredditId), username, amount)
  return score
}

export async function topPilots(
  subredditId: string,
  count: number,
): Promise<{username: string; score: number}[]> {
  const rows = await redis.zRange(leaderboardKey(subredditId), 0, count - 1, {
    reverse: true,
    by: 'rank',
  })
  return rows.map(r => ({username: r.member, score: r.score}))
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
