import {redis} from '@devvit/web/server'
import type {PilotProfile, PilotProfileRsp, ShipLine} from '../shared/api.ts'

const PILOTS_KEY = 'pilots'

function creditsKey(userId: string): string {
  return `pilot:${userId}:credits`
}

function xpKey(userId: string): string {
  return `pilot:${userId}:xp`
}

/** XP required to advance from `level` to `level + 1` — a gentle, ever-slowing climb rather than linear or explosive. */
export function xpToNextLevel(level: number): number {
  return Math.floor(100 * level ** 1.4)
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

async function readCredits(userId: string): Promise<number> {
  const v = await redis.get(creditsKey(userId))
  return v === undefined ? 0 : Number(v)
}

async function readXp(userId: string): Promise<number> {
  const v = await redis.get(xpKey(userId))
  return v === undefined ? 0 : Number(v)
}

/** Loads a pilot's stored profile as-is, creating a fresh one (line unset, or seeded from `migrateLine`) if this is their first-ever visit. Never touches the live credits/xp counters — callers merge those in separately. */
async function loadOrInitProfile(
  userId: string,
  username: string,
  migrateLine: ShipLine | undefined,
): Promise<PilotProfile> {
  const existing = await redis.hGet(PILOTS_KEY, userId)
  if (existing) {
    const profile = JSON.parse(existing) as PilotProfile
    profile.username = username
    await redis.hSet(PILOTS_KEY, {[userId]: JSON.stringify(profile)})
    return profile
  }
  const profile: PilotProfile = {
    userId,
    username,
    line: migrateLine ?? null,
    shipTier: 1,
    moduleInventory: [],
    equippedModuleIds: [null, null, null],
    createdAt: Date.now(),
  }
  await redis.hSet(PILOTS_KEY, {[userId]: JSON.stringify(profile)})
  return profile
}

async function mergeLiveCounters(
  profile: PilotProfile,
): Promise<PilotProfileRsp> {
  const [credits, xp] = await Promise.all([
    readCredits(profile.userId),
    readXp(profile.userId),
  ])
  return {...profile, credits, xp, ...levelForXp(xp)}
}

/**
 * Loads (or creates) a pilot's global profile. `migrateLine` seeds the
 * initial line for a pre-existing sector player who predates this feature,
 * so they aren't forced through the ship picker again — pass `undefined`
 * once a pilot might already have a profile of their own.
 */
export async function getOrCreatePilotProfile(
  userId: string,
  username: string,
  migrateLine?: ShipLine,
): Promise<PilotProfileRsp> {
  const profile = await loadOrInitProfile(userId, username, migrateLine)
  return mergeLiveCounters(profile)
}

/** Locks in a pilot's ship line, once. Throws if they've already chosen one. */
export async function chooseLine(
  userId: string,
  username: string,
  line: ShipLine,
): Promise<PilotProfileRsp> {
  const profile = await loadOrInitProfile(userId, username, undefined)
  if (!canChooseLine(profile)) throw new Error('line already chosen')
  const updated: PilotProfile = {...profile, line}
  await redis.hSet(PILOTS_KEY, {[userId]: JSON.stringify(updated)})
  return mergeLiveCounters(updated)
}

const COMBAT_REWARDS: Record<'hit' | 'kill', {xp: number; credits: number}> = {
  hit: {xp: 2, credits: 1},
  kill: {xp: 15, credits: 10},
}

/** Credits/XP for a Sector Mode hit or kill — atomic INCRBY, safe even if the same pilot is active in two sector posts at once. Returns the amounts granted, for the caller to relay in a realtime toast. */
export async function grantCombatReward(
  userId: string,
  kind: 'hit' | 'kill',
): Promise<{xpGained: number; creditsGained: number}> {
  const reward = COMBAT_REWARDS[kind]
  await Promise.all([
    redis.incrBy(creditsKey(userId), reward.credits),
    redis.incrBy(xpKey(userId), reward.xp),
  ])
  return {xpGained: reward.xp, creditsGained: reward.credits}
}

/** Applies the small currency-loss death penalty. The percentage itself still depends on a fresh-enough read of current credits (an inherent property of a proportional penalty, not fixable with a flat atomic increment alone) — but the write is now self-correcting: if a concurrent penalty from another active sector post races this one and the combined deltas would push the balance negative, this clamps it back to 0 immediately via the same atomic incrBy, rather than leaving a visible negative balance until some unrelated later call happens to correct it. */
export async function applyDeathPenaltyFor(userId: string): Promise<void> {
  const credits = await readCredits(userId)
  const penalized = applyDeathPenalty(credits)
  const delta = penalized - credits
  if (delta === 0) return
  const after = await redis.incrBy(creditsKey(userId), delta)
  if (after < 0) {
    await redis.incrBy(creditsKey(userId), -after)
  }
}
