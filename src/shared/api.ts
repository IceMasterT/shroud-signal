/** Generic error detail for all responses. */
export type ErrorRsp = {error: string; status: number}

/** The current counter state for this post. */
export type GetCounterRsp = {count: number}

/** Increment the post counter by a signed amount. */
export type IncCounterReq = {amount: number}
export type IncCounterRsp = {count: number}

// ── Shroud Signal: shared sector gameplay ──────────────────────────────────

/** The five Mentaverse starter ship lines. */
export type ShipLine =
  | 'fighter'
  | 'miner'
  | 'transport'
  | 'pathfinder'
  | 'tender'
export const SHIP_LINES: readonly ShipLine[] = [
  'fighter',
  'miner',
  'transport',
  'pathfinder',
  'tender',
]

/** Weapon range in world units — shared so the client's laser visual matches the server's hit-detection cone. */
export const WEAPON_RANGE = 260
/** Minimum time between shots, enforced authoritatively server-side (client also gates on this for feel). */
export const FIRE_COOLDOWN_MS = 350

/** A player's live state within one sector (post). */
export type PlayerState = {
  userId: string
  username: string
  snoovatar: string | null
  line: ShipLine
  x: number
  y: number
  rotation: number
  hull: number
  score: number
  lastFiredAt: number
}

/** Sent once on load: your own state, plus everyone else currently present. */
export type InitRsp = {
  postId: string
  channel: string
  player: PlayerState
  others: PlayerState[]
}

/** Sent frequently (throttled client-side) as the player flies around. */
export type MoveReq = {x: number; y: number; rotation: number}
export type MoveRsp = {ok: true}

/**
 * Fire the ship's weapon. No client-supplied geometry — the server fires
 * from the shooter's own authoritative last-known position/facing so a
 * client can't claim to be somewhere it isn't to snipe out of range.
 */
export type FireReq = Record<string, never>
export type FireRsp = {ok: true}

/** Broadcast on the realtime channel to every connected client in the sector. */
export type RealtimeMsg =
  | {type: 'join'; player: PlayerState}
  | {type: 'move'; player: PlayerState}
  | {type: 'leave'; userId: string}
  | {type: 'score'; userId: string; score: number}
  | {type: 'pulse'; text: string}
  | {type: 'shot'; userId: string; x: number; y: number; rotation: number}
  | {type: 'hit'; targetUserId: string; shooterUserId: string; hull: number}
  | {type: 'respawn'; player: PlayerState}

/** Top pilots for the current subreddit, by score. */
export type LeaderboardEntry = {username: string; score: number}
export type LeaderboardRsp = {entries: LeaderboardEntry[]}

/** Increment the caller's score (e.g. after a scripted action) by a signed amount. */
export type ScoreReq = {amount: number}
export type ScoreRsp = {score: number}

export type Endpoint = (typeof Endpoint)[keyof typeof Endpoint]
export const Endpoint = {
  GetCounter: 'api/counter',
  IncCounter: 'api/counter/inc',
  Init: 'api/init',
  Move: 'api/move',
  Leave: 'api/leave',
  Score: 'api/score',
  Fire: 'api/fire',
  Leaderboard: 'api/leaderboard',
  OnAppInstall: 'internal/on/app/install',
  OnMenuNewPost: 'internal/on/menu/new-post',
  OnGalaxyPulse: 'internal/on/tick/pulse',
} as const

export const EndpointMethod = {
  [Endpoint.GetCounter]: 'GET',
  [Endpoint.IncCounter]: 'POST',
  [Endpoint.Init]: 'GET',
  [Endpoint.Move]: 'POST',
  [Endpoint.Leave]: 'POST',
  [Endpoint.Score]: 'POST',
  [Endpoint.Fire]: 'POST',
  [Endpoint.Leaderboard]: 'GET',
  [Endpoint.OnAppInstall]: 'POST',
  [Endpoint.OnMenuNewPost]: 'POST',
  [Endpoint.OnGalaxyPulse]: 'POST',
} as const satisfies {[endpoint: string]: 'GET' | 'POST'}
