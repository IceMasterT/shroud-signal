import {reddit, redis} from '@devvit/web/server'
import type {
  Challenge,
  ChallengeAction,
  ChallengeStatus,
} from '../shared/api.ts'
import {createMatch} from './match.ts'

const MIN_PLAYER_CAP = 1
const MAX_PLAYER_CAP = 10
const MIN_WARMUP_MIN = 1
const MAX_WARMUP_MIN = 5

function challengeKey(challengeId: string): string {
  return `challenge:${challengeId}`
}

function randomId(): string {
  return `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`
}

export function clampPlayerCap(n: number): number {
  return Math.round(Math.max(MIN_PLAYER_CAP, Math.min(MAX_PLAYER_CAP, n)))
}

export function clampWarmupMinutes(n: number): number {
  return Math.round(Math.max(MIN_WARMUP_MIN, Math.min(MAX_WARMUP_MIN, n)))
}

export async function getChallenge(
  challengeId: string,
): Promise<Challenge | undefined> {
  const json = await redis.get(challengeKey(challengeId))
  return json ? (JSON.parse(json) as Challenge) : undefined
}

async function saveChallenge(challenge: Challenge): Promise<void> {
  await redis.set(
    challengeKey(challenge.challengeId),
    JSON.stringify(challenge),
  )
}

/**
 * Creates a challenge from the "setup" post, posts an announcement into the
 * target subreddit (requires the app to be installed there; throws
 * otherwise, which the caller should surface to the mod), and turns the
 * setup post itself into the challenger's live status post.
 */
export async function createChallenge(
  setupPostId: string,
  challengerSubredditId: string,
  challengerSubredditName: string,
  targetSubredditName: string,
  playerCap: number,
  warmupMinutes: number,
): Promise<Challenge> {
  const challengeId = randomId()
  const cap = clampPlayerCap(playerCap)
  const warmup = clampWarmupMinutes(warmupMinutes)

  const targetPost = await reddit.submitCustomPost({
    subredditName: targetSubredditName,
    title: `r/${challengerSubredditName} has challenged you to a Last One Standing battle!`,
    entry: 'challenge',
    postData: {kind: 'challenge', challengeId, role: 'target'},
  })

  const challenge: Challenge = {
    challengeId,
    challengerPostId: setupPostId,
    targetPostId: targetPost.id,
    challengerSubredditId,
    challengerSubredditName,
    targetSubredditName,
    playerCap: cap,
    warmupMinutes: warmup,
    counterPlayerCap: null,
    counterWarmupMinutes: null,
    status: 'pending',
    createdAt: Date.now(),
    matchId: null,
    arenaUrlA: null,
    arenaUrlB: null,
  }
  await saveChallenge(challenge)
  await reddit.setPostData(setupPostId as `t3_${string}`, {
    kind: 'challenge',
    challengeId,
    role: 'challenger',
  })
  return challenge
}

/**
 * Applies a response to a challenge. `role` comes from the caller's own
 * post's postData, not a client-asserted value, so a target can't accept
 * their own challenge by pretending to be the challenger and vice versa.
 */
export async function respondChallenge(
  challengeId: string,
  role: 'challenger' | 'target',
  action: ChallengeAction,
  playerCap: number | undefined,
  warmupMinutes: number | undefined,
): Promise<{challengeStatus: ChallengeStatus; matchId: string | null}> {
  const challenge = await getChallenge(challengeId)
  if (!challenge) throw new Error('challenge not found')

  if (action === 'decline') {
    if (challenge.status !== 'pending' && challenge.status !== 'countered') {
      throw new Error('challenge cannot be declined in its current state')
    }
    challenge.status = 'declined'
    await saveChallenge(challenge)
    return {challengeStatus: challenge.status, matchId: null}
  }

  if (action === 'accept' || action === 'counter') {
    if (role !== 'target')
      throw new Error('only the challenged subreddit can do that')
    if (challenge.status !== 'pending')
      throw new Error('challenge is not pending')
    if (action === 'counter') {
      challenge.counterPlayerCap = clampPlayerCap(
        playerCap ?? challenge.playerCap,
      )
      challenge.counterWarmupMinutes = clampWarmupMinutes(
        warmupMinutes ?? challenge.warmupMinutes,
      )
      challenge.status = 'countered'
      await saveChallenge(challenge)
      return {challengeStatus: challenge.status, matchId: null}
    }
  } else if (action === 'accept-counter') {
    if (role !== 'challenger') {
      throw new Error('only the challenger can accept a counter offer')
    }
    if (challenge.status !== 'countered')
      throw new Error('no counter to accept')
    challenge.playerCap = challenge.counterPlayerCap ?? challenge.playerCap
    challenge.warmupMinutes =
      challenge.counterWarmupMinutes ?? challenge.warmupMinutes
  }

  const match = await createMatch(challenge)
  challenge.status = 'accepted'
  challenge.matchId = match.matchId
  challenge.arenaUrlA = match.arenaUrlA
  challenge.arenaUrlB = match.arenaUrlB
  await saveChallenge(challenge)
  return {challengeStatus: challenge.status, matchId: match.matchId}
}
