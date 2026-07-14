import {once} from 'node:events'
import type {IncomingMessage, ServerResponse} from 'node:http'
import {context, reddit} from '@devvit/web/server'
import type {
  PartialJsonValue,
  TriggerResponse,
  UiResponse,
} from '@devvit/web/shared'
import {
  Endpoint,
  EndpointMethod,
  type ErrorRsp,
  type GetCounterRsp,
  type IncCounterReq,
  type IncCounterRsp,
  type InitRsp,
  type LeaderboardRsp,
  type MoveReq,
  type MoveRsp,
  type ScoreReq,
  type ScoreRsp,
} from '../shared/api.ts'
import {dbGetCounter, dbIncCounter} from './db.ts'
import {randomPulseLine} from './lore.ts'
import {
  addScore,
  announceJoin,
  getOrCreatePlayer,
  leaveSector,
  listOtherPlayers,
  movePlayer,
  pulseActiveSectors,
  sectorChannel,
  topPilots,
  touchActiveSector,
} from './sector.ts'

type AnyRsp =
  | GetCounterRsp
  | IncCounterRsp
  | InitRsp
  | MoveRsp
  | ScoreRsp
  | LeaderboardRsp
  | UiResponse
  | TriggerResponse
  | ErrorRsp

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
      case Endpoint.Move:
        rsp = await routeMove(reqMsg)
        break
      case Endpoint.Leave:
        rsp = await routeLeave()
        break
      case Endpoint.Score:
        rsp = await routeScore(reqMsg)
        break
      case Endpoint.Leaderboard:
        rsp = await routeLeaderboard()
        break
      case Endpoint.OnMenuNewPost:
        rsp = await routeMenuNewPost()
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

async function routeMove(reqMsg: IncomingMessage): Promise<MoveRsp | ErrorRsp> {
  const postId = context.postId
  const userId = context.userId
  if (!postId) return {error: 'no postId', status: 400}
  if (!userId) return {error: 'must be logged in', status: 401}
  const req = await readJson<MoveReq>(reqMsg)
  await movePlayer(postId, userId, req.x, req.y, req.rotation)
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
  const score = await addScore(
    postId,
    subredditId,
    userId,
    username,
    req.amount,
  )
  return {score}
}

async function routeLeaderboard(): Promise<LeaderboardRsp | ErrorRsp> {
  const subredditId = context.subredditId
  const entries = await topPilots(subredditId, 10)
  return {entries}
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
