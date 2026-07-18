import {realtime, reddit, redis} from '@devvit/web/server'
import type {
  Challenge,
  JoinPolicy,
  Match,
  MatchMsg,
  PlayerState,
  PresetId,
  ShipLine,
  SquadRule,
  Team,
  TeamAssignMode,
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
  MATCH_ROUNDS_TO_WIN,
  MISSILE_COOLDOWN_MS,
  MISSILE_SPEED,
  matchChannel,
  OVERCHARGE_DURATION_MS,
  PLASMA_COOLDOWN_MS,
  PLASMA_RANGE,
  ROUND_MAX_MS,
  ROUND_RESULT_DISPLAY_MS,
  SHIP_WEAPONS,
  SQUAD_PRESETS,
  TENDER_HEAL_AMOUNT,
  TENDER_HEAL_RANGE,
  TORPEDO_RANGE,
} from '../shared/api.ts'
import {
  abilityReady,
  assignAutoTeam,
  canClaimPresetSlot,
  canJoinLine,
  computeDamage,
  isEligibleToJoin,
  type Mine,
  maxHullFor,
  mineTriggeredBy,
  nearestAlly,
  survivalCredit,
} from './abilities.ts'

const LASER_HALF_ANGLE = 0.3
const LASER_DAMAGE = 14
const TORPEDO_DAMAGE = 55
const TORPEDO_IMPACT_RADIUS = 100
const TORPEDO_AIM_HALF_ANGLE = 0.4
const AUTOCANNON_DAMAGE = 14
const AUTOCANNON_HALF_ANGLE = 0.3
const BURST_DAMAGE = 30
const BURST_HALF_ANGLE = 0.35
const PLASMA_DAMAGE = 30
const PLASMA_HALF_ANGLE = 0.25
const FLAK_SHOTGUN_DAMAGE = 38
const FLAK_HALF_ANGLE = 0.5

/** Tuning for every hit-scan (instant, no travel time) weapon. Torpedo is handled separately — it's the only projectile with travel time. */
const HITSCAN_TUNING: Record<
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

/** A torpedo in flight, tracked so a Flak Battery can find and destroy it before it lands. */
type PendingTorpedo = {
  shooterId: string
  shooterTeam: Team | null
  x: number
  y: number
  impactX: number
  impactY: number
  firedAt: number
  resolveAt: number
}

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
function matchMinesKey(matchId: string): string {
  return `match:${matchId}:mines`
}
function matchTorpedoesKey(matchId: string): string {
  return `match:${matchId}:torpedoes`
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
    squadRule: challenge.squadRule,
    // Cross-subreddit Challenges never offer a team-pick choice — team is
    // always "which subreddit you're on" — so this is a fixed, unused default.
    teamAssignMode: 'auto',
    // Cross-subreddit Challenges are always open, whitelist-free — anyone
    // who lands on the right subreddit's arena post may join.
    joinPolicy: 'open',
    whitelist: [],
    joinModeA: null,
    joinModeB: null,
    presetIdA: null,
    presetIdB: null,
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

const SCRIMMAGE_WARMUP_MINUTES = 2

/**
 * Creates the single arena post for a practice scrimmage. Unlike a
 * cross-subreddit Challenge's two posts (one per subreddit), a scrimmage is
 * single-subreddit, so both team join through the same post — arenaUrlA/B
 * both point at it and are unused by the scrimmage client.
 */
export async function createScrimmage(
  subredditName: string,
  matchSize: '5v5' | '10v10',
  squadRule: SquadRule,
  teamAssignMode: TeamAssignMode,
  joinPolicy: JoinPolicy,
  whitelist: string[],
  presetId: PresetId | null,
): Promise<Match> {
  const matchId = randomId()
  const playerCap = matchSize === '10v10' ? 10 : 5

  const arena = await reddit.submitCustomPost({
    subredditName,
    title: `Practice Scrimmage (${matchSize}): Purple vs Orange`,
    entry: 'battle',
    postData: {kind: 'scrimmage', matchId},
  })

  const now = Date.now()
  const match: Match = {
    matchId,
    arenaPostIdA: arena.id,
    arenaPostIdB: arena.id,
    arenaUrlA: arena.url,
    arenaUrlB: arena.url,
    subredditAName: subredditName,
    subredditBName: subredditName,
    playerCap,
    warmupMinutes: SCRIMMAGE_WARMUP_MINUTES,
    squadRule,
    teamAssignMode,
    joinPolicy,
    whitelist,
    // A preset, if chosen, is forced match-wide — there's no per-team
    // negotiation like a Challenge-born match has, since the mod already
    // decided this at scrimmage-creation time.
    joinModeA: presetId ? 'preset' : 'individual',
    joinModeB: presetId ? 'preset' : 'individual',
    presetIdA: presetId,
    presetIdB: presetId,
    status: 'warmup',
    round: 1,
    roundWinsA: 0,
    roundWinsB: 0,
    survivalMsA: 0,
    survivalMsB: 0,
    warmupEndsAt: now + SCRIMMAGE_WARMUP_MINUTES * 60_000,
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
  mode: 'individual' | 'preset',
  presetId: PresetId | null,
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

  const committedMode =
    (side === 'A' ? match.joinModeA : match.joinModeB) ?? null
  const committedPresetId =
    (side === 'A' ? match.presetIdA : match.presetIdB) ?? null

  if (committedMode === null) {
    if (mode === 'preset') {
      if (!presetId) throw new Error('preset is required for preset mode')
      if (side === 'A') {
        match.joinModeA = 'preset'
        match.presetIdA = presetId
      } else {
        match.joinModeB = 'preset'
        match.presetIdB = presetId
      }
    } else if (side === 'A') {
      match.joinModeA = 'individual'
    } else {
      match.joinModeB = 'individual'
    }
    await saveMatch(match)
  } else if (committedMode !== mode) {
    throw new Error(
      `this team already committed to ${committedMode === 'preset' ? 'a squad preset' : 'individual picks'}`,
    )
  } else if (mode === 'preset' && presetId !== committedPresetId) {
    throw new Error('this team is using a different squad preset')
  }

  let assignedLine = line
  if (mode === 'preset') {
    const activePresetId = presetId ?? committedPresetId
    if (!activePresetId) throw new Error('preset is required for preset mode')
    const slots = SQUAD_PRESETS[activePresetId].slice(0, match.playerCap)
    const openLine = [...new Set(slots)].find(l =>
      canClaimPresetSlot(teammates, slots, l),
    )
    if (!openLine) throw new Error('this preset is full for your team')
    assignedLine = openLine
  } else if (match.squadRule !== 'custom' && !canJoinLine(teammates, line)) {
    throw new Error(`${line} is full for this team (max 2)`)
  }

  const spawn = randSpawn(side)
  const maxHull = maxHullFor(assignedLine)
  const player: PlayerState = {
    userId,
    username,
    snoovatar: snoovatar ?? null,
    line: assignedLine,
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

/**
 * Joins a scrimmage's auto-balanced team and delegates to joinMatch for the
 * actual seat — joinMatch itself already handles the "already joined,
 * return the existing seat" case, so a freshly-computed team here is safely
 * ignored if the player is rejoining after a page refresh.
 */
export async function joinScrimmage(
  matchId: string,
  userId: string,
  username: string,
  snoovatar: string | undefined,
  line: ShipLine,
  requestedTeam: Team | null,
  isModerator: boolean,
): Promise<{role: 'player'; team: Team} | {role: 'spectator'}> {
  const match = await getMatch(matchId)
  if (!match) throw new Error('match not found')
  if (
    !isEligibleToJoin(match.joinPolicy, match.whitelist, username, isModerator)
  ) {
    return {role: 'spectator'}
  }
  let team: Team
  if (match.teamAssignMode === 'manual') {
    if (!requestedTeam) throw new Error('choose a team')
    team = requestedTeam
  } else {
    const players = await getMatchPlayers(matchId)
    team = assignAutoTeam(players)
  }
  const player = await joinMatch(
    matchId,
    team,
    userId,
    username,
    snoovatar,
    line,
    'individual',
    null,
  )
  return {role: 'player', team: player.team ?? team}
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

  if (await isEliminated(matchId, userId)) return
  const minesRaw = await redis.hGetAll(matchMinesKey(matchId))
  const mines: Mine[] = Object.values(minesRaw ?? {}).map(
    json => JSON.parse(json) as Mine,
  )
  const triggered = mineTriggeredBy(mines, player)
  if (!triggered) return
  const deleted = await redis.hDel(matchMinesKey(matchId), [triggered.mineId])
  if (deleted === 0) return
  const ownerJson = await redis.hGet(
    matchPlayersKey(matchId),
    triggered.ownerId,
  )
  if (!ownerJson) return
  const owner = JSON.parse(ownerJson) as PlayerState
  await broadcastMatch(matchId, {
    type: 'mine_detonated',
    mineId: triggered.mineId,
    targetUserId: userId,
    x: triggered.x,
    y: triggered.y,
  })
  await applyDamageInMatch(matchId, owner, player, TORPEDO_DAMAGE)
}

export async function fireWeaponInMatch(
  matchId: string,
  shooterId: string,
  requestedMode: WeaponMode,
): Promise<void> {
  const match = await getMatch(matchId)
  if (match?.status !== 'round_active') return

  const existing = await redis.hGet(matchPlayersKey(matchId), shooterId)
  if (!existing) return
  const shooter = JSON.parse(existing) as PlayerState
  if (await isEliminated(matchId, shooterId)) return

  // Authoritative on the shooter's own line, not whatever the client asked
  // to fire — a client can't fire a weapon its ship doesn't have. Fighter is
  // the only line with two weapons (laser + torpedo); everyone else only
  // ever has one, so a mismatched request just falls back to it.
  const weapons = SHIP_WEAPONS[shooter.line]
  const firstWeapon = weapons[0]
  if (!firstWeapon) return // unreachable — every line has at least one weapon
  const mode = weapons.includes(requestedMode) ? requestedMode : firstWeapon

  const now = Date.now()
  const isPrimary = mode === firstWeapon
  const cooldownMs =
    mode === 'torpedo' ? MISSILE_COOLDOWN_MS : HITSCAN_TUNING[mode].cooldownMs
  if (isPrimary) {
    if (now - (shooter.lastLaserAt ?? 0) < cooldownMs) return
    shooter.lastLaserAt = now
  } else {
    if (now - (shooter.lastTorpedoAt ?? 0) < cooldownMs) return
    shooter.lastTorpedoAt = now
  }
  await redis.hSet(matchPlayersKey(matchId), {
    [shooterId]: JSON.stringify(shooter),
  })

  const {x, y, rotation, team: shooterTeam} = shooter
  const dirX = Math.cos(rotation - Math.PI / 2)
  const dirY = Math.sin(rotation - Math.PI / 2)
  const enemies = await enemyRoster(matchId, shooterTeam)

  if (mode === 'flak' && (await tryFlakIntercept(matchId, shooter, now))) return

  if (mode === 'torpedo') {
    // A torpedo used to always fly to the full TORPEDO_RANGE in the firing
    // direction, so firing at anyone closer than that overshot them entirely
    // — guaranteed miss. Now it stops at the nearest roughly-aimed-at enemy
    // (a wider cone than laser's, since it isn't meant to be pixel-precise),
    // falling back to full range only when nothing qualifies (an intentional miss).
    let travelDistance = TORPEDO_RANGE
    let closestDist: number | undefined
    for (const p of enemies) {
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

    const travelMs = (travelDistance / MISSILE_SPEED) * 1000
    const impactX = x + dirX * travelDistance
    const impactY = y + dirY * travelDistance
    const torpedoId = `${now.toString(36)}${Math.random().toString(36).slice(2, 6)}`
    const pending: PendingTorpedo = {
      shooterId,
      shooterTeam,
      x,
      y,
      impactX,
      impactY,
      firedAt: now,
      resolveAt: now + travelMs,
    }
    await redis.hSet(matchTorpedoesKey(matchId), {
      [torpedoId]: JSON.stringify(pending),
    })
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
        torpedoId,
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
    return
  }

  const tuning = HITSCAN_TUNING[mode]
  await broadcastMatch(matchId, {
    type: 'shot',
    userId: shooterId,
    x,
    y,
    rotation,
    mode,
    travelMs: 0,
  })
  let closest: {player: PlayerState; distance: number} | undefined
  for (const p of enemies) {
    const dx = p.x - x
    const dy = p.y - y
    const distance = Math.hypot(dx, dy)
    if (distance === 0 || distance > tuning.range) continue
    const dot = (dx / distance) * dirX + (dy / distance) * dirY
    const angle = Math.acos(Math.max(-1, Math.min(1, dot)))
    if (angle > tuning.halfAngle) continue
    if (!closest || distance < closest.distance) closest = {player: p, distance}
  }
  if (!closest) return
  await applyDamageInMatch(matchId, shooter, closest.player, tuning.damage)
}

/** Scans in-flight enemy torpedoes for one within Flak range (interpolating its current position from firedAt/resolveAt) and destroys it. Returns whether one was found — if so, the Flak shot is consumed and no shotgun blast fires this trigger pull. */
async function tryFlakIntercept(
  matchId: string,
  tender: PlayerState,
  now: number,
): Promise<boolean> {
  const raw = await redis.hGetAll(matchTorpedoesKey(matchId))
  let bestId: string | undefined
  let bestDist = Infinity
  for (const [torpedoId, json] of Object.entries(raw ?? {})) {
    const t = JSON.parse(json) as PendingTorpedo
    if (t.shooterTeam === tender.team) continue
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
  const deleted = await redis.hDel(matchTorpedoesKey(matchId), [bestId])
  if (deleted === 0) return false // race: already resolved or intercepted first
  await broadcastMatch(matchId, {
    type: 'flak_intercept',
    userId: tender.userId,
    x: tender.x,
    y: tender.y,
  })
  return true
}

async function resolveTorpedoImpactInMatch(
  matchId: string,
  torpedoId: string,
  shooterId: string,
  shooterTeam: Team | null,
  impactX: number,
  impactY: number,
): Promise<void> {
  const deleted = await redis.hDel(matchTorpedoesKey(matchId), [torpedoId])
  if (deleted === 0) return // intercepted by flak before arrival

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

  if (shooter.line === 'miner') {
    const mineId = `${now.toString(36)}${Math.random().toString(36).slice(2, 6)}`
    const mine: Mine = {
      mineId,
      ownerId: userId,
      team: shooter.team ?? 'A',
      x: shooter.x,
      y: shooter.y,
    }
    await redis.hSet(matchMinesKey(matchId), {
      [mineId]: JSON.stringify(mine),
    })
    await broadcastMatch(matchId, {
      type: 'mine_placed',
      mineId,
      ownerId: userId,
      x: shooter.x,
      y: shooter.y,
    })
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
  await redis.del(matchMinesKey(match.matchId))
  await redis.del(matchTorpedoesKey(match.matchId))
  for (const p of players) {
    if (!p.team) continue
    const spawn = randSpawn(p.team)
    const maxHull = maxHullFor(p.line)
    p.x = spawn.x
    p.y = spawn.y
    p.rotation = 0
    p.hull = maxHull
    p.lastAbilityAt = 0
    p.abilityActiveUntil = 0
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

/** The elapsed ms from round start to the last elimination on `team`, or undefined if the team was never fully wiped this round (or has no players). */
async function teamWipeElapsedMs(
  match: Match,
  team: Team,
): Promise<number | undefined> {
  const players = await getMatchPlayers(match.matchId)
  const ids = players.filter(p => p.team === team).map(p => p.userId)
  if (ids.length === 0) return undefined
  let last: number | undefined
  for (const id of ids) {
    const score = await redis.zScore(matchEliminatedKey(match.matchId), id)
    if (score !== undefined && (last === undefined || score > last))
      last = score
  }
  return last === undefined
    ? undefined
    : Math.max(0, last - match.roundStartedAt)
}

async function endRound(match: Match, winner: Team | 'tie'): Promise<Match> {
  const elapsed = Date.now() - match.roundStartedAt
  const loserWipedAtMs =
    winner === 'tie'
      ? undefined
      : await teamWipeElapsedMs(match, winner === 'A' ? 'B' : 'A')
  const {creditA, creditB} = survivalCredit(winner, elapsed, loserWipedAtMs)
  match.survivalMsA += creditA
  match.survivalMsB += creditB
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
