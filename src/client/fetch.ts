import {
  type ChallengeStateRsp,
  type CreateChallengeReq,
  type CreateChallengeRsp,
  Endpoint,
  type ErrorRsp,
  type FireReq,
  type FireRsp,
  type GetCounterRsp,
  type IncCounterReq,
  type IncCounterRsp,
  type InitRsp,
  type JoinMatchRsp,
  type LeaderboardRsp,
  type MatchStateRsp,
  type MoveReq,
  type MoveRsp,
  type RespondChallengeReq,
  type RespondChallengeRsp,
  type ScoreReq,
  type ScoreRsp,
} from '../shared/api.ts'

export function isErrorRsp(x: unknown): x is ErrorRsp {
  return typeof x === 'object' && x !== null && 'error' in x
}

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

/** Reads the JSON body regardless of HTTP status, so callers can show the server's error reason. */
async function postJsonOrError<Req, T>(
  endpoint: string,
  req: Req,
): Promise<T | ErrorRsp> {
  let rsp: Response
  try {
    rsp = await fetch(endpoint, {
      method: 'POST',
      headers: {Accept: 'application/json', 'Content-Type': 'application/json'},
      body: JSON.stringify(req),
    })
  } catch (err) {
    return {
      error: `HTTP error: ${err instanceof Error ? err.message : err}`,
      status: 0,
    }
  }
  try {
    return (await rsp.json()) as T | ErrorRsp
  } catch {
    return {error: 'invalid response', status: rsp.status}
  }
}

async function getJsonOrError<T>(endpoint: string): Promise<T | ErrorRsp> {
  let rsp: Response
  try {
    rsp = await fetch(endpoint, {headers: {Accept: 'application/json'}})
  } catch (err) {
    return {
      error: `HTTP error: ${err instanceof Error ? err.message : err}`,
      status: 0,
    }
  }
  try {
    return (await rsp.json()) as T | ErrorRsp
  } catch {
    return {error: 'invalid response', status: rsp.status}
  }
}

export function fetchChallengeCreate(
  req: CreateChallengeReq,
): Promise<CreateChallengeRsp | ErrorRsp> {
  return postJsonOrError<CreateChallengeReq, CreateChallengeRsp>(
    Endpoint.ChallengeCreate,
    req,
  )
}

export function fetchChallengeRespond(
  req: RespondChallengeReq,
): Promise<RespondChallengeRsp | ErrorRsp> {
  return postJsonOrError<RespondChallengeReq, RespondChallengeRsp>(
    Endpoint.ChallengeRespond,
    req,
  )
}

export function fetchChallengeState(): Promise<ChallengeStateRsp | ErrorRsp> {
  return getJsonOrError<ChallengeStateRsp>(Endpoint.ChallengeState)
}

export function fetchMatchJoin(): Promise<JoinMatchRsp | ErrorRsp> {
  return postJsonOrError<Record<string, never>, JoinMatchRsp>(
    Endpoint.MatchJoin,
    {},
  )
}

export function fetchMatchState(): Promise<MatchStateRsp | ErrorRsp> {
  return getJsonOrError<MatchStateRsp>(Endpoint.MatchState)
}
