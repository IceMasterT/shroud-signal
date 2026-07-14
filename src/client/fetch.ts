import {
  Endpoint,
  type FireReq,
  type FireRsp,
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

export async function fetchGetCounter(): Promise<GetCounterRsp | undefined> {
  let rsp
  try {
    rsp = await fetch(Endpoint.GetCounter, {
      headers: {Accept: 'application/json'},
    })
  } catch (err) {
    const msg = `HTTP error: ${err instanceof Error ? err.message : err}`
    console.error(msg)
    return
  }

  if (!rsp.ok) {
    const text = await rsp.text().catch(() => '')
    const err = `HTTP status ${rsp.status}: ${rsp.statusText}; ${text}`
    console.error(err)
    return
  }

  return (await rsp.json()) as GetCounterRsp
}

export async function fetchIncCounter(
  amount: number,
): Promise<IncCounterRsp | undefined> {
  const req: IncCounterReq = {amount}
  let rsp
  try {
    rsp = await fetch(Endpoint.IncCounter, {
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/json',
      },
      method: 'POST',
      body: JSON.stringify(req),
    })
  } catch (err) {
    const msg = `HTTP error: ${err instanceof Error ? err.message : err}`
    console.error(msg)
    return
  }

  if (!rsp.ok) {
    const text = await rsp.text().catch(() => '')
    const err = `HTTP status ${rsp.status}: ${rsp.statusText}; ${text}`
    console.error(err)
    return
  }

  return (await rsp.json()) as IncCounterRsp
}

async function getJson<T>(endpoint: string): Promise<T | undefined> {
  let rsp
  try {
    rsp = await fetch(endpoint, {headers: {Accept: 'application/json'}})
  } catch (err) {
    console.error(`HTTP error: ${err instanceof Error ? err.message : err}`)
    return
  }
  if (!rsp.ok) {
    console.error(`HTTP status ${rsp.status}: ${rsp.statusText}`)
    return
  }
  return (await rsp.json()) as T
}

async function postJson<Req, T>(
  endpoint: string,
  req: Req,
): Promise<T | undefined> {
  let rsp
  try {
    rsp = await fetch(endpoint, {
      method: 'POST',
      headers: {Accept: 'application/json', 'Content-Type': 'application/json'},
      body: JSON.stringify(req),
    })
  } catch (err) {
    console.error(`HTTP error: ${err instanceof Error ? err.message : err}`)
    return
  }
  if (!rsp.ok) {
    console.error(`HTTP status ${rsp.status}: ${rsp.statusText}`)
    return
  }
  return (await rsp.json()) as T
}

export function fetchInit(): Promise<InitRsp | undefined> {
  return getJson<InitRsp>(Endpoint.Init)
}

export function fetchMove(req: MoveReq): Promise<MoveRsp | undefined> {
  return postJson<MoveReq, MoveRsp>(Endpoint.Move, req)
}

export function fetchLeave(): Promise<Response> {
  // Fire-and-forget on page unload; keepalive lets it survive navigation.
  return fetch(Endpoint.Leave, {method: 'POST', keepalive: true})
}

export function fetchScore(req: ScoreReq): Promise<ScoreRsp | undefined> {
  return postJson<ScoreReq, ScoreRsp>(Endpoint.Score, req)
}

export function fetchFire(req: FireReq): Promise<FireRsp | undefined> {
  return postJson<FireReq, FireRsp>(Endpoint.Fire, req)
}

export function fetchLeaderboard(): Promise<LeaderboardRsp | undefined> {
  return getJson<LeaderboardRsp>(Endpoint.Leaderboard)
}
