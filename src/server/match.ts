import {realtime, reddit, redis} from '@devvit/web/server'
import type {
  Challenge,
  Match,
  MatchMsg,
  PlayerState,
  ShipLine,
  Team,
} from '../shared/api.ts'
import {
  BULWARK_DURATION_MS,
  LASER_COOLDOWN_MS,
  LASER_RANGE,
  MATCH_ROUNDS_TO_WIN,
  matchChannel,
  OVERCHARGE_DURATION_MS,
  ROUND_MAX_MS,
  ROUND_RESULT_DISPLAY_MS,
  TENDER_HEAL_AMOUNT,
  TENDER_HEAL_RANGE,
  TORPEDO_COOLDOWN_MS,
  TORPEDO_RANGE,
  TORPEDO_SPEED,
} from '../shared/api.ts'
import {
  abilityReady,
  canJoinLine,
  computeDamage,
  maxHullFor,
  nearestAlly,
} from './abilities.ts'

const LASER_HALF_ANGLE = 0.3
const LASER_DAMAGE = 20
const TORPEDO_DAMAGE = 45
const TORPEDO_IMPACT_RADIUS = 70

function matchKey(matchId: string): string {
  return `match:${matchId}`
}
function matchPlayersKey(matchId: string): string {
  return `match:${matchId}:players`
}
function matchHullKey(matchId: string): string {
  return `match:${matchId}:hull`
}
function matchEliminatedKey(matchId: string): string {
  return `match:${matchId}:eliminated`
}
function matchKillsKey(matchId: string): string {
  return `match:${matchId}:kills`
}

function randomId(): string {
  return `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`
}

/** Seeds each team on opposite sides of the arena so a round opens as two fleets closing in. */
function randSpawn(side: Team): {x: number; y: number} {
  const baseX = side === 'A' ? -500 : 500
  const a = Math.random() * Math.PI * 2
  const r = 80 + Math.random() * 220
  return {
    x: Math.round(baseX + Math.cos(a) * r),
    y: Math.round(Math.sin(a) * r),
  }
}

export async function getMatch(matchId: string): Promise<Match | undefined> {
  const json = await redis.get(matchKey(matchId))
  return json ? (JSON.parse(json) as Match) : undefined
}

async function saveMatch(match: Match): Promise<void> {
  await redis.set(matchKey(match.matchId), JSON.stringify(match))
}

export async function getMatchPlayers(matchId: string): Promise<PlayerState[]> {
  const [all, kills] = await Promise.all([
    redis.hGetAll(matchPlayersKey(matchId)),
    redis.hGetAll(matchKillsKey(matchId)),
  ])
  const out: PlayerState[] = []
  for (const [userId, json] of Object.entries(all ?? {})) {
    try {
      const p = JSON.parse(json) as PlayerState
      p.kills = Number(kills?.[userId] ?? 0)
      out.push(p)
    } catch {
      // skip malformed entries
    }
  }
  return out
}

async function broadcastMatch(matchId: string, msg: MatchMsg): Promise<void> {
  await realtime.send(matchChannel(matchId), msg)
}

/** Creates the two synced arena posts (one per subreddit) and the warmup-status match record. */
export async function createMatch(challenge: Challenge): Promise<Match> {
  if (!challenge.targetPostId) throw new Error('challenge has no target post')
  const matchId = randomId()

  const arenaA = await reddit.submitCustomPost({
    subredditName: challenge.challengerSubredditName,
    title: `Battle vs r/${challenge.targetSubredditName}: Last One Standing`,
    entry: 'battle',
    postData: {kind: 'match-arena', matchId, side: 'A'},
  })
  const arenaB = await reddit.submitCustomPost({
    subredditName: challenge.targetSubredditName,
    title: `Battle vs r/${challenge.challengerSubredditName}: Last One Standing`,
    entry: 'battle',
    postData: {kind: 'match-arena', matchId, side: 'B'},
  })

  const now = Date.now()
  const match: Match = {
    matchId,
    arenaPostIdA: arenaA.id,
    arenaPostIdB: arenaB.id,
    arenaUrlA: arenaA.url,
    arenaUrlB: arenaB.url,
    subredditAName: challenge.challengerSubredditName,
    subredditBName: challenge.targetSubredditName,
    playerCap: challenge.playerCap,
    warmupMinutes: challenge.warmupMinutes,
    status: 'warmup',
    round: 1,
    roundWinsA: 0,
    roundWinsB: 0,
    survivalMsA: 0,
    survivalMsB: 0,
    warmupEndsAt: now + challenge.warmupMinutes * 60_000,
    roundStartedAt: 0,
    roundEndsAt: 0,
    roundResultAt: 0,
    lastRoundWinner: null,
    winner: null,
  }
  await saveMatch(match)
  return match
}

export async function joinMatch(
  matchId: string,
  side: Team,
  userId: string,
  username: string,
  snoovatar: string | undefined,
  line: ShipLine,
): Promise<PlayerState> {
  const match = await getMatch(matchId)
  if (!match) throw new Error('match not found')
  if (match.status !== 'warmup')
    throw new Error('match is not accepting players')

  const existing = await redis.hGet(matchPlayersKey(matchId), userId)
  if (existing) return JSON.parse(existing) as PlayerState

  const players = await getMatchPlayers(matchId)
  const teammates = players.filter(p => p.team === side)
  if (teammates.length >= match.playerCap) throw new Error('team is full')
  if (!canJoinLine(teammates, line))
    throw new Error(`${line} is full for this team (max 2)`)

  const spawn = randSpawn(side)
  const maxHull = maxHullFor(line)
  const player: PlayerState = {
    userId,
    username,
    snoovatar: snoovatar ?? null,
    line,
    x: spawn.x,
    y: spawn.y,
    rotation: 0,
    hull: maxHull,
    score: 0,
    kills: 0,
    lastLaserAt: 0,
    lastTorpedoAt: 0,
    lastAbilityAt: 0,
    abilityActiveUntil: 0,
    team: side,
  }
  await redis.hSet(matchPlayersKey(matchId), {[userId]: JSON.stringify(player)})
  await redis.hSet(matchHullKey(matchId), {[userId]: String(maxHull)})
  await broadcastMatch(matchId, {type: 'roster', player})
  return player
}

export async function movePlayerInMatch(
  matchId: string,
  userId: string,
  x: number,
  y: number,
  rotation: number,
): Promise<void> {
  const existing = await redis.hGet(matchPlayersKey(matchId), userId)
  if (!existing) return
  const player = JSON.parse(existing) as PlayerState
  player.x = x
  player.y = y
  player.rotation = rotation
  await redis.hSet(matchPlayersKey(matchId), {[userId]: JSON.stringify(player)})
  await broadcastMatch(matchId, {type: 'move', player})
}

export async function fireWeaponInMatch(
  matchId: string,
  shooterId: string,
  mode: 'laser' | 'torpedo',
): Promise<void> {
  const match = await getMatch(matchId)
  if (match?.status !== 'round_active') return

  const existing = await redis.hGet(matchPlayersKey(matchId), shooterId)
  if (!existing) return
  const shooter = JSON.parse(existing) as PlayerState
  if (await isEliminated(matchId, shooterId)) return

  const now = Date.now()
  if (mode === 'laser') {
    if (now - (shooter.lastLaserAt ?? 0) < LASER_COOLDOWN_MS) return
    shooter.lastLaserAt = now
  } else {
    if (now - (shooter.lastTorpedoAt ?? 0) < TORPEDO_COOLDOWN_MS) return
    shooter.lastTorpedoAt = now
  }
  await redis.hSet(matchPlayersKey(matchId), {
    [shooterId]: JSON.stringify(shooter),
  })

  const {x, y, rotation, team: shooterTeam} = shooter
  const dirX = Math.cos(rotation - Math.PI / 2)
  const dirY = Math.sin(rotation - Math.PI / 2)

  if (mode === 'laser') {
    await broadcastMatch(matchId, {
      type: 'shot',
      userId: shooterId,
      x,
      y,
      rotation,
      mode,
      travelMs: 0,
    })

    const enemies = await enemyRoster(matchId, shooterTeam)
    let closest: {player: PlayerState; distance: number} | undefined
    for (const p of enemies) {
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
    await applyDamageInMatch(matchId, shooter, closest.player, LASER_DAMAGE)
    return
  }

  const travelMs = (TORPEDO_RANGE / TORPEDO_SPEED) * 1000
  const impactX = x + dirX * TORPEDO_RANGE
  const impactY = y + dirY * TORPEDO_RANGE
  await broadcastMatch(matchId, {
    type: 'shot',
    userId: shooterId,
    x,
    y,
    rotation,
    mode,
    travelMs,
  })
  setTimeout(() => {
    resolveTorpedoImpactInMatch(
      matchId,
      shooterId,
      shooterTeam,
      impactX,
      impactY,
    ).catch(err =>
      console.error(
        `match torpedo resolution failed; ${err instanceof Error ? err.stack : err}`,
      ),
    )
  }, travelMs)
}

async function resolveTorpedoImpactInMatch(
  matchId: string,
  shooterId: string,
  shooterTeam: Team | null,
  impactX: number,
  impactY: number,
): Promise<void> {
  const shooterJson = await redis.hGet(matchPlayersKey(matchId), shooterId)
  if (!shooterJson) return
  const shooter = JSON.parse(shooterJson) as PlayerState
  const enemies = await enemyRoster(matchId, shooterTeam)
  let closest: {player: PlayerState; distance: number} | undefined
  for (const p of enemies) {
    const distance = Math.hypot(p.x - impactX, p.y - impactY)
    if (distance > TORPEDO_IMPACT_RADIUS) continue
    if (!closest || distance < closest.distance) closest = {player: p, distance}
  }
  if (!closest) {
    await broadcastMatch(matchId, {type: 'miss', x: impactX, y: impactY})
    return
  }
  await applyDamageInMatch(matchId, shooter, closest.player, TORPEDO_DAMAGE)
}

async function enemyRoster(
  matchId: string,
  shooterTeam: Team | null,
): Promise<PlayerState[]> {
  const players = await getMatchPlayers(matchId)
  const alive: PlayerState[] = []
  for (const p of players) {
    if (p.team === shooterTeam) continue
    if (await isEliminated(matchId, p.userId)) continue
    alive.push(p)
  }
  return alive
}

async function isEliminated(matchId: string, userId: string): Promise<boolean> {
  return (await redis.zScore(matchEliminatedKey(matchId), userId)) !== undefined
}

export async function activateAbility(
  matchId: string,
  userId: string,
): Promise<void> {
  const match = await getMatch(matchId)
  if (match?.status !== 'round_active') throw new Error('no active round')

  const existing = await redis.hGet(matchPlayersKey(matchId), userId)
  if (!existing) throw new Error('not in this match')
  const shooter = JSON.parse(existing) as PlayerState
  if (await isEliminated(matchId, userId)) throw new Error('you are eliminated')

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

  await redis.hSet(matchPlayersKey(matchId), {
    [userId]: JSON.stringify(shooter),
  })

  if (shooter.line === 'tender') {
    const players = await getMatchPlayers(matchId)
    const allies: PlayerState[] = []
    for (const p of players) {
      if (p.team !== shooter.team) continue
      if (await isEliminated(matchId, p.userId)) continue
      allies.push(p)
    }
    const target = nearestAlly(allies, shooter, TENDER_HEAL_RANGE)
    if (target) {
      const maxHull = maxHullFor(target.line)
      const current = await redis.hGet(matchHullKey(matchId), target.userId)
      const healed = Math.min(
        maxHull,
        Number(current ?? maxHull) + TENDER_HEAL_AMOUNT,
      )
      await redis.hSet(matchHullKey(matchId), {
        [target.userId]: String(healed),
      })
      await broadcastMatch(matchId, {
        type: 'heal',
        targetUserId: target.userId,
        healerUserId: userId,
        hull: healed,
      })
    }
  }

  await broadcastMatch(matchId, {type: 'ability', userId, line: shooter.line})
}

async function applyDamageInMatch(
  matchId: string,
  shooter: PlayerState,
  target: PlayerState,
  baseDamage: number,
): Promise<void> {
  const damage = computeDamage(baseDamage, Date.now(), shooter, target)
  const hull = Math.max(
    0,
    await redis.hIncrBy(matchHullKey(matchId), target.userId, -damage),
  )
  await broadcastMatch(matchId, {
    type: 'hit',
    targetUserId: target.userId,
    shooterUserId: shooter.userId,
    hull,
  })
  if (hull > 0) return

  await redis.zAdd(matchEliminatedKey(matchId), {
    member: target.userId,
    score: Date.now(),
  })
  const kills = await redis.hIncrBy(matchKillsKey(matchId), shooter.userId, 1)
  await broadcastMatch(matchId, {type: 'kills', userId: shooter.userId, kills})
  if (!target.team) return
  await broadcastMatch(matchId, {
    type: 'eliminated',
    userId: target.userId,
    team: target.team,
  })

  const remainingEnemyTeam = target.team === 'A' ? 'B' : 'A'
  const stillAlive = await enemyRoster(matchId, remainingEnemyTeam)
  if (stillAlive.length === 0) {
    const match = await getMatch(matchId)
    if (match && match.status === 'round_active')
      await endRound(match, remainingEnemyTeam)
  }
}

async function startRound(match: Match): Promise<Match> {
  const players = await getMatchPlayers(match.matchId)
  await redis.del(matchEliminatedKey(match.matchId))
  for (const p of players) {
    if (!p.team) continue
    const spawn = randSpawn(p.team)
    const maxHull = maxHullFor(p.line)
    p.x = spawn.x
    p.y = spawn.y
    p.rotation = 0
    p.hull = maxHull
    await redis.hSet(matchPlayersKey(match.matchId), {
      [p.userId]: JSON.stringify(p),
    })
    await redis.hSet(matchHullKey(match.matchId), {
      [p.userId]: String(maxHull),
    })
  }
  match.status = 'round_active'
  match.roundStartedAt = Date.now()
  match.roundEndsAt = match.roundStartedAt + ROUND_MAX_MS
  await saveMatch(match)
  await broadcastMatch(match.matchId, {type: 'round_start', round: match.round})
  return match
}

async function endRound(match: Match, winner: Team | 'tie'): Promise<Match> {
  const elapsed = Date.now() - match.roundStartedAt
  match.survivalMsA += elapsed
  match.survivalMsB += elapsed
  if (winner === 'A') match.roundWinsA++
  else if (winner === 'B') match.roundWinsB++
  match.lastRoundWinner = winner
  match.status = 'round_result'
  match.roundResultAt = Date.now()

  const seriesWinner = decideSeriesWinner(match)
  if (seriesWinner) {
    match.status = 'complete'
    match.winner = seriesWinner
  }
  await saveMatch(match)
  await broadcastMatch(match.matchId, {
    type: 'round_end',
    winner,
    roundWinsA: match.roundWinsA,
    roundWinsB: match.roundWinsB,
  })
  if (match.winner) {
    await broadcastMatch(match.matchId, {
      type: 'match_end',
      winner: match.winner,
    })
  }
  return match
}

function decideSeriesWinner(match: Match): Team | 'tie' | null {
  if (match.roundWinsA >= MATCH_ROUNDS_TO_WIN) return 'A'
  if (match.roundWinsB >= MATCH_ROUNDS_TO_WIN) return 'B'
  if (match.round >= 3) {
    if (match.roundWinsA !== match.roundWinsB) {
      return match.roundWinsA > match.roundWinsB ? 'A' : 'B'
    }
    if (match.survivalMsA === match.survivalMsB) return 'tie'
    return match.survivalMsA > match.survivalMsB ? 'A' : 'B'
  }
  return null
}

/**
 * Lazily advances match state based on elapsed time (warm-up window, round
 * timeout, round-result display) — checked on every state poll/action
 * rather than a server-side timer, so it stays correct across restarts.
 */
export async function tickMatch(match: Match): Promise<Match> {
  const now = Date.now()

  if (match.status === 'warmup') {
    const players = await getMatchPlayers(match.matchId)
    const countA = players.filter(p => p.team === 'A').length
    const countB = players.filter(p => p.team === 'B').length
    const full = countA >= match.playerCap && countB >= match.playerCap
    if (full || now >= match.warmupEndsAt) {
      if (countA === 0 || countB === 0) {
        // Nobody showed up on one side — cancel rather than run a one-sided round.
        match.status = 'complete'
        match.winner = countA > 0 ? 'A' : countB > 0 ? 'B' : 'tie'
        await saveMatch(match)
        return match
      }
      return await startRound(match)
    }
    return match
  }

  if (match.status === 'round_active') {
    if (now >= match.roundEndsAt) return await endRound(match, 'tie')
    return match
  }

  if (match.status === 'round_result') {
    if (!match.winner && now >= match.roundResultAt + ROUND_RESULT_DISPLAY_MS) {
      match.round++
      return await startRound(match)
    }
    return match
  }

  return match
}
