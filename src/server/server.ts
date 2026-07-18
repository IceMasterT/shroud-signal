import {once} from 'node:events'
import type {IncomingMessage, ServerResponse} from 'node:http'
import {context, reddit} from '@devvit/web/server'
import type {
  PartialJsonValue,
  TriggerResponse,
  UiResponse,
} from '@devvit/web/shared'
import {
  type ChallengeAction,
  type ChallengeStateRsp,
  type CreateChallengeReq,
  type CreateChallengeRsp,
  type CreateScrimmageReq,
  type CreateScrimmageRsp,
  Endpoint,
  EndpointMethod,
  type ErrorRsp,
  type FireReq,
  type FireRsp,
  type GetCounterRsp,
  type IncCounterReq,
  type IncCounterRsp,
  type InitRsp,
  type JoinMatchReq,
  type JoinMatchRsp,
  type LeaderboardRsp,
  type MatchAbilityRsp,
  type MatchStateRsp,
  type MoveReq,
  type MoveRsp,
  type PostKind,
  type RespondChallengeReq,
  type RespondChallengeRsp,
  type ScoreReq,
  type ScoreRsp,
  type ScrimmageJoinReq,
  type ScrimmageJoinRsp,
  type SectorJoinReq,
  type SectorJoinRsp,
  SHIP_LINES,
  SQUAD_PRESETS,
  SQUAD_RULES,
  WEAPON_MODES,
} from '../shared/api.ts'
import {
  clampPlayerCap,
  clampWarmupMinutes,
  createChallenge,
  getChallenge,
  respondChallenge,
} from './challenge.ts'
import {dbGetCounter, dbIncCounter} from './db.ts'
import {randomPulseLine} from './lore.ts'
import {
  activateAbility,
  createScrimmage,
  fireWeaponInMatch,
  getMatch,
  getMatchPlayers,
  joinMatch,
  joinScrimmage,
  movePlayerInMatch,
  tickMatch,
} from './match.ts'
import {
  addScore,
  announceJoin,
  fireWeapon,
  getOrCreatePlayer,
  leaveSector,
  listOtherPlayers,
  movePlayer,
  pulseActiveSectors,
  sectorChannel,
  setPlayerLine,
  topPilots,
  touchActiveSector,
} from './sector.ts'

type AnyRsp =
  | GetCounterRsp
  | IncCounterRsp
  | InitRsp
  | SectorJoinRsp
  | MoveRsp
  | ScoreRsp
  | FireRsp
  | LeaderboardRsp
  | CreateChallengeRsp
  | RespondChallengeRsp
  | ChallengeStateRsp
  | JoinMatchRsp
  | MatchAbilityRsp
  | MatchStateRsp
  | CreateScrimmageRsp
  | ScrimmageJoinRsp
  | UiResponse
  | TriggerResponse
  | ErrorRsp

/** postData is written exclusively by our own server code (never client-writable), so a light shape check is enough. */
function getPostKind(): PostKind | undefined {
  const data = context.postData
  if (!data || typeof data.kind !== 'string') return undefined
  return data as unknown as PostKind
}

/** A match-arena and a scrimmage both play through match.ts's shared round engine — this is the one place that needs to treat them interchangeably. */
function matchIdFromKind(kind: PostKind | undefined): string | undefined {
  if (kind?.kind === 'match-arena' || kind?.kind === 'scrimmage')
    return kind.matchId
  return undefined
}

export async function onReq(
  reqMsg: IncomingMessage,
  rspMsg: ServerResponse,
): Promise<void> {
  try {
    await route(reqMsg, rspMsg)
  } catch (err) {
    const msg = `server error; ${err instanceof Error ? err.stack : err}`
    console.error(msg)
    writeJson<ErrorRsp>(500, {error: msg, status: 500}, rspMsg)
  }
}

async function route(
  reqMsg: IncomingMessage,
  rspMsg: ServerResponse,
): Promise<void> {
  const endpoint = reqMsg.url?.slice(1) as Endpoint
  const method = EndpointMethod[endpoint]

  let rsp: AnyRsp
  if (method !== reqMsg.method) {
    rsp = {error: 'not found', status: 404}
  } else {
    switch (endpoint) {
      case Endpoint.GetCounter:
        rsp = await routeGetCounter()
        break
      case Endpoint.IncCounter:
        rsp = await routeInc(reqMsg)
        break
      case Endpoint.Init:
        rsp = await routeInit()
        break
      case Endpoint.SectorJoin:
        rsp = await routeSectorJoin(reqMsg)
        break
      case Endpoint.Move:
        rsp = await routeMove(reqMsg)
        break
      case Endpoint.Leave:
        rsp = await routeLeave()
        break
      case Endpoint.Score:
        rsp = await routeScore(reqMsg)
        break
      case Endpoint.Fire:
        rsp = await routeFire(reqMsg)
        break
      case Endpoint.Leaderboard:
        rsp = await routeLeaderboard()
        break
      case Endpoint.ChallengeCreate:
        rsp = await routeChallengeCreate(reqMsg)
        break
      case Endpoint.ChallengeRespond:
        rsp = await routeChallengeRespond(reqMsg)
        break
      case Endpoint.ChallengeState:
        rsp = await routeChallengeState()
        break
      case Endpoint.MatchJoin:
        rsp = await routeMatchJoin(reqMsg)
        break
      case Endpoint.MatchAbility:
        rsp = await routeMatchAbility()
        break
      case Endpoint.MatchState:
        rsp = await routeMatchState()
        break
      case Endpoint.ScrimmageCreate:
        rsp = await routeScrimmageCreate(reqMsg)
        break
      case Endpoint.ScrimmageJoin:
        rsp = await routeScrimmageJoin(reqMsg)
        break
      case Endpoint.OnMenuNewPost:
        rsp = await routeMenuNewPost()
        break
      case Endpoint.OnMenuNewChallenge:
        rsp = await routeMenuNewChallenge()
        break
      case Endpoint.OnMenuNewScrimmage:
        rsp = await routeMenuNewScrimmage()
        break
      case Endpoint.OnAppInstall:
        rsp = await routeAppInstall()
        break
      case Endpoint.OnGalaxyPulse:
        rsp = await routeGalaxyPulse()
        break
      default:
        endpoint satisfies never
        rsp = {error: 'not found', status: 404}
        break
    }
  }

  writeJson<PartialJsonValue>('status' in rsp ? rsp.status : 200, rsp, rspMsg)
}

async function routeGetCounter(): Promise<GetCounterRsp> {
  const t3 = context.postId
  if (!t3) throw Error('no t3')
  return {count: await dbGetCounter(t3)}
}

async function routeInc(reqMsg: IncomingMessage): Promise<IncCounterRsp> {
  const t3 = context.postId
  if (!t3) throw Error('no t3')
  const req = await readJson<IncCounterReq>(reqMsg)
  return {count: await dbIncCounter(t3, req.amount)}
}

async function routeInit(): Promise<InitRsp | ErrorRsp> {
  const postId = context.postId
  const userId = context.userId
  if (!postId) return {error: 'no postId', status: 400}
  if (!userId) return {error: 'must be logged in', status: 401}
  const username = context.username ?? 'anonymous'
  const player = await getOrCreatePlayer(
    postId,
    userId,
    username,
    context.snoovatar,
  )
  const others = await listOtherPlayers(postId, userId)
  await announceJoin(postId, player)
  await touchActiveSector(postId)
  return {postId, channel: sectorChannel(postId), player, others}
}

async function routeSectorJoin(
  reqMsg: IncomingMessage,
): Promise<SectorJoinRsp | ErrorRsp> {
  const postId = context.postId
  const userId = context.userId
  if (!postId) return {error: 'no postId', status: 400}
  if (!userId) return {error: 'must be logged in', status: 401}
  const username = context.username ?? 'anonymous'
  const req = await readJson<SectorJoinReq>(reqMsg)
  if (!SHIP_LINES.includes(req.line)) {
    return {error: 'invalid ship line', status: 400}
  }
  await setPlayerLine(postId, userId, username, context.snoovatar, req.line)
  return {ok: true}
}

async function routeMove(reqMsg: IncomingMessage): Promise<MoveRsp | ErrorRsp> {
  const postId = context.postId
  const userId = context.userId
  if (!postId) return {error: 'no postId', status: 400}
  if (!userId) return {error: 'must be logged in', status: 401}
  const req = await readJson<MoveReq>(reqMsg)
  if (
    !isFiniteNumber(req.x) ||
    !isFiniteNumber(req.y) ||
    !isFiniteNumber(req.rotation)
  ) {
    return {error: 'invalid move payload', status: 400}
  }
  const kind = getPostKind()
  const matchId = matchIdFromKind(kind)
  if (matchId) {
    await movePlayerInMatch(matchId, userId, req.x, req.y, req.rotation)
  } else {
    await movePlayer(postId, userId, req.x, req.y, req.rotation)
  }
  return {ok: true}
}

async function routeLeave(): Promise<UiResponse | ErrorRsp> {
  const postId = context.postId
  const userId = context.userId
  if (!postId) return {error: 'no postId', status: 400}
  if (!userId) return {error: 'must be logged in', status: 401}
  await leaveSector(postId, userId)
  return {}
}

async function routeScore(
  reqMsg: IncomingMessage,
): Promise<ScoreRsp | ErrorRsp> {
  const postId = context.postId
  const userId = context.userId
  const subredditId = context.subredditId
  if (!postId) return {error: 'no postId', status: 400}
  if (!userId) return {error: 'must be logged in', status: 401}
  const username = context.username ?? 'anonymous'
  const req = await readJson<ScoreReq>(reqMsg)
  if (!isFiniteNumber(req.amount)) {
    return {error: 'invalid score payload', status: 400}
  }
  const score = await addScore(
    postId,
    subredditId,
    userId,
    username,
    req.amount,
  )
  return {score}
}

async function routeFire(reqMsg: IncomingMessage): Promise<FireRsp | ErrorRsp> {
  const postId = context.postId
  const userId = context.userId
  const subredditId = context.subredditId
  if (!postId) return {error: 'no postId', status: 400}
  if (!userId) return {error: 'must be logged in', status: 401}
  const req = await readJson<FireReq>(reqMsg)
  if (!WEAPON_MODES.includes(req.mode)) {
    return {error: 'invalid fire mode', status: 400}
  }
  const kind = getPostKind()
  const matchId = matchIdFromKind(kind)
  if (matchId) {
    await fireWeaponInMatch(matchId, userId, req.mode)
  } else {
    // Free-play sectors only ever have plain laser + torpedo — the newer
    // battle-arena-only weapons (autocannon/burst/plasma/flak) don't apply here.
    if (req.mode !== 'laser' && req.mode !== 'torpedo') {
      return {error: 'invalid fire mode for a sector', status: 400}
    }
    const username = context.username ?? 'anonymous'
    await fireWeapon(postId, subredditId, userId, username, req.mode)
  }
  return {ok: true}
}

function isFiniteNumber(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v)
}

async function routeLeaderboard(): Promise<LeaderboardRsp | ErrorRsp> {
  const subredditId = context.subredditId
  const entries = await topPilots(subredditId, 10)
  return {entries}
}

async function routeChallengeCreate(
  reqMsg: IncomingMessage,
): Promise<CreateChallengeRsp | ErrorRsp> {
  const postId = context.postId
  const subredditId = context.subredditId
  const subredditName = context.subredditName
  if (!postId) return {error: 'no postId', status: 400}
  const kind = getPostKind()
  if (kind?.kind !== 'challenge-setup') {
    return {error: 'not a challenge setup post', status: 400}
  }
  const req = await readJson<CreateChallengeReq>(reqMsg)
  if (typeof req.targetSubredditName !== 'string' || !req.targetSubredditName) {
    return {error: 'target subreddit is required', status: 400}
  }
  if (!isFiniteNumber(req.playerCap) || !isFiniteNumber(req.warmupMinutes)) {
    return {error: 'invalid challenge payload', status: 400}
  }
  if (!SQUAD_RULES.includes(req.squadRule)) {
    return {error: 'invalid squad rule', status: 400}
  }
  try {
    const challenge = await createChallenge(
      postId,
      subredditId,
      subredditName,
      req.targetSubredditName.replace(/^r\//i, '').trim(),
      clampPlayerCap(req.playerCap),
      clampWarmupMinutes(req.warmupMinutes),
      req.squadRule,
    )
    return {challengeId: challenge.challengeId}
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    return {
      error: `couldn't challenge r/${req.targetSubredditName}: ${msg}. Shroud Signal may not be installed there yet.`,
      status: 400,
    }
  }
}

async function routeChallengeRespond(
  reqMsg: IncomingMessage,
): Promise<RespondChallengeRsp | ErrorRsp> {
  const kind = getPostKind()
  if (kind?.kind !== 'challenge') {
    return {error: 'not a challenge post', status: 400}
  }
  const req = await readJson<RespondChallengeReq>(reqMsg)
  const validActions: ChallengeAction[] = [
    'accept',
    'counter',
    'accept-counter',
    'decline',
  ]
  if (!validActions.includes(req.action)) {
    return {error: 'invalid challenge action', status: 400}
  }
  if (req.squadRule !== undefined && !SQUAD_RULES.includes(req.squadRule)) {
    return {error: 'invalid squad rule', status: 400}
  }
  try {
    const result = await respondChallenge(
      kind.challengeId,
      kind.role,
      req.action,
      req.playerCap,
      req.warmupMinutes,
      req.squadRule,
    )
    return result
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    return {error: msg, status: 400}
  }
}

async function routeChallengeState(): Promise<ChallengeStateRsp | ErrorRsp> {
  const kind = getPostKind()
  if (kind?.kind !== 'challenge') {
    return {error: 'not a challenge post', status: 400}
  }
  const challenge = await getChallenge(kind.challengeId)
  if (!challenge) return {error: 'challenge not found', status: 404}
  return {challenge}
}

async function routeMatchJoin(
  reqMsg: IncomingMessage,
): Promise<JoinMatchRsp | ErrorRsp> {
  const userId = context.userId
  const username = context.username ?? 'anonymous'
  if (!userId) return {error: 'must be logged in', status: 401}
  const kind = getPostKind()
  if (kind?.kind !== 'match-arena')
    return {error: 'not a match arena post', status: 400}
  const req = await readJson<JoinMatchReq>(reqMsg)
  if (!SHIP_LINES.includes(req.line)) {
    return {error: 'invalid ship line', status: 400}
  }
  if (req.mode !== 'individual' && req.mode !== 'preset') {
    return {error: 'invalid join mode', status: 400}
  }
  if (
    req.mode === 'preset' &&
    (!req.presetId || !(req.presetId in SQUAD_PRESETS))
  ) {
    return {error: 'invalid preset', status: 400}
  }
  try {
    await joinMatch(
      kind.matchId,
      kind.side,
      userId,
      username,
      context.snoovatar,
      req.line,
      req.mode,
      req.presetId,
    )
    return {ok: true}
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    return {error: msg, status: 400}
  }
}

async function routeMatchAbility(): Promise<MatchAbilityRsp | ErrorRsp> {
  const userId = context.userId
  if (!userId) return {error: 'must be logged in', status: 401}
  const matchId = matchIdFromKind(getPostKind())
  if (!matchId)
    return {error: 'not a match arena or scrimmage post', status: 400}
  try {
    await activateAbility(matchId, userId)
    return {ok: true}
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    return {error: msg, status: 400}
  }
}

async function routeMatchState(): Promise<MatchStateRsp | ErrorRsp> {
  const userId = context.userId
  const matchId = matchIdFromKind(getPostKind())
  if (!matchId)
    return {error: 'not a match arena or scrimmage post', status: 400}
  let match = await getMatch(matchId)
  if (!match) return {error: 'match not found', status: 404}
  match = await tickMatch(match)
  const players = await getMatchPlayers(matchId)
  const rosterA = players.filter(p => p.team === 'A')
  const rosterB = players.filter(p => p.team === 'B')
  const self = players.find(p => p.userId === userId) ?? null
  return {
    match,
    self,
    rosterA,
    rosterB,
  }
}

async function routeScrimmageCreate(
  reqMsg: IncomingMessage,
): Promise<CreateScrimmageRsp | ErrorRsp> {
  const subredditName = context.subredditName
  if (!subredditName) return {error: 'no subreddit', status: 400}
  const kind = getPostKind()
  if (kind?.kind !== 'scrimmage-setup') {
    return {error: 'not a scrimmage setup post', status: 400}
  }
  const req = await readJson<CreateScrimmageReq>(reqMsg)
  if (req.matchSize !== '5v5' && req.matchSize !== '10v10') {
    return {error: 'invalid match size', status: 400}
  }
  if (!SQUAD_RULES.includes(req.squadRule)) {
    return {error: 'invalid squad rule', status: 400}
  }
  try {
    const match = await createScrimmage(
      subredditName,
      req.matchSize,
      req.squadRule,
    )
    return {matchId: match.matchId, arenaUrl: match.arenaUrlA}
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    return {error: `couldn't create the scrimmage: ${msg}`, status: 400}
  }
}

async function routeScrimmageJoin(
  reqMsg: IncomingMessage,
): Promise<ScrimmageJoinRsp | ErrorRsp> {
  const userId = context.userId
  const username = context.username ?? 'anonymous'
  if (!userId) return {error: 'must be logged in', status: 401}
  const kind = getPostKind()
  if (kind?.kind !== 'scrimmage')
    return {error: 'not a scrimmage post', status: 400}
  const req = await readJson<ScrimmageJoinReq>(reqMsg)
  if (!SHIP_LINES.includes(req.line)) {
    return {error: 'invalid ship line', status: 400}
  }
  try {
    return await joinScrimmage(
      kind.matchId,
      userId,
      username,
      context.snoovatar,
      req.line,
    )
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    return {error: msg, status: 400}
  }
}

async function routeGalaxyPulse(): Promise<TriggerResponse> {
  await pulseActiveSectors(randomPulseLine())
  return {}
}

async function routeMenuNewPost(): Promise<UiResponse> {
  const post = await reddit.submitCustomPost({title: context.appSlug})
  return {
    showToast: {text: `Post ${post.id} created.`, appearance: 'success'},
    navigateTo: post.url,
  }
}

async function routeMenuNewChallenge(): Promise<UiResponse> {
  const post = await reddit.submitCustomPost({
    title: 'Set up a subreddit challenge',
    entry: 'challenge',
    postData: {kind: 'challenge-setup'},
  })
  return {
    showToast: {text: 'Set up your challenge!', appearance: 'success'},
    navigateTo: post.url,
  }
}

async function routeMenuNewScrimmage(): Promise<UiResponse> {
  const post = await reddit.submitCustomPost({
    title: 'Set up a scrimmage',
    entry: 'scrimmage',
    postData: {kind: 'scrimmage-setup'},
  })
  return {
    showToast: {text: 'Set up your scrimmage!', appearance: 'success'},
    navigateTo: post.url,
  }
}

async function routeAppInstall(): Promise<TriggerResponse> {
  await reddit.submitCustomPost({title: context.appSlug})
  return {}
}

async function readJson<T>(reqMsg: IncomingMessage): Promise<T> {
  const chunks: Uint8Array[] = []
  reqMsg.on('data', chunk => chunks.push(chunk))
  await once(reqMsg, 'end')
  return JSON.parse(`${Buffer.concat(chunks)}`)
}

function writeJson<T extends PartialJsonValue>(
  status: number,
  json: Readonly<T>,
  rsp: ServerResponse,
): void {
  const body = JSON.stringify(json)
  const len = Buffer.byteLength(body)
  rsp.writeHead(status, {
    'Content-Length': len,
    'Content-Type': 'application/json',
  })
  rsp.end(body)
}
