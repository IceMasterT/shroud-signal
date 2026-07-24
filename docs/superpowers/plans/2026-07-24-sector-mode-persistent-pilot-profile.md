# Sector Mode Persistent Pilot Profile Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give Sector Mode a persistent, cross-post pilot identity — a locked ship line, level/XP, credits, ship tier, and a (currently inert) module inventory/loadout — so playing Sector Mode repeatedly builds toward something durable, without touching Battle Mode at all.

**Architecture:** A new global `pilots` Redis hash (keyed by `userId`, one profile ever, across every subreddit) replaces `sector.ts`'s old per-post `lineForUser`/`setPlayerLine` line assignment. Credits and XP live in their own atomic `redis.incrBy`-backed keys — never inside the profile's JSON blob — mirroring the exact reason `sector.ts` already keeps hull/score/kills in dedicated hashes instead of a read-modify-write blob. `sector.ts`'s combat path (`applyDamage`) grants rewards and applies the death penalty; `match.ts`/`challenge.ts` (Battle Mode) are never touched or imported by any of this.

**Tech Stack:** TypeScript, Devvit Web (`@devvit/web/server`/`client`), Redis (via Devvit's client), Phaser (client sector scene), `node:test` for unit tests, Biome for lint/format, esbuild for bundling.

## Global Constraints

- Design spec is `docs/superpowers/specs/2026-07-24-sector-mode-persistent-pilot-profile-design.md` — refer back to it if a task here seems to contradict it.
- Battle Mode (`src/server/match.ts`, `src/server/challenge.ts`, and the Skirmish/Challenge/Scrimmage clients) is **never** imported, read, or written by any task in this plan.
- One profile per Reddit `userId`, global across every subreddit's sector posts — not per-post, not per-subreddit.
- One ship line per pilot, chosen once via `chooseLine`. No respeccing, ever, once locked.
- Death penalty is a flat 10% of current credits, floored at 0 (`DEATH_PENALTY_PCT = 0.1`) — a deliberate choice over "no loss on death."
- Credits/XP are dedicated `redis.incrBy`-backed string keys (`pilot:{userId}:credits`, `pilot:{userId}:xp`), never folded into the profile's JSON blob — this is what keeps concurrent reward grants (the same pilot active in two sector posts at once) safe from lost updates.
- `moduleInventory`/`equippedModuleIds` exist on the profile from Task 3 onward but stay empty/inert in this plan — the module catalog, drop sources, and effects are a separate, later spec (sub-project #2). Do not add any code that grants or equips modules.
- Codebase style: Biome-formatted (single quotes, no semicolons, 2-space indent, trailing commas in multi-line literals). `npm run test` = `test:types && lint && test:unit && build`. Lint uses `--error-on-warnings`. Run the full `npm run test` at the end of each task unless that task's own verify step says otherwise (some intermediate tasks in Phase 1 deliberately leave known, soon-to-be-fixed compile errors — each such task's verify step says exactly what's expected).
- This codebase does not unit-test Redis-backed functions (no mocking) — only pure logic gets `node:test` coverage, matching `abilities.ts`/`abilities.test.ts`. `pilot.ts`'s `getOrCreatePilotProfile`/`chooseLine`/`grantCombatReward`/`applyDeathPenaltyFor` are type-checked only, not unit tested; `xpToNextLevel`/`levelForXp`/`applyDeathPenalty`/`canChooseLine` are pure and get full unit tests.

---

## File Structure

- **Modify** `src/shared/api.ts` — `Rarity`, `PilotModuleInstance`, `PilotProfile`, `PilotProfileRsp`, `ChooseLineReq`/`Rsp`, `SHIP_TIER_ASSET` types/constant; a new `pilot_reward` `RealtimeMsg` variant; two new `Endpoint`/`EndpointMethod` entries; removes `SectorJoinReq`/`SectorJoinRsp` and `Endpoint.SectorJoin`.
- **Create** `src/server/pilot.ts` — pure progression functions (`xpToNextLevel`, `levelForXp`, `applyDeathPenalty`, `canChooseLine`) plus Redis-backed profile/reward functions (`getOrCreatePilotProfile`, `chooseLine`, `grantCombatReward`, `applyDeathPenaltyFor`).
- **Create** `src/server/pilot.test.ts` — unit tests for the pure functions.
- **Modify** `src/server/sector.ts` — `getOrCreatePlayer` now sources `line` from the pilot profile; new `peekSectorLine` migration helper; removes `lineForUser`/`setPlayerLine`; `applyDamage` grants combat rewards and applies the death penalty.
- **Modify** `src/server/server.ts` — `routePilotProfile`/`routePilotChooseLine` replace `routeSectorJoin`.
- **Modify** `src/client/fetch.ts` — `fetchPilotProfile`/`fetchPilotChooseLine` replace `fetchSectorJoin`.
- **Modify** `src/client/scene.ts` — profile-driven ship-picker-skip flow, a `pilot_reward` toast, and a read-only "PILOT" HUD panel (keyboard `P` / touch button).

---

## Phase 1 — Profile core + line lock-in

A pilot's chosen ship line now survives across every sector post they visit, on any subreddit. Returning players (from before this feature shipped) are migrated in automatically instead of being forced through the picker again.

### Task 1: Shared types and endpoints for the pilot profile

**Files:**
- Modify: `src/shared/api.ts`

**Interfaces:**
- Produces: `Rarity`, `PilotModuleInstance`, `PilotProfile`, `PilotProfileRsp`, `ChooseLineReq`, `ChooseLineRsp`, `SHIP_TIER_ASSET`, `Endpoint.PilotProfile`, `Endpoint.PilotChooseLine`.

- [ ] **Step 1: Replace `SectorJoinReq`/`SectorJoinRsp` with the pilot profile types**

Find in `src/shared/api.ts`:

```typescript
/** Set (or change) the caller's ship line for this sector, before init spawns them. */
export type SectorJoinReq = {line: ShipLine}
export type SectorJoinRsp = {ok: true}
```

Replace with:

```typescript
export type Rarity = 'common' | 'rare' | 'epic' | 'legendary'

/** One acquired module in a pilot's inventory. The module catalog/effects/prices are a separate, not-yet-built system — this is just the instance shape. */
export type PilotModuleInstance = {
  instanceId: string
  moduleId: string
  rarity: Rarity
  quality: number
}

/**
 * A pilot's persistent identity across every Sector Mode post on every
 * subreddit — never read or written by Battle Mode (match.ts/challenge.ts).
 * `line` is null until `chooseLine` succeeds, then locked forever.
 */
export type PilotProfile = {
  userId: string
  username: string
  line: ShipLine | null
  shipTier: number
  moduleInventory: PilotModuleInstance[]
  equippedModuleIds: (string | null)[]
  createdAt: number
}

/** GET /api/pilot/profile response — the stored profile merged with the live credits/xp counters and the level derived from them. */
export type PilotProfileRsp = PilotProfile & {
  credits: number
  xp: number
  level: number
  xpIntoLevel: number
  xpToNext: number
}

/** POST /api/pilot/choose-line — locks in a pilot's ship line, once, ever. */
export type ChooseLineReq = {line: ShipLine}
export type ChooseLineRsp = PilotProfileRsp

/** Ship-tier art lookup (`public/assets/ships/`) — prefixes don't derive algorithmically from folder names, hence an explicit table. */
export const SHIP_TIER_ASSET: Record<
  ShipLine,
  {folder: string; prefix: string}
> = {
  fighter: {folder: 'Menta-Talon', prefix: 'MT'},
  miner: {folder: 'Menta-Prospector', prefix: 'MP'},
  transport: {folder: 'Menta-Drayman', prefix: 'DM'},
  pathfinder: {folder: 'Menta-Pathfinder', prefix: 'PF'},
  tender: {folder: 'Menta-Tender', prefix: 'MD'},
}
```

- [ ] **Step 2: Replace the `Endpoint.SectorJoin` entry with the two new endpoints**

Find:

```typescript
export const Endpoint = {
  GetCounter: 'api/counter',
  IncCounter: 'api/counter/inc',
  Init: 'api/init',
  SectorJoin: 'api/sector/join',
  Move: 'api/move',
```

Replace with:

```typescript
export const Endpoint = {
  GetCounter: 'api/counter',
  IncCounter: 'api/counter/inc',
  Init: 'api/init',
  PilotProfile: 'api/pilot/profile',
  PilotChooseLine: 'api/pilot/choose-line',
  Move: 'api/move',
```

Find:

```typescript
export const EndpointMethod = {
  [Endpoint.GetCounter]: 'GET',
  [Endpoint.IncCounter]: 'POST',
  [Endpoint.Init]: 'GET',
  [Endpoint.SectorJoin]: 'POST',
  [Endpoint.Move]: 'POST',
```

Replace with:

```typescript
export const EndpointMethod = {
  [Endpoint.GetCounter]: 'GET',
  [Endpoint.IncCounter]: 'POST',
  [Endpoint.Init]: 'GET',
  [Endpoint.PilotProfile]: 'GET',
  [Endpoint.PilotChooseLine]: 'POST',
  [Endpoint.Move]: 'POST',
```

- [ ] **Step 3: Verify it compiles, with expected errors**

Run: `npm run test:types`
Expected: errors in three files, all fixed later in this plan —
- `src/server/server.ts`: `SectorJoinReq`/`SectorJoinRsp` not found, `Endpoint.SectorJoin` not found, and the `endpoint satisfies never` exhaustiveness check failing (two new `Endpoint` values have no `case` yet) — fixed by Task 5.
- `src/client/fetch.ts`: `SectorJoinReq`/`SectorJoinRsp` not found — fixed by Task 6.
- `src/client/scene.ts`: `fetchSectorJoin` not found (transitively, once Task 6 removes it) — fixed by Task 7.

Confirm there are no other errors.

- [ ] **Step 4: Commit**

```bash
git add src/shared/api.ts
git commit -m "Add pilot profile types and endpoints, remove SectorJoin"
```

---

### Task 2: Pure pilot-progression functions

**Files:**
- Create: `src/server/pilot.ts`
- Create: `src/server/pilot.test.ts`

**Interfaces:**
- Consumes: `ShipLine` from `../shared/api.ts` (pre-existing)
- Produces: `xpToNextLevel(level: number): number`; `levelForXp(totalXp: number): {level: number; xpIntoLevel: number; xpToNext: number}`; `applyDeathPenalty(credits: number): number`; `canChooseLine(profile: {line: ShipLine | null}): boolean`

- [ ] **Step 1: Write the failing tests**

Create `src/server/pilot.test.ts`:

```typescript
import assert from 'node:assert/strict'
import {test} from 'node:test'
import {
  applyDeathPenalty,
  canChooseLine,
  levelForXp,
  xpToNextLevel,
} from './pilot.ts'

test('xpToNextLevel grows with level', () => {
  assert.equal(xpToNextLevel(1), 100)
  assert.equal(xpToNextLevel(2), 263)
})

test('levelForXp stays at level 1 until the first threshold is crossed', () => {
  assert.deepEqual(levelForXp(0), {level: 1, xpIntoLevel: 0, xpToNext: 100})
  assert.deepEqual(levelForXp(99), {level: 1, xpIntoLevel: 99, xpToNext: 100})
})

test('levelForXp advances a level once its threshold is met, carrying the remainder', () => {
  assert.deepEqual(levelForXp(100), {level: 2, xpIntoLevel: 0, xpToNext: 263})
  assert.deepEqual(levelForXp(150), {level: 2, xpIntoLevel: 50, xpToNext: 263})
})

test('applyDeathPenalty takes a flat 10% of current credits', () => {
  assert.equal(applyDeathPenalty(100), 90)
  assert.equal(applyDeathPenalty(0), 0)
})

test('applyDeathPenalty floors the loss, so very low balances are untouched', () => {
  assert.equal(applyDeathPenalty(5), 5)
})

test('canChooseLine is true only before a line has ever been chosen', () => {
  assert.equal(canChooseLine({line: null}), true)
  assert.equal(canChooseLine({line: 'fighter'}), false)
})
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node --experimental-strip-types --no-warnings=ExperimentalWarning --test src/server/pilot.test.ts`
Expected: FAIL — `src/server/pilot.ts` doesn't exist yet.

- [ ] **Step 3: Create `src/server/pilot.ts` with the pure functions**

```typescript
import type {ShipLine} from '../shared/api.ts'

/** XP required to advance from `level` to `level + 1` — a gentle, ever-slowing climb rather than linear or explosive. */
export function xpToNextLevel(level: number): number {
  return Math.floor(100 * Math.pow(level, 1.4))
}

/** Turns a raw lifetime XP total into a displayable level and progress toward the next one. */
export function levelForXp(totalXp: number): {
  level: number
  xpIntoLevel: number
  xpToNext: number
} {
  let level = 1
  let remaining = totalXp
  let need = xpToNextLevel(level)
  while (remaining >= need) {
    remaining -= need
    level += 1
    need = xpToNextLevel(level)
  }
  return {level, xpIntoLevel: remaining, xpToNext: need}
}

const DEATH_PENALTY_PCT = 0.1

/** A flat percentage of current credits, floored at 0 — scales with a pilot's wealth instead of becoming trivial or crushing at the extremes. */
export function applyDeathPenalty(credits: number): number {
  return Math.max(0, credits - Math.floor(credits * DEATH_PENALTY_PCT))
}

/** One ship line per pilot, chosen once — no respeccing. */
export function canChooseLine(profile: {line: ShipLine | null}): boolean {
  return profile.line === null
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `node --experimental-strip-types --no-warnings=ExperimentalWarning --test src/server/pilot.test.ts`
Expected: PASS, all 6 tests.

- [ ] **Step 5: Commit**

```bash
git add src/server/pilot.ts src/server/pilot.test.ts
git commit -m "Add pure pilot progression functions: xpToNextLevel, levelForXp, applyDeathPenalty, canChooseLine"
```

---

### Task 3: Redis-backed pilot profile functions

**Files:**
- Modify: `src/server/pilot.ts`

**Interfaces:**
- Consumes: `PilotProfile`, `PilotProfileRsp` from `../shared/api.ts` (Task 1); `canChooseLine`, `levelForXp` from this file (Task 2)
- Produces: `getOrCreatePilotProfile(userId: string, username: string, migrateLine?: ShipLine): Promise<PilotProfileRsp>`; `chooseLine(userId: string, username: string, line: ShipLine): Promise<PilotProfileRsp>`

- [ ] **Step 1: Add the `redis` import and profile/counter key helpers**

Find in `src/server/pilot.ts`:

```typescript
import type {ShipLine} from '../shared/api.ts'

/** XP required to advance from `level` to `level + 1` — a gentle, ever-slowing climb rather than linear or explosive. */
export function xpToNextLevel(level: number): number {
```

Replace with:

```typescript
import {redis} from '@devvit/web/server'
import type {PilotProfile, PilotProfileRsp, ShipLine} from '../shared/api.ts'

const PILOTS_KEY = 'pilots'

function creditsKey(userId: string): string {
  return `pilot:${userId}:credits`
}

function xpKey(userId: string): string {
  return `pilot:${userId}:xp`
}

/** XP required to advance from `level` to `level + 1` — a gentle, ever-slowing climb rather than linear or explosive. */
export function xpToNextLevel(level: number): number {
```

- [ ] **Step 2: Add the Redis-backed functions, after `canChooseLine`**

Find:

```typescript
/** One ship line per pilot, chosen once — no respeccing. */
export function canChooseLine(profile: {line: ShipLine | null}): boolean {
  return profile.line === null
}
```

Replace with:

```typescript
/** One ship line per pilot, chosen once — no respeccing. */
export function canChooseLine(profile: {line: ShipLine | null}): boolean {
  return profile.line === null
}

async function readCredits(userId: string): Promise<number> {
  const v = await redis.get(creditsKey(userId))
  return v === undefined ? 0 : Number(v)
}

async function readXp(userId: string): Promise<number> {
  const v = await redis.get(xpKey(userId))
  return v === undefined ? 0 : Number(v)
}

/** Loads a pilot's stored profile as-is, creating a fresh one (line unset, or seeded from `migrateLine`) if this is their first-ever visit. Never touches the live credits/xp counters — callers merge those in separately. */
async function loadOrInitProfile(
  userId: string,
  username: string,
  migrateLine: ShipLine | undefined,
): Promise<PilotProfile> {
  const existing = await redis.hGet(PILOTS_KEY, userId)
  if (existing) {
    const profile = JSON.parse(existing) as PilotProfile
    profile.username = username
    await redis.hSet(PILOTS_KEY, {[userId]: JSON.stringify(profile)})
    return profile
  }
  const profile: PilotProfile = {
    userId,
    username,
    line: migrateLine ?? null,
    shipTier: 1,
    moduleInventory: [],
    equippedModuleIds: [null, null, null],
    createdAt: Date.now(),
  }
  await redis.hSet(PILOTS_KEY, {[userId]: JSON.stringify(profile)})
  return profile
}

async function mergeLiveCounters(
  profile: PilotProfile,
): Promise<PilotProfileRsp> {
  const [credits, xp] = await Promise.all([
    readCredits(profile.userId),
    readXp(profile.userId),
  ])
  return {...profile, credits, xp, ...levelForXp(xp)}
}

/**
 * Loads (or creates) a pilot's global profile. `migrateLine` seeds the
 * initial line for a pre-existing sector player who predates this feature,
 * so they aren't forced through the ship picker again — pass `undefined`
 * once a pilot might already have a profile of their own.
 */
export async function getOrCreatePilotProfile(
  userId: string,
  username: string,
  migrateLine?: ShipLine,
): Promise<PilotProfileRsp> {
  const profile = await loadOrInitProfile(userId, username, migrateLine)
  return mergeLiveCounters(profile)
}

/** Locks in a pilot's ship line, once. Throws if they've already chosen one. */
export async function chooseLine(
  userId: string,
  username: string,
  line: ShipLine,
): Promise<PilotProfileRsp> {
  const profile = await loadOrInitProfile(userId, username, undefined)
  if (!canChooseLine(profile)) throw new Error('line already chosen')
  const updated: PilotProfile = {...profile, line}
  await redis.hSet(PILOTS_KEY, {[userId]: JSON.stringify(updated)})
  return mergeLiveCounters(updated)
}
```

- [ ] **Step 3: Verify it compiles and existing tests still pass**

Run: `npm run test:types`
Expected: the same Task-1 errors persist in `server.ts`/`fetch.ts`/`scene.ts` (fixed in Tasks 5-7) — confirm no NEW errors from `pilot.ts` itself.

Run: `node --experimental-strip-types --no-warnings=ExperimentalWarning --test src/server/pilot.test.ts`
Expected: PASS, unchanged from Task 2 (these functions aren't unit tested — see Global Constraints).

- [ ] **Step 4: Commit**

```bash
git add src/server/pilot.ts
git commit -m "Add getOrCreatePilotProfile and chooseLine Redis-backed functions"
```

---

### Task 4: Wire `sector.ts` to the pilot profile, with migration

**Files:**
- Modify: `src/server/sector.ts`

**Interfaces:**
- Consumes: `getOrCreatePilotProfile` from `./pilot.ts` (Task 3)
- Produces: `peekSectorLine(postId: string, userId: string): Promise<ShipLine | undefined>`; `getOrCreatePlayer` now sources `line` from the profile

- [ ] **Step 1: Update imports**

Find in `src/server/sector.ts`:

```typescript
import {realtime, redis} from '@devvit/web/server'
import type {
  PlayerState,
  RealtimeMsg,
  ShipLine,
  WeaponMode,
} from '../shared/api.ts'
import {
  LASER_COOLDOWN_MS,
  LASER_RANGE,
  SHIP_LINES,
  TORPEDO_COOLDOWN_MS,
  TORPEDO_RANGE,
  TORPEDO_SPEED,
} from '../shared/api.ts'
```

Replace with:

```typescript
import {realtime, redis} from '@devvit/web/server'
import type {
  PlayerState,
  RealtimeMsg,
  ShipLine,
  WeaponMode,
} from '../shared/api.ts'
import {
  LASER_COOLDOWN_MS,
  LASER_RANGE,
  TORPEDO_COOLDOWN_MS,
  TORPEDO_RANGE,
  TORPEDO_SPEED,
} from '../shared/api.ts'
import {getOrCreatePilotProfile} from './pilot.ts'
```

(`SHIP_LINES` is dropped — its only use was `lineForUser`, removed in Step 3 below.)

- [ ] **Step 2: Remove `lineForUser`**

Find:

```typescript
/** Stable, deterministic starter-line assignment from a Reddit user id. */
function lineForUser(userId: string): ShipLine {
  let hash = 0
  for (let i = 0; i < userId.length; i++)
    hash = (hash * 31 + userId.charCodeAt(i)) >>> 0
  return SHIP_LINES[hash % SHIP_LINES.length] ?? 'fighter'
}

function randSpawn(): {x: number; y: number} {
```

Replace with:

```typescript
function randSpawn(): {x: number; y: number} {
```

- [ ] **Step 3: Replace `getOrCreatePlayer` and `setPlayerLine` with the profile-driven version plus `peekSectorLine`**

Find:

```typescript
/** Loads (or creates) a player's state within one sector. */
export async function getOrCreatePlayer(
  postId: string,
  userId: string,
  username: string,
  snoovatar: string | undefined,
): Promise<PlayerState> {
  const snoovatarOrNull = snoovatar ?? null
  const existing = await redis.hGet(playersKey(postId), userId)
  if (existing) {
    const p = JSON.parse(existing) as PlayerState
    p.username = username
    p.snoovatar = snoovatarOrNull
    p.lastLaserAt = p.lastLaserAt ?? 0
    p.lastTorpedoAt = p.lastTorpedoAt ?? 0
    p.team = p.team ?? null
    p.kills = p.kills ?? 0
    await redis.hSet(playersKey(postId), {[userId]: JSON.stringify(p)})
    const [hull, score, kills] = await Promise.all([
      readHull(postId, userId),
      readScore(postId, userId),
      readKills(postId, userId),
    ])
    return {...p, hull, score, kills}
  }
  const spawn = randSpawn()
  const player: PlayerState = {
    userId,
    username,
    snoovatar: snoovatarOrNull,
    line: lineForUser(userId),
    x: spawn.x,
    y: spawn.y,
    rotation: 0,
    hull: START_HULL,
    score: 0,
    kills: 0,
    lastLaserAt: 0,
    lastTorpedoAt: 0,
    lastAbilityAt: 0,
    abilityActiveUntil: 0,
    team: null,
  }
  await Promise.all([
    redis.hSet(playersKey(postId), {[userId]: JSON.stringify(player)}),
    redis.hSet(hullKey(postId), {[userId]: String(START_HULL)}),
    redis.hSet(scoreKey(postId), {[userId]: '0'}),
  ])
  return player
}

/** Sets (or changes) a player's chosen ship line, creating them first if this is their first visit. */
export async function setPlayerLine(
  postId: string,
  userId: string,
  username: string,
  snoovatar: string | undefined,
  line: ShipLine,
): Promise<PlayerState> {
  const player = await getOrCreatePlayer(postId, userId, username, snoovatar)
  player.line = line
  await redis.hSet(playersKey(postId), {[userId]: JSON.stringify(player)})
  return player
}
```

Replace with:

```typescript
/** Loads (or creates) a player's state within one sector. The ship line always comes from the pilot's persistent profile, never assigned locally. */
export async function getOrCreatePlayer(
  postId: string,
  userId: string,
  username: string,
  snoovatar: string | undefined,
): Promise<PlayerState> {
  const snoovatarOrNull = snoovatar ?? null
  // By the time /api/init runs, the client has already resolved (or chosen)
  // the pilot's line via /api/pilot/profile + /api/pilot/choose-line, so
  // profile.line should always be set here — the 'fighter' fallback only
  // guards against a client that skips straight to /api/init.
  const profile = await getOrCreatePilotProfile(userId, username)
  const line = profile.line ?? 'fighter'
  const existing = await redis.hGet(playersKey(postId), userId)
  if (existing) {
    const p = JSON.parse(existing) as PlayerState
    p.username = username
    p.snoovatar = snoovatarOrNull
    p.line = line
    p.lastLaserAt = p.lastLaserAt ?? 0
    p.lastTorpedoAt = p.lastTorpedoAt ?? 0
    p.team = p.team ?? null
    p.kills = p.kills ?? 0
    await redis.hSet(playersKey(postId), {[userId]: JSON.stringify(p)})
    const [hull, score, kills] = await Promise.all([
      readHull(postId, userId),
      readScore(postId, userId),
      readKills(postId, userId),
    ])
    return {...p, hull, score, kills}
  }
  const spawn = randSpawn()
  const player: PlayerState = {
    userId,
    username,
    snoovatar: snoovatarOrNull,
    line,
    x: spawn.x,
    y: spawn.y,
    rotation: 0,
    hull: START_HULL,
    score: 0,
    kills: 0,
    lastLaserAt: 0,
    lastTorpedoAt: 0,
    lastAbilityAt: 0,
    abilityActiveUntil: 0,
    team: null,
  }
  await Promise.all([
    redis.hSet(playersKey(postId), {[userId]: JSON.stringify(player)}),
    redis.hSet(hullKey(postId), {[userId]: String(START_HULL)}),
    redis.hSet(scoreKey(postId), {[userId]: '0'}),
  ])
  return player
}

/** Best-effort peek at a pre-existing sector player's line, read-only (creates nothing) — used once by the pilot-profile migration path so a player who predates this feature isn't forced through the ship picker again. */
export async function peekSectorLine(
  postId: string,
  userId: string,
): Promise<ShipLine | undefined> {
  const existing = await redis.hGet(playersKey(postId), userId)
  if (!existing) return undefined
  return (JSON.parse(existing) as PlayerState).line
}
```

- [ ] **Step 4: Verify it compiles, with expected errors**

Run: `npm run test:types`
Expected: the Task-1 errors in `fetch.ts`/`scene.ts` still persist (fixed in Tasks 6-7), **plus a new one** in `src/server/server.ts`: `setPlayerLine` is no longer exported from `sector.ts` — fixed by Task 5. Confirm no other new errors (in particular, no errors from `sector.ts` itself).

- [ ] **Step 5: Commit**

```bash
git add src/server/sector.ts
git commit -m "Source sector line assignment from the pilot profile, with migration for pre-existing players"
```

---

### Task 5: Server routing — `routePilotProfile`/`routePilotChooseLine`

**Files:**
- Modify: `src/server/server.ts`

**Interfaces:**
- Consumes: `getOrCreatePilotProfile`, `chooseLine` from `./pilot.ts` (Tasks 3); `peekSectorLine` from `./sector.ts` (Task 4); `ChooseLineReq`, `ChooseLineRsp`, `PilotProfileRsp` from `../shared/api.ts` (Task 1)
- Produces: `routePilotProfile(): Promise<PilotProfileRsp | ErrorRsp>`; `routePilotChooseLine(reqMsg): Promise<ChooseLineRsp | ErrorRsp>`

- [ ] **Step 1: Update the `../shared/api.ts` type imports**

Find in `src/server/server.ts`:

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

Replace with:

```typescript
import {
  type ChallengeAction,
  type ChallengeStateRsp,
  type ChooseLineReq,
  type ChooseLineRsp,
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
  type PilotProfileRsp,
  type PostKind,
  type RespondChallengeReq,
  type RespondChallengeRsp,
  type ScoreReq,
  type ScoreRsp,
  type ScrimmageJoinReq,
  type ScrimmageJoinRsp,
  SHIP_LINES,
  SQUAD_PRESETS,
  SQUAD_RULES,
  WEAPON_MODES,
} from '../shared/api.ts'
```

- [ ] **Step 2: Update the `./pilot.ts` and `./sector.ts` imports**

Find:

```typescript
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
```

Replace with:

```typescript
import {chooseLine, getOrCreatePilotProfile} from './pilot.ts'
import {
  addScore,
  announceJoin,
  fireWeapon,
  getOrCreatePlayer,
  leaveSector,
  listOtherPlayers,
  movePlayer,
  peekSectorLine,
  pulseActiveSectors,
  sectorChannel,
  topPilots,
  touchActiveSector,
} from './sector.ts'
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
```

Replace with:

```typescript
type AnyRsp =
  | GetCounterRsp
  | IncCounterRsp
  | InitRsp
  | PilotProfileRsp
  | ChooseLineRsp
  | MoveRsp
```

- [ ] **Step 4: Replace the `Endpoint.SectorJoin` case with the two new cases**

Find:

```typescript
      case Endpoint.SectorJoin:
        rsp = await routeSectorJoin(reqMsg)
        break
```

Replace with:

```typescript
      case Endpoint.PilotProfile:
        rsp = await routePilotProfile()
        break
      case Endpoint.PilotChooseLine:
        rsp = await routePilotChooseLine(reqMsg)
        break
```

- [ ] **Step 5: Replace `routeSectorJoin` with `routePilotProfile`/`routePilotChooseLine`**

Find:

```typescript
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
```

Replace with:

```typescript
async function routePilotProfile(): Promise<PilotProfileRsp | ErrorRsp> {
  const postId = context.postId
  const userId = context.userId
  if (!postId) return {error: 'no postId', status: 400}
  if (!userId) return {error: 'must be logged in', status: 401}
  const username = context.username ?? 'anonymous'
  const migrateLine = await peekSectorLine(postId, userId)
  return await getOrCreatePilotProfile(userId, username, migrateLine)
}

async function routePilotChooseLine(
  reqMsg: IncomingMessage,
): Promise<ChooseLineRsp | ErrorRsp> {
  const userId = context.userId
  if (!userId) return {error: 'must be logged in', status: 401}
  const username = context.username ?? 'anonymous'
  const req = await readJson<ChooseLineReq>(reqMsg)
  if (!SHIP_LINES.includes(req.line)) {
    return {error: 'invalid ship line', status: 400}
  }
  try {
    return await chooseLine(userId, username, req.line)
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    return {error: msg, status: 409}
  }
}
```

- [ ] **Step 6: Verify it compiles**

Run: `npm run test:types`
Expected: `server.ts` is now clean. The Task-1 errors in `fetch.ts`/`scene.ts` still persist (fixed in Tasks 6-7) — confirm no other new errors.

- [ ] **Step 7: Commit**

```bash
git add src/server/server.ts
git commit -m "Replace routeSectorJoin with routePilotProfile and routePilotChooseLine"
```

---

### Task 6: Client fetch wrappers

**Files:**
- Modify: `src/client/fetch.ts`

**Interfaces:**
- Consumes: `ChooseLineReq`, `ChooseLineRsp`, `PilotProfileRsp` from `../shared/api.ts` (Task 1)
- Produces: `fetchPilotProfile(): Promise<PilotProfileRsp | ErrorRsp>`; `fetchPilotChooseLine(req: ChooseLineReq): Promise<ChooseLineRsp | ErrorRsp>`

- [ ] **Step 1: Update the type imports**

Find in `src/client/fetch.ts`:

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

Replace with:

```typescript
import {
  type ChallengeStateRsp,
  type ChooseLineReq,
  type ChooseLineRsp,
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
  type PilotProfileRsp,
  type RespondChallengeReq,
  type RespondChallengeRsp,
  type ScoreReq,
  type ScoreRsp,
  type ScrimmageJoinReq,
  type ScrimmageJoinRsp,
} from '../shared/api.ts'
```

- [ ] **Step 2: Remove `fetchSectorJoin`**

Find:

```typescript
export function fetchSectorJoin(
  req: SectorJoinReq,
): Promise<SectorJoinRsp | ErrorRsp> {
  return postJsonOrError<SectorJoinReq, SectorJoinRsp>(Endpoint.SectorJoin, req)
}

export function fetchLeave(): Promise<Response> {
```

Replace with:

```typescript
export function fetchLeave(): Promise<Response> {
```

- [ ] **Step 3: Add `fetchPilotProfile`/`fetchPilotChooseLine`, alongside the other `getJsonOrError`/`postJsonOrError`-based fetchers**

Find:

```typescript
export function fetchChallengeState(): Promise<ChallengeStateRsp | ErrorRsp> {
  return getJsonOrError<ChallengeStateRsp>(Endpoint.ChallengeState)
}

export function fetchMatchJoin(
```

Replace with:

```typescript
export function fetchChallengeState(): Promise<ChallengeStateRsp | ErrorRsp> {
  return getJsonOrError<ChallengeStateRsp>(Endpoint.ChallengeState)
}

export function fetchPilotProfile(): Promise<PilotProfileRsp | ErrorRsp> {
  return getJsonOrError<PilotProfileRsp>(Endpoint.PilotProfile)
}

export function fetchPilotChooseLine(
  req: ChooseLineReq,
): Promise<ChooseLineRsp | ErrorRsp> {
  return postJsonOrError<ChooseLineReq, ChooseLineRsp>(
    Endpoint.PilotChooseLine,
    req,
  )
}

export function fetchMatchJoin(
```

- [ ] **Step 4: Verify it compiles**

Run: `npm run test:types`
Expected: `fetch.ts` is now clean. Only the Task-1 error in `scene.ts` still persists (fixed in Task 7) — confirm no other new errors.

- [ ] **Step 5: Commit**

```bash
git add src/client/fetch.ts
git commit -m "Replace fetchSectorJoin with fetchPilotProfile and fetchPilotChooseLine"
```

---

### Task 7: Client scene — profile-driven ship-picker skip

**Files:**
- Modify: `src/client/scene.ts`

**Interfaces:**
- Consumes: `fetchPilotProfile`, `fetchPilotChooseLine` from `./fetch.ts` (Task 6)

- [ ] **Step 1: Update the `./fetch.ts` imports**

Find in `src/client/scene.ts`:

```typescript
import {
  fetchFire,
  fetchInit,
  fetchLeaderboard,
  fetchLeave,
  fetchMove,
  fetchScore,
  fetchSectorJoin,
  isErrorRsp,
} from './fetch.ts'
```

Replace with:

```typescript
import {
  fetchFire,
  fetchInit,
  fetchLeaderboard,
  fetchLeave,
  fetchMove,
  fetchPilotChooseLine,
  fetchPilotProfile,
  fetchScore,
  isErrorRsp,
} from './fetch.ts'
```

- [ ] **Step 2: Stop showing the picker unconditionally at the top of `create()`**

Find:

```typescript
  async create(): Promise<void> {
    const W = this.scale.width
    const H = this.scale.height

    const chosenLine = await this.showShipPicker()

    // Starfield — pre-rolled positions, drawn once, cheap.
```

Replace with:

```typescript
  async create(): Promise<void> {
    const W = this.scale.width
    const H = this.scale.height

    // Starfield — pre-rolled positions, drawn once, cheap.
```

- [ ] **Step 3: Replace the join call with the profile-driven resolution**

Find:

```typescript
    kb.on('keydown-L', () => void this.toggleLeaderboard())

    const joined = await fetchSectorJoin({line: chosenLine})
    if (isErrorRsp(joined)) {
      this.hudName.setText('Failed to join — reload to retry')
      return
    }
    const init = await fetchInit()
    if (!init) {
      this.hudName.setText('Failed to connect — reload to retry')
      return
    }
```

Replace with:

```typescript
    kb.on('keydown-L', () => void this.toggleLeaderboard())

    const profile = await fetchPilotProfile()
    if (isErrorRsp(profile)) {
      this.hudName.setText('Failed to connect — reload to retry')
      return
    }
    if (profile.line === null) {
      const chosenLine = await this.showShipPicker()
      const chosen = await fetchPilotChooseLine({line: chosenLine})
      if (isErrorRsp(chosen)) {
        this.hudName.setText('Failed to join — reload to retry')
        return
      }
    }

    const init = await fetchInit()
    if (!init) {
      this.hudName.setText('Failed to connect — reload to retry')
      return
    }
```

- [ ] **Step 4: Verify the full test suite passes**

Run: `npm run test`
Expected: PASS — `test:types`, `lint`, `test:unit`, and `build` all succeed with zero errors. This closes out Phase 1: a pilot's chosen line now survives across sector posts, and returning (pre-migration) players are seeded in automatically instead of re-picking.

- [ ] **Step 5: Commit**

```bash
git add src/client/scene.ts
git commit -m "Skip the ship picker once a pilot's line is already set on their profile"
```

---

## Phase 2 — Combat rewards + death penalty

Hits and kills in Sector Mode now grant XP/credits to the pilot's profile; dying costs a small percentage of credits. Battle Mode is untouched — none of this is wired into `match.ts`/`challenge.ts`.

### Task 8: `grantCombatReward`/`applyDeathPenaltyFor`

**Files:**
- Modify: `src/server/pilot.ts`

**Interfaces:**
- Consumes: `applyDeathPenalty`, `creditsKey`/`xpKey` (private, this file, Tasks 2-3)
- Produces: `grantCombatReward(userId: string, kind: 'hit' | 'kill'): Promise<{xpGained: number; creditsGained: number}>`; `applyDeathPenaltyFor(userId: string): Promise<void>`

- [ ] **Step 1: Add the reward table and functions, after `chooseLine`**

Find in `src/server/pilot.ts`:

```typescript
/** Locks in a pilot's ship line, once. Throws if they've already chosen one. */
export async function chooseLine(
  userId: string,
  username: string,
  line: ShipLine,
): Promise<PilotProfileRsp> {
  const profile = await loadOrInitProfile(userId, username, undefined)
  if (!canChooseLine(profile)) throw new Error('line already chosen')
  const updated: PilotProfile = {...profile, line}
  await redis.hSet(PILOTS_KEY, {[userId]: JSON.stringify(updated)})
  return mergeLiveCounters(updated)
}
```

Replace with:

```typescript
/** Locks in a pilot's ship line, once. Throws if they've already chosen one. */
export async function chooseLine(
  userId: string,
  username: string,
  line: ShipLine,
): Promise<PilotProfileRsp> {
  const profile = await loadOrInitProfile(userId, username, undefined)
  if (!canChooseLine(profile)) throw new Error('line already chosen')
  const updated: PilotProfile = {...profile, line}
  await redis.hSet(PILOTS_KEY, {[userId]: JSON.stringify(updated)})
  return mergeLiveCounters(updated)
}

const COMBAT_REWARDS: Record<'hit' | 'kill', {xp: number; credits: number}> = {
  hit: {xp: 2, credits: 1},
  kill: {xp: 15, credits: 10},
}

/** Credits/XP for a Sector Mode hit or kill — atomic INCRBY, safe even if the same pilot is active in two sector posts at once. Returns the amounts granted, for the caller to relay in a realtime toast. */
export async function grantCombatReward(
  userId: string,
  kind: 'hit' | 'kill',
): Promise<{xpGained: number; creditsGained: number}> {
  const reward = COMBAT_REWARDS[kind]
  await Promise.all([
    redis.incrBy(creditsKey(userId), reward.credits),
    redis.incrBy(xpKey(userId), reward.xp),
  ])
  return {xpGained: reward.xp, creditsGained: reward.credits}
}

/** Applies the small currency-loss death penalty, atomically. */
export async function applyDeathPenaltyFor(userId: string): Promise<void> {
  const credits = await readCredits(userId)
  const penalized = applyDeathPenalty(credits)
  const delta = penalized - credits
  if (delta !== 0) await redis.incrBy(creditsKey(userId), delta)
}
```

- [ ] **Step 2: Verify it compiles and existing tests still pass**

Run: `npm run test:types && npm run test:unit`
Expected: both PASS — no lingering expected errors from Phase 1 (Task 7 closed those out).

- [ ] **Step 3: Commit**

```bash
git add src/server/pilot.ts
git commit -m "Add grantCombatReward and applyDeathPenaltyFor"
```

---

### Task 9: `pilot_reward` realtime message

**Files:**
- Modify: `src/shared/api.ts`

**Interfaces:**
- Produces: `RealtimeMsg` gains `{type: 'pilot_reward'; userId: string; kind: 'hit' | 'kill'; xpGained: number; creditsGained: number}`

- [ ] **Step 1: Add the new `RealtimeMsg` variant**

Find in `src/shared/api.ts`:

```typescript
  | {type: 'hit'; targetUserId: string; shooterUserId: string; hull: number}
  | {type: 'miss'; x: number; y: number}
  | {type: 'respawn'; player: PlayerState}
```

Replace with:

```typescript
  | {type: 'hit'; targetUserId: string; shooterUserId: string; hull: number}
  | {type: 'miss'; x: number; y: number}
  | {type: 'respawn'; player: PlayerState}
  | {
      type: 'pilot_reward'
      userId: string
      kind: 'hit' | 'kill'
      xpGained: number
      creditsGained: number
    }
```

- [ ] **Step 2: Verify it compiles**

Run: `npm run test:types`
Expected: PASS — this is a purely additive union member; nothing yet constructs or switches on it.

- [ ] **Step 3: Commit**

```bash
git add src/shared/api.ts
git commit -m "Add pilot_reward realtime message type"
```

---

### Task 10: Wire rewards and the death penalty into `sector.ts`'s `applyDamage`

**Files:**
- Modify: `src/server/sector.ts`

**Interfaces:**
- Consumes: `grantCombatReward`, `applyDeathPenaltyFor` from `./pilot.ts` (Task 8)

- [ ] **Step 1: Update the `./pilot.ts` import**

Find in `src/server/sector.ts`:

```typescript
import {getOrCreatePilotProfile} from './pilot.ts'
```

Replace with:

```typescript
import {
  applyDeathPenaltyFor,
  getOrCreatePilotProfile,
  grantCombatReward,
} from './pilot.ts'
```

- [ ] **Step 2: Grant rewards and apply the death penalty in `applyDamage`**

Find:

```typescript
async function applyDamage(
  postId: string,
  subredditId: string,
  shooterId: string,
  shooterUsername: string,
  target: PlayerState,
  damage: number,
): Promise<void> {
  const hull = Math.max(
    0,
    await redis.hIncrBy(hullKey(postId), target.userId, -damage),
  )
  await broadcast(postId, {
    type: 'hit',
    targetUserId: target.userId,
    shooterUserId: shooterId,
    hull,
  })

  if (hull > 0) {
    await addScore(postId, subredditId, shooterId, shooterUsername, HIT_SCORE)
    return
  }

  await addScore(postId, subredditId, shooterId, shooterUsername, KILL_SCORE)
  await addKill(postId, subredditId, shooterId, shooterUsername)
  const spawn = randSpawn()
```

Replace with:

```typescript
async function applyDamage(
  postId: string,
  subredditId: string,
  shooterId: string,
  shooterUsername: string,
  target: PlayerState,
  damage: number,
): Promise<void> {
  const hull = Math.max(
    0,
    await redis.hIncrBy(hullKey(postId), target.userId, -damage),
  )
  await broadcast(postId, {
    type: 'hit',
    targetUserId: target.userId,
    shooterUserId: shooterId,
    hull,
  })

  if (hull > 0) {
    await addScore(postId, subredditId, shooterId, shooterUsername, HIT_SCORE)
    await broadcastPilotReward(postId, shooterId, 'hit')
    return
  }

  await addScore(postId, subredditId, shooterId, shooterUsername, KILL_SCORE)
  await addKill(postId, subredditId, shooterId, shooterUsername)
  await broadcastPilotReward(postId, shooterId, 'kill')
  await applyDeathPenaltyFor(target.userId)
  const spawn = randSpawn()
```

- [ ] **Step 3: Add the `broadcastPilotReward` helper, right after `applyDamage`**

Find:

```typescript
  await redis.hSet(playersKey(postId), {
    [target.userId]: JSON.stringify(respawned),
  })
  await broadcast(postId, {type: 'respawn', player: respawned})
}

async function broadcast(postId: string, msg: RealtimeMsg): Promise<void> {
```

Replace with:

```typescript
  await redis.hSet(playersKey(postId), {
    [target.userId]: JSON.stringify(respawned),
  })
  await broadcast(postId, {type: 'respawn', player: respawned})
}

/** Grants Sector Mode combat XP/credits and tells the earning pilot's own client so it can show a toast — every other client on the channel gets the same message but ignores it, since the `userId` isn't theirs. */
async function broadcastPilotReward(
  postId: string,
  userId: string,
  kind: 'hit' | 'kill',
): Promise<void> {
  const {xpGained, creditsGained} = await grantCombatReward(userId, kind)
  await broadcast(postId, {
    type: 'pilot_reward',
    userId,
    kind,
    xpGained,
    creditsGained,
  })
}

async function broadcast(postId: string, msg: RealtimeMsg): Promise<void> {
```

- [ ] **Step 4: Verify the full test suite passes**

Run: `npm run test`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/server/sector.ts
git commit -m "Grant pilot combat rewards and apply the death penalty in Sector Mode"
```

---

### Task 11: Client toast for `pilot_reward`

**Files:**
- Modify: `src/client/scene.ts`

**Interfaces:**
- Consumes: `showPulse` (private, this file — already exists)

- [ ] **Step 1: Handle `pilot_reward` in `handleRealtime`**

Find in `src/client/scene.ts`:

```typescript
    } else if (msg.type === 'kills' && msg.userId === this.player?.userId) {
      if (this.player) {
        this.player.kills = msg.kills
        this.updateScoreHud()
      }
    } else if (msg.type === 'pulse') {
```

Replace with:

```typescript
    } else if (msg.type === 'kills' && msg.userId === this.player?.userId) {
      if (this.player) {
        this.player.kills = msg.kills
        this.updateScoreHud()
      }
    } else if (
      msg.type === 'pilot_reward' &&
      msg.userId === this.player?.userId
    ) {
      this.showPulse(`+${msg.xpGained} XP   +${msg.creditsGained} CR`)
    } else if (msg.type === 'pulse') {
```

- [ ] **Step 2: Verify the full test suite passes**

Run: `npm run test`
Expected: PASS. This closes out Phase 2 — combat now visibly rewards the pilot's persistent profile, and only the earning pilot's own client shows the toast.

- [ ] **Step 3: Commit**

```bash
git add src/client/scene.ts
git commit -m "Show a toast for the pilot's own combat rewards"
```

---

## Phase 3 — Read-only HUD

A togglable "PILOT" panel shows level/XP/credits/ship tier, sourced from `GET /api/pilot/profile`. Fully additive — no server changes.

### Task 12: PILOT HUD panel

**Files:**
- Modify: `src/client/scene.ts`

**Interfaces:**
- Consumes: `fetchPilotProfile` from `./fetch.ts` (already imported, Task 7)

- [ ] **Step 1: Add panel state fields**

Find in `src/client/scene.ts`:

```typescript
  private leaderboardPanel!: Phaser.GameObjects.Text
  private leaderboardOpen = false
  private hudPulse!: Phaser.GameObjects.Text
```

Replace with:

```typescript
  private leaderboardPanel!: Phaser.GameObjects.Text
  private leaderboardOpen = false
  private pilotPanel!: Phaser.GameObjects.Text
  private pilotPanelOpen = false
  private hudPulse!: Phaser.GameObjects.Text
```

- [ ] **Step 2: Add "[P] PILOT" to the on-screen key hint**

Find:

```typescript
    this.add
      .text(
        W - 12,
        H - 12,
        '[SPACE] LASER  ·  [E] MISSILE  ·  [L] LEADERBOARD',
        {
```

Replace with:

```typescript
    this.add
      .text(
        W - 12,
        H - 12,
        '[SPACE] LASER  ·  [E] MISSILE  ·  [L] LEADERBOARD  ·  [P] PILOT',
        {
```

- [ ] **Step 3: Add a touch button for the panel, alongside the existing leaderboard button**

Find:

```typescript
    if (isTouchDevice()) {
      this.joystick = new VirtualJoystick(this, 110, H - 110, 70)
      this.touchMissile = new TouchButton(this, W - 70, H - 70, 34, 'MSL')
      this.touchLaser = new TouchButton(this, W - 160, H - 70, 34, 'LSR')
      new TouchButton(
        this,
        W - 115,
        H - 160,
        34,
        'LDR',
        () => void this.toggleLeaderboard(),
      )
    }
```

Replace with:

```typescript
    if (isTouchDevice()) {
      this.joystick = new VirtualJoystick(this, 110, H - 110, 70)
      this.touchMissile = new TouchButton(this, W - 70, H - 70, 34, 'MSL')
      this.touchLaser = new TouchButton(this, W - 160, H - 70, 34, 'LSR')
      new TouchButton(
        this,
        W - 115,
        H - 160,
        34,
        'LDR',
        () => void this.toggleLeaderboard(),
      )
      new TouchButton(
        this,
        W - 115,
        H - 210,
        34,
        'PLT',
        () => void this.togglePilotPanel(),
      )
    }
```

- [ ] **Step 4: Create the panel and its keybinding, alongside the leaderboard panel**

Find:

```typescript
    this.leaderboardPanel = this.add
      .text(W / 2, H / 2, '', {
        fontFamily: 'monospace',
        fontSize: '13px',
        color: '#eef6ff',
        align: 'center',
        backgroundColor: '#050c18',
        padding: {x: 18, y: 14},
      })
      .setOrigin(0.5, 0.5)
      .setScrollFactor(0)
      .setDepth(60)
      .setVisible(false)
    kb.on('keydown-L', () => void this.toggleLeaderboard())
```

Replace with:

```typescript
    this.leaderboardPanel = this.add
      .text(W / 2, H / 2, '', {
        fontFamily: 'monospace',
        fontSize: '13px',
        color: '#eef6ff',
        align: 'center',
        backgroundColor: '#050c18',
        padding: {x: 18, y: 14},
      })
      .setOrigin(0.5, 0.5)
      .setScrollFactor(0)
      .setDepth(60)
      .setVisible(false)
    kb.on('keydown-L', () => void this.toggleLeaderboard())

    this.pilotPanel = this.add
      .text(W / 2, H / 2, '', {
        fontFamily: 'monospace',
        fontSize: '13px',
        color: '#eef6ff',
        align: 'center',
        backgroundColor: '#050c18',
        padding: {x: 18, y: 14},
      })
      .setOrigin(0.5, 0.5)
      .setScrollFactor(0)
      .setDepth(60)
      .setVisible(false)
    kb.on('keydown-P', () => void this.togglePilotPanel())
```

- [ ] **Step 5: Add `togglePilotPanel`, alongside `toggleLeaderboard`**

Find:

```typescript
    this.leaderboardPanel.setText(`TOP PILOTS\n\n${lines}`)
  }

  private showPulse(text: string): void {
```

Replace with:

```typescript
    this.leaderboardPanel.setText(`TOP PILOTS\n\n${lines}`)
  }

  private async togglePilotPanel(): Promise<void> {
    this.pilotPanelOpen = !this.pilotPanelOpen
    if (!this.pilotPanelOpen) {
      this.pilotPanel.setVisible(false)
      return
    }
    this.pilotPanel.setText('Loading…').setVisible(true)
    const profile = await fetchPilotProfile()
    if (!this.pilotPanelOpen) return // toggled off while awaiting
    if (isErrorRsp(profile)) {
      this.pilotPanel.setText('PILOT\n\nFailed to load.')
      return
    }
    this.pilotPanel.setText(
      `PILOT\n\nLEVEL ${profile.level}   (${profile.xpIntoLevel}/${profile.xpToNext} XP)\nCREDITS ${profile.credits}\nSHIP TIER  Mk.${profile.shipTier}`,
    )
  }

  private showPulse(text: string): void {
```

- [ ] **Step 6: Verify the full test suite passes**

Run: `npm run test`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add src/client/scene.ts
git commit -m "Add a read-only PILOT HUD panel showing level, XP, credits, and ship tier"
```

---

Each phase leaves the game in a working, testable state: Phase 1 makes a pilot's line persistent, Phase 2 makes combat feed it, Phase 3 makes it visible. `moduleInventory`/`equippedModuleIds`/`shipTier` exist on the profile throughout but stay inert until the module-catalog and ship-tier-economy specs (sub-projects #2/#3) land.
