# Sector Pirate Mission Engine (Starbase Defense) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give every new Sector post a randomly-assigned mission theme and ship the first one end-to-end: `starbase-defense` — escalating pirate waves (3-8, the last always a capital-ship boss) attacking a stationary starbase, with players able to fight both the pirates and, per the prior plan, each other, using their real ship kit.

**Architecture:** A new `src/server/mission.ts` module owns everything pirate/mission-specific (Mission state, NPC roster, wave spawning/advancement, win/loss), the same way `pilot.ts` owns the persistent-profile concern — `sector.ts` keeps owning player state and only exports the few pieces `mission.ts` needs to touch a player (damage, respawn) or read shared tuning (`HITSCAN_TUNING`, `WORLD_HALF`). NPC "AI" has no dedicated scheduler — it piggybacks on the exact same `movePlayer`/`fireWeapon` traffic the weapon/ability plan already routes through, per the design spec's Part 3. Every concurrency-sensitive value (NPC hull, the starbase's hull, the "who gets to advance the wave" race) uses a dedicated atomic Redis key, mirroring the exact pattern already proven for player hull/credits/XP in this codebase.

**Tech Stack:** TypeScript, Devvit Web (`@devvit/web/server`/`client`), Redis, Phaser (client sector scene), `node:test`, Biome, esbuild.

## Global Constraints

- Design spec: `docs/superpowers/specs/2026-07-28-solo-pve-sector-content-design.md`. This plan builds only the `starbase-defense` theme end-to-end — `mining-raid`, `escort-repair`, `cargo-recovery`, `salvage-race`, and module loot (`grantLootModule`) are explicitly out of scope, planned separately after this ships.
- Battle Mode (`src/server/match.ts`, `src/server/challenge.ts`) is **never modified** by this plan.
- **Every new sector gets a theme, once, at creation, for its lifetime.** A resolved mission (won or lost) reverts that sector to plain PvP permanently — it does not regenerate. Sectors created before this plan (which never set `postData` at all — confirmed: `{kind: 'sector'}` is never actually constructed anywhere in the current codebase, only declared as a type) have no theme and are unaffected; `getPostKind()` returning `undefined` is the signal for "legacy, no mission."
- **Concurrency**: NPC hull, the starbase's hull, and "which request gets to advance the wave" each use a dedicated atomic Redis key (`redis.hIncrBy`/`incrBy`, or a claim-via-`hIncrBy`-to-1 pattern) — never a read-modify-write on the shared `Mission` JSON blob. NPC *position* (cosmetic, self-correcting every tick) is the one piece allowed to be eventually-consistent under concurrent ticks, exactly as player position already is.
- No permadeath anywhere — a player killed by a pirate NPC respawns exactly like a PvP death (same hull reset, same `applyDeathPenaltyFor` credit loss), it just isn't scored as anyone else's PvP kill.
- Codebase style: Biome-formatted (single quotes, no semicolons, 2-space indent, trailing commas). `npm run test` = `test:types && lint && test:unit && build`, lint uses `--error-on-warnings` — run the full `npm run test` before calling a task done.
- Pure logic gets `node:test` coverage (following `abilities.ts`/`pilot.ts`'s precedent); Redis-backed functions are not unit-tested in this codebase (no mocking).

---

## File Structure

- **Modify** `src/shared/api.ts` — `SectorTheme`, `PostKind`'s `sector` variant gains `theme`, `NpcKind`/`NpcState`, `Mission` (stored) and `MissionRsp` (API-facing, with the live NPC roster merged in), a new `mission_state` `RealtimeMsg` variant, `InitRsp` gains `mission: MissionRsp | null`.
- **Modify** `src/server/sector.ts` — exports `HITSCAN_TUNING` and `WORLD_HALF` for `mission.ts` to reuse; new exported `applyNpcDamageToPlayer`; `fireWeapon`'s hitscan and torpedo branches gain NPC targeting alongside player targeting; `movePlayer`/`fireWeapon` each call `tickMission` once.
- **Create** `src/server/mission.ts` — theme assignment, Mission/NPC Redis CRUD, wave spawning, win/loss evaluation, the reactive tick, player-damages-NPC handling.
- **Create** `src/server/mission.test.ts` — unit tests for the pure functions (`raidersInWave`, `evaluateMissionOutcome`).
- **Modify** `src/server/server.ts` — `routeMenuNewPost` assigns a random theme at creation; `routeInit` attaches the sector's `MissionRsp` (creating it on first load if the sector is themed and none exists yet).
- **Modify** `src/client/scene.ts` — loads pirate/starbase art, renders NPCs and the starbase with a hull bar, a MISSION HUD line, and reacts to `mission_state` broadcasts.

---

### Task 1: Shared types — theme, NPC/Mission data model, realtime message, InitRsp

**Files:**
- Modify: `src/shared/api.ts`

**Interfaces:**
- Produces: `SectorTheme`; `PostKind`'s `{kind: 'sector'; theme: SectorTheme}`; `NpcKind = 'raider' | 'capital'`; `NpcState`; `Mission`; `MissionRsp = Mission & {npcs: NpcState[]}`; `RealtimeMsg` gains `{type: 'mission_state'; mission: MissionRsp}`; `InitRsp` gains `mission: MissionRsp | null`.

- [ ] **Step 1: Replace `PostKind`'s bare `sector` variant with the themed one, and add `SectorTheme` right above it**

Find in `src/shared/api.ts`:

```typescript
/** postData.kind tags what a given post is, read via context.postData on both client and server. */
export type PostKind =
  | {kind: 'sector'}
  | {kind: 'challenge-setup'}
```

Replace with:

```typescript
/**
 * A sector's mission theme, assigned once at creation, for the sector's
 * lifetime. A plain string union rather than a hardcoded pirate assumption —
 * a future non-pirate theme just adds a new value. Sectors created before
 * this existed never had `postData` set at all (`getPostKind()` returns
 * `undefined` for them), which is exactly the signal for "no mission."
 */
export type SectorTheme = 'starbase-defense'

/** postData.kind tags what a given post is, read via context.postData on both client and server. */
export type PostKind =
  | {kind: 'sector'; theme: SectorTheme}
  | {kind: 'challenge-setup'}
```

- [ ] **Step 2: Add the NPC/Mission data model, right after `InitRsp`**

Find:

```typescript
/** Sent once on load: your own state, plus everyone else currently present. */
export type InitRsp = {
  postId: string
  channel: string
  player: PlayerState
  others: PlayerState[]
}
```

Replace with:

```typescript
/** Sent once on load: your own state, plus everyone else currently present. */
export type InitRsp = {
  postId: string
  channel: string
  player: PlayerState
  others: PlayerState[]
  mission: MissionRsp | null
}

/** 'raider' = a regular wave pirate. 'capital' = the boss, exactly one, only on the final wave. */
export type NpcKind = 'raider' | 'capital'

/** One hostile currently alive in a sector's mission. `weapon` excludes 'torpedo' — NPCs are only ever assigned a hitscan weapon (see mission.ts's RAIDER_WEAPONS/CAPITAL_WEAPON), so this matches HITSCAN_TUNING's own key type exactly and lets mission.ts index it directly. */
export type NpcState = {
  npcId: string
  kind: NpcKind
  x: number
  y: number
  rotation: number
  hull: number
  maxHull: number
  weapon: Exclude<WeaponMode, 'torpedo'>
  lastFiredAt: number
  targetUserId: string | null // null means "closing on/attacking the starbase," not a player
}

/**
 * A sector's mission progress. Hull values live in dedicated atomic Redis
 * keys, not here — see mission.ts — so this is only the rarely-changing
 * bookkeeping. `theme`-specific objective fields (only `starbase-defense`'s
 * for now) are flat fields rather than a discriminated union, since only one
 * theme exists; a second theme is the natural point to introduce the union.
 */
export type Mission = {
  theme: SectorTheme
  wave: number // 1-based; the last wave is always the boss
  totalWaves: number // randomly rolled 3-8 at mission start
  participants: string[] // userIds who've dealt NPC damage — loot eligibility (later plan)
  status: 'active' | 'won' | 'lost'
  starbaseMaxHull: number
  lastTickAt: number
}

/** `Mission` merged with the live NPC roster and hull values — what the client actually reads. */
export type MissionRsp = Mission & {
  npcs: NpcState[]
  starbaseHull: number
}
```

- [ ] **Step 3: Add the `mission_state` realtime message, after `flak_intercept`**

Find:

```typescript
  | {type: 'ability'; userId: string; line: ShipLine}
  | {type: 'flak_intercept'; userId: string; x: number; y: number}
```

Replace with:

```typescript
  | {type: 'ability'; userId: string; line: ShipLine}
  | {type: 'flak_intercept'; userId: string; x: number; y: number}
  | {type: 'mission_state'; mission: MissionRsp}
```

- [ ] **Step 4: Verify it compiles**

Run: `npm run test:types`
Expected: errors in `src/server/server.ts`'s `routeMenuNewPost` (the `reddit.submitCustomPost` call doesn't set `postData` at all, which is fine at the type level since `postData` isn't required there — actually expect no error from that) and in `src/server/server.ts`'s `getPostKind`/`InitRsp`-constructing code (`routeInit` doesn't yet return a `mission` field, which the widened `InitRsp` type now requires). Confirm `src/shared/api.ts` itself is clean, and the only error anywhere is `routeInit`'s now-incomplete `InitRsp` object literal (missing `mission`) — fixed in Task 8, not this dispatch.

- [ ] **Step 5: Commit**

```bash
git add src/shared/api.ts
git commit -m "Add SectorTheme, NPC/Mission data model, and mission_state realtime message"
```

---

### Task 2: Pure mission logic + tests

**Files:**
- Create: `src/server/mission.ts`
- Create: `src/server/mission.test.ts`

**Interfaces:**
- Produces: `raidersInWave(wave: number): number`; `evaluateMissionOutcome(starbaseHull: number, wave: number, totalWaves: number, npcCountRemaining: number): 'active' | 'won' | 'lost'`

- [ ] **Step 1: Write the failing tests**

Create `src/server/mission.test.ts`:

```typescript
import assert from 'node:assert/strict'
import {test} from 'node:test'
import {evaluateMissionOutcome, raidersInWave} from './mission.ts'

test('raidersInWave escalates by 1 raider per wave, starting at 3', () => {
  assert.equal(raidersInWave(1), 3)
  assert.equal(raidersInWave(2), 4)
  assert.equal(raidersInWave(7), 9)
})

test('evaluateMissionOutcome is lost once the starbase hull hits 0, regardless of wave progress', () => {
  assert.equal(evaluateMissionOutcome(0, 2, 5, 3), 'lost')
  assert.equal(evaluateMissionOutcome(-5, 5, 5, 0), 'lost')
})

test('evaluateMissionOutcome is won only once the final wave is cleared with hull remaining', () => {
  assert.equal(evaluateMissionOutcome(100, 5, 5, 0), 'won')
  assert.equal(evaluateMissionOutcome(1, 5, 5, 0), 'won')
})

test('evaluateMissionOutcome stays active mid-fight and between waves', () => {
  assert.equal(evaluateMissionOutcome(100, 1, 5, 3), 'active')
  assert.equal(evaluateMissionOutcome(100, 3, 5, 0), 'active') // wave cleared, not the last one
  assert.equal(evaluateMissionOutcome(100, 5, 5, 2), 'active') // final wave, not yet cleared
})
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node --experimental-strip-types --no-warnings=ExperimentalWarning --test src/server/mission.test.ts`
Expected: FAIL — `src/server/mission.ts` doesn't exist yet.

- [ ] **Step 3: Create `src/server/mission.ts` with the two pure functions**

```typescript
/** Regular (non-boss) wave size, escalating by 1 raider per wave — wave 1 is 3 raiders, wave 7 is 9. */
export function raidersInWave(wave: number): number {
  return 2 + wave
}

/**
 * `active` mid-fight; `lost` the instant the starbase's hull reaches 0,
 * regardless of wave progress; `won` once the final wave (the boss) is
 * cleared with the starbase still standing. Clearing a non-final wave with
 * no NPCs remaining is still `active` — the next wave is about to spawn.
 */
export function evaluateMissionOutcome(
  starbaseHull: number,
  wave: number,
  totalWaves: number,
  npcCountRemaining: number,
): 'active' | 'won' | 'lost' {
  if (starbaseHull <= 0) return 'lost'
  if (wave >= totalWaves && npcCountRemaining === 0) return 'won'
  return 'active'
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `node --experimental-strip-types --no-warnings=ExperimentalWarning --test src/server/mission.test.ts`
Expected: PASS, all 4 tests.

- [ ] **Step 5: Commit**

```bash
git add src/server/mission.ts src/server/mission.test.ts
git commit -m "Add pure mission-outcome functions: raidersInWave, evaluateMissionOutcome"
```

---

### Task 3: Mission Redis CRUD, theme assignment, and wave spawning

**Files:**
- Modify: `src/server/mission.ts`
- Modify: `src/server/sector.ts`

**Interfaces:**
- Consumes: `HITSCAN_TUNING` and `WORLD_HALF` from `sector.ts` (exported in this task)
- Produces: `pickSectorTheme(): SectorTheme`; `getOrCreateMission(postId: string, theme: SectorTheme): Promise<MissionRsp>` (Redis-backed, not unit-tested)

- [ ] **Step 1: Export `HITSCAN_TUNING` and `WORLD_HALF` from `sector.ts`**

Find in `src/server/sector.ts`:

```typescript
const START_HULL = 100
const WORLD_HALF = 900 // spawn/clamp bounds, world units from sector center
```

Replace with:

```typescript
const START_HULL = 100
export const WORLD_HALF = 900 // spawn/clamp bounds, world units from sector center
```

Find:

```typescript
/** Tuning for every hit-scan (instant, no travel time) weapon. Torpedo is handled separately — it's the only projectile with travel time. */
const HITSCAN_TUNING: Record<
```

Replace with:

```typescript
/** Tuning for every hit-scan (instant, no travel time) weapon. Torpedo is handled separately — it's the only projectile with travel time. Exported so mission.ts's NPCs engage/fire at the exact same range/cooldown/damage a player with the same weapon would. */
export const HITSCAN_TUNING: Record<
```

- [ ] **Step 2: Add the Redis keys, tuning constants, and `pickSectorTheme` to `mission.ts`**

Find in `src/server/mission.ts`:

```typescript
/** Regular (non-boss) wave size, escalating by 1 raider per wave — wave 1 is 3 raiders, wave 7 is 9. */
export function raidersInWave(wave: number): number {
```

Replace with:

```typescript
import {realtime, redis} from '@devvit/web/server'
import type {
  Mission,
  MissionRsp,
  NpcState,
  SectorTheme,
  WeaponMode,
} from '../shared/api.ts'
import {HITSCAN_TUNING, WORLD_HALF, sectorChannel} from './sector.ts'

function missionKey(postId: string): string {
  return `sector:${postId}:mission`
}

function npcsKey(postId: string): string {
  return `sector:${postId}:npcs`
}

/** Dedicated atomic key, same reason player hull/credits/XP are: two players damaging the same NPC "simultaneously" must never lose a hit. */
function npcHullKey(postId: string): string {
  return `sector:${postId}:npc-hull`
}

/** Dedicated atomic key for the same reason — multiple raiders reaching the starbase in the same tick window must never lose damage. */
function starbaseHullKey(postId: string): string {
  return `sector:${postId}:starbase-hull`
}

/** Claim key for "who gets to advance the wave" — see spawnNextWaveIfClear in Task 5. */
function waveClaimKey(postId: string): string {
  return `sector:${postId}:wave-claim`
}

const STARBASE_MAX_HULL = 500
const RAIDER_HULL = 60
const CAPITAL_HULL = 400
const CAPITAL_DAMAGE_MUL = 2
const NPC_MOVE_UNITS_PER_SEC = 150
const NPC_AGGRO_RANGE_MUL = 1.5 // an NPC notices a player before it's literally in firing range
const RAIDER_WEAPONS: readonly Exclude<WeaponMode, 'torpedo'>[] = [
  'autocannon',
  'burst',
  'plasma',
  'flak',
]
const CAPITAL_WEAPON: Exclude<WeaponMode, 'torpedo'> = 'plasma'
const MIN_TOTAL_WAVES = 3
const MAX_TOTAL_WAVES = 8

/** Only one theme exists today — a plain function (not a weighted table) until a second theme gives this something to actually choose between. */
export function pickSectorTheme(): SectorTheme {
  return 'starbase-defense'
}

/** Regular (non-boss) wave size, escalating by 1 raider per wave — wave 1 is 3 raiders, wave 7 is 9. */
export function raidersInWave(wave: number): number {
```

- [ ] **Step 3: Add the Redis read/create/spawn functions, at the end of `mission.ts`**

Add after `evaluateMissionOutcome`:

```typescript
function randomTotalWaves(): number {
  return (
    MIN_TOTAL_WAVES +
    Math.floor(Math.random() * (MAX_TOTAL_WAVES - MIN_TOTAL_WAVES + 1))
  )
}

function randEdgeSpawn(): {x: number; y: number} {
  const edge = Math.floor(Math.random() * 4)
  const along = (Math.random() - 0.5) * 2 * WORLD_HALF
  if (edge === 0) return {x: along, y: -WORLD_HALF} // top
  if (edge === 1) return {x: along, y: WORLD_HALF} // bottom
  if (edge === 2) return {x: -WORLD_HALF, y: along} // left
  return {x: WORLD_HALF, y: along} // right
}

function makeNpc(kind: 'raider' | 'capital'): NpcState {
  const spawn = randEdgeSpawn()
  const weapon =
    kind === 'capital'
      ? CAPITAL_WEAPON
      : (RAIDER_WEAPONS[Math.floor(Math.random() * RAIDER_WEAPONS.length)] ??
        'autocannon')
  const maxHull = kind === 'capital' ? CAPITAL_HULL : RAIDER_HULL
  return {
    npcId: `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`,
    kind,
    x: spawn.x,
    y: spawn.y,
    rotation: 0,
    hull: maxHull,
    maxHull,
    weapon,
    lastFiredAt: 0,
    targetUserId: null,
  }
}

/** Spawns the NPCs for `wave` — a single capital ship on the final wave, otherwise `raidersInWave(wave)` raiders. Writes them into the npcs hash and seeds their hull in the dedicated atomic key. */
async function spawnWave(
  postId: string,
  wave: number,
  totalWaves: number,
): Promise<void> {
  const isBossWave = wave >= totalWaves
  const npcs = isBossWave
    ? [makeNpc('capital')]
    : Array.from({length: raidersInWave(wave)}, () => makeNpc('raider'))
  const blob: Record<string, string> = {}
  const hulls: Record<string, string> = {}
  for (const npc of npcs) {
    blob[npc.npcId] = JSON.stringify(npc)
    hulls[npc.npcId] = String(npc.hull)
  }
  await Promise.all([
    redis.hSet(npcsKey(postId), blob),
    redis.hSet(npcHullKey(postId), hulls),
  ])
}

async function readNpcs(postId: string): Promise<NpcState[]> {
  const raw = await redis.hGetAll(npcsKey(postId))
  const hulls = await redis.hGetAll(npcHullKey(postId))
  const out: NpcState[] = []
  for (const [npcId, json] of Object.entries(raw ?? {})) {
    try {
      const npc = JSON.parse(json) as NpcState
      npc.hull = Number(hulls?.[npcId] ?? npc.hull)
      out.push(npc)
    } catch {
      // skip malformed entries
    }
  }
  return out
}

async function readStarbaseHull(postId: string): Promise<number> {
  const v = await redis.get(starbaseHullKey(postId))
  return v === undefined ? STARBASE_MAX_HULL : Number(v)
}

async function toMissionRsp(
  postId: string,
  mission: Mission,
): Promise<MissionRsp> {
  const [npcs, starbaseHull] = await Promise.all([
    readNpcs(postId),
    readStarbaseHull(postId),
  ])
  return {...mission, npcs, starbaseHull}
}

/** Loads a sector's mission, or creates and spawns wave 1 if none exists yet — called on every /api/init for a themed sector. */
export async function getOrCreateMission(
  postId: string,
  theme: SectorTheme,
): Promise<MissionRsp> {
  const existing = await redis.get(missionKey(postId))
  if (existing) return toMissionRsp(postId, JSON.parse(existing) as Mission)

  const totalWaves = randomTotalWaves()
  const mission: Mission = {
    theme,
    wave: 1,
    totalWaves,
    participants: [],
    status: 'active',
    starbaseMaxHull: STARBASE_MAX_HULL,
    lastTickAt: Date.now(),
  }
  await Promise.all([
    redis.set(missionKey(postId), JSON.stringify(mission)),
    redis.set(starbaseHullKey(postId), String(STARBASE_MAX_HULL)),
    spawnWave(postId, 1, totalWaves),
  ])
  return toMissionRsp(postId, mission)
}

async function broadcastMission(
  postId: string,
  mission: MissionRsp,
): Promise<void> {
  await realtime.send(sectorChannel(postId), {type: 'mission_state', mission})
}
```

- [ ] **Step 4: Verify it compiles**

Run: `npm run test:types`
Expected: the single Task-1 `routeInit`/`InitRsp` error persists (fixed in Task 8) — confirm `mission.ts`/`sector.ts` themselves are clean.

Run: `node --experimental-strip-types --no-warnings=ExperimentalWarning --test src/server/mission.test.ts`
Expected: PASS, unchanged from Task 2.

- [ ] **Step 5: Commit**

```bash
git add src/server/mission.ts src/server/sector.ts
git commit -m "Add Mission Redis CRUD, theme picker, and wave spawning"
```

---

### Task 4: `applyNpcDamageToPlayer` in `sector.ts`

**Files:**
- Modify: `src/server/sector.ts`

**Interfaces:**
- Produces: `applyNpcDamageToPlayer(postId: string, npcId: string, target: PlayerState, damage: number): Promise<void>` (exported)

- [ ] **Step 1: Add the function, right after `applyDamage`**

Find in `src/server/sector.ts`:

```typescript
/** Grants Sector Mode combat XP/credits and tells the earning pilot's own client so it can show a toast — every other client on the channel gets the same message but ignores it, since the `userId` isn't theirs. */
async function broadcastPilotReward(
```

Replace with:

```typescript
/**
 * An NPC (never another pilot) damaging a player — same hull/respawn/death-
 * penalty handling as a PvP hit, but with no shooter pilot to score, credit,
 * or reward (NPCs have no profile, so there's no PvP leaderboard score to
 * credit either — hence no subredditId parameter, unlike applyDamage).
 * Exported for mission.ts's reactive tick.
 */
export async function applyNpcDamageToPlayer(
  postId: string,
  npcId: string,
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
    shooterUserId: npcId,
    hull,
  })
  if (hull > 0) return

  await applyDeathPenaltyFor(target.userId)
  const spawn = randSpawn()
  await redis.hSet(hullKey(postId), {[target.userId]: String(START_HULL)})
  const targetKills = await readKills(postId, target.userId)
  const respawned: PlayerState = {
    ...target,
    kills: targetKills,
    hull: START_HULL,
    x: spawn.x,
    y: spawn.y,
    rotation: 0,
  }
  await redis.hSet(playersKey(postId), {
    [target.userId]: JSON.stringify(respawned),
  })
  await broadcast(postId, {type: 'respawn', player: respawned})
}
```

- [ ] **Step 2: Verify it compiles**

Run: `npm run test:types`
Expected: the single Task-1 error persists, `sector.ts` itself clean.

- [ ] **Step 3: Commit**

```bash
git add src/server/sector.ts
git commit -m "Add applyNpcDamageToPlayer for NPC-sourced damage against players"
```

---

### Task 5: Player-damages-NPC handling and wave advancement

**Files:**
- Modify: `src/server/mission.ts`

**Interfaces:**
- Consumes: `grantCombatReward` from `./pilot.ts`; `applyDeathPenaltyFor` is NOT needed here (only used for players dying)
- Produces: `findClosestNpcInRange(postId: string, x: number, y: number, dirX: number, dirY: number, range: number): Promise<NpcState | undefined>`; `applyPlayerDamageToNpc(postId: string, shooterUserId: string, npc: NpcState, damage: number): Promise<void>`

- [ ] **Step 1: Import `grantCombatReward`**

Find in `src/server/mission.ts`:

```typescript
import {HITSCAN_TUNING, WORLD_HALF, sectorChannel} from './sector.ts'
```

Replace with:

```typescript
import {HITSCAN_TUNING, WORLD_HALF, sectorChannel} from './sector.ts'
import {grantCombatReward} from './pilot.ts'
```

- [ ] **Step 2: Add `findClosestNpcInRange`, `spawnNextWaveIfClear`, and `applyPlayerDamageToNpc`, at the end of `mission.ts`**

Add after `broadcastMission`:

```typescript
/** Closest alive NPC within range and roughly facing the shooter's aim direction — mirrors fireWeapon's own player-targeting loop in sector.ts, over NPCs instead. No aiming cone beyond a generous check, since a shooter's own cone check already happened before this is called. */
export async function findClosestNpcInRange(
  postId: string,
  x: number,
  y: number,
  dirX: number,
  dirY: number,
  range: number,
): Promise<NpcState | undefined> {
  const npcs = await readNpcs(postId)
  let closest: {npc: NpcState; distance: number} | undefined
  for (const npc of npcs) {
    const dx = npc.x - x
    const dy = npc.y - y
    const distance = Math.hypot(dx, dy)
    if (distance === 0 || distance > range) continue
    const dot = (dx / distance) * dirX + (dy / distance) * dirY
    const angle = Math.acos(Math.max(-1, Math.min(1, dot)))
    if (angle > 0.5) continue // generous cone — same order as the weapons' own halfAngle values
    if (!closest || distance < closest.distance) closest = {npc, distance}
  }
  return closest?.npc
}

/** Closest alive NPC within a plain radius, no facing/cone check — for torpedo impact resolution, which has a fixed impact point, not a shooter aiming. Mirrors the existing player-side torpedo-impact loop in sector.ts, which is likewise cone-free. */
export async function findClosestNpcInRadius(
  postId: string,
  x: number,
  y: number,
  radius: number,
): Promise<NpcState | undefined> {
  const npcs = await readNpcs(postId)
  let closest: {npc: NpcState; distance: number} | undefined
  for (const npc of npcs) {
    const distance = Math.hypot(npc.x - x, npc.y - y)
    if (distance > radius) continue
    if (!closest || distance < closest.distance) closest = {npc, distance}
  }
  return closest?.npc
}

/**
 * If the npcs hash is now empty, either spawns the next wave or resolves the
 * mission as won. Race-guarded: only the request whose hIncrBy on this wave's
 * claim key returns 1 actually performs the spawn/resolve — every other
 * concurrent caller that also just cleared the last NPC of the wave sees a
 * higher number and backs out, so a wave is never skipped or double-spawned.
 */
async function spawnNextWaveIfClear(
  postId: string,
  mission: Mission,
): Promise<Mission> {
  const remaining = await redis.hLen(npcsKey(postId))
  if (remaining > 0) return mission

  const claimed = await redis.hIncrBy(
    waveClaimKey(postId),
    String(mission.wave),
    1,
  )
  if (claimed !== 1) return mission // another request already advancing this wave

  const starbaseHull = await readStarbaseHull(postId)
  const outcome = evaluateMissionOutcome(
    starbaseHull,
    mission.wave,
    mission.totalWaves,
    0,
  )
  // Either terminal outcome resolves the mission without spawning further —
  // the starbase could have been destroyed by the same volley that killed
  // the wave's last NPC, so 'won' is never assumed just because the wave's
  // clear condition on its own would say so.
  if (outcome !== 'active') {
    const resolved: Mission = {...mission, status: outcome}
    await redis.set(missionKey(postId), JSON.stringify(resolved))
    return resolved
  }
  const nextWave = mission.wave + 1
  await spawnWave(postId, nextWave, mission.totalWaves)
  const advanced: Mission = {...mission, wave: nextWave}
  await redis.set(missionKey(postId), JSON.stringify(advanced))
  return advanced
}

/** A player's shot lands on an NPC — hull decrement (atomic), death/reward/wave-advance on a kill, always ends by broadcasting the fresh mission state. */
export async function applyPlayerDamageToNpc(
  postId: string,
  shooterUserId: string,
  npc: NpcState,
  damage: number,
): Promise<void> {
  const existingRaw = await redis.get(missionKey(postId))
  if (!existingRaw) return
  let mission = JSON.parse(existingRaw) as Mission
  if (mission.status !== 'active') return

  const hull = Math.max(
    0,
    await redis.hIncrBy(npcHullKey(postId), npc.npcId, -damage),
  )
  if (!mission.participants.includes(shooterUserId)) {
    mission = {...mission, participants: [...mission.participants, shooterUserId]}
    await redis.set(missionKey(postId), JSON.stringify(mission))
  }

  if (hull > 0) {
    await broadcastMission(postId, await toMissionRsp(postId, mission))
    return
  }

  await Promise.all([
    redis.hDel(npcsKey(postId), [npc.npcId]),
    redis.hDel(npcHullKey(postId), [npc.npcId]),
  ])
  await grantCombatReward(shooterUserId, npc.kind === 'capital' ? 'kill' : 'hit')
  mission = await spawnNextWaveIfClear(postId, mission)
  await broadcastMission(postId, await toMissionRsp(postId, mission))
}
```

- [ ] **Step 3: Verify it compiles**

Run: `npm run test:types`
Expected: the single Task-1 error persists, `mission.ts` itself clean.

Run: `node --experimental-strip-types --no-warnings=ExperimentalWarning --test src/server/mission.test.ts`
Expected: PASS, unchanged.

- [ ] **Step 4: Commit**

```bash
git add src/server/mission.ts
git commit -m "Add player-damages-NPC handling and race-guarded wave advancement"
```

---

### Task 6: Integrate NPC targeting into `fireWeapon`

**Files:**
- Modify: `src/server/sector.ts`

**Interfaces:**
- Consumes: `findClosestNpcInRange`, `findClosestNpcInRadius`, `applyPlayerDamageToNpc` from `./mission.ts`

- [ ] **Step 1: Import the mission.ts functions**

Find in `src/server/sector.ts`:

```typescript
import {
  applyDeathPenaltyFor,
  getOrCreatePilotProfile,
  grantCombatReward,
} from './pilot.ts'
```

Replace with:

```typescript
import {
  applyPlayerDamageToNpc,
  findClosestNpcInRadius,
  findClosestNpcInRange,
} from './mission.ts'
import {
  applyDeathPenaltyFor,
  getOrCreatePilotProfile,
  grantCombatReward,
} from './pilot.ts'
```

- [ ] **Step 2: Have the hitscan branch also consider the closest NPC, and fire at whichever target is closer**

Find:

```typescript
    let closest: {player: PlayerState; distance: number} | undefined
    for (const p of others) {
      const dx = p.x - x
      const dy = p.y - y
      const distance = Math.hypot(dx, dy)
      if (distance === 0 || distance > tuning.range) continue
      const dot = (dx / distance) * dirX + (dy / distance) * dirY
      const angle = Math.acos(Math.max(-1, Math.min(1, dot)))
      if (angle > tuning.halfAngle) continue
      if (!closest || distance < closest.distance)
        closest = {player: p, distance}
    }
    if (!closest) return
    await applyDamage(
      postId,
      subredditId,
      shooter,
      shooterUsername,
      closest.player,
      tuning.damage,
    )
    return
  }
```

Replace with:

```typescript
    let closest: {player: PlayerState; distance: number} | undefined
    for (const p of others) {
      const dx = p.x - x
      const dy = p.y - y
      const distance = Math.hypot(dx, dy)
      if (distance === 0 || distance > tuning.range) continue
      const dot = (dx / distance) * dirX + (dy / distance) * dirY
      const angle = Math.acos(Math.max(-1, Math.min(1, dot)))
      if (angle > tuning.halfAngle) continue
      if (!closest || distance < closest.distance)
        closest = {player: p, distance}
    }
    const closestNpc = await findClosestNpcInRange(
      postId,
      x,
      y,
      dirX,
      dirY,
      tuning.range,
    )
    const npcDistance = closestNpc
      ? Math.hypot(closestNpc.x - x, closestNpc.y - y)
      : undefined
    if (
      closestNpc &&
      (!closest || (npcDistance !== undefined && npcDistance < closest.distance))
    ) {
      await applyPlayerDamageToNpc(
        postId,
        shooterId,
        closestNpc,
        tuning.damage,
      )
      return
    }
    if (!closest) return
    await applyDamage(
      postId,
      subredditId,
      shooter,
      shooterUsername,
      closest.player,
      tuning.damage,
    )
    return
  }
```

- [ ] **Step 3: Have torpedo impact resolution do the same comparison**

Find:

```typescript
  const others = await listOtherPlayers(postId, shooterId)
  let closest: {player: PlayerState; distance: number} | undefined
  for (const p of others) {
    const distance = Math.hypot(p.x - impactX, p.y - impactY)
    if (distance > TORPEDO_IMPACT_RADIUS) continue
    if (!closest || distance < closest.distance) closest = {player: p, distance}
  }
  if (!closest) {
    await broadcast(postId, {type: 'miss', x: impactX, y: impactY})
    return
  }
  await applyDamage(
    postId,
    subredditId,
    shooter,
    shooterUsername,
    closest.player,
    TORPEDO_DAMAGE,
  )
}
```

Replace with:

```typescript
  const others = await listOtherPlayers(postId, shooterId)
  let closest: {player: PlayerState; distance: number} | undefined
  for (const p of others) {
    const distance = Math.hypot(p.x - impactX, p.y - impactY)
    if (distance > TORPEDO_IMPACT_RADIUS) continue
    if (!closest || distance < closest.distance) closest = {player: p, distance}
  }
  const npc = await findClosestNpcInRadius(
    postId,
    impactX,
    impactY,
    TORPEDO_IMPACT_RADIUS,
  )
  const npcDistance = npc ? Math.hypot(npc.x - impactX, npc.y - impactY) : undefined
  if (npc && (!closest || (npcDistance !== undefined && npcDistance < closest.distance))) {
    await applyPlayerDamageToNpc(postId, shooterId, npc, TORPEDO_DAMAGE)
    return
  }
  if (!closest) {
    await broadcast(postId, {type: 'miss', x: impactX, y: impactY})
    return
  }
  await applyDamage(
    postId,
    subredditId,
    shooter,
    shooterUsername,
    closest.player,
    TORPEDO_DAMAGE,
  )
}
```

- [ ] **Step 4: Verify it compiles**

Run: `npm run test:types`
Expected: the single Task-1 error persists, `sector.ts` itself clean.

- [ ] **Step 5: Commit**

```bash
git add src/server/sector.ts
git commit -m "Let players damage NPCs, choosing whichever target (player or NPC) is closer"
```

---

### Task 7: The reactive tick — NPC movement and NPC-fires-at-player-or-starbase

**Files:**
- Modify: `src/server/mission.ts`
- Modify: `src/server/sector.ts`

**Interfaces:**
- Consumes: `applyNpcDamageToPlayer`, `listOtherPlayers` from `./sector.ts`
- Produces: `tickMission(postId: string): Promise<void>` (exported)

- [ ] **Step 1: Import what the tick needs**

Find in `src/server/mission.ts`:

```typescript
import {HITSCAN_TUNING, WORLD_HALF, sectorChannel} from './sector.ts'
import {grantCombatReward} from './pilot.ts'
```

Replace with:

```typescript
import {
  applyNpcDamageToPlayer,
  HITSCAN_TUNING,
  listOtherPlayers,
  WORLD_HALF,
  sectorChannel,
} from './sector.ts'
import {grantCombatReward} from './pilot.ts'
```

Find at the top of `src/server/mission.ts`:

```typescript
import type {
  Mission,
  MissionRsp,
  NpcState,
  SectorTheme,
  WeaponMode,
} from '../shared/api.ts'
```

Replace with:

```typescript
import type {
  Mission,
  MissionRsp,
  NpcState,
  PlayerState,
  SectorTheme,
  WeaponMode,
} from '../shared/api.ts'
```

- [ ] **Step 2: Add `tickMission`, at the end of `mission.ts`**

```typescript
const MIN_TICK_INTERVAL_MS = 200 // caps how often the reactive tick actually does work, however often movePlayer/fireWeapon fire
const MAX_TICK_DT_SEC = 0.5 // guards against a huge jump if a sector goes quiet for a while

function nearestPlayer(
  npc: NpcState,
  players: PlayerState[],
  range: number,
): PlayerState | undefined {
  let closest: {player: PlayerState; distance: number} | undefined
  for (const p of players) {
    const distance = Math.hypot(p.x - npc.x, p.y - npc.y)
    if (distance > range) continue
    if (!closest || distance < closest.distance) closest = {player: p, distance}
  }
  return closest?.player
}

/**
 * Runs on every movePlayer/fireWeapon call in a themed sector — there is no
 * dedicated scheduler. Moves each alive NPC a step toward its target (the
 * nearest aggro'd player, or the starbase at the origin if none is close
 * enough) and fires if already in range with its cooldown elapsed.
 */
export async function tickMission(postId: string): Promise<void> {
  const existingRaw = await redis.get(missionKey(postId))
  if (!existingRaw) return
  let mission = JSON.parse(existingRaw) as Mission
  if (mission.status !== 'active') return

  const now = Date.now()
  if (now - mission.lastTickAt < MIN_TICK_INTERVAL_MS) return
  const dt = Math.min((now - mission.lastTickAt) / 1000, MAX_TICK_DT_SEC)
  mission = {...mission, lastTickAt: now}
  await redis.set(missionKey(postId), JSON.stringify(mission))

  const [npcs, players] = await Promise.all([
    readNpcs(postId),
    listOtherPlayers(postId, ''), // no "self" from the tick's perspective — '' excludes no real userId, so this returns every player in the sector
  ])
  if (npcs.length === 0) return

  for (const npc of npcs) {
    const tuning = HITSCAN_TUNING[npc.weapon]
    const aggroRange = tuning.range * NPC_AGGRO_RANGE_MUL
    const target = nearestPlayer(npc, players, aggroRange)
    const targetX = target ? target.x : 0
    const targetY = target ? target.y : 0
    npc.targetUserId = target ? target.userId : null

    const dx = targetX - npc.x
    const dy = targetY - npc.y
    const distance = Math.hypot(dx, dy)
    const step = NPC_MOVE_UNITS_PER_SEC * dt
    if (distance > step && distance > 0) {
      npc.x += (dx / distance) * step
      npc.y += (dy / distance) * step
    } else {
      npc.x = targetX
      npc.y = targetY
    }
    npc.rotation = Math.atan2(dy, dx) + Math.PI / 2

    const withinRange = distance <= tuning.range
    const cooledDown = now - npc.lastFiredAt >= tuning.cooldownMs
    if (withinRange && cooledDown) {
      npc.lastFiredAt = now
      const damage =
        npc.kind === 'capital'
          ? tuning.damage * CAPITAL_DAMAGE_MUL
          : tuning.damage
      if (target) {
        await applyNpcDamageToPlayer(postId, npc.npcId, target, damage)
      } else {
        await redis.incrBy(starbaseHullKey(postId), -damage)
      }
    }
    await redis.hSet(npcsKey(postId), {[npc.npcId]: JSON.stringify(npc)})
  }

  const starbaseHull = await readStarbaseHull(postId)
  const outcome = evaluateMissionOutcome(
    Math.max(0, starbaseHull),
    mission.wave,
    mission.totalWaves,
    npcs.length,
  )
  if (outcome === 'lost') {
    mission = {...mission, status: 'lost'}
    await redis.set(missionKey(postId), JSON.stringify(mission))
  }

  await broadcastMission(postId, await toMissionRsp(postId, mission))
}
```

- [ ] **Step 3: Call `tickMission` from `movePlayer` and `fireWeapon`**

Find in `src/server/sector.ts`:

```typescript
  await redis.hSet(playersKey(postId), {[userId]: JSON.stringify(player)})
  await broadcast(postId, {type: 'move', player})

  const minesRaw = await redis.hGetAll(minesKey(postId))
```

Replace with:

```typescript
  await redis.hSet(playersKey(postId), {[userId]: JSON.stringify(player)})
  await broadcast(postId, {type: 'move', player})
  await tickMission(postId)

  const minesRaw = await redis.hGetAll(minesKey(postId))
```

Find:

```typescript
  const {x, y, rotation} = shooter
  const dirX = Math.cos(rotation - Math.PI / 2)
  const dirY = Math.sin(rotation - Math.PI / 2)
  const others = await listOtherPlayers(postId, shooterId)

  if (mode === 'flak' && (await tryFlakIntercept(postId, shooter, now))) return
```

Replace with:

```typescript
  const {x, y, rotation} = shooter
  const dirX = Math.cos(rotation - Math.PI / 2)
  const dirY = Math.sin(rotation - Math.PI / 2)
  const others = await listOtherPlayers(postId, shooterId)
  await tickMission(postId)

  if (mode === 'flak' && (await tryFlakIntercept(postId, shooter, now))) return
```

Find the import block once more:

```typescript
import {applyPlayerDamageToNpc, findClosestNpcInRange} from './mission.ts'
```

Replace with:

```typescript
import {
  applyPlayerDamageToNpc,
  findClosestNpcInRange,
  tickMission,
} from './mission.ts'
```

- [ ] **Step 4: Verify it compiles**

Run: `npm run test:types`
Expected: the single Task-1 error persists, `sector.ts`/`mission.ts` themselves clean.

Run: `node --experimental-strip-types --no-warnings=ExperimentalWarning --test src/server/mission.test.ts`
Expected: PASS, unchanged.

- [ ] **Step 5: Commit**

```bash
git add src/server/mission.ts src/server/sector.ts
git commit -m "Add the reactive NPC tick, piggybacked on movePlayer and fireWeapon"
```

---

### Task 8: Server routing — theme assignment and Init wiring

**Files:**
- Modify: `src/server/server.ts`

**Interfaces:**
- Consumes: `pickSectorTheme`, `getOrCreateMission` from `./mission.ts`

- [ ] **Step 1: Import the two mission.ts functions**

Find in `src/server/server.ts`:

```typescript
import {chooseLine, getOrCreatePilotProfile} from './pilot.ts'
```

Replace with:

```typescript
import {getOrCreateMission, pickSectorTheme} from './mission.ts'
import {chooseLine, getOrCreatePilotProfile} from './pilot.ts'
```

- [ ] **Step 2: Assign a theme at sector creation**

Find:

```typescript
async function routeMenuNewPost(): Promise<UiResponse> {
  const post = await reddit.submitCustomPost({title: context.appSlug})
  return {
    showToast: {text: `Post ${post.id} created.`, appearance: 'success'},
    navigateTo: post.url,
  }
}
```

Replace with:

```typescript
async function routeMenuNewPost(): Promise<UiResponse> {
  const post = await reddit.submitCustomPost({
    title: context.appSlug,
    postData: {kind: 'sector', theme: pickSectorTheme()},
  })
  return {
    showToast: {text: `Post ${post.id} created.`, appearance: 'success'},
    navigateTo: post.url,
  }
}
```

- [ ] **Step 3: Attach the sector's mission (if themed) to `InitRsp`**

Find:

```typescript
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
```

Replace with:

```typescript
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
  const kind = getPostKind()
  const mission =
    kind?.kind === 'sector' ? await getOrCreateMission(postId, kind.theme) : null
  return {postId, channel: sectorChannel(postId), player, others, mission}
}
```

- [ ] **Step 4: Verify the full test suite passes**

Run: `npm run test`
Expected: PASS — `test:types`, `lint`, `test:unit`, and `build` all succeed with zero errors. This closes out the server-side half of the plan: newly-created sectors are themed, and `/api/init` returns the sector's mission state.

- [ ] **Step 5: Commit**

```bash
git add src/server/server.ts
git commit -m "Assign a random theme at sector creation and attach mission state to Init"
```

---

### Task 9: Client — NPC/starbase rendering and the MISSION HUD

**Files:**
- Modify: `src/client/scene.ts`

**Interfaces:**
- Consumes: `MissionRsp`, `NpcState` from `../shared/api.ts`

- [ ] **Step 1: Import the mission types and load the new art**

Find in `src/client/scene.ts`:

```typescript
import type {PlayerState, RealtimeMsg, WeaponMode} from '../shared/api.ts'
```

Replace with:

```typescript
import type {
  MissionRsp,
  NpcState,
  PlayerState,
  RealtimeMsg,
  WeaponMode,
} from '../shared/api.ts'
```

Find:

```typescript
  preload(): void {
    this.load.image('fighter', 'assets/ships/fighter.webp')
    this.load.image('miner', 'assets/ships/miner.webp')
    this.load.image('transport', 'assets/ships/transport.webp')
    this.load.image('pathfinder', 'assets/ships/pathfinder.webp')
    this.load.image('tender', 'assets/ships/tender.webp')
  }
```

Replace with:

```typescript
  preload(): void {
    this.load.image('fighter', 'assets/ships/fighter.webp')
    this.load.image('miner', 'assets/ships/miner.webp')
    this.load.image('transport', 'assets/ships/transport.webp')
    this.load.image('pathfinder', 'assets/ships/pathfinder.webp')
    this.load.image('tender', 'assets/ships/tender.webp')
    this.load.image(
      'npc-raider-1',
      'assets/ships/Menta-Pirates/pirate_standard/1.webp',
    )
    this.load.image(
      'npc-raider-2',
      'assets/ships/Menta-Pirates/pirate_standard/2.webp',
    )
    this.load.image(
      'npc-raider-3',
      'assets/ships/Menta-Pirates/pirate_standard/3.webp',
    )
    this.load.image(
      'npc-raider-4',
      'assets/ships/Menta-Pirates/pirate_standard/4.webp',
    )
    this.load.image(
      'npc-capital',
      'assets/ships/Menta-Pirates/pirate_capital_ship/Black Horizon.webp',
    )
    this.load.image(
      'starbase',
      'assets/ships/Menta-Merchant/civilian_planetary_defenses/civilian-planetary-turret.webp',
    )
  }
```

- [ ] **Step 2: Add NPC/starbase state and the MISSION HUD text field**

Find:

```typescript
  private leaderboardPanel!: Phaser.GameObjects.Text
  private leaderboardOpen = false
  private pilotPanel!: Phaser.GameObjects.Text
  private pilotPanelOpen = false
  private hudPulse!: Phaser.GameObjects.Text
  private pulseHideEvent: Phaser.Time.TimerEvent | null = null
```

Replace with:

```typescript
  private leaderboardPanel!: Phaser.GameObjects.Text
  private leaderboardOpen = false
  private pilotPanel!: Phaser.GameObjects.Text
  private pilotPanelOpen = false
  private hudPulse!: Phaser.GameObjects.Text
  private pulseHideEvent: Phaser.Time.TimerEvent | null = null
  private npcs = new Map<string, Phaser.GameObjects.Image>()
  private starbase: Phaser.GameObjects.Image | null = null
  private hudMission!: Phaser.GameObjects.Text
```

- [ ] **Step 3: Create the MISSION HUD text object, alongside the other HUD elements**

Find:

```typescript
    this.hudPulse = this.add
      .text(W / 2, 14, '', {
        fontFamily: 'monospace',
        fontSize: '12px',
        color: '#c9a4ff',
        align: 'center',
      })
      .setOrigin(0.5, 0)
      .setScrollFactor(0)
      .setDepth(50)
      .setAlpha(0)
```

Replace with:

```typescript
    this.hudPulse = this.add
      .text(W / 2, 14, '', {
        fontFamily: 'monospace',
        fontSize: '12px',
        color: '#c9a4ff',
        align: 'center',
      })
      .setOrigin(0.5, 0)
      .setScrollFactor(0)
      .setDepth(50)
      .setAlpha(0)
    this.hudMission = this.add
      .text(W / 2, H - 12, '', {
        fontFamily: 'monospace',
        fontSize: '12px',
        color: '#ff9500',
        align: 'center',
      })
      .setOrigin(0.5, 1)
      .setScrollFactor(0)
      .setDepth(50)
```

- [ ] **Step 4: Render the mission's initial state from `InitRsp`, and handle `mission_state` broadcasts thereafter**

Find:

```typescript
    for (const p of init.others) this.spawnRemote(p)
    this.updateCountHud()
```

Replace with:

```typescript
    for (const p of init.others) this.spawnRemote(p)
    this.updateCountHud()
    if (init.mission) this.renderMission(init.mission)
```

Find, at the tail of `handleRealtime`'s existing chain:

```typescript
    } else if (msg.type === 'flak_intercept') {
      this.fizzleMiss(msg.x, msg.y)
    }
  }
```

Replace with:

```typescript
    } else if (msg.type === 'flak_intercept') {
      this.fizzleMiss(msg.x, msg.y)
    } else if (msg.type === 'mission_state') {
      this.renderMission(msg.mission)
    }
  }
```

- [ ] **Step 5: Add `renderMission`, right after `updateCountHud`**

Find:

```typescript
  private updateCountHud(): void {
    this.hudCount.setText(
      `SECTOR · ${this.others.size + 1} pilot${this.others.size === 0 ? '' : 's'}`,
    )
  }
```

Replace with:

```typescript
  private updateCountHud(): void {
    this.hudCount.setText(
      `SECTOR · ${this.others.size + 1} pilot${this.others.size === 0 ? '' : 's'}`,
    )
  }

  private renderMission(mission: MissionRsp): void {
    if (!this.starbase) {
      this.starbase = this.add.image(0, 0, 'starbase').setDisplaySize(64, 64).setDepth(15)
    }

    const seenIds = new Set<string>()
    for (const npc of mission.npcs) {
      seenIds.add(npc.npcId)
      this.renderNpc(npc)
    }
    for (const [npcId, sprite] of this.npcs) {
      if (!seenIds.has(npcId)) {
        sprite.destroy()
        this.npcs.delete(npcId)
      }
    }

    const statusLine =
      mission.status === 'won'
        ? 'STARBASE SECURED'
        : mission.status === 'lost'
          ? 'STARBASE LOST'
          : `WAVE ${mission.wave}/${mission.totalWaves}`
    this.hudMission.setText(
      `${statusLine}   STARBASE HULL ${Math.max(0, mission.starbaseHull)}/${mission.starbaseMaxHull}`,
    )
  }

  private renderNpc(npc: NpcState): void {
    const key = npc.kind === 'capital' ? 'npc-capital' : this.raiderKeyFor(npc.npcId)
    let sprite = this.npcs.get(npc.npcId)
    if (!sprite) {
      sprite = this.add
        .image(npc.x, npc.y, key)
        .setDisplaySize(npc.kind === 'capital' ? 80 : 40, npc.kind === 'capital' ? 80 : 40)
        .setDepth(16)
      this.npcs.set(npc.npcId, sprite)
    }
    sprite.setPosition(npc.x, npc.y)
    sprite.rotation = npc.rotation
  }

  /** Deterministic per-NPC pick among the 4 raider art variants, stable across re-renders of the same npcId. */
  private raiderKeyFor(npcId: string): string {
    let hash = 0
    for (let i = 0; i < npcId.length; i++)
      hash = (hash * 31 + npcId.charCodeAt(i)) >>> 0
    return `npc-raider-${(hash % 4) + 1}`
  }
```

- [ ] **Step 6: Verify the full test suite passes**

Run: `npm run test`
Expected: PASS — `test:types`, `lint`, `test:unit`, and `build` all succeed with zero errors. This closes out the plan.

- [ ] **Step 7: Manual check**

Run the app locally (`npm run dev` / `npm run playtest`) and confirm, in a themed sector: NPCs (raiders in wave 1, then escalating) spawn from the world's edges and move toward the starbase at the center; shooting one damages/kills it (loot/credits aside, this plan doesn't add loot); once a wave clears, the next spawns automatically; the MISSION HUD shows wave progress and the starbase's hull; if the starbase's hull reaches 0, the HUD reads "STARBASE LOST." This plan has no automated test for the visual/tick-timing feel — this manual pass is the verification step.

- [ ] **Step 8: Commit**

```bash
git add src/client/scene.ts
git commit -m "Render NPCs and the starbase, add the MISSION HUD"
```

---

Each task leaves the game in a working, testable state. Once this plan ships, a themed sector runs the full `starbase-defense` mission end-to-end — theme assignment, escalating waves, a capital-ship boss, win/loss, and client rendering. Loot and the other four themes (each reusing this same engine, per the design spec) are separate, later plans.
