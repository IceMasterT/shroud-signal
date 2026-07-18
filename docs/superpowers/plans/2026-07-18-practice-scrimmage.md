# Practice Scrimmage Mode Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a moderator spin up a single-subreddit "Practice Scrimmage" — members split into Purple/Orange teams and fight a best-of-3 Last One Standing series, entirely independent of the existing cross-subreddit "Challenge a Subreddit" feature.

**Architecture:** A scrimmage reuses the existing `Match` record and its entire round/combat/best-of-3 engine (`src/server/match.ts`) completely unchanged — confirmed safe because the realtime channel is keyed by `matchChannel(matchId)` (`src/shared/api.ts:310`), not by post, so one arena post can host both teams instead of the two-posts-per-subreddit split a cross-subreddit Challenge needs. New surface area is additive: two new `PostKind` variants, two new server functions (`createScrimmage`, `joinScrimmage`), two new endpoints, one new client entry (`scrimmage.ts`, parallel to `challenge.ts`), and scrimmage-aware branches inside the existing `battle.ts`.

**Tech Stack:** TypeScript, Devvit Web (`@devvit/web/server`/`client`), Redis (via Devvit's client), Phaser (client battle scene), `node:test` for unit tests, Biome for lint/format, esbuild for bundling.

## Global Constraints

- Design spec is `docs/superpowers/specs/2026-07-18-practice-scrimmage-design.md` — refer back to it if a task here seems to contradict it.
- `Team` stays `'A'|'B'` in the data model everywhere. Only the scrimmage client UI ever displays "Purple"/"Orange" — via a `teamLabel()` helper, never by renaming the type.
- A scrimmage has exactly one arena post (not one per team). `Match.arenaPostIdA`/`arenaPostIdB` both point at that same post; `arenaUrlA`/`arenaUrlB` are unused by the scrimmage client.
- Round/combat/best-of-3/tie-break logic (`startRound`, `endRound`, `tickMatch`, `decideSeriesWinner`, `survivalCredit`, `joinMatch`, `fireWeaponInMatch`, `movePlayerInMatch`, `activateAbility`) is **never modified** by this plan — every scrimmage function is a new, additive wrapper around it.
- Codebase style: Biome-formatted (single quotes, no semicolons, 2-space indent, trailing commas in multi-line literals). `npm run test` = `test:types && lint && test:unit && build`. Lint uses `--error-on-warnings` — always run the FULL `npm run test`, never just one sub-command, before calling a task done.
- New pure logic (`assignAutoTeam`, `isEligibleToJoin`) lives in `src/server/abilities.ts` alongside `canJoinLine`/`canClaimPresetSlot`, unit-tested with zero Redis mocking, matching this codebase's established pattern.
- This codebase does not unit-test the Redis-backed `match.ts`/`challenge.ts` functions directly (no `match.test.ts` exists) — only their pure-logic building blocks. Follow that precedent: new Redis-backed functions (`createScrimmage`, `joinScrimmage`) get type-checked and manually/E2E-verified, not unit-tested; new pure functions get real `node:test` unit tests.

---

## File Structure

- **Modify** `src/shared/api.ts` — two new `PostKind` variants, `TeamAssignMode`/`JoinPolicy` types, `Match` gains `teamAssignMode`/`joinPolicy`/`whitelist`, `CreateScrimmageReq`/`Rsp`, `ScrimmageJoinReq`/`Rsp`, `MatchStateRsp` gains `spectator`, three new `Endpoint` entries.
- **Modify** `src/server/abilities.ts` — new `assignAutoTeam` and `isEligibleToJoin` pure functions.
- **Modify** `src/server/abilities.test.ts` — their tests.
- **Modify** `src/server/match.ts` — new `createScrimmage`/`joinScrimmage` functions; `createMatch` gains three hardcoded-default fields to satisfy the widened `Match` type.
- **Modify** `src/server/server.ts` — `routeScrimmageCreate`/`routeScrimmageJoin`/`routeMenuNewScrimmage`; broadens `routeMove`/`routeFire`/`routeMatchAbility`/`routeMatchState` to also accept `{kind:'scrimmage'}` posts via a new `matchIdFromKind` helper.
- **Modify** `src/client/fetch.ts` — `fetchScrimmageCreate`/`fetchScrimmageJoin`.
- **Modify** `src/client/battle.ts` — scrimmage boot branch, `isScrimmage`/`isSpectator` state, `teamLabel()` helper, Purple/Orange team picker, spectator scene support.
- **Create** `src/client/scrimmage.ts` — mod setup form (parallel to `src/client/challenge.ts`, much smaller — no accept/counter/decline).
- **Create** `public/scrimmage.html` — entry HTML for the setup post (copy of `public/challenge.html` with title/script swapped).
- **Modify** `devvit.json` — new `scrimmage` post entrypoint, new "Start a Scrimmage" subreddit menu item.
- **Modify** `package.json` — `build:client` gains `src/client/scrimmage.ts`.

---

## Phase 1 — Scrimmage creation, open join, auto-assign

A mod creates a scrimmage (5v5 or 10v10, capped-or-custom squad rule), members open the post and pick a ship, the server auto-balances them onto Purple/Orange, and the existing round engine takes it from there. No manual team pick, no whitelist, no squad presets yet — those are Phases 2-4.

### Task 1: Shared types for scrimmage posts and endpoints

**Files:**
- Modify: `src/shared/api.ts`

**Interfaces:**
- Produces: `PostKind` gains `{kind:'scrimmage-setup'}` and `{kind:'scrimmage'; matchId: string}`; `CreateScrimmageReq = {matchSize: '5v5'|'10v10'; squadRule: SquadRule}`; `CreateScrimmageRsp = {matchId: string; arenaUrl: string}`; `ScrimmageJoinReq = {line: ShipLine}`; `ScrimmageJoinRsp = {team: Team}`; `Endpoint.ScrimmageCreate`, `Endpoint.ScrimmageJoin`, `Endpoint.OnMenuNewScrimmage`.

- [ ] **Step 1: Add the two new `PostKind` variants**

Find in `src/shared/api.ts`:

```typescript
export type PostKind =
  | {kind: 'sector'}
  | {kind: 'challenge-setup'}
  | {kind: 'challenge'; challengeId: string; role: 'challenger' | 'target'}
  | {kind: 'match-arena'; matchId: string; side: Team}
```

Replace with:

```typescript
export type PostKind =
  | {kind: 'sector'}
  | {kind: 'challenge-setup'}
  | {kind: 'challenge'; challengeId: string; role: 'challenger' | 'target'}
  | {kind: 'match-arena'; matchId: string; side: Team}
  | {kind: 'scrimmage-setup'}
  | {kind: 'scrimmage'; matchId: string}
```

- [ ] **Step 2: Add `CreateScrimmageReq`/`Rsp` and `ScrimmageJoinReq`/`Rsp`**

Find:

```typescript
export type MatchStateRsp = {
  match: Match
  self: PlayerState | null
  rosterA: PlayerState[]
  rosterB: PlayerState[]
}
export type JoinMatchReq = {
  line: ShipLine
  mode: 'individual' | 'preset'
  presetId: PresetId | null
}
export type JoinMatchRsp = {ok: true}
export type MatchAbilityReq = Record<string, never>
export type MatchAbilityRsp = {ok: true}
```

Replace with:

```typescript
export type MatchStateRsp = {
  match: Match
  self: PlayerState | null
  rosterA: PlayerState[]
  rosterB: PlayerState[]
}
export type JoinMatchReq = {
  line: ShipLine
  mode: 'individual' | 'preset'
  presetId: PresetId | null
}
export type JoinMatchRsp = {ok: true}
export type MatchAbilityReq = Record<string, never>
export type MatchAbilityRsp = {ok: true}

/**
 * A scrimmage is single-subreddit, mod-configured practice for the
 * cross-subreddit Challenge above — a separate creation/join pipeline that
 * builds a plain `Match` record and reuses its entire round engine unchanged.
 */
export type CreateScrimmageReq = {
  matchSize: '5v5' | '10v10'
  squadRule: SquadRule
}
export type CreateScrimmageRsp = {matchId: string; arenaUrl: string}

export type ScrimmageJoinReq = {line: ShipLine}
export type ScrimmageJoinRsp = {team: Team}
```

- [ ] **Step 3: Add the three new `Endpoint`/`EndpointMethod` entries**

Find:

```typescript
  MatchJoin: 'api/match/join',
  MatchAbility: 'api/match/ability',
  MatchState: 'api/match/state',
  OnAppInstall: 'internal/on/app/install',
  OnMenuNewPost: 'internal/on/menu/new-post',
  OnMenuNewChallenge: 'internal/on/menu/new-challenge',
  OnGalaxyPulse: 'internal/on/tick/pulse',
} as const
```

Replace with:

```typescript
  MatchJoin: 'api/match/join',
  MatchAbility: 'api/match/ability',
  MatchState: 'api/match/state',
  ScrimmageCreate: 'api/scrimmage/create',
  ScrimmageJoin: 'api/scrimmage/join',
  OnAppInstall: 'internal/on/app/install',
  OnMenuNewPost: 'internal/on/menu/new-post',
  OnMenuNewChallenge: 'internal/on/menu/new-challenge',
  OnMenuNewScrimmage: 'internal/on/menu/new-scrimmage',
  OnGalaxyPulse: 'internal/on/tick/pulse',
} as const
```

Find:

```typescript
  [Endpoint.MatchJoin]: 'POST',
  [Endpoint.MatchAbility]: 'POST',
  [Endpoint.MatchState]: 'GET',
  [Endpoint.OnAppInstall]: 'POST',
  [Endpoint.OnMenuNewPost]: 'POST',
  [Endpoint.OnMenuNewChallenge]: 'POST',
  [Endpoint.OnGalaxyPulse]: 'POST',
} as const satisfies {[endpoint: string]: 'GET' | 'POST'}
```

Replace with:

```typescript
  [Endpoint.MatchJoin]: 'POST',
  [Endpoint.MatchAbility]: 'POST',
  [Endpoint.MatchState]: 'GET',
  [Endpoint.ScrimmageCreate]: 'POST',
  [Endpoint.ScrimmageJoin]: 'POST',
  [Endpoint.OnAppInstall]: 'POST',
  [Endpoint.OnMenuNewPost]: 'POST',
  [Endpoint.OnMenuNewChallenge]: 'POST',
  [Endpoint.OnMenuNewScrimmage]: 'POST',
  [Endpoint.OnGalaxyPulse]: 'POST',
} as const satisfies {[endpoint: string]: 'GET' | 'POST'}
```

- [ ] **Step 4: Verify it compiles, with expected errors**

Run: `npm run test:types`
Expected: an error in `src/server/server.ts`'s `route()` function — the `default: endpoint satisfies never` line now fails because three new `Endpoint` values (`ScrimmageCreate`, `ScrimmageJoin`, `OnMenuNewScrimmage`) have no `case` yet. That's expected — fixed in Task 4. Confirm there are no other errors.

- [ ] **Step 5: Commit**

```bash
git add src/shared/api.ts
git commit -m "Add scrimmage PostKind variants, request/response types, and endpoints"
```

---

### Task 2: `assignAutoTeam` pure function

**Files:**
- Modify: `src/server/abilities.ts`
- Modify: `src/server/abilities.test.ts`

**Interfaces:**
- Consumes: `Team`, `PlayerState` from `../shared/api.ts` (already imported in `abilities.ts`)
- Produces: `assignAutoTeam(players: Pick<PlayerState, 'team'>[]): Team`

- [ ] **Step 1: Write the failing tests**

Add to `src/server/abilities.test.ts`, after the `canJoinLine` tests:

```typescript
test('assignAutoTeam picks the team with fewer players', () => {
  assert.equal(assignAutoTeam([]), 'A')
  assert.equal(assignAutoTeam([{team: 'A'}]), 'B')
  assert.equal(assignAutoTeam([{team: 'A'}, {team: 'B'}, {team: 'B'}]), 'A')
})

test('assignAutoTeam breaks ties toward team A', () => {
  assert.equal(
    assignAutoTeam([{team: 'A'}, {team: 'B'}, {team: 'A'}, {team: 'B'}]),
    'A',
  )
})

test('assignAutoTeam ignores unassigned (null-team) players', () => {
  assert.equal(assignAutoTeam([{team: null}, {team: null}]), 'A')
})
```

Add `assignAutoTeam` to the import list at the top of the file:

```typescript
import {
  abilityReady,
  assignAutoTeam,
  canClaimPresetSlot,
  canJoinLine,
  computeDamage,
  maxHullFor,
  mineTriggeredBy,
  nearestAlly,
  survivalCredit,
} from './abilities.ts'
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node --experimental-strip-types --no-warnings=ExperimentalWarning --test src/server/abilities.test.ts`
Expected: FAIL — `assignAutoTeam is not defined` (or a TS error, since it doesn't exist yet).

- [ ] **Step 3: Implement `assignAutoTeam`**

Add to `src/server/abilities.ts`, after `canJoinLine`:

```typescript
/**
 * Auto-balances a new scrimmage joiner onto whichever team currently has
 * fewer players. Ties go to team A — deterministic, not random, so
 * auto-assign stays reproducible for testing and doesn't need a seeded RNG.
 */
export function assignAutoTeam(players: Pick<PlayerState, 'team'>[]): Team {
  const countA = players.filter(p => p.team === 'A').length
  const countB = players.filter(p => p.team === 'B').length
  return countA <= countB ? 'A' : 'B'
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `node --experimental-strip-types --no-warnings=ExperimentalWarning --test src/server/abilities.test.ts`
Expected: PASS, all tests including the three new ones.

- [ ] **Step 5: Commit**

```bash
git add src/server/abilities.ts src/server/abilities.test.ts
git commit -m "Add assignAutoTeam pure function for scrimmage auto team-balancing"
```

---

### Task 3: `createScrimmage` and `joinScrimmage` server functions

**Files:**
- Modify: `src/server/match.ts`

**Interfaces:**
- Consumes: `assignAutoTeam` from `./abilities.ts` (Task 2); `SquadRule`, `SQUAD_RULES` from `../shared/api.ts`
- Produces: `createScrimmage(subredditName: string, matchSize: '5v5'|'10v10', squadRule: SquadRule): Promise<Match>`; `joinScrimmage(matchId: string, userId: string, username: string, snoovatar: string | undefined, line: ShipLine): Promise<{team: Team}>`

- [ ] **Step 1: Import `assignAutoTeam`**

Find in `src/server/match.ts`:

```typescript
import {
  abilityReady,
  canClaimPresetSlot,
  canJoinLine,
  computeDamage,
  type Mine,
  maxHullFor,
  mineTriggeredBy,
  nearestAlly,
  survivalCredit,
} from './abilities.ts'
```

Replace with:

```typescript
import {
  abilityReady,
  assignAutoTeam,
  canClaimPresetSlot,
  canJoinLine,
  computeDamage,
  type Mine,
  maxHullFor,
  mineTriggeredBy,
  nearestAlly,
  survivalCredit,
} from './abilities.ts'
```

- [ ] **Step 2: Add `createScrimmage`**

Add to `src/server/match.ts`, right after `createMatch` (after its closing `}` and before `export async function joinMatch`):

```typescript
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
    joinModeA: 'individual',
    joinModeB: 'individual',
    presetIdA: null,
    presetIdB: null,
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
```

- [ ] **Step 3: Add `joinScrimmage`**

Add right after `joinMatch` (after its closing `}` and before `export async function movePlayerInMatch`):

```typescript
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
): Promise<{team: Team}> {
  const match = await getMatch(matchId)
  if (!match) throw new Error('match not found')
  const players = await getMatchPlayers(matchId)
  const team = assignAutoTeam(players)
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
  return {team: player.team ?? team}
}
```

- [ ] **Step 4: Verify it compiles**

Run: `npm run test:types`
Expected: no new errors from `match.ts` (the `endpoint satisfies never` error from Task 1 is still expected and unrelated).

- [ ] **Step 5: Commit**

```bash
git add src/server/match.ts
git commit -m "Add createScrimmage and joinScrimmage server functions"
```

---

### Task 4: Server routing for scrimmage endpoints

**Files:**
- Modify: `src/server/server.ts`

**Interfaces:**
- Consumes: `createScrimmage`, `joinScrimmage` from `./match.ts` (Task 3); `CreateScrimmageReq`, `CreateScrimmageRsp`, `ScrimmageJoinReq`, `ScrimmageJoinRsp` from `../shared/api.ts` (Task 1)
- Produces: `routeScrimmageCreate`, `routeScrimmageJoin`, `routeMenuNewScrimmage`, `matchIdFromKind(kind: PostKind | undefined): string | undefined`

- [ ] **Step 1: Add the new type imports**

Find:

```typescript
import {
  type ChallengeAction,
  type ChallengeStateRsp,
  type CreateChallengeReq,
  type CreateChallengeRsp,
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
  type SectorJoinReq,
  type SectorJoinRsp,
  SHIP_LINES,
  SQUAD_PRESETS,
  SQUAD_RULES,
  WEAPON_MODES,
} from '../shared/api.ts'
```

Replace with:

```typescript
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
```

- [ ] **Step 2: Import `createScrimmage`/`joinScrimmage`**

Find:

```typescript
import {
  activateAbility,
  fireWeaponInMatch,
  getMatch,
  getMatchPlayers,
  joinMatch,
  movePlayerInMatch,
  tickMatch,
} from './match.ts'
```

Replace with:

```typescript
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
```

- [ ] **Step 3: Widen the `AnyRsp` union**

Find:

```typescript
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
  | UiResponse
  | TriggerResponse
  | ErrorRsp
```

Replace with:

```typescript
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
```

- [ ] **Step 4: Add `matchIdFromKind`, right after `getPostKind`**

Find:

```typescript
/** postData is written exclusively by our own server code (never client-writable), so a light shape check is enough. */
function getPostKind(): PostKind | undefined {
  const data = context.postData
  if (!data || typeof data.kind !== 'string') return undefined
  return data as unknown as PostKind
}
```

Replace with:

```typescript
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
```

- [ ] **Step 5: Add the two new `case`s and the `OnMenuNewScrimmage` case to `route()`**

Find:

```typescript
      case Endpoint.MatchState:
        rsp = await routeMatchState()
        break
      case Endpoint.OnMenuNewPost:
        rsp = await routeMenuNewPost()
        break
      case Endpoint.OnMenuNewChallenge:
        rsp = await routeMenuNewChallenge()
        break
```

Replace with:

```typescript
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
```

- [ ] **Step 6: Broaden `routeMove` and `routeFire` to accept scrimmage posts**

Find:

```typescript
  const kind = getPostKind()
  if (kind?.kind === 'match-arena') {
    await movePlayerInMatch(kind.matchId, userId, req.x, req.y, req.rotation)
  } else {
    await movePlayer(postId, userId, req.x, req.y, req.rotation)
  }
  return {ok: true}
}
```

Replace with:

```typescript
  const kind = getPostKind()
  const matchId = matchIdFromKind(kind)
  if (matchId) {
    await movePlayerInMatch(matchId, userId, req.x, req.y, req.rotation)
  } else {
    await movePlayer(postId, userId, req.x, req.y, req.rotation)
  }
  return {ok: true}
}
```

Find:

```typescript
  const kind = getPostKind()
  if (kind?.kind === 'match-arena') {
    await fireWeaponInMatch(kind.matchId, userId, req.mode)
  } else {
```

Replace with:

```typescript
  const kind = getPostKind()
  const matchId = matchIdFromKind(kind)
  if (matchId) {
    await fireWeaponInMatch(matchId, userId, req.mode)
  } else {
```

- [ ] **Step 7: Broaden `routeMatchAbility` and `routeMatchState`**

Find:

```typescript
async function routeMatchAbility(): Promise<MatchAbilityRsp | ErrorRsp> {
  const userId = context.userId
  if (!userId) return {error: 'must be logged in', status: 401}
  const kind = getPostKind()
  if (kind?.kind !== 'match-arena')
    return {error: 'not a match arena post', status: 400}
  try {
    await activateAbility(kind.matchId, userId)
    return {ok: true}
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    return {error: msg, status: 400}
  }
}

async function routeMatchState(): Promise<MatchStateRsp | ErrorRsp> {
  const userId = context.userId
  const kind = getPostKind()
  if (kind?.kind !== 'match-arena')
    return {error: 'not a match arena post', status: 400}
  let match = await getMatch(kind.matchId)
  if (!match) return {error: 'match not found', status: 404}
  match = await tickMatch(match)
  const players = await getMatchPlayers(kind.matchId)
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
```

Replace with:

```typescript
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
```

- [ ] **Step 8: Add `routeScrimmageCreate`, `routeScrimmageJoin`, and `routeMenuNewScrimmage`**

Add right after `routeMatchState` (before `routeGalaxyPulse`):

```typescript
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
  const match = await createScrimmage(
    subredditName,
    req.matchSize,
    req.squadRule,
  )
  return {matchId: match.matchId, arenaUrl: match.arenaUrlA}
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
```

Add right after `routeMenuNewChallenge`:

```typescript
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
```

- [ ] **Step 9: Verify it compiles and existing tests still pass**

Run: `npm run test:types && npm run lint && npm run test:unit`
Expected: all pass — the `endpoint satisfies never` error from Task 1 is now resolved, `server.test.ts`'s existing tests are unaffected.

- [ ] **Step 10: Commit**

```bash
git add src/server/server.ts
git commit -m "Add scrimmage create/join routes and broaden match routes to accept scrimmage posts"
```

---

### Task 5: `devvit.json` — new entrypoint and menu item

**Files:**
- Modify: `devvit.json`

- [ ] **Step 1: Add the `scrimmage` post entrypoint**

Find:

```json
  "post": {
    "entrypoints": {
      "default": {
        "entry": "splash.html"
      },
      "game": {
        "entry": "game.html"
      },
      "challenge": {
        "entry": "challenge.html"
      },
      "battle": {
        "entry": "battle.html"
      }
    }
  },
```

Replace with:

```json
  "post": {
    "entrypoints": {
      "default": {
        "entry": "splash.html"
      },
      "game": {
        "entry": "game.html"
      },
      "challenge": {
        "entry": "challenge.html"
      },
      "battle": {
        "entry": "battle.html"
      },
      "scrimmage": {
        "entry": "scrimmage.html"
      }
    }
  },
```

- [ ] **Step 2: Add the "Start a Scrimmage" menu item**

Find:

```json
  "menu": {
    "items": [
      {
        "label": "Chart a New Sector",
        "description": "Establish a new Shroud Signal sector post in this subreddit.",
        "location": "subreddit",
        "endpoint": "/internal/on/menu/new-post"
      },
      {
        "label": "Challenge a Subreddit",
        "description": "Challenge another subreddit to a Last One Standing battle.",
        "location": "subreddit",
        "endpoint": "/internal/on/menu/new-challenge"
      }
    ]
  },
```

Replace with:

```json
  "menu": {
    "items": [
      {
        "label": "Chart a New Sector",
        "description": "Establish a new Shroud Signal sector post in this subreddit.",
        "location": "subreddit",
        "endpoint": "/internal/on/menu/new-post"
      },
      {
        "label": "Challenge a Subreddit",
        "description": "Challenge another subreddit to a Last One Standing battle.",
        "location": "subreddit",
        "endpoint": "/internal/on/menu/new-challenge"
      },
      {
        "label": "Start a Scrimmage",
        "description": "Set up a local practice battle for members of this subreddit.",
        "location": "subreddit",
        "endpoint": "/internal/on/menu/new-scrimmage"
      }
    ]
  },
```

- [ ] **Step 3: Commit**

```bash
git add devvit.json
git commit -m "Add scrimmage post entrypoint and Start a Scrimmage menu item"
```

---

### Task 6: `public/scrimmage.html`

**Files:**
- Create: `public/scrimmage.html`

- [ ] **Step 1: Create the file as a copy of `public/challenge.html` with the title and script swapped**

```html
<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <title>Shroud Signal Scrimmage</title>
    <link rel="modulepreload" href="scrimmage.js">
    <style>
    body {
      margin: 0;
      min-height: 100dvh;
      background: #05070c;
      color: #eef6ff;
      font-family: monospace;
      display: grid;
      place-items: center;
      box-sizing: border-box;
      padding: 2rem 1rem;
    }
    #root {
      width: 100%;
      max-width: 480px;
    }
    .panel {
      background: #0b0f16;
      border: 1px solid #2a3444;
      border-radius: 6px;
      padding: 1.5rem;
      display: grid;
      gap: 0.9rem;
      text-align: center;
    }
    h1 {
      font-size: 15px;
      letter-spacing: 0.08em;
      text-transform: uppercase;
      color: #ff9500;
      margin: 0;
    }
    p {
      font-size: 13px;
      line-height: 1.5;
      color: #cdd8e6;
      margin: 0;
    }
    .stat {
      color: #ff9500;
    }
    button {
      font-family: monospace;
      font-size: 13px;
      letter-spacing: 0.06em;
      text-transform: uppercase;
      color: #eef6ff;
      background: rgba(20, 26, 40, 0.75);
      border: 1px solid #ff9500;
      border-radius: 4px;
      padding: 0.7rem 1.2rem;
      cursor: pointer;
    }
    button:hover {
      background: rgba(255, 149, 0, 0.18);
    }
    button.secondary {
      border-color: #446688;
    }
    .row {
      display: flex;
      gap: 0.6rem;
      justify-content: center;
      flex-wrap: wrap;
    }
    .error {
      color: #ff5566;
    }
    a.enter {
      display: inline-block;
      text-decoration: none;
    }
    </style>
  </head>
  <body>
    <div id="root">
      <div class="panel"><p>Loading…</p></div>
    </div>
    <script src="scrimmage.js" type="module"></script>
  </body>
</html>
```

- [ ] **Step 2: Commit**

```bash
git add public/scrimmage.html
git commit -m "Add scrimmage.html entry"
```

---

### Task 7: `src/client/fetch.ts` — scrimmage fetch wrappers

**Files:**
- Modify: `src/client/fetch.ts`

**Interfaces:**
- Consumes: `CreateScrimmageReq`, `CreateScrimmageRsp`, `ScrimmageJoinReq`, `ScrimmageJoinRsp` from `../shared/api.ts` (Task 1)
- Produces: `fetchScrimmageCreate(req: CreateScrimmageReq): Promise<CreateScrimmageRsp | ErrorRsp>`, `fetchScrimmageJoin(req: ScrimmageJoinReq): Promise<ScrimmageJoinRsp | ErrorRsp>`

- [ ] **Step 1: Add the type imports**

Find:

```typescript
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
  type JoinMatchReq,
  type JoinMatchRsp,
  type LeaderboardRsp,
  type MatchAbilityReq,
  type MatchAbilityRsp,
  type MatchStateRsp,
  type MoveReq,
  type MoveRsp,
  type RespondChallengeReq,
  type RespondChallengeRsp,
  type ScoreReq,
  type ScoreRsp,
  type SectorJoinReq,
  type SectorJoinRsp,
} from '../shared/api.ts'
```

Replace with:

```typescript
import {
  type ChallengeStateRsp,
  type CreateChallengeReq,
  type CreateChallengeRsp,
  type CreateScrimmageReq,
  type CreateScrimmageRsp,
  Endpoint,
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
  type MatchAbilityReq,
  type MatchAbilityRsp,
  type MatchStateRsp,
  type MoveReq,
  type MoveRsp,
  type RespondChallengeReq,
  type RespondChallengeRsp,
  type ScoreReq,
  type ScoreRsp,
  type ScrimmageJoinReq,
  type ScrimmageJoinRsp,
  type SectorJoinReq,
  type SectorJoinRsp,
} from '../shared/api.ts'
```

- [ ] **Step 2: Add the two fetch wrappers**

Find:

```typescript
export function fetchMatchState(): Promise<MatchStateRsp | ErrorRsp> {
  return getJsonOrError<MatchStateRsp>(Endpoint.MatchState)
}
```

Replace with:

```typescript
export function fetchMatchState(): Promise<MatchStateRsp | ErrorRsp> {
  return getJsonOrError<MatchStateRsp>(Endpoint.MatchState)
}

export function fetchScrimmageCreate(
  req: CreateScrimmageReq,
): Promise<CreateScrimmageRsp | ErrorRsp> {
  return postJsonOrError<CreateScrimmageReq, CreateScrimmageRsp>(
    Endpoint.ScrimmageCreate,
    req,
  )
}

export function fetchScrimmageJoin(
  req: ScrimmageJoinReq,
): Promise<ScrimmageJoinRsp | ErrorRsp> {
  return postJsonOrError<ScrimmageJoinReq, ScrimmageJoinRsp>(
    Endpoint.ScrimmageJoin,
    req,
  )
}
```

- [ ] **Step 3: Verify it compiles**

Run: `npm run test:types`
Expected: no errors.

- [ ] **Step 4: Commit**

```bash
git add src/client/fetch.ts
git commit -m "Add fetchScrimmageCreate and fetchScrimmageJoin"
```

---

### Task 8: `src/client/scrimmage.ts` — mod setup form

**Files:**
- Create: `src/client/scrimmage.ts`
- Modify: `package.json`

**Interfaces:**
- Consumes: `fetchScrimmageCreate`, `isErrorRsp` from `./fetch.ts` (Task 7)

- [ ] **Step 1: Create `src/client/scrimmage.ts`**

```typescript
import {showForm} from '@devvit/web/client'
import {fetchScrimmageCreate, isErrorRsp} from './fetch.ts'

const rootEl = document.getElementById('root')
if (!rootEl) throw new Error('missing #root')
const root: HTMLElement = rootEl

function render(html: string): void {
  root.innerHTML = html
}

function escapeHtml(s: string): string {
  return s.replace(
    /[&<>"']/g,
    c =>
      ({'&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'})[
        c
      ] ?? c,
  )
}

async function runSetup(): Promise<void> {
  render('<div class="panel"><p>Setting up your scrimmage…</p></div>')
  const result = await showForm({
    title: 'Start a Scrimmage',
    fields: [
      {
        type: 'select',
        name: 'matchSize',
        label: 'Match size',
        options: [
          {label: '5v5', value: '5v5'},
          {label: '10v10', value: '10v10'},
        ],
        defaultValue: ['5v5'],
      },
      {
        type: 'boolean',
        name: 'customSquadRule',
        label: 'Custom squad rule (no 2-per-line cap)',
        defaultValue: false,
      },
    ],
  })
  if (result.action !== 'SUBMITTED') {
    render(
      '<div class="panel"><p>Scrimmage setup cancelled.</p><button id="retry">Try again</button></div>',
    )
    document
      .getElementById('retry')
      ?.addEventListener('click', () => void runSetup())
    return
  }
  const matchSize = result.values.matchSize?.[0] === '10v10' ? '10v10' : '5v5'
  const rsp = await fetchScrimmageCreate({
    matchSize,
    squadRule: result.values.customSquadRule ? 'custom' : 'capped',
  })
  if (isErrorRsp(rsp)) {
    render(
      `<div class="panel"><p class="error">${escapeHtml(rsp.error)}</p><button id="retry">Try again</button></div>`,
    )
    document
      .getElementById('retry')
      ?.addEventListener('click', () => void runSetup())
    return
  }
  render(`
    <div class="panel">
      <h1>Scrimmage created!</h1>
      <p>Purple vs Orange, <span class="stat">${escapeHtml(matchSize)}</span>.</p>
      <a class="enter" href="${escapeHtml(rsp.arenaUrl)}"><button>Enter the arena</button></a>
    </div>
  `)
}

void runSetup()
```

- [ ] **Step 2: Add `src/client/scrimmage.ts` to the `build:client` esbuild entry list**

Find in `package.json`:

```json
    "build:client": "esbuild --bundle --log-level=warning --sourcemap=linked --target=es2023 --format=esm --outdir=public --platform=browser src/client/splash.ts src/client/game.ts src/client/challenge.ts src/client/battle.ts",
```

Replace with:

```json
    "build:client": "esbuild --bundle --log-level=warning --sourcemap=linked --target=es2023 --format=esm --outdir=public --platform=browser src/client/splash.ts src/client/game.ts src/client/challenge.ts src/client/battle.ts src/client/scrimmage.ts",
```

- [ ] **Step 3: Verify it builds**

Run: `npm run build:client`
Expected: succeeds, and `public/scrimmage.js` now exists.

- [ ] **Step 4: Commit**

```bash
git add src/client/scrimmage.ts package.json
git commit -m "Add scrimmage setup client and wire it into the client build"
```

---

### Task 9: `src/client/battle.ts` — scrimmage support and Purple/Orange labels

**Files:**
- Modify: `src/client/battle.ts`

**Interfaces:**
- Consumes: `fetchScrimmageJoin` from `./fetch.ts` (Task 7)
- Produces: module-level `isScrimmage: boolean`; `teamLabel(team: Team, scrimmage: boolean): string`; `BattleScene.isScrimmage: boolean`

- [ ] **Step 1: Import `fetchScrimmageJoin`**

Find:

```typescript
import {
  fetchFire,
  fetchMatchAbility,
  fetchMatchJoin,
  fetchMatchState,
  fetchMove,
  isErrorRsp,
} from './fetch.ts'
```

Replace with:

```typescript
import {
  fetchFire,
  fetchMatchAbility,
  fetchMatchJoin,
  fetchMatchState,
  fetchMove,
  fetchScrimmageJoin,
  isErrorRsp,
} from './fetch.ts'
```

- [ ] **Step 2: Add the `teamLabel` helper**

Find:

```typescript
function getKind(): PostKind | undefined {
  const data = context.postData
  if (!data || typeof data.kind !== 'string') return undefined
  return data as unknown as PostKind
}
```

Replace with:

```typescript
function getKind(): PostKind | undefined {
  const data = context.postData
  if (!data || typeof data.kind !== 'string') return undefined
  return data as unknown as PostKind
}

/** Scrimmages display Purple/Orange instead of Team A/B — a display-only relabeling, `Team` itself always stays 'A'|'B'. */
function teamLabel(team: Team, scrimmage: boolean): string {
  if (!scrimmage) return team
  return team === 'A' ? 'Purple' : 'Orange'
}
```

- [ ] **Step 3: Add `isScrimmage` to `BattleScene` and use it in `spawnRemote`/`updateHud`**

Find:

```typescript
class BattleScene extends Phaser.Scene {
  ship: Phaser.GameObjects.Image | null = null
  velX = 0
  velY = 0
```

Replace with:

```typescript
class BattleScene extends Phaser.Scene {
  isScrimmage = false
  ship: Phaser.GameObjects.Image | null = null
  velX = 0
  velY = 0
```

Find:

```typescript
    const label = this.add
      .text(0, 30, `${p.username} · ${p.team}`, {
        fontFamily: 'monospace',
        fontSize: '10px',
        color: '#9fb4c9',
      })
      .setOrigin(0.5, 0)
```

Replace with:

```typescript
    const label = this.add
      .text(0, 30, `${p.username} · ${teamLabel(p.team, this.isScrimmage)}`, {
        fontFamily: 'monospace',
        fontSize: '10px',
        color: '#9fb4c9',
      })
      .setOrigin(0.5, 0)
```

Find:

```typescript
  updateHud(): void {
    if (!this.self) return
    const alive = [...this.others.values()].filter(r => !r.eliminated)
    const aliveA =
      (this.self.team === 'A' ? 1 : 0) +
      alive.filter(r => r.team === 'A').length
    const aliveB =
      (this.self.team === 'B' ? 1 : 0) +
      alive.filter(r => r.team === 'B').length
    this.hudTop.setText(
      `TEAM ${this.self.team}  ·  A ${aliveA} vs B ${aliveB} remaining`,
    )
    this.hudBottom.setText(
      `${this.self.username}  ·  ${SHIP_LABEL[this.self.line]}  ·  HULL ${this.self.hull}  ·  KILLS ${this.self.kills}${this.selfEliminated ? '  ·  ELIMINATED (spectating)' : ''}`,
    )
  }
```

Replace with:

```typescript
  updateHud(): void {
    const alive = [...this.others.values()].filter(r => !r.eliminated)
    const aliveA =
      (this.self?.team === 'A' ? 1 : 0) +
      alive.filter(r => r.team === 'A').length
    const aliveB =
      (this.self?.team === 'B' ? 1 : 0) +
      alive.filter(r => r.team === 'B').length
    const teamLine = this.self
      ? `TEAM ${teamLabel(this.self.team, this.isScrimmage)}`
      : 'SPECTATING'
    this.hudTop.setText(
      `${teamLine}  ·  ${teamLabel('A', this.isScrimmage)} ${aliveA} vs ${teamLabel('B', this.isScrimmage)} ${aliveB} remaining`,
    )
    this.hudBottom.setText(
      this.self
        ? `${this.self.username}  ·  ${SHIP_LABEL[this.self.line]}  ·  HULL ${this.self.hull}  ·  KILLS ${this.self.kills}${this.selfEliminated ? '  ·  ELIMINATED (spectating)' : ''}`
        : 'Spectator view',
    )
  }
```

(The `this.self` guard is dropped here — Phase 3 adds a spectator path where `self` is always `null`, and `updateHud` needs to work for that from the start. `this.self` is already typed `PlayerState | null`, so this is a genuine null-safety improvement, not a Phase-3-only concern — it also makes `updateHud` safely callable before `spawnSelf` ever runs.)

- [ ] **Step 4: Add `isScrimmage` module state and set it in `boot()`**

Find:

```typescript
let scene: BattleScene | null = null
let lastRound = 0
let mySide: Team = 'A'
```

Replace with:

```typescript
let scene: BattleScene | null = null
let lastRound = 0
let mySide: Team = 'A'
let isScrimmage = false
```

Find:

```typescript
async function boot(): Promise<void> {
  const kind = getKind()
  if (kind?.kind !== 'match-arena') {
    showOverlay('<div class="panel"><p>Nothing to see here.</p></div>')
    return
  }
  mySide = kind.side
```

Replace with:

```typescript
async function boot(): Promise<void> {
  const kind = getKind()
  if (kind?.kind !== 'match-arena' && kind?.kind !== 'scrimmage') {
    showOverlay('<div class="panel"><p>Nothing to see here.</p></div>')
    return
  }
  isScrimmage = kind.kind === 'scrimmage'
  if (kind.kind === 'match-arena') mySide = kind.side
```

- [ ] **Step 5: Set `scene.isScrimmage` once the scene is ready**

Find:

```typescript
  game.events.once('ready', () => {
    scene = game.scene.getScene('battle') as BattleScene
  })
```

Replace with:

```typescript
  game.events.once('ready', () => {
    scene = game.scene.getScene('battle') as BattleScene
    scene.isScrimmage = isScrimmage
  })
```

- [ ] **Step 6: Add a scrimmage join function and warmup-panel branch**

Find:

```typescript
async function joinBattle(
  line: PlayerState['line'],
  mode: 'individual' | 'preset',
  presetId: PresetId | null,
): Promise<void> {
  const rsp = await fetchMatchJoin({line, mode, presetId})
  if (isErrorRsp(rsp)) {
    showOverlay(
      `<div class="panel"><p class="error">${escapeHtml(rsp.error)}</p></div>`,
    )
  }
  await poll()
}
```

Replace with:

```typescript
async function joinBattle(
  line: PlayerState['line'],
  mode: 'individual' | 'preset',
  presetId: PresetId | null,
): Promise<void> {
  const rsp = await fetchMatchJoin({line, mode, presetId})
  if (isErrorRsp(rsp)) {
    showOverlay(
      `<div class="panel"><p class="error">${escapeHtml(rsp.error)}</p></div>`,
    )
  }
  await poll()
}

async function joinScrimmageBattle(line: PlayerState['line']): Promise<void> {
  const rsp = await fetchScrimmageJoin({line})
  if (isErrorRsp(rsp)) {
    showOverlay(
      `<div class="panel"><p class="error">${escapeHtml(rsp.error)}</p></div>`,
    )
  }
  await poll()
}
```

- [ ] **Step 7: Use `teamLabel` in the warmup/round-result/complete panels and branch the join-choice UI/click-wiring for scrimmages**

Find:

```typescript
  if (match.status === 'warmup') {
    const secsLeft = Math.max(
      0,
      Math.round((match.warmupEndsAt - Date.now()) / 1000),
    )
    showOverlay(`
      <div class="panel">
        <h1>Last One Standing</h1>
        <p>r/${escapeHtml(match.subredditAName)} vs r/${escapeHtml(match.subredditBName)}</p>
        <p>Warm-up: <span class="stat">${secsLeft}s</span> left, or when both teams are full.</p>
        <div class="rosters">
          <div class="roster">TEAM A<br>${rosterList(rosterA, match.playerCap)}</div>
          <div class="roster">TEAM B<br>${rosterList(rosterB, match.playerCap)}</div>
        </div>
        ${self ? '<p>You are in. Waiting for the round to start…</p>' : renderJoinChoice(match)}
      </div>
    `)
    if (!self) {
      for (const btn of document.querySelectorAll<HTMLButtonElement>(
        '.ship-pick',
      )) {
        btn.addEventListener('click', () => {
          const line = btn.dataset.line as PlayerState['line']
          void joinBattle(line, 'individual', null)
        })
      }
      for (const btn of document.querySelectorAll<HTMLButtonElement>(
        '.preset-pick',
      )) {
        btn.addEventListener('click', () => {
          const presetId = btn.dataset.preset as PresetId
          const slots = SQUAD_PRESETS[presetId].slice(0, match.playerCap)
          const line = slots[0]
          if (line) void joinBattle(line, 'preset', presetId)
        })
      }
    }
    return
  }
```

Replace with:

```typescript
  if (match.status === 'warmup') {
    const secsLeft = Math.max(
      0,
      Math.round((match.warmupEndsAt - Date.now()) / 1000),
    )
    const title = isScrimmage
      ? `Practice Scrimmage · ${escapeHtml(match.subredditAName)}`
      : `r/${escapeHtml(match.subredditAName)} vs r/${escapeHtml(match.subredditBName)}`
    showOverlay(`
      <div class="panel">
        <h1>Last One Standing</h1>
        <p>${title}</p>
        <p>Warm-up: <span class="stat">${secsLeft}s</span> left, or when both teams are full.</p>
        <div class="rosters">
          <div class="roster">${teamLabel('A', isScrimmage).toUpperCase()}<br>${rosterList(rosterA, match.playerCap)}</div>
          <div class="roster">${teamLabel('B', isScrimmage).toUpperCase()}<br>${rosterList(rosterB, match.playerCap)}</div>
        </div>
        ${self ? '<p>You are in. Waiting for the round to start…</p>' : isScrimmage ? `<div class="ship-picker">${shipPickerHtml()}</div>` : renderJoinChoice(match)}
      </div>
    `)
    if (!self) {
      if (isScrimmage) {
        for (const btn of document.querySelectorAll<HTMLButtonElement>(
          '.ship-pick',
        )) {
          btn.addEventListener('click', () => {
            const line = btn.dataset.line as PlayerState['line']
            void joinScrimmageBattle(line)
          })
        }
      } else {
        for (const btn of document.querySelectorAll<HTMLButtonElement>(
          '.ship-pick',
        )) {
          btn.addEventListener('click', () => {
            const line = btn.dataset.line as PlayerState['line']
            void joinBattle(line, 'individual', null)
          })
        }
        for (const btn of document.querySelectorAll<HTMLButtonElement>(
          '.preset-pick',
        )) {
          btn.addEventListener('click', () => {
            const presetId = btn.dataset.preset as PresetId
            const slots = SQUAD_PRESETS[presetId].slice(0, match.playerCap)
            const line = slots[0]
            if (line) void joinBattle(line, 'preset', presetId)
          })
        }
      }
    }
    return
  }
```

(A scrimmage's `joinModeA`/`joinModeB` are always `'individual'` in Phase 1 — Task 3's `createScrimmage` seeds them that way — so going straight to `shipPickerHtml()` for scrimmages, bypassing `renderJoinChoice`'s preset-vs-individual branching entirely, is correct as-is and needs no further condition here.)

- [ ] **Step 8: Update round-result and complete panels to use `teamLabel`**

Find:

```typescript
  if (match.status === 'round_result') {
    const winnerText =
      match.lastRoundWinner === 'tie'
        ? 'Round tied (time limit)'
        : `Team ${match.lastRoundWinner} wins the round`
```

Replace with:

```typescript
  if (match.status === 'round_result') {
    const winnerText =
      match.lastRoundWinner === 'tie'
        ? 'Round tied (time limit)'
        : `Team ${teamLabel(match.lastRoundWinner, isScrimmage)} wins the round`
```

Find:

```typescript
  if (match.status === 'complete') {
    const winnerText =
      match.winner === 'tie'
        ? "It's a tie!"
        : `Team ${match.winner} wins the battle!`
```

Replace with:

```typescript
  if (match.status === 'complete') {
    const winnerText =
      match.winner === 'tie'
        ? "It's a tie!"
        : `Team ${teamLabel(match.winner, isScrimmage)} wins the battle!`
```

- [ ] **Step 9: Update `killsScoreboard` to use `teamLabel`**

Find:

```typescript
function killsScoreboard(
  rosterA: PlayerState[],
  rosterB: PlayerState[],
): string {
  const ranked = [...rosterA, ...rosterB]
    .filter(p => p.kills > 0)
    .sort((a, b) => b.kills - a.kills)
    .slice(0, 5)
  if (ranked.length === 0) return ''
  const rows = ranked
    .map(
      (p, i) =>
        `${i + 1}. ${escapeHtml(p.username)} (${p.team}) — ${p.kills} kill${p.kills === 1 ? '' : 's'}`,
    )
    .join('<br>')
  return `<p><b>TOP KILLS</b><br>${rows}</p>`
}
```

Replace with:

```typescript
function killsScoreboard(
  rosterA: PlayerState[],
  rosterB: PlayerState[],
): string {
  const ranked = [...rosterA, ...rosterB]
    .filter(p => p.kills > 0)
    .sort((a, b) => b.kills - a.kills)
    .slice(0, 5)
  if (ranked.length === 0) return ''
  const rows = ranked
    .map(
      (p, i) =>
        `${i + 1}. ${escapeHtml(p.username)} (${teamLabel(p.team, isScrimmage)}) — ${p.kills} kill${p.kills === 1 ? '' : 's'}`,
    )
    .join('<br>')
  return `<p><b>TOP KILLS</b><br>${rows}</p>`
}
```

- [ ] **Step 10: Verify it compiles, lints, and builds**

Run: `npm run test:types && npm run lint && npm run build:client`
Expected: all pass.

- [ ] **Step 11: Commit**

```bash
git add src/client/battle.ts
git commit -m "Add scrimmage support and Purple/Orange team labels to the battle client"
```

---

### Task 10: Phase 1 manual verification

**Files:** none (verification only)

- [ ] **Step 1: Run the full test suite**

Run: `npm run test`
Expected: `test:types`, `lint`, `test:unit`, and `build` all pass.

- [ ] **Step 2: Manual smoke test via local playtest**

Following this codebase's established verification pattern (local mock via a static server + Playwright, or `devvit playtest` against the dev subreddit — whichever this session already has set up):

1. Trigger "Start a Scrimmage" from the subreddit menu. Fill the form (5v5, capped squad rule). Submit.
2. Confirm a new arena post is created and the setup panel shows an "Enter the arena" link.
3. Open the arena post as at least two different logged-in test users. Confirm both see a ship picker with no preset option (Phase 1 has none).
4. Join as user 1: confirm the roster panel shows them under "PURPLE" or "ORANGE" (not "TEAM A"/"TEAM B").
5. Join as user 2 with a different line: confirm they land on the *other* team (auto-balance — first joiner goes Purple, second goes Orange).
6. Once both teams have at least one player and warm-up ends (or times out), confirm a round starts, combat works exactly as in an existing Challenge-born match-arena, and round-result/match-complete panels say "Team Purple"/"Team Orange" instead of "Team A"/"Team B".
7. Confirm the existing cross-subreddit Challenge flow (`Challenge a Subreddit` menu item, `match-arena` posts) is completely unaffected — still says "Team A"/"Team B", still works end-to-end.

- [ ] **Step 3: Report status**

If all checks pass, Phase 1 is complete and shippable on its own (a working, single-subreddit, auto-balanced practice mode). Proceed to Phase 2, or stop here if that's sufficient for now.

---

## Phase 2 — Manual team pick

Adds the mod-configurable choice between auto-assign (Phase 1's behavior) and letting players pick Purple or Orange themselves.

### Task 11: Types — `TeamAssignMode`

**Files:**
- Modify: `src/shared/api.ts`
- Modify: `src/server/match.ts`

**Interfaces:**
- Produces: `TeamAssignMode = 'auto' | 'manual'`; `Match.teamAssignMode: TeamAssignMode`; `CreateScrimmageReq.teamAssignMode: TeamAssignMode`; `ScrimmageJoinReq.team: Team | null`

- [ ] **Step 1: Add `TeamAssignMode` and widen `Match`**

Find in `src/shared/api.ts`:

```typescript
export type SquadRule = 'capped' | 'custom'
export const SQUAD_RULES: readonly SquadRule[] = ['capped', 'custom']
```

Replace with:

```typescript
export type SquadRule = 'capped' | 'custom'
export const SQUAD_RULES: readonly SquadRule[] = ['capped', 'custom']

/** Scrimmage-only: whether players pick their own team or the server auto-balances them. Cross-subreddit Challenge matches don't use this — team is always "which subreddit's post you're on" for those. */
export type TeamAssignMode = 'auto' | 'manual'
```

Find:

```typescript
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
  squadRule: SquadRule
  joinModeA: 'individual' | 'preset' | null
```

Replace with:

```typescript
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
  squadRule: SquadRule
  teamAssignMode: TeamAssignMode
  joinModeA: 'individual' | 'preset' | null
```

- [ ] **Step 2: Widen `CreateScrimmageReq` and `ScrimmageJoinReq`/`Rsp`**

Find:

```typescript
export type CreateScrimmageReq = {
  matchSize: '5v5' | '10v10'
  squadRule: SquadRule
}
export type CreateScrimmageRsp = {matchId: string; arenaUrl: string}

export type ScrimmageJoinReq = {line: ShipLine}
export type ScrimmageJoinRsp = {team: Team}
```

Replace with:

```typescript
export type CreateScrimmageReq = {
  matchSize: '5v5' | '10v10'
  squadRule: SquadRule
  teamAssignMode: TeamAssignMode
}
export type CreateScrimmageRsp = {matchId: string; arenaUrl: string}

export type ScrimmageJoinReq = {line: ShipLine; team: Team | null}
export type ScrimmageJoinRsp = {team: Team}
```

- [ ] **Step 3: Give `createMatch` a hardcoded default for the new required `Match` field**

Find in `src/server/match.ts`:

```typescript
    playerCap: challenge.playerCap,
    warmupMinutes: challenge.warmupMinutes,
    squadRule: challenge.squadRule,
    joinModeA: null,
```

Replace with:

```typescript
    playerCap: challenge.playerCap,
    warmupMinutes: challenge.warmupMinutes,
    squadRule: challenge.squadRule,
    // Cross-subreddit Challenges never offer a team-pick choice — team is
    // always "which subreddit you're on" — so this is a fixed, unused default.
    teamAssignMode: 'auto',
    joinModeA: null,
```

- [ ] **Step 4: Verify it compiles, with an expected error**

Run: `npm run test:types`
Expected: an error at `createScrimmage`'s `Match` literal in `src/server/match.ts` (missing `teamAssignMode`) — expected, fixed in Task 12.

- [ ] **Step 5: Commit**

```bash
git add src/shared/api.ts src/server/match.ts
git commit -m "Add TeamAssignMode type and thread it through Match/CreateScrimmageReq/ScrimmageJoinReq"
```

---

### Task 12: Server — manual team-pick logic

**Files:**
- Modify: `src/server/match.ts`
- Modify: `src/server/server.ts`

**Interfaces:**
- Consumes: `TeamAssignMode` from `../shared/api.ts` (Task 11)
- Produces: `createScrimmage(..., teamAssignMode: TeamAssignMode)` (4th param added); `joinScrimmage(..., requestedTeam: Team | null)` (6th param added)

- [ ] **Step 1: Thread `teamAssignMode` through `createScrimmage`**

Find in `src/server/match.ts`:

```typescript
export async function createScrimmage(
  subredditName: string,
  matchSize: '5v5' | '10v10',
  squadRule: SquadRule,
): Promise<Match> {
```

Replace with:

```typescript
export async function createScrimmage(
  subredditName: string,
  matchSize: '5v5' | '10v10',
  squadRule: SquadRule,
  teamAssignMode: TeamAssignMode,
): Promise<Match> {
```

Find:

```typescript
    warmupMinutes: SCRIMMAGE_WARMUP_MINUTES,
    squadRule,
    joinModeA: 'individual',
```

Replace with:

```typescript
    warmupMinutes: SCRIMMAGE_WARMUP_MINUTES,
    squadRule,
    teamAssignMode,
    joinModeA: 'individual',
```

Find the `import type` block for `../shared/api.ts` in `src/server/match.ts`:

```typescript
import type {
  Challenge,
  Match,
  MatchMsg,
  PlayerState,
  PresetId,
  Team,
  WeaponMode,
} from '../shared/api.ts'
```

Replace with:

```typescript
import type {
  Challenge,
  Match,
  MatchMsg,
  PlayerState,
  PresetId,
  Team,
  TeamAssignMode,
  WeaponMode,
} from '../shared/api.ts'
```

- [ ] **Step 2: Thread manual-pick validation through `joinScrimmage`**

Find:

```typescript
export async function joinScrimmage(
  matchId: string,
  userId: string,
  username: string,
  snoovatar: string | undefined,
  line: ShipLine,
): Promise<{team: Team}> {
  const match = await getMatch(matchId)
  if (!match) throw new Error('match not found')
  const players = await getMatchPlayers(matchId)
  const team = assignAutoTeam(players)
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
  return {team: player.team ?? team}
}
```

Replace with:

```typescript
export async function joinScrimmage(
  matchId: string,
  userId: string,
  username: string,
  snoovatar: string | undefined,
  line: ShipLine,
  requestedTeam: Team | null,
): Promise<{team: Team}> {
  const match = await getMatch(matchId)
  if (!match) throw new Error('match not found')
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
  return {team: player.team ?? team}
}
```

- [ ] **Step 3: Wire `teamAssignMode`/`team` through `server.ts`'s routing**

Find in `src/server/server.ts`:

```typescript
  if (!SQUAD_RULES.includes(req.squadRule)) {
    return {error: 'invalid squad rule', status: 400}
  }
  const match = await createScrimmage(
    subredditName,
    req.matchSize,
    req.squadRule,
  )
  return {matchId: match.matchId, arenaUrl: match.arenaUrlA}
}
```

Replace with:

```typescript
  if (!SQUAD_RULES.includes(req.squadRule)) {
    return {error: 'invalid squad rule', status: 400}
  }
  if (req.teamAssignMode !== 'auto' && req.teamAssignMode !== 'manual') {
    return {error: 'invalid team assign mode', status: 400}
  }
  const match = await createScrimmage(
    subredditName,
    req.matchSize,
    req.squadRule,
    req.teamAssignMode,
  )
  return {matchId: match.matchId, arenaUrl: match.arenaUrlA}
}
```

Find:

```typescript
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
```

Replace with:

```typescript
  const req = await readJson<ScrimmageJoinReq>(reqMsg)
  if (!SHIP_LINES.includes(req.line)) {
    return {error: 'invalid ship line', status: 400}
  }
  if (req.team !== null && req.team !== 'A' && req.team !== 'B') {
    return {error: 'invalid team', status: 400}
  }
  try {
    return await joinScrimmage(
      kind.matchId,
      userId,
      username,
      context.snoovatar,
      req.line,
      req.team,
    )
  } catch (err) {
```

- [ ] **Step 4: Verify it compiles and passes existing tests**

Run: `npm run test:types && npm run lint && npm run test:unit`
Expected: all pass.

- [ ] **Step 5: Commit**

```bash
git add src/server/match.ts src/server/server.ts
git commit -m "Add manual team-pick logic to createScrimmage and joinScrimmage"
```

---

### Task 13: Client — team-assign form field and Purple/Orange picker

**Files:**
- Modify: `src/client/scrimmage.ts`
- Modify: `src/client/battle.ts`

- [ ] **Step 1: Add the team-assign field to the setup form**

Find in `src/client/scrimmage.ts`:

```typescript
      {
        type: 'boolean',
        name: 'customSquadRule',
        label: 'Custom squad rule (no 2-per-line cap)',
        defaultValue: false,
      },
    ],
  })
```

Replace with:

```typescript
      {
        type: 'select',
        name: 'teamAssignMode',
        label: 'Team assignment',
        options: [
          {label: 'Auto-balance', value: 'auto'},
          {label: 'Players pick their own team', value: 'manual'},
        ],
        defaultValue: ['auto'],
      },
      {
        type: 'boolean',
        name: 'customSquadRule',
        label: 'Custom squad rule (no 2-per-line cap)',
        defaultValue: false,
      },
    ],
  })
```

Find:

```typescript
  const matchSize = result.values.matchSize?.[0] === '10v10' ? '10v10' : '5v5'
  const rsp = await fetchScrimmageCreate({
    matchSize,
    squadRule: result.values.customSquadRule ? 'custom' : 'capped',
  })
```

Replace with:

```typescript
  const matchSize = result.values.matchSize?.[0] === '10v10' ? '10v10' : '5v5'
  const teamAssignMode =
    result.values.teamAssignMode?.[0] === 'manual' ? 'manual' : 'auto'
  const rsp = await fetchScrimmageCreate({
    matchSize,
    squadRule: result.values.customSquadRule ? 'custom' : 'capped',
    teamAssignMode,
  })
```

- [ ] **Step 2: Add the Purple/Orange picker to `battle.ts`**

Find:

```typescript
let scene: BattleScene | null = null
let lastRound = 0
let mySide: Team = 'A'
let isScrimmage = false
```

Replace with:

```typescript
let scene: BattleScene | null = null
let lastRound = 0
let mySide: Team = 'A'
let isScrimmage = false
let scrimmageTeamChoice: Team | null = null
```

Find:

```typescript
async function joinScrimmageBattle(line: PlayerState['line']): Promise<void> {
  const rsp = await fetchScrimmageJoin({line})
  if (isErrorRsp(rsp)) {
    showOverlay(
      `<div class="panel"><p class="error">${escapeHtml(rsp.error)}</p></div>`,
    )
  }
  await poll()
}
```

Replace with:

```typescript
async function joinScrimmageBattle(
  line: PlayerState['line'],
  team: Team | null,
): Promise<void> {
  const rsp = await fetchScrimmageJoin({line, team})
  if (isErrorRsp(rsp)) {
    showOverlay(
      `<div class="panel"><p class="error">${escapeHtml(rsp.error)}</p></div>`,
    )
  }
  await poll()
}

function renderScrimmageJoinChoice(match: Match): string {
  if (match.teamAssignMode === 'manual' && !scrimmageTeamChoice) {
    return `
      <p>Pick your team:</p>
      <div class="row">
        <button id="pick-purple">Purple Team</button>
        <button id="pick-orange">Orange Team</button>
      </div>
    `
  }
  return `<div class="ship-picker">${shipPickerHtml()}</div>`
}
```

- [ ] **Step 3: Use `renderScrimmageJoinChoice` and wire the team-pick buttons**

Find:

```typescript
        ${self ? '<p>You are in. Waiting for the round to start…</p>' : isScrimmage ? `<div class="ship-picker">${shipPickerHtml()}</div>` : renderJoinChoice(match)}
      </div>
    `)
    if (!self) {
      if (isScrimmage) {
        for (const btn of document.querySelectorAll<HTMLButtonElement>(
          '.ship-pick',
        )) {
          btn.addEventListener('click', () => {
            const line = btn.dataset.line as PlayerState['line']
            void joinScrimmageBattle(line)
          })
        }
      } else {
```

Replace with:

```typescript
        ${self ? '<p>You are in. Waiting for the round to start…</p>' : isScrimmage ? renderScrimmageJoinChoice(match) : renderJoinChoice(match)}
      </div>
    `)
    if (!self) {
      if (isScrimmage) {
        document.getElementById('pick-purple')?.addEventListener('click', () => {
          scrimmageTeamChoice = 'A'
          void poll()
        })
        document.getElementById('pick-orange')?.addEventListener('click', () => {
          scrimmageTeamChoice = 'B'
          void poll()
        })
        for (const btn of document.querySelectorAll<HTMLButtonElement>(
          '.ship-pick',
        )) {
          btn.addEventListener('click', () => {
            const line = btn.dataset.line as PlayerState['line']
            void joinScrimmageBattle(line, scrimmageTeamChoice)
          })
        }
      } else {
```

- [ ] **Step 4: Verify it compiles, lints, and builds**

Run: `npm run test:types && npm run lint && npm run build:client`
Expected: all pass.

- [ ] **Step 5: Commit**

```bash
git add src/client/scrimmage.ts src/client/battle.ts
git commit -m "Add manual Purple/Orange team pick to the scrimmage setup form and battle client"
```

---

### Task 14: Phase 2 manual verification

- [ ] **Step 1: Run `npm run test`**

Expected: all pass.

- [ ] **Step 2: Manual smoke test**

1. Create a scrimmage with team assignment set to "Players pick their own team."
2. Open the arena as two test users. Confirm each sees a Purple/Orange choice screen before the ship picker.
3. Have both users pick the *same* color (e.g. both Purple). Confirm both land on Purple, and a third user who picks Orange lands there correctly (mixed manual + no auto-interference).
4. Confirm a scrimmage created with "Auto-balance" still behaves exactly as in Phase 1 (no team-pick screen shown at all).
5. Confirm `match-arena` (cross-subreddit Challenge) posts are unaffected — no team-pick screen ever appears there since `teamAssignMode` is hardcoded `'auto'` and unused on that path (Task 11), and `mySide` there still comes from postData, not the new picker.

---

## Phase 3 — Whitelist + spectator

Adds a mod-configurable whitelist; anyone not on it (and not a moderator) becomes a live spectator instead of a player.

### Task 15: Types — `JoinPolicy`, whitelist, spectator

**Files:**
- Modify: `src/shared/api.ts`
- Modify: `src/server/match.ts`

**Interfaces:**
- Produces: `JoinPolicy = 'open' | 'whitelist'`; `Match.joinPolicy: JoinPolicy`; `Match.whitelist: string[]`; `CreateScrimmageReq.joinPolicy`/`whitelist`; `MatchStateRsp.spectator: boolean`; `ScrimmageJoinRsp = {role:'player'; team: Team} | {role:'spectator'}`

- [ ] **Step 1: Add `JoinPolicy` and widen `Match`**

Find in `src/shared/api.ts`:

```typescript
/** Scrimmage-only: whether players pick their own team or the server auto-balances them. Cross-subreddit Challenge matches don't use this — team is always "which subreddit's post you're on" for those. */
export type TeamAssignMode = 'auto' | 'manual'
```

Replace with:

```typescript
/** Scrimmage-only: whether players pick their own team or the server auto-balances them. Cross-subreddit Challenge matches don't use this — team is always "which subreddit's post you're on" for those. */
export type TeamAssignMode = 'auto' | 'manual'

/** Scrimmage-only: 'open' is first-come-first-served (anyone may join a team); 'whitelist' restricts play to listed usernames (plus moderators) — everyone else becomes a spectator. */
export type JoinPolicy = 'open' | 'whitelist'
```

Find:

```typescript
  squadRule: SquadRule
  teamAssignMode: TeamAssignMode
  joinModeA: 'individual' | 'preset' | null
```

Replace with:

```typescript
  squadRule: SquadRule
  teamAssignMode: TeamAssignMode
  joinPolicy: JoinPolicy
  whitelist: string[]
  joinModeA: 'individual' | 'preset' | null
```

- [ ] **Step 2: Widen `CreateScrimmageReq`, `MatchStateRsp`, and `ScrimmageJoinRsp`**

Find:

```typescript
export type CreateScrimmageReq = {
  matchSize: '5v5' | '10v10'
  squadRule: SquadRule
  teamAssignMode: TeamAssignMode
}
export type CreateScrimmageRsp = {matchId: string; arenaUrl: string}

export type ScrimmageJoinReq = {line: ShipLine; team: Team | null}
export type ScrimmageJoinRsp = {team: Team}
```

Replace with:

```typescript
export type CreateScrimmageReq = {
  matchSize: '5v5' | '10v10'
  squadRule: SquadRule
  teamAssignMode: TeamAssignMode
  joinPolicy: JoinPolicy
  whitelist: string[]
}
export type CreateScrimmageRsp = {matchId: string; arenaUrl: string}

export type ScrimmageJoinReq = {line: ShipLine; team: Team | null}
export type ScrimmageJoinRsp = {role: 'player'; team: Team} | {role: 'spectator'}
```

Find:

```typescript
export type MatchStateRsp = {
  match: Match
  self: PlayerState | null
  rosterA: PlayerState[]
  rosterB: PlayerState[]
}
```

Replace with:

```typescript
export type MatchStateRsp = {
  match: Match
  self: PlayerState | null
  rosterA: PlayerState[]
  rosterB: PlayerState[]
  /** True only when this is a whitelist-restricted scrimmage, self is null, and the requester isn't eligible to join a team. Always false for match-arena posts. */
  spectator: boolean
}
```

- [ ] **Step 3: Give `createMatch` hardcoded defaults for the two new required `Match` fields**

Find in `src/server/match.ts`:

```typescript
    teamAssignMode: 'auto',
    joinModeA: null,
```

Replace with:

```typescript
    teamAssignMode: 'auto',
    // Cross-subreddit Challenges are always open, whitelist-free — anyone
    // who lands on the right subreddit's arena post may join.
    joinPolicy: 'open',
    whitelist: [],
    joinModeA: null,
```

- [ ] **Step 4: Verify it compiles, with expected errors**

Run: `npm run test:types`
Expected: errors at `createScrimmage`'s `Match` literal (missing `joinPolicy`/`whitelist`), `joinScrimmage`'s return statements (now missing the `role` discriminant), and `routeMatchState`'s return (missing `spectator`) — all expected, fixed in Tasks 16-17.

- [ ] **Step 5: Commit**

```bash
git add src/shared/api.ts src/server/match.ts
git commit -m "Add JoinPolicy type, Match whitelist fields, and spectator response shapes"
```

---

### Task 16: `isEligibleToJoin` pure function

**Files:**
- Modify: `src/server/abilities.ts`
- Modify: `src/server/abilities.test.ts`

**Interfaces:**
- Consumes: `JoinPolicy` from `../shared/api.ts` (Task 15)
- Produces: `isEligibleToJoin(joinPolicy: JoinPolicy, whitelist: string[], username: string, isModerator: boolean): boolean`

- [ ] **Step 1: Write the failing tests**

Add to `src/server/abilities.test.ts`, after the `assignAutoTeam` tests:

```typescript
test('isEligibleToJoin allows anyone when the policy is open', () => {
  assert.equal(isEligibleToJoin('open', [], 'anyone', false), true)
})

test('isEligibleToJoin restricts to the whitelist (case-insensitive)', () => {
  assert.equal(
    isEligibleToJoin('whitelist', ['alice'], 'Alice', false),
    true,
  )
  assert.equal(isEligibleToJoin('whitelist', ['alice'], 'bob', false), false)
})

test('isEligibleToJoin always allows moderators under a whitelist', () => {
  assert.equal(isEligibleToJoin('whitelist', [], 'anymod', true), true)
})
```

Update the import list:

```typescript
import {
  abilityReady,
  assignAutoTeam,
  canClaimPresetSlot,
  canJoinLine,
  computeDamage,
  isEligibleToJoin,
  maxHullFor,
  mineTriggeredBy,
  nearestAlly,
  survivalCredit,
} from './abilities.ts'
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node --experimental-strip-types --no-warnings=ExperimentalWarning --test src/server/abilities.test.ts`
Expected: FAIL — `isEligibleToJoin is not defined`.

- [ ] **Step 3: Implement `isEligibleToJoin`**

Add to `src/server/abilities.ts`, after `assignAutoTeam`:

```typescript
/** Whether a user may join a scrimmage team. Everyone is eligible under 'open'; under 'whitelist', only listed usernames (case-insensitive) or moderators may — everyone else is a spectator. */
export function isEligibleToJoin(
  joinPolicy: JoinPolicy,
  whitelist: string[],
  username: string,
  isModerator: boolean,
): boolean {
  if (joinPolicy === 'open') return true
  if (isModerator) return true
  return whitelist.includes(username.toLowerCase())
}
```

Add `JoinPolicy` to the type import at the top of `src/server/abilities.ts`:

```typescript
import type {JoinPolicy, PlayerState, ShipLine, Team} from '../shared/api.ts'
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `node --experimental-strip-types --no-warnings=ExperimentalWarning --test src/server/abilities.test.ts`
Expected: PASS, all tests.

- [ ] **Step 5: Commit**

```bash
git add src/server/abilities.ts src/server/abilities.test.ts
git commit -m "Add isEligibleToJoin pure function for scrimmage whitelist gating"
```

---

### Task 17: Server — whitelist wiring, moderator lookup, setup form

**Files:**
- Modify: `src/server/match.ts`
- Modify: `src/server/server.ts`
- Modify: `src/client/scrimmage.ts`

**Interfaces:**
- Consumes: `isEligibleToJoin` from `./abilities.ts` (Task 16)
- Produces: `createScrimmage(..., joinPolicy: JoinPolicy, whitelist: string[])` (5th/6th params added); `joinScrimmage(..., isModerator: boolean)` returns `{role:'player'; team: Team} | {role:'spectator'}`

- [ ] **Step 1: Thread `joinPolicy`/`whitelist` through `createScrimmage`**

Find in `src/server/match.ts`:

```typescript
export async function createScrimmage(
  subredditName: string,
  matchSize: '5v5' | '10v10',
  squadRule: SquadRule,
  teamAssignMode: TeamAssignMode,
): Promise<Match> {
```

Replace with:

```typescript
export async function createScrimmage(
  subredditName: string,
  matchSize: '5v5' | '10v10',
  squadRule: SquadRule,
  teamAssignMode: TeamAssignMode,
  joinPolicy: JoinPolicy,
  whitelist: string[],
): Promise<Match> {
```

Find:

```typescript
    squadRule,
    teamAssignMode,
    joinModeA: 'individual',
```

Replace with:

```typescript
    squadRule,
    teamAssignMode,
    joinPolicy,
    whitelist,
    joinModeA: 'individual',
```

Update the `../shared/api.ts` type import:

```typescript
import type {
  Challenge,
  JoinPolicy,
  Match,
  MatchMsg,
  PlayerState,
  PresetId,
  Team,
  TeamAssignMode,
  WeaponMode,
} from '../shared/api.ts'
```

- [ ] **Step 2: Add the eligibility check to `joinScrimmage`**

Find:

```typescript
export async function joinScrimmage(
  matchId: string,
  userId: string,
  username: string,
  snoovatar: string | undefined,
  line: ShipLine,
  requestedTeam: Team | null,
): Promise<{team: Team}> {
  const match = await getMatch(matchId)
  if (!match) throw new Error('match not found')
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
  return {team: player.team ?? team}
}
```

Replace with:

```typescript
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
```

Add `isEligibleToJoin` to the `./abilities.ts` import:

```typescript
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
```

- [ ] **Step 3: Add a moderator-lookup helper and wire everything through `server.ts`**

Find:

```typescript
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
  if (req.teamAssignMode !== 'auto' && req.teamAssignMode !== 'manual') {
    return {error: 'invalid team assign mode', status: 400}
  }
  const match = await createScrimmage(
    subredditName,
    req.matchSize,
    req.squadRule,
    req.teamAssignMode,
  )
  return {matchId: match.matchId, arenaUrl: match.arenaUrlA}
}
```

Replace with:

```typescript
async function isRequesterModerator(): Promise<boolean> {
  const subredditName = context.subredditName
  if (!subredditName) return false
  const user = await reddit.getCurrentUser()
  if (!user) return false
  const perms = await user.getModPermissionsForSubreddit(subredditName)
  return perms.length > 0
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
  if (req.teamAssignMode !== 'auto' && req.teamAssignMode !== 'manual') {
    return {error: 'invalid team assign mode', status: 400}
  }
  if (req.joinPolicy !== 'open' && req.joinPolicy !== 'whitelist') {
    return {error: 'invalid join policy', status: 400}
  }
  const match = await createScrimmage(
    subredditName,
    req.matchSize,
    req.squadRule,
    req.teamAssignMode,
    req.joinPolicy,
    req.whitelist.map(u => u.toLowerCase()),
  )
  return {matchId: match.matchId, arenaUrl: match.arenaUrlA}
}
```

Find:

```typescript
  try {
    return await joinScrimmage(
      kind.matchId,
      userId,
      username,
      context.snoovatar,
      req.line,
      req.team,
    )
  } catch (err) {
```

Replace with:

```typescript
  try {
    return await joinScrimmage(
      kind.matchId,
      userId,
      username,
      context.snoovatar,
      req.line,
      req.team,
      await isRequesterModerator(),
    )
  } catch (err) {
```

- [ ] **Step 4: Compute `spectator` in `routeMatchState`**

Find:

```typescript
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
```

Replace with:

```typescript
async function routeMatchState(): Promise<MatchStateRsp | ErrorRsp> {
  const userId = context.userId
  const kind = getPostKind()
  const matchId = matchIdFromKind(kind)
  if (!matchId)
    return {error: 'not a match arena or scrimmage post', status: 400}
  let match = await getMatch(matchId)
  if (!match) return {error: 'match not found', status: 404}
  match = await tickMatch(match)
  const players = await getMatchPlayers(matchId)
  const rosterA = players.filter(p => p.team === 'A')
  const rosterB = players.filter(p => p.team === 'B')
  const self = players.find(p => p.userId === userId) ?? null
  let spectator = false
  if (!self && kind?.kind === 'scrimmage' && context.username) {
    spectator = !isEligibleToJoin(
      match.joinPolicy,
      match.whitelist,
      context.username,
      await isRequesterModerator(),
    )
  }
  return {
    match,
    self,
    rosterA,
    rosterB,
    spectator,
  }
}
```

Add `isEligibleToJoin` to `server.ts`'s import from `./abilities.ts` — this file currently has no such import block, so add one right after the `./match.ts` import block:

```typescript
import {isEligibleToJoin} from './abilities.ts'
```

- [ ] **Step 5: Add the whitelist fields to the setup form**

Find in `src/client/scrimmage.ts`:

```typescript
      {
        type: 'select',
        name: 'teamAssignMode',
        label: 'Team assignment',
        options: [
          {label: 'Auto-balance', value: 'auto'},
          {label: 'Players pick their own team', value: 'manual'},
        ],
        defaultValue: ['auto'],
      },
      {
        type: 'boolean',
        name: 'customSquadRule',
        label: 'Custom squad rule (no 2-per-line cap)',
        defaultValue: false,
      },
    ],
  })
```

Replace with:

```typescript
      {
        type: 'select',
        name: 'teamAssignMode',
        label: 'Team assignment',
        options: [
          {label: 'Auto-balance', value: 'auto'},
          {label: 'Players pick their own team', value: 'manual'},
        ],
        defaultValue: ['auto'],
      },
      {
        type: 'boolean',
        name: 'customSquadRule',
        label: 'Custom squad rule (no 2-per-line cap)',
        defaultValue: false,
      },
      {
        type: 'boolean',
        name: 'whitelistOnly',
        label: 'Restrict to a whitelist (everyone else spectates)',
        defaultValue: false,
      },
      {
        type: 'paragraph',
        name: 'whitelist',
        label: 'Whitelisted usernames (one per line, only used if restricted above)',
        required: false,
      },
    ],
  })
```

Find:

```typescript
  const matchSize = result.values.matchSize?.[0] === '10v10' ? '10v10' : '5v5'
  const teamAssignMode =
    result.values.teamAssignMode?.[0] === 'manual' ? 'manual' : 'auto'
  const rsp = await fetchScrimmageCreate({
    matchSize,
    squadRule: result.values.customSquadRule ? 'custom' : 'capped',
    teamAssignMode,
  })
```

Replace with:

```typescript
  const matchSize = result.values.matchSize?.[0] === '10v10' ? '10v10' : '5v5'
  const teamAssignMode =
    result.values.teamAssignMode?.[0] === 'manual' ? 'manual' : 'auto'
  const whitelist = (result.values.whitelist ?? '')
    .split('\n')
    .map(u => u.trim())
    .filter(u => u.length > 0)
  const rsp = await fetchScrimmageCreate({
    matchSize,
    squadRule: result.values.customSquadRule ? 'custom' : 'capped',
    teamAssignMode,
    joinPolicy: result.values.whitelistOnly ? 'whitelist' : 'open',
    whitelist,
  })
```

- [ ] **Step 6: Verify it compiles and passes existing tests**

Run: `npm run test:types && npm run lint && npm run test:unit`
Expected: all pass.

- [ ] **Step 7: Commit**

```bash
git add src/server/match.ts src/server/server.ts src/client/scrimmage.ts
git commit -m "Wire whitelist gating and moderator bypass through scrimmage create/join"
```

---

### Task 18: Client — spectator view

**Files:**
- Modify: `src/client/battle.ts`

**Interfaces:**
- Produces: `BattleScene.resetSpectatorView(others: PlayerState[]): void`; module-level `isSpectator: boolean`

- [ ] **Step 1: Add `resetSpectatorView` to `BattleScene`**

Find:

```typescript
  resetForNewRound(self: PlayerState, others: PlayerState[]): void {
    for (const r of this.others.values()) r.container.destroy()
    this.others.clear()
    for (const m of this.mines.values()) m.destroy()
    this.mines.clear()
    this.spawnSelf(self)
    for (const p of others) this.spawnRemote(p)
  }
```

Replace with:

```typescript
  resetForNewRound(self: PlayerState, others: PlayerState[]): void {
    for (const r of this.others.values()) r.container.destroy()
    this.others.clear()
    for (const m of this.mines.values()) m.destroy()
    this.mines.clear()
    this.spawnSelf(self)
    for (const p of others) this.spawnRemote(p)
  }

  /** No ship, no controls — the camera sits at the default center (roughly between the two spawn clusters) and every ship is drawn exactly as spawnRemote already draws them for everyone else's screen. */
  resetSpectatorView(others: PlayerState[]): void {
    for (const r of this.others.values()) r.container.destroy()
    this.others.clear()
    for (const m of this.mines.values()) m.destroy()
    this.mines.clear()
    for (const p of others) this.spawnRemote(p)
    this.updateHud()
  }
```

- [ ] **Step 2: Add `isSpectator` module state, set it from the poll response**

Find:

```typescript
let scene: BattleScene | null = null
let lastRound = 0
let mySide: Team = 'A'
let isScrimmage = false
let scrimmageTeamChoice: Team | null = null
```

Replace with:

```typescript
let scene: BattleScene | null = null
let lastRound = 0
let mySide: Team = 'A'
let isScrimmage = false
let scrimmageTeamChoice: Team | null = null
let isSpectator = false
```

Find:

```typescript
async function poll(): Promise<void> {
  const rsp = await fetchMatchState()
  if (isErrorRsp(rsp)) {
    showOverlay(
      `<div class="panel"><p class="error">${escapeHtml(rsp.error)}</p></div>`,
    )
    return
  }
  renderMatch(rsp.match, rsp.self, rsp.rosterA, rsp.rosterB)
}
```

Replace with:

```typescript
async function poll(): Promise<void> {
  const rsp = await fetchMatchState()
  if (isErrorRsp(rsp)) {
    showOverlay(
      `<div class="panel"><p class="error">${escapeHtml(rsp.error)}</p></div>`,
    )
    return
  }
  isSpectator = rsp.spectator
  renderMatch(rsp.match, rsp.self, rsp.rosterA, rsp.rosterB)
}
```

- [ ] **Step 3: Show a spectator panel in warm-up and reset the scene for spectators once a round starts**

Find:

```typescript
        ${self ? '<p>You are in. Waiting for the round to start…</p>' : isScrimmage ? renderScrimmageJoinChoice(match) : renderJoinChoice(match)}
      </div>
    `)
    if (!self) {
      if (isScrimmage) {
```

Replace with:

```typescript
        ${self ? '<p>You are in. Waiting for the round to start…</p>' : isSpectator ? "<p>This scrimmage is whitelist-only and you're not on the list — you can spectate the battle live.</p>" : isScrimmage ? renderScrimmageJoinChoice(match) : renderJoinChoice(match)}
      </div>
    `)
    if (!self && !isSpectator) {
      if (isScrimmage) {
```

Find:

```typescript
  if (match.status === 'round_active') {
    hideOverlay()
    if (!scene) return
    if (
      self &&
      (!scene.self ||
        scene.self.userId !== self.userId ||
        match.round !== lastRound)
    ) {
      lastRound = match.round
      scene.resetForNewRound(self, [...rosterA, ...rosterB])
    }
    return
  }
```

Replace with:

```typescript
  if (match.status === 'round_active') {
    hideOverlay()
    if (!scene) return
    if (self) {
      if (
        !scene.self ||
        scene.self.userId !== self.userId ||
        match.round !== lastRound
      ) {
        lastRound = match.round
        scene.resetForNewRound(self, [...rosterA, ...rosterB])
      }
    } else if (isSpectator && match.round !== lastRound) {
      lastRound = match.round
      scene.resetSpectatorView([...rosterA, ...rosterB])
    }
    return
  }
```

- [ ] **Step 4: Verify it compiles, lints, and builds**

Run: `npm run test:types && npm run lint && npm run build:client`
Expected: all pass.

- [ ] **Step 5: Commit**

```bash
git add src/client/battle.ts
git commit -m "Add spectator view for whitelist-gated scrimmage non-participants"
```

---

### Task 19: Phase 3 manual verification

- [ ] **Step 1: Run `npm run test`**

Expected: all pass.

- [ ] **Step 2: Manual smoke test**

1. Create a scrimmage with "Restrict to a whitelist" on and one test username listed.
2. Open the post as the whitelisted user: confirm they see the normal join flow and can play.
3. Open the post as a non-whitelisted user: confirm they see the spectator message during warm-up, and once a round starts, confirm they see both teams' ships moving/fighting live with no ship/controls of their own and a "SPECTATING" HUD line.
4. Open the post as a subreddit moderator who isn't on the whitelist: confirm they can still join and play (moderator bypass).
5. Create a scrimmage with an open join policy: confirm nobody is ever treated as a spectator.
6. Confirm match-arena (Challenge) posts are entirely unaffected — `spectator` is always `false` there, no spectator UI ever appears.

---

## Phase 4 — Squad preset option

Lets a mod force the whole scrimmage onto one curated squad preset instead of individual picks, reusing the existing `SQUAD_PRESETS`/`joinModeA`/`joinModeB`/`presetIdA`/`presetIdB` machinery unchanged.

### Task 20: `createScrimmage` preset support and setup form field

**Files:**
- Modify: `src/server/match.ts`
- Modify: `src/server/server.ts`
- Modify: `src/client/scrimmage.ts`

**Interfaces:**
- Produces: `createScrimmage(..., presetId: PresetId | null)` (7th param added); `CreateScrimmageReq.presetId: PresetId | null`

- [ ] **Step 1: Add `presetId` to `CreateScrimmageReq`**

Find in `src/shared/api.ts`:

```typescript
export type CreateScrimmageReq = {
  matchSize: '5v5' | '10v10'
  squadRule: SquadRule
  teamAssignMode: TeamAssignMode
  joinPolicy: JoinPolicy
  whitelist: string[]
}
```

Replace with:

```typescript
export type CreateScrimmageReq = {
  matchSize: '5v5' | '10v10'
  squadRule: SquadRule
  teamAssignMode: TeamAssignMode
  joinPolicy: JoinPolicy
  whitelist: string[]
  presetId: PresetId | null
}
```

- [ ] **Step 2: Thread `presetId` through `createScrimmage`**

Find in `src/server/match.ts`:

```typescript
export async function createScrimmage(
  subredditName: string,
  matchSize: '5v5' | '10v10',
  squadRule: SquadRule,
  teamAssignMode: TeamAssignMode,
  joinPolicy: JoinPolicy,
  whitelist: string[],
): Promise<Match> {
```

Replace with:

```typescript
export async function createScrimmage(
  subredditName: string,
  matchSize: '5v5' | '10v10',
  squadRule: SquadRule,
  teamAssignMode: TeamAssignMode,
  joinPolicy: JoinPolicy,
  whitelist: string[],
  presetId: PresetId | null,
): Promise<Match> {
```

Find:

```typescript
    joinPolicy,
    whitelist,
    joinModeA: 'individual',
    joinModeB: 'individual',
    presetIdA: null,
    presetIdB: null,
```

Replace with:

```typescript
    joinPolicy,
    whitelist,
    // A preset, if chosen, is forced match-wide — there's no per-team
    // negotiation like a Challenge-born match has, since the mod already
    // decided this at scrimmage-creation time.
    joinModeA: presetId ? 'preset' : 'individual',
    joinModeB: presetId ? 'preset' : 'individual',
    presetIdA: presetId,
    presetIdB: presetId,
```

- [ ] **Step 3: Validate and pass `presetId` through `routeScrimmageCreate`**

Find in `src/server/server.ts`:

```typescript
  if (req.joinPolicy !== 'open' && req.joinPolicy !== 'whitelist') {
    return {error: 'invalid join policy', status: 400}
  }
  const match = await createScrimmage(
    subredditName,
    req.matchSize,
    req.squadRule,
    req.teamAssignMode,
    req.joinPolicy,
    req.whitelist.map(u => u.toLowerCase()),
  )
  return {matchId: match.matchId, arenaUrl: match.arenaUrlA}
}
```

Replace with:

```typescript
  if (req.joinPolicy !== 'open' && req.joinPolicy !== 'whitelist') {
    return {error: 'invalid join policy', status: 400}
  }
  if (req.presetId !== null && !(req.presetId in SQUAD_PRESETS)) {
    return {error: 'invalid preset', status: 400}
  }
  const match = await createScrimmage(
    subredditName,
    req.matchSize,
    req.squadRule,
    req.teamAssignMode,
    req.joinPolicy,
    req.whitelist.map(u => u.toLowerCase()),
    req.presetId,
  )
  return {matchId: match.matchId, arenaUrl: match.arenaUrlA}
}
```

- [ ] **Step 4: Add the preset choice to the setup form**

Find in `src/client/scrimmage.ts`:

```typescript
      {
        type: 'boolean',
        name: 'customSquadRule',
        label: 'Custom squad rule (no 2-per-line cap)',
        defaultValue: false,
      },
```

Replace with:

```typescript
      {
        type: 'select',
        name: 'squadMode',
        label: 'Squad composition',
        options: [
          {label: 'Individual picks', value: 'individual'},
          {label: 'Curated preset (forced match-wide)', value: 'preset'},
        ],
        defaultValue: ['individual'],
      },
      {
        type: 'select',
        name: 'presetId',
        label: 'Preset (only used if "Curated preset" is chosen above)',
        options: [
          {label: 'Balanced Wing', value: 'balanced'},
          {label: 'Aggro Rush', value: 'aggro'},
          {label: 'Turtle Wall', value: 'turtle'},
          {label: 'Recon Strike', value: 'recon'},
        ],
        defaultValue: ['balanced'],
      },
      {
        type: 'boolean',
        name: 'customSquadRule',
        label: 'Custom squad rule (no 2-per-line cap, ignored if using a preset)',
        defaultValue: false,
      },
```

Find:

```typescript
  const rsp = await fetchScrimmageCreate({
    matchSize,
    squadRule: result.values.customSquadRule ? 'custom' : 'capped',
    teamAssignMode,
    joinPolicy: result.values.whitelistOnly ? 'whitelist' : 'open',
    whitelist,
  })
```

Replace with:

```typescript
  const presetId =
    result.values.squadMode?.[0] === 'preset'
      ? ((result.values.presetId?.[0] ?? 'balanced') as PresetId)
      : null
  const rsp = await fetchScrimmageCreate({
    matchSize,
    squadRule: result.values.customSquadRule ? 'custom' : 'capped',
    teamAssignMode,
    joinPolicy: result.values.whitelistOnly ? 'whitelist' : 'open',
    whitelist,
    presetId,
  })
```

Add `PresetId` to the top of `src/client/scrimmage.ts` (it currently has no type imports from `../shared/api.ts`):

```typescript
import {showForm} from '@devvit/web/client'
import type {PresetId} from '../shared/api.ts'
import {fetchScrimmageCreate, isErrorRsp} from './fetch.ts'
```

- [ ] **Step 5: Verify it compiles, lints, and builds**

Run: `npm run test`
Expected: all pass — this is the last task, so run the full suite (`test:types && lint && test:unit && build`), not just a subset.

- [ ] **Step 6: Commit**

```bash
git add src/shared/api.ts src/server/match.ts src/server/server.ts src/client/scrimmage.ts
git commit -m "Add squad preset option to the scrimmage setup form"
```

---

### Task 21: Phase 4 manual verification

- [ ] **Step 1: Manual smoke test**

1. Create a scrimmage with squad composition set to "Curated preset" / "Aggro Rush."
2. Open the arena as two test users. Confirm the warm-up screen shows the single committed preset (matching the existing Challenge-flow preset-commit display), not the individual ship picker or a mode choice.
3. Confirm joining assigns lines from the preset's slot list, exactly as it already does for a Challenge-born match committed to a preset.
4. Confirm "Individual picks" still behaves exactly as Phase 1-3 (ship picker, `squadRule` capped/custom respected).

- [ ] **Step 2: Full-feature regression pass**

Re-run the Phase 1, 2, and 3 manual verification checklists (Tasks 10, 14, 19) once more end-to-end, plus a full existing-Challenge-flow smoke test (create a cross-subreddit challenge, accept it, play a full best-of-3), to confirm nothing in this plan regressed the pre-existing feature it was built alongside.

- [ ] **Step 3: Final commit checkpoint**

If all checks pass, Practice Scrimmage Mode is complete across all four phases. No further commit needed here — this task is verification-only.
