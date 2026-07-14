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

/**
 * Weapon tuning, shared so the client's visuals (beam length, torpedo travel
 * time/speed) match the server's authoritative hit-detection exactly.
 */
export const LASER_RANGE = 420
export const LASER_COOLDOWN_MS = 350
export const TORPEDO_RANGE = 640
export const TORPEDO_SPEED = 480 // world units/sec
export const TORPEDO_COOLDOWN_MS = 1400

export type WeaponMode = 'laser' | 'torpedo'

/** A player's live state within one sector (post). `team` is only set in a match arena. */
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
  lastLaserAt: number
  lastTorpedoAt: number
  team: Team | null
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
 * client can't claim to be somewhere it isn't to snipe out of range. `mode`
 * is not geometry, just which weapon, so it's safe to trust as-is.
 */
export type FireReq = {mode: WeaponMode}
export type FireRsp = {ok: true}

/** Broadcast on the realtime channel to every connected client in the sector. */
export type RealtimeMsg =
  | {type: 'join'; player: PlayerState}
  | {type: 'move'; player: PlayerState}
  | {type: 'leave'; userId: string}
  | {type: 'score'; userId: string; score: number}
  | {type: 'pulse'; text: string}
  | {
      type: 'shot'
      userId: string
      x: number
      y: number
      rotation: number
      mode: WeaponMode
      travelMs: number
    }
  | {type: 'hit'; targetUserId: string; shooterUserId: string; hull: number}
  | {type: 'miss'; x: number; y: number}
  | {type: 'respawn'; player: PlayerState}

/** Top pilots for the current subreddit, by score. */
export type LeaderboardEntry = {username: string; score: number}
export type LeaderboardRsp = {entries: LeaderboardEntry[]}

/** Increment the caller's score (e.g. after a scripted action) by a signed amount. */
export type ScoreReq = {amount: number}
export type ScoreRsp = {score: number}

// ── Shroud Signal: subreddit vs subreddit battles ───────────────────────────

export type Team = 'A' | 'B'

/** postData.kind tags what a given post is, read via context.postData on both client and server. */
export type PostKind =
  | {kind: 'sector'}
  | {kind: 'challenge-setup'}
  | {kind: 'challenge'; challengeId: string; role: 'challenger' | 'target'}
  | {kind: 'match-arena'; matchId: string; side: Team}

export type ChallengeStatus =
  | 'pending'
  | 'countered'
  | 'accepted'
  | 'declined'
  | 'cancelled'

/** playerCap is per team, not combined. warmupMinutes bounds the warm-up join window. */
export type Challenge = {
  challengeId: string
  challengerPostId: string
  targetPostId: string | null
  challengerSubredditId: string
  challengerSubredditName: string
  targetSubredditName: string
  playerCap: number
  warmupMinutes: number
  counterPlayerCap: number | null
  counterWarmupMinutes: number | null
  status: ChallengeStatus
  createdAt: number
  matchId: string | null
  arenaUrlA: string | null
  arenaUrlB: string | null
}

export type CreateChallengeReq = {
  targetSubredditName: string
  playerCap: number
  warmupMinutes: number
}
export type CreateChallengeRsp = {challengeId: string}

export type ChallengeAction =
  | 'accept'
  | 'counter'
  | 'accept-counter'
  | 'decline'
export type RespondChallengeReq = {
  challengeId: string
  action: ChallengeAction
  playerCap?: number
  warmupMinutes?: number
}
/** `challengeStatus`, not `status` — the latter is reserved by the router for the HTTP status code. */
export type RespondChallengeRsp = {
  challengeStatus: ChallengeStatus
  matchId: string | null
}

export type ChallengeStateRsp = {challenge: Challenge}

export type MatchStatus =
  | 'warmup'
  | 'round_active'
  | 'round_result'
  | 'complete'

/** Shared by client and server so both agree on the realtime channel name for a match. */
export function matchChannel(matchId: string): string {
  return `match:${matchId}`
}

export type Match = {
  matchId: string
  arenaPostIdA: string
  arenaPostIdB: string
  arenaUrlA: string
  arenaUrlB: string
  subredditAName: string
  subredditBName: string
  playerCap: number
  warmupMinutes: number
  status: MatchStatus
  round: number
  roundWinsA: number
  roundWinsB: number
  survivalMsA: number
  survivalMsB: number
  warmupEndsAt: number
  roundStartedAt: number
  roundEndsAt: number
  roundResultAt: number
  lastRoundWinner: Team | 'tie' | null
  winner: Team | 'tie' | null
}

export type MatchStateRsp = {
  match: Match
  self: PlayerState | null
  rosterA: PlayerState[]
  rosterB: PlayerState[]
}
export type JoinMatchRsp = {ok: true}

/** Broadcast on a match's own realtime channel (`match:{matchId}`), separate from a free-play sector's channel. */
export type MatchMsg =
  | {type: 'roster'; player: PlayerState}
  | {type: 'round_start'; round: number}
  | {type: 'move'; player: PlayerState}
  | {
      type: 'shot'
      userId: string
      x: number
      y: number
      rotation: number
      mode: WeaponMode
      travelMs: number
    }
  | {type: 'hit'; targetUserId: string; shooterUserId: string; hull: number}
  | {type: 'miss'; x: number; y: number}
  | {type: 'eliminated'; userId: string; team: Team}
  | {
      type: 'round_end'
      winner: Team | 'tie'
      roundWinsA: number
      roundWinsB: number
    }
  | {type: 'match_end'; winner: Team | 'tie'}

export const ROUND_MAX_MS = 5 * 60 * 1000
export const ROUND_RESULT_DISPLAY_MS = 8000
export const MATCH_ROUNDS_TO_WIN = 2

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
  ChallengeCreate: 'api/challenge/create',
  ChallengeRespond: 'api/challenge/respond',
  ChallengeState: 'api/challenge/state',
  MatchJoin: 'api/match/join',
  MatchState: 'api/match/state',
  OnAppInstall: 'internal/on/app/install',
  OnMenuNewPost: 'internal/on/menu/new-post',
  OnMenuNewChallenge: 'internal/on/menu/new-challenge',
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
  [Endpoint.ChallengeCreate]: 'POST',
  [Endpoint.ChallengeRespond]: 'POST',
  [Endpoint.ChallengeState]: 'GET',
  [Endpoint.MatchJoin]: 'POST',
  [Endpoint.MatchState]: 'GET',
  [Endpoint.OnAppInstall]: 'POST',
  [Endpoint.OnMenuNewPost]: 'POST',
  [Endpoint.OnMenuNewChallenge]: 'POST',
  [Endpoint.OnGalaxyPulse]: 'POST',
} as const satisfies {[endpoint: string]: 'GET' | 'POST'}
