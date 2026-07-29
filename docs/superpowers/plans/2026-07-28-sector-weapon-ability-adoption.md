# Sector Mode Weapon & Ability Adoption Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give Sector Mode players their real ship line's full Battle-Mode weapon + active ability kit (autocannon/burst/plasma/flak, Overcharge/Bulwark/heal/mines/radar-ping) instead of today's flat laser+torpedo-for-everyone, laying the foundation the upcoming pirate-mission engine needs.

**Architecture:** `src/server/sector.ts`'s `fireWeapon`/`applyDamage`/`movePlayer` are extended to mirror the equivalent logic already proven in `src/server/match.ts` (`fireWeaponInMatch`/`applyDamageInMatch`/`movePlayerInMatch`) — per-line weapon validation, `computeDamage` for line/ability-aware damage, in-flight torpedo tracking so Flak can intercept them, and mine placement/triggering — adapted for Sector Mode's flat 100-hull baseline (no per-line hull scaling) and lack of teams (mines exclude by owner, not by team). `match.ts`/`challenge.ts` are read only for reference and never modified.

**Tech Stack:** TypeScript, Devvit Web (`@devvit/web/server`/`client`), Redis, Phaser (client sector scene), `node:test`, Biome, esbuild.

## Global Constraints

- Design spec: `docs/superpowers/specs/2026-07-28-solo-pve-sector-content-design.md`, Part 2 ("Combat — reusing Battle Mode's weapon/ability system"). This plan is a prerequisite slice of that design's Phase 1 — it ports the weapon/ability kit itself; the NPC/mission engine that will eventually *gate* this kit on "sector has an active mission" is a separate, later plan. Until that lands, every sector always has the full kit (no gating condition exists yet to turn it off).
- `src/server/match.ts` and `src/server/challenge.ts` are **never modified** by this plan — read-only reference for the patterns being ported.
- Sector Mode does **not** adopt per-line hull scaling (`SHIP_STATS.hullMul`) — every player's max hull stays the flat 100 (`START_HULL`) it is today. Only weapon *set* and `computeDamage`'s damage/ability multipliers are adopted.
- `PlayerState.lastLaserAt`/`lastTorpedoAt` are reused as generic "primary weapon slot" / "secondary weapon slot" cooldown trackers (exactly as `match.ts` already does) — not touched as a type, no new PlayerState fields needed.
- Codebase style: Biome-formatted (single quotes, no semicolons, 2-space indent, trailing commas). `npm run test` = `test:types && lint && test:unit && build`, lint uses `--error-on-warnings` — run the full `npm run test` before calling a task done.
- Redis-backed functions in this codebase are not unit-tested (no mocking) — only pure logic (already in `abilities.ts`, reused here unchanged) gets `node:test` coverage. No new pure functions are introduced by this plan, so no new test file is created.

---

## File Structure

- **Modify** `src/shared/api.ts` — `AbilityReq`/`AbilityRsp` types, `Endpoint.Ability` + method, five new `RealtimeMsg` variants (`heal`, `mine_placed`, `mine_detonated`, `ability`, `flak_intercept`).
- **Modify** `src/server/sector.ts` — hitscan tuning table, per-line weapon fallback validation, `computeDamage`-based `applyDamage`, in-flight torpedo tracking + Flak interception, mines + new `activateAbility`, `movePlayer` gains a `subredditId` parameter.
- **Modify** `src/server/server.ts` — new `routeAbility`; `routeFire`'s sector branch no longer restricts to laser/torpedo; `routeMove` passes `subredditId` through to `movePlayer`.
- **Modify** `src/client/fetch.ts` — `fetchAbility`.
- **Modify** `src/client/scene.ts` — per-line weapon key mapping (replacing the hardcoded laser/torpedo keys), an ability keybind, and visual feedback for heal/mine/flak-intercept.

---

### Task 1: Shared types — ability request/response and new realtime messages

**Files:**
- Modify: `src/shared/api.ts`

**Interfaces:**
- Produces: `AbilityReq = Record<string, never>`; `AbilityRsp = {ok: true}`; `Endpoint.Ability`; `RealtimeMsg` gains `heal`/`mine_placed`/`mine_detonated`/`ability`/`flak_intercept` variants.

- [ ] **Step 1: Add `AbilityReq`/`AbilityRsp`, right after `FireReq`/`FireRsp`**

Find in `src/shared/api.ts`:

```typescript
export type FireReq = {mode: WeaponMode}
export type FireRsp = {ok: true}
```

Replace with:

```typescript
export type FireReq = {mode: WeaponMode}
export type FireRsp = {ok: true}

/** Activates the caller's ship line's active ability in a sector (Fighter's Overcharge, Transport's Bulwark, Tender's heal, Miner's mine, Pathfinder's radar ping). No payload — the line comes from the caller's own player state. */
export type AbilityReq = Record<string, never>
export type AbilityRsp = {ok: true}
```

- [ ] **Step 2: Add the five new `RealtimeMsg` variants, after `pilot_reward`**

Find:

```typescript
  | {
      type: 'pilot_reward'
      userId: string
      kind: 'hit' | 'kill'
      xpGained: number
      creditsGained: number
    }
```

Replace with:

```typescript
  | {
      type: 'pilot_reward'
      userId: string
      kind: 'hit' | 'kill'
      xpGained: number
      creditsGained: number
    }
  | {type: 'heal'; targetUserId: string; healerUserId: string; hull: number}
  | {type: 'mine_placed'; mineId: string; ownerId: string; x: number; y: number}
  | {
      type: 'mine_detonated'
      mineId: string
      targetUserId: string
      x: number
      y: number
    }
  | {type: 'ability'; userId: string; line: ShipLine}
  | {type: 'flak_intercept'; userId: string; x: number; y: number}
```

- [ ] **Step 3: Add `Endpoint.Ability`**

Find:

```typescript
  PilotProfile: 'api/pilot/profile',
  PilotChooseLine: 'api/pilot/choose-line',
  Move: 'api/move',
```

Replace with:

```typescript
  PilotProfile: 'api/pilot/profile',
  PilotChooseLine: 'api/pilot/choose-line',
  Move: 'api/move',
  Ability: 'api/ability',
```

Find:

```typescript
  [Endpoint.PilotProfile]: 'GET',
  [Endpoint.PilotChooseLine]: 'POST',
  [Endpoint.Move]: 'POST',
```

Replace with:

```typescript
  [Endpoint.PilotProfile]: 'GET',
  [Endpoint.PilotChooseLine]: 'POST',
  [Endpoint.Move]: 'POST',
  [Endpoint.Ability]: 'POST',
```

- [ ] **Step 4: Verify it compiles**

Run: `npm run test:types`
Expected: no errors — purely additive types and one new `Endpoint`/`EndpointMethod` entry pair (added together, so the exhaustiveness check in `server.ts`'s `route()` switch has no unhandled case yet — wait, it will: adding a new `Endpoint` value with no `case` in `route()`'s switch breaks the `endpoint satisfies never` exhaustiveness check).
Expected instead: one error in `src/server/server.ts` — the `default: endpoint satisfies never` line fails because `Endpoint.Ability` has no `case` yet. That's expected, fixed in Task 5.

- [ ] **Step 5: Commit**

```bash
git add src/shared/api.ts
git commit -m "Add ability request/response types and new sector realtime messages"
```

---

### Task 2: Per-line weapons and `computeDamage` in `sector.ts`

**Files:**
- Modify: `src/server/sector.ts`

**Interfaces:**
- Consumes: `SHIP_WEAPONS`, `AUTOCANNON_RANGE`, `AUTOCANNON_COOLDOWN_MS`, `BURST_RANGE`, `BURST_COOLDOWN_MS`, `PLASMA_RANGE`, `PLASMA_COOLDOWN_MS`, `FLAK_RANGE`, `FLAK_COOLDOWN_MS` from `../shared/api.ts`; `computeDamage` from `./abilities.ts`
- Produces: `applyDamage(postId, subredditId, shooter: PlayerState, shooterUsername, target, baseDamage)` — signature changes from taking `shooterId: string` to the full `shooter: PlayerState`

- [ ] **Step 1: Import the new weapon-tuning constants and `computeDamage`**

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
  TORPEDO_COOLDOWN_MS,
  TORPEDO_RANGE,
  TORPEDO_SPEED,
} from '../shared/api.ts'
import {
  applyDeathPenaltyFor,
  getOrCreatePilotProfile,
  grantCombatReward,
} from './pilot.ts'
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
  AUTOCANNON_COOLDOWN_MS,
  AUTOCANNON_RANGE,
  BURST_COOLDOWN_MS,
  BURST_RANGE,
  FLAK_COOLDOWN_MS,
  FLAK_RANGE,
  LASER_COOLDOWN_MS,
  LASER_RANGE,
  PLASMA_COOLDOWN_MS,
  PLASMA_RANGE,
  SHIP_WEAPONS,
  TORPEDO_COOLDOWN_MS,
  TORPEDO_RANGE,
  TORPEDO_SPEED,
} from '../shared/api.ts'
import {computeDamage} from './abilities.ts'
import {
  applyDeathPenaltyFor,
  getOrCreatePilotProfile,
  grantCombatReward,
} from './pilot.ts'
```

- [ ] **Step 2: Add per-weapon damage/angle constants and the hitscan tuning table**

Find:

```typescript
const LASER_HALF_ANGLE = 0.3 // radians either side of facing — ~17°
const LASER_DAMAGE = 20
const HIT_SCORE = 10
const KILL_SCORE = 40

const TORPEDO_DAMAGE = 55
const TORPEDO_IMPACT_RADIUS = 100 // how far off the flight line a target may be and still be caught
const TORPEDO_AIM_HALF_ANGLE = 0.4
```

Replace with:

```typescript
const LASER_HALF_ANGLE = 0.3 // radians either side of facing — ~17°
const LASER_DAMAGE = 20
const HIT_SCORE = 10
const KILL_SCORE = 40

const TORPEDO_DAMAGE = 55
const TORPEDO_IMPACT_RADIUS = 100 // how far off the flight line a target may be and still be caught
const TORPEDO_AIM_HALF_ANGLE = 0.4

// Damage/angle tuning for the battle-arena weapons, mirrored from match.ts's
// own private HITSCAN_TUNING — kept as an independent copy rather than a
// shared export, matching this codebase's existing precedent of sector.ts
// and match.ts each independently declaring baseline tuning (e.g. START_HULL).
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
```

- [ ] **Step 3: Rewrite `fireWeapon`'s cooldown/validation and hitscan branch to be per-line**

Find:

```typescript
export async function fireWeapon(
  postId: string,
  subredditId: string,
  shooterId: string,
  shooterUsername: string,
  mode: WeaponMode,
): Promise<void> {
  const existing = await redis.hGet(playersKey(postId), shooterId)
  if (!existing) return
  const shooter = JSON.parse(existing) as PlayerState

  const now = Date.now()
  if (mode === 'laser') {
    if (now - (shooter.lastLaserAt ?? 0) < LASER_COOLDOWN_MS) return
    shooter.lastLaserAt = now
  } else {
    if (now - (shooter.lastTorpedoAt ?? 0) < TORPEDO_COOLDOWN_MS) return
    shooter.lastTorpedoAt = now
  }
  await redis.hSet(playersKey(postId), {[shooterId]: JSON.stringify(shooter)})

  const {x, y, rotation} = shooter
  const dirX = Math.cos(rotation - Math.PI / 2)
  const dirY = Math.sin(rotation - Math.PI / 2)
  const others = await listOtherPlayers(postId, shooterId)

  if (mode === 'laser') {
    await broadcast(postId, {
      type: 'shot',
      userId: shooterId,
      x,
      y,
      rotation,
      mode,
      travelMs: 0,
    })

    let closest: {player: PlayerState; distance: number} | undefined
    for (const p of others) {
      const dx = p.x - x
      const dy = p.y - y
      const distance = Math.hypot(dx, dy)
      if (distance === 0 || distance > LASER_RANGE) continue
      const dot = (dx / distance) * dirX + (dy / distance) * dirY
      const angle = Math.acos(Math.max(-1, Math.min(1, dot)))
      if (angle > LASER_HALF_ANGLE) continue
      if (!closest || distance < closest.distance)
        closest = {player: p, distance}
    }
    if (!closest) return
    await applyDamage(
      postId,
      subredditId,
      shooterId,
      shooterUsername,
      closest.player,
      LASER_DAMAGE,
    )
    return
  }

  // Stop at the nearest roughly-aimed-at target instead of always flying to
```

Replace with:

```typescript
export async function fireWeapon(
  postId: string,
  subredditId: string,
  shooterId: string,
  shooterUsername: string,
  requestedMode: WeaponMode,
): Promise<void> {
  const existing = await redis.hGet(playersKey(postId), shooterId)
  if (!existing) return
  const shooter = JSON.parse(existing) as PlayerState

  // Authoritative on the shooter's own line, not whatever the client asked
  // to fire — mirrors fireWeaponInMatch's fallback so a client can't fire a
  // weapon its ship doesn't have. lastLaserAt/lastTorpedoAt are reused as
  // generic primary/secondary weapon-slot cooldown trackers, same as match.ts.
  const weapons = SHIP_WEAPONS[shooter.line]
  const firstWeapon = weapons[0]
  if (!firstWeapon) return // unreachable — every line has at least one weapon
  const mode = weapons.includes(requestedMode) ? requestedMode : firstWeapon

  const now = Date.now()
  const isPrimary = mode === firstWeapon
  const cooldownMs =
    mode === 'torpedo' ? TORPEDO_COOLDOWN_MS : HITSCAN_TUNING[mode].cooldownMs
  if (isPrimary) {
    if (now - (shooter.lastLaserAt ?? 0) < cooldownMs) return
    shooter.lastLaserAt = now
  } else {
    if (now - (shooter.lastTorpedoAt ?? 0) < cooldownMs) return
    shooter.lastTorpedoAt = now
  }
  await redis.hSet(playersKey(postId), {[shooterId]: JSON.stringify(shooter)})

  const {x, y, rotation} = shooter
  const dirX = Math.cos(rotation - Math.PI / 2)
  const dirY = Math.sin(rotation - Math.PI / 2)
  const others = await listOtherPlayers(postId, shooterId)

  if (mode !== 'torpedo') {
    const tuning = HITSCAN_TUNING[mode]
    await broadcast(postId, {
      type: 'shot',
      userId: shooterId,
      x,
      y,
      rotation,
      mode,
      travelMs: 0,
    })

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

  // Stop at the nearest roughly-aimed-at target instead of always flying to
```

(This leaves `mode` used below as a `WeaponMode` known to be `'torpedo'` at this point — the existing torpedo-travel code beneath it, unchanged by this step, already only runs in that case.)

- [ ] **Step 4: Update the torpedo branch and `resolveTorpedoImpact` to pass the full `shooter` object**

Find:

```typescript
  const travelMs = (travelDistance / TORPEDO_SPEED) * 1000
  const impactX = x + dirX * travelDistance
  const impactY = y + dirY * travelDistance
  await broadcast(postId, {
    type: 'shot',
    userId: shooterId,
    x,
    y,
    rotation,
    mode,
    travelMs,
  })
  setTimeout(() => {
    resolveTorpedoImpact(
      postId,
      subredditId,
      shooterId,
      shooterUsername,
      impactX,
      impactY,
    ).catch(err =>
      console.error(
        `torpedo resolution failed; ${err instanceof Error ? err.stack : err}`,
      ),
    )
  }, travelMs)
}

async function resolveTorpedoImpact(
  postId: string,
  subredditId: string,
  shooterId: string,
  shooterUsername: string,
  impactX: number,
  impactY: number,
): Promise<void> {
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
    shooterId,
    shooterUsername,
    closest.player,
    TORPEDO_DAMAGE,
  )
}
```

Replace with:

```typescript
  const travelMs = (travelDistance / TORPEDO_SPEED) * 1000
  const impactX = x + dirX * travelDistance
  const impactY = y + dirY * travelDistance
  await broadcast(postId, {
    type: 'shot',
    userId: shooterId,
    x,
    y,
    rotation,
    mode,
    travelMs,
  })
  setTimeout(() => {
    resolveTorpedoImpact(
      postId,
      subredditId,
      shooterId,
      shooterUsername,
      impactX,
      impactY,
    ).catch(err =>
      console.error(
        `torpedo resolution failed; ${err instanceof Error ? err.stack : err}`,
      ),
    )
  }, travelMs)
}

async function resolveTorpedoImpact(
  postId: string,
  subredditId: string,
  shooterId: string,
  shooterUsername: string,
  impactX: number,
  impactY: number,
): Promise<void> {
  const shooterJson = await redis.hGet(playersKey(postId), shooterId)
  if (!shooterJson) return
  const shooter = JSON.parse(shooterJson) as PlayerState

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

(`resolveTorpedoImpact`'s own Redis-tracked in-flight state and Flak interception are added in Task 3 — this step only makes it fetch the shooter's current `PlayerState`, since `applyDamage` needs it for `computeDamage`.)

- [ ] **Step 5: Rewrite `applyDamage` to take the full `shooter` and use `computeDamage`**

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
    await broadcastPilotReward(postId, shooterId, 'hit')
    return
  }

  await addScore(postId, subredditId, shooterId, shooterUsername, KILL_SCORE)
  await addKill(postId, subredditId, shooterId, shooterUsername)
  await broadcastPilotReward(postId, shooterId, 'kill')
  await applyDeathPenaltyFor(target.userId)
  const spawn = randSpawn()
```

Replace with:

```typescript
async function applyDamage(
  postId: string,
  subredditId: string,
  shooter: PlayerState,
  shooterUsername: string,
  target: PlayerState,
  baseDamage: number,
): Promise<void> {
  const damage = computeDamage(baseDamage, Date.now(), shooter, target)
  const shooterId = shooter.userId
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

- [ ] **Step 6: Verify it compiles**

Run: `npm run test:types`
Expected: the Task-1 `Endpoint.Ability` exhaustiveness error in `server.ts` still persists (fixed in Task 5) — confirm no other new errors, and specifically confirm `sector.ts` itself is clean.

- [ ] **Step 7: Verify the full test suite's unaffected parts still pass**

Run: `npm run test:unit`
Expected: PASS — this task doesn't touch any tested pure function, so all 35 existing tests should be unaffected.

- [ ] **Step 8: Commit**

```bash
git add src/server/sector.ts
git commit -m "Adopt per-line weapons and computeDamage in Sector Mode's fireWeapon/applyDamage"
```

---

### Task 3: In-flight torpedo tracking and Flak interception

**Files:**
- Modify: `src/server/sector.ts`

**Interfaces:**
- Consumes: `FLAK_INTERCEPT_RANGE` from `../shared/api.ts`
- Produces: `torpedoesKey(postId): string` (private); `PendingTorpedo` (private type); `tryFlakIntercept(postId, tender, now): Promise<boolean>` (private)

- [ ] **Step 1: Import `FLAK_INTERCEPT_RANGE`**

Find in `src/server/sector.ts`:

```typescript
import {
  AUTOCANNON_COOLDOWN_MS,
  AUTOCANNON_RANGE,
  BURST_COOLDOWN_MS,
  BURST_RANGE,
  FLAK_COOLDOWN_MS,
  FLAK_RANGE,
  LASER_COOLDOWN_MS,
  LASER_RANGE,
  PLASMA_COOLDOWN_MS,
  PLASMA_RANGE,
  SHIP_WEAPONS,
  TORPEDO_COOLDOWN_MS,
  TORPEDO_RANGE,
  TORPEDO_SPEED,
} from '../shared/api.ts'
```

Replace with:

```typescript
import {
  AUTOCANNON_COOLDOWN_MS,
  AUTOCANNON_RANGE,
  BURST_COOLDOWN_MS,
  BURST_RANGE,
  FLAK_COOLDOWN_MS,
  FLAK_INTERCEPT_RANGE,
  FLAK_RANGE,
  LASER_COOLDOWN_MS,
  LASER_RANGE,
  PLASMA_COOLDOWN_MS,
  PLASMA_RANGE,
  SHIP_WEAPONS,
  TORPEDO_COOLDOWN_MS,
  TORPEDO_RANGE,
  TORPEDO_SPEED,
} from '../shared/api.ts'
```

- [ ] **Step 2: Add `torpedoesKey` next to the other per-post key helpers**

Find:

```typescript
function killsKey(postId: string): string {
  return `sector:${postId}:kills`
}
```

Replace with:

```typescript
function killsKey(postId: string): string {
  return `sector:${postId}:kills`
}

function torpedoesKey(postId: string): string {
  return `sector:${postId}:torpedoes`
}
```

- [ ] **Step 3: Add the `PendingTorpedo` type and `tryFlakIntercept`, right before `fireWeapon`**

Find:

```typescript
/**
 * Fires the shooter's weapon. Deliberately takes no client-supplied position —
```

Replace with:

```typescript
/** A torpedo in flight, tracked so a Flak Battery can find and destroy it before it lands. */
type PendingTorpedo = {
  shooterId: string
  x: number
  y: number
  impactX: number
  impactY: number
  firedAt: number
  resolveAt: number
}

/** Scans in-flight torpedoes for one within Flak range (interpolating its current position from firedAt/resolveAt) and destroys it. Returns whether one was found — if so, the Flak shot is consumed and no shotgun blast fires this trigger pull. Sector Mode has no teams, so "not mine" (not "not my team's") is the only exclusion. */
async function tryFlakIntercept(
  postId: string,
  tender: PlayerState,
  now: number,
): Promise<boolean> {
  const raw = await redis.hGetAll(torpedoesKey(postId))
  let bestId: string | undefined
  let bestDist = Infinity
  for (const [torpedoId, json] of Object.entries(raw ?? {})) {
    const t = JSON.parse(json) as PendingTorpedo
    if (t.shooterId === tender.userId) continue
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
  const deleted = await redis.hDel(torpedoesKey(postId), [bestId])
  if (deleted === 0) return false // race: already resolved or intercepted first
  await broadcast(postId, {
    type: 'flak_intercept',
    userId: tender.userId,
    x: tender.x,
    y: tender.y,
  })
  return true
}

/**
 * Fires the shooter's weapon. Deliberately takes no client-supplied position —
```

- [ ] **Step 4: Wire the Flak intercept check into `fireWeapon`, and track outgoing torpedoes**

Find:

```typescript
  const {x, y, rotation} = shooter
  const dirX = Math.cos(rotation - Math.PI / 2)
  const dirY = Math.sin(rotation - Math.PI / 2)
  const others = await listOtherPlayers(postId, shooterId)

  if (mode !== 'torpedo') {
```

Replace with:

```typescript
  const {x, y, rotation} = shooter
  const dirX = Math.cos(rotation - Math.PI / 2)
  const dirY = Math.sin(rotation - Math.PI / 2)
  const others = await listOtherPlayers(postId, shooterId)

  if (mode === 'flak' && (await tryFlakIntercept(postId, shooter, now))) return

  if (mode !== 'torpedo') {
```

Find:

```typescript
  const travelMs = (travelDistance / TORPEDO_SPEED) * 1000
  const impactX = x + dirX * travelDistance
  const impactY = y + dirY * travelDistance
  await broadcast(postId, {
    type: 'shot',
    userId: shooterId,
    x,
    y,
    rotation,
    mode,
    travelMs,
  })
  setTimeout(() => {
    resolveTorpedoImpact(
      postId,
      subredditId,
      shooterId,
      shooterUsername,
      impactX,
      impactY,
    ).catch(err =>
      console.error(
        `torpedo resolution failed; ${err instanceof Error ? err.stack : err}`,
      ),
    )
  }, travelMs)
}
```

Replace with:

```typescript
  const travelMs = (travelDistance / TORPEDO_SPEED) * 1000
  const impactX = x + dirX * travelDistance
  const impactY = y + dirY * travelDistance
  const torpedoId = `${now.toString(36)}${Math.random().toString(36).slice(2, 6)}`
  const pending: PendingTorpedo = {
    shooterId,
    x,
    y,
    impactX,
    impactY,
    firedAt: now,
    resolveAt: now + travelMs,
  }
  await redis.hSet(torpedoesKey(postId), {
    [torpedoId]: JSON.stringify(pending),
  })
  await broadcast(postId, {
    type: 'shot',
    userId: shooterId,
    x,
    y,
    rotation,
    mode,
    travelMs,
  })
  setTimeout(() => {
    resolveTorpedoImpact(
      postId,
      subredditId,
      torpedoId,
      shooterId,
      shooterUsername,
      impactX,
      impactY,
    ).catch(err =>
      console.error(
        `torpedo resolution failed; ${err instanceof Error ? err.stack : err}`,
      ),
    )
  }, travelMs)
}
```

- [ ] **Step 5: Have `resolveTorpedoImpact` consume its tracked entry (so Flak can beat it to the punch)**

Find:

```typescript
async function resolveTorpedoImpact(
  postId: string,
  subredditId: string,
  shooterId: string,
  shooterUsername: string,
  impactX: number,
  impactY: number,
): Promise<void> {
  const shooterJson = await redis.hGet(playersKey(postId), shooterId)
  if (!shooterJson) return
  const shooter = JSON.parse(shooterJson) as PlayerState
```

Replace with:

```typescript
async function resolveTorpedoImpact(
  postId: string,
  subredditId: string,
  torpedoId: string,
  shooterId: string,
  shooterUsername: string,
  impactX: number,
  impactY: number,
): Promise<void> {
  const deleted = await redis.hDel(torpedoesKey(postId), [torpedoId])
  if (deleted === 0) return // intercepted by flak before arrival

  const shooterJson = await redis.hGet(playersKey(postId), shooterId)
  if (!shooterJson) return
  const shooter = JSON.parse(shooterJson) as PlayerState
```

- [ ] **Step 6: Verify it compiles**

Run: `npm run test:types`
Expected: same single expected error as Task 2 (the `Endpoint.Ability` exhaustiveness check in `server.ts`, fixed in Task 5) — confirm `sector.ts` itself is clean.

- [ ] **Step 7: Commit**

```bash
git add src/server/sector.ts
git commit -m "Track in-flight torpedoes in Sector Mode so Flak Batteries can intercept them"
```

---

### Task 4: Mines and `activateAbility`

**Files:**
- Modify: `src/server/sector.ts`

**Interfaces:**
- Consumes: `OVERCHARGE_DURATION_MS`, `BULWARK_DURATION_MS`, `TENDER_HEAL_AMOUNT`, `TENDER_HEAL_RANGE` from `../shared/api.ts`; `abilityReady`, `nearestAlly`, `mineTriggeredBy`, `type Mine` from `./abilities.ts`
- Produces: `activateAbility(postId, userId): Promise<void>` (exported, throws on error); `movePlayer` gains a `subredditId: string` parameter (existing callers must update)

- [ ] **Step 1: Import the ability constants and `abilities.ts` helpers**

Find in `src/server/sector.ts`:

```typescript
import {
  AUTOCANNON_COOLDOWN_MS,
  AUTOCANNON_RANGE,
  BURST_COOLDOWN_MS,
  BURST_RANGE,
  FLAK_COOLDOWN_MS,
  FLAK_INTERCEPT_RANGE,
  FLAK_RANGE,
  LASER_COOLDOWN_MS,
  LASER_RANGE,
  PLASMA_COOLDOWN_MS,
  PLASMA_RANGE,
  SHIP_WEAPONS,
  TORPEDO_COOLDOWN_MS,
  TORPEDO_RANGE,
  TORPEDO_SPEED,
} from '../shared/api.ts'
import {computeDamage} from './abilities.ts'
```

Replace with:

```typescript
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
  OVERCHARGE_DURATION_MS,
  PLASMA_COOLDOWN_MS,
  PLASMA_RANGE,
  SHIP_WEAPONS,
  TENDER_HEAL_AMOUNT,
  TENDER_HEAL_RANGE,
  TORPEDO_COOLDOWN_MS,
  TORPEDO_RANGE,
  TORPEDO_SPEED,
} from '../shared/api.ts'
import {
  abilityReady,
  computeDamage,
  type Mine,
  mineTriggeredBy,
  nearestAlly,
} from './abilities.ts'
```

- [ ] **Step 2: Add `minesKey`**

Find:

```typescript
function torpedoesKey(postId: string): string {
  return `sector:${postId}:torpedoes`
}
```

Replace with:

```typescript
function torpedoesKey(postId: string): string {
  return `sector:${postId}:torpedoes`
}

function minesKey(postId: string): string {
  return `sector:${postId}:mines`
}
```

- [ ] **Step 3: Give `movePlayer` a `subredditId` parameter and check for mine triggers**

Find:

```typescript
/** Persists a position/rotation update and broadcasts it to the sector. */
export async function movePlayer(
  postId: string,
  userId: string,
  x: number,
  y: number,
  rotation: number,
): Promise<PlayerState | undefined> {
  const existing = await redis.hGet(playersKey(postId), userId)
  if (!existing) return undefined
  const player = JSON.parse(existing) as PlayerState
  player.x = Math.max(-WORLD_HALF, Math.min(WORLD_HALF, x))
  player.y = Math.max(-WORLD_HALF, Math.min(WORLD_HALF, y))
  player.rotation = rotation
  await redis.hSet(playersKey(postId), {[userId]: JSON.stringify(player)})
  await broadcast(postId, {type: 'move', player})
  return player
}
```

Replace with:

```typescript
/** Persists a position/rotation update and broadcasts it to the sector, then checks whether the new position triggered a mine. */
export async function movePlayer(
  postId: string,
  subredditId: string,
  userId: string,
  x: number,
  y: number,
  rotation: number,
): Promise<PlayerState | undefined> {
  const existing = await redis.hGet(playersKey(postId), userId)
  if (!existing) return undefined
  const player = JSON.parse(existing) as PlayerState
  player.x = Math.max(-WORLD_HALF, Math.min(WORLD_HALF, x))
  player.y = Math.max(-WORLD_HALF, Math.min(WORLD_HALF, y))
  player.rotation = rotation
  await redis.hSet(playersKey(postId), {[userId]: JSON.stringify(player)})
  await broadcast(postId, {type: 'move', player})

  const minesRaw = await redis.hGetAll(minesKey(postId))
  const mines: Mine[] = Object.values(minesRaw ?? {}).map(
    json => JSON.parse(json) as Mine,
  )
  // Sector Mode has no teams, so mineTriggeredBy's team check never excludes
  // anyone (every mine is stored with a placeholder team, every player has
  // team: null) — excluding the mine's own owner has to be done explicitly here.
  const triggered = mineTriggeredBy(mines, player)
  if (!triggered || triggered.ownerId === userId) return player
  const deleted = await redis.hDel(minesKey(postId), [triggered.mineId])
  if (deleted === 0) return player // race: already triggered by someone else
  const ownerJson = await redis.hGet(playersKey(postId), triggered.ownerId)
  if (!ownerJson) return player
  const owner = JSON.parse(ownerJson) as PlayerState
  await broadcast(postId, {
    type: 'mine_detonated',
    mineId: triggered.mineId,
    targetUserId: userId,
    x: triggered.x,
    y: triggered.y,
  })
  await applyDamage(postId, subredditId, owner, owner.username, player, TORPEDO_DAMAGE)
  return player
}
```

- [ ] **Step 4: Add `activateAbility`, right after `movePlayer`**

Find:

```typescript
/** Removes a player from the sector's active set and tells everyone else. */
export async function leaveSector(
```

Replace with:

```typescript
/**
 * Activates the caller's ship line's active ability, gated by its own
 * cooldown. Mirrors activateAbility in match.ts, adapted for Sector Mode's
 * flat 100-hull baseline (heals cap at START_HULL, not a per-line max) and
 * lack of teams (mines are placed with a placeholder team and excluded by
 * owner instead, in movePlayer).
 */
export async function activateAbility(
  postId: string,
  userId: string,
): Promise<void> {
  const existing = await redis.hGet(playersKey(postId), userId)
  if (!existing) throw new Error('not in this sector')
  const shooter = JSON.parse(existing) as PlayerState

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

  await redis.hSet(playersKey(postId), {[userId]: JSON.stringify(shooter)})

  if (shooter.line === 'tender') {
    const allies = await listOtherPlayers(postId, userId)
    const target = nearestAlly(allies, shooter, TENDER_HEAL_RANGE)
    if (target) {
      const current = await redis.hGet(hullKey(postId), target.userId)
      const healed = Math.min(
        START_HULL,
        Number(current ?? START_HULL) + TENDER_HEAL_AMOUNT,
      )
      await redis.hSet(hullKey(postId), {[target.userId]: String(healed)})
      await broadcast(postId, {
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
      team: 'A', // Sector Mode has no teams; movePlayer excludes self-triggering by ownerId instead.
      x: shooter.x,
      y: shooter.y,
    }
    await redis.hSet(minesKey(postId), {[mineId]: JSON.stringify(mine)})
    await broadcast(postId, {
      type: 'mine_placed',
      mineId,
      ownerId: userId,
      x: shooter.x,
      y: shooter.y,
    })
  }

  await broadcast(postId, {type: 'ability', userId, line: shooter.line})
}

/** Removes a player from the sector's active set and tells everyone else. */
export async function leaveSector(
```

- [ ] **Step 5: Verify it compiles**

Run: `npm run test:types`
Expected: two errors in `src/server/server.ts` — the `Endpoint.Ability` exhaustiveness error carried over from Task 1, plus a new one: `movePlayer`'s call site in `routeMove` is now missing the required `subredditId` argument. Both fixed in Task 5. Confirm `sector.ts` itself is clean and no other new errors appear.

- [ ] **Step 6: Commit**

```bash
git add src/server/sector.ts
git commit -m "Add mines and activateAbility to Sector Mode"
```

---

### Task 5: Server routing — `routeAbility`, unrestricted `routeFire`, `subredditId` into `routeMove`

**Files:**
- Modify: `src/server/server.ts`

**Interfaces:**
- Consumes: `activateAbility` from `./sector.ts` (Task 4); `AbilityReq`, `AbilityRsp` from `../shared/api.ts` (Task 1)
- Produces: `routeAbility(): Promise<AbilityRsp | ErrorRsp>`

- [ ] **Step 1: Add the `AbilityReq`/`AbilityRsp` type imports**

Find in `src/server/server.ts`:

```typescript
import {
  type ChallengeAction,
  type ChallengeStateRsp,
  type ChooseLineReq,
  type ChooseLineRsp,
  type CreateChallengeReq,
```

Replace with:

```typescript
import {
  type AbilityReq,
  type AbilityRsp,
  type ChallengeAction,
  type ChallengeStateRsp,
  type ChooseLineReq,
  type ChooseLineRsp,
  type CreateChallengeReq,
```

- [ ] **Step 2: Import `activateAbility` from `sector.ts`**

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
  peekSectorLine,
  pulseActiveSectors,
  sectorChannel,
  topPilots,
  touchActiveSector,
} from './sector.ts'
```

Replace with:

```typescript
import {
  activateAbility,
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
  | PilotProfileRsp
  | ChooseLineRsp
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
  | AbilityRsp
```

- [ ] **Step 4: Add the `Endpoint.Ability` case**

Find:

```typescript
      case Endpoint.Fire:
        rsp = await routeFire(reqMsg)
        break
```

Replace with:

```typescript
      case Endpoint.Fire:
        rsp = await routeFire(reqMsg)
        break
      case Endpoint.Ability:
        rsp = await routeAbility()
        break
```

- [ ] **Step 5: Add `routeAbility`, right after `routeFire`**

Find:

```typescript
function isFiniteNumber(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v)
}
```

Replace with:

```typescript
async function routeAbility(): Promise<AbilityRsp | ErrorRsp> {
  const postId = context.postId
  const userId = context.userId
  if (!postId) return {error: 'no postId', status: 400}
  if (!userId) return {error: 'must be logged in', status: 401}
  try {
    await activateAbility(postId, userId)
    return {ok: true}
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    return {error: msg, status: 400}
  }
}

function isFiniteNumber(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v)
}
```

- [ ] **Step 6: Pass `subredditId` into `movePlayer` and remove the sector weapon-mode restriction, in `routeMove`/`routeFire`**

Find:

```typescript
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
```

Replace with:

```typescript
async function routeMove(reqMsg: IncomingMessage): Promise<MoveRsp | ErrorRsp> {
  const postId = context.postId
  const userId = context.userId
  const subredditId = context.subredditId
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
    await movePlayer(postId, subredditId, userId, req.x, req.y, req.rotation)
  }
  return {ok: true}
}
```

Find:

```typescript
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
```

Replace with:

```typescript
  const kind = getPostKind()
  const matchId = matchIdFromKind(kind)
  if (matchId) {
    await fireWeaponInMatch(matchId, userId, req.mode)
  } else {
    // Sector Mode now grants every line its full Battle-Mode weapon kit —
    // fireWeapon validates against the shooter's own line internally, the
    // same way fireWeaponInMatch already does.
    const username = context.username ?? 'anonymous'
    await fireWeapon(postId, subredditId, userId, username, req.mode)
  }
  return {ok: true}
}
```

- [ ] **Step 7: Verify the full test suite passes**

Run: `npm run test`
Expected: PASS — `test:types`, `lint`, `test:unit`, and `build` all succeed with zero errors.

- [ ] **Step 8: Commit**

```bash
git add src/server/server.ts
git commit -m "Add routeAbility, drop Sector Mode's laser/torpedo-only restriction"
```

---

### Task 6: Client — per-line weapon keys, ability keybind, visual feedback

**Files:**
- Modify: `src/client/fetch.ts`
- Modify: `src/client/scene.ts`

**Interfaces:**
- Consumes: `Endpoint.Ability`, `AbilityReq`, `AbilityRsp`, `SHIP_WEAPONS` from `../shared/api.ts`
- Produces: `fetchAbility(): Promise<AbilityRsp | ErrorRsp>`

- [ ] **Step 1: Add `fetchAbility` to `src/client/fetch.ts`**

Find:

```typescript
export function fetchFire(req: FireReq): Promise<FireRsp | undefined> {
  return postJson<FireReq, FireRsp>(Endpoint.Fire, req)
}
```

Replace with:

```typescript
export function fetchFire(req: FireReq): Promise<FireRsp | undefined> {
  return postJson<FireReq, FireRsp>(Endpoint.Fire, req)
}

export function fetchAbility(): Promise<AbilityRsp | ErrorRsp> {
  return postJsonOrError<AbilityReq, AbilityRsp>(Endpoint.Ability, {})
}
```

Find the import block at the top of `src/client/fetch.ts`:

```typescript
import {
  type ChallengeStateRsp,
  type ChooseLineReq,
  type ChooseLineRsp,
  type CreateChallengeReq,
```

Replace with:

```typescript
import {
  type AbilityReq,
  type AbilityRsp,
  type ChallengeStateRsp,
  type ChooseLineReq,
  type ChooseLineRsp,
  type CreateChallengeReq,
```

- [ ] **Step 2: Verify it compiles**

Run: `npm run test:types`
Expected: no errors.

- [ ] **Step 3: Import `fetchAbility` and `SHIP_WEAPONS` in `scene.ts`**

Find in `src/client/scene.ts`:

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

Replace with:

```typescript
import {
  fetchAbility,
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

Find:

```typescript
import {
  LASER_COOLDOWN_MS,
  LASER_RANGE,
  TORPEDO_COOLDOWN_MS,
  TORPEDO_RANGE,
  TORPEDO_SPEED,
} from '../shared/api.ts'
```

Replace with:

```typescript
import {
  LASER_COOLDOWN_MS,
  LASER_RANGE,
  SHIP_WEAPONS,
  TORPEDO_COOLDOWN_MS,
  TORPEDO_RANGE,
  TORPEDO_SPEED,
} from '../shared/api.ts'
```

- [ ] **Step 4: Add an ability keybind, alongside the existing weapon keys**

Find:

```typescript
    this.keys = {
      up: kb.addKey(Phaser.Input.Keyboard.KeyCodes.W),
      down: kb.addKey(Phaser.Input.Keyboard.KeyCodes.S),
      left: kb.addKey(Phaser.Input.Keyboard.KeyCodes.A),
      right: kb.addKey(Phaser.Input.Keyboard.KeyCodes.D),
      laser: kb.addKey(Phaser.Input.Keyboard.KeyCodes.SPACE),
      torpedo: kb.addKey(Phaser.Input.Keyboard.KeyCodes.E),
    }
```

Replace with:

```typescript
    this.keys = {
      up: kb.addKey(Phaser.Input.Keyboard.KeyCodes.W),
      down: kb.addKey(Phaser.Input.Keyboard.KeyCodes.S),
      left: kb.addKey(Phaser.Input.Keyboard.KeyCodes.A),
      right: kb.addKey(Phaser.Input.Keyboard.KeyCodes.D),
      laser: kb.addKey(Phaser.Input.Keyboard.KeyCodes.SPACE),
      torpedo: kb.addKey(Phaser.Input.Keyboard.KeyCodes.E),
      ability: kb.addKey(Phaser.Input.Keyboard.KeyCodes.Q),
    }
```

Find the `keys` field type declaration:

```typescript
  private keys!: {
    up: Phaser.Input.Keyboard.Key
    down: Phaser.Input.Keyboard.Key
    left: Phaser.Input.Keyboard.Key
    right: Phaser.Input.Keyboard.Key
    laser: Phaser.Input.Keyboard.Key
    torpedo: Phaser.Input.Keyboard.Key
  }
```

Replace with:

```typescript
  private keys!: {
    up: Phaser.Input.Keyboard.Key
    down: Phaser.Input.Keyboard.Key
    left: Phaser.Input.Keyboard.Key
    right: Phaser.Input.Keyboard.Key
    laser: Phaser.Input.Keyboard.Key
    torpedo: Phaser.Input.Keyboard.Key
    ability: Phaser.Input.Keyboard.Key
  }
```

- [ ] **Step 5: Fire the player's own line's weapons instead of the hardcoded laser/torpedo, and trigger the ability**

Find:

```typescript
    const nowMs = performance.now()
    if (this.keys.laser.isDown || this.touchLaser?.isDown) {
      if (nowMs - this.lastLaserFiredAt > LASER_COOLDOWN_MS) {
        this.lastLaserFiredAt = nowMs
        this.fireLaser(this.ship.x, this.ship.y, this.ship.rotation)
        void fetchFire({mode: 'laser'})
      }
    }
    if (this.keys.torpedo.isDown || this.touchMissile?.isDown) {
      if (nowMs - this.lastTorpedoFiredAt > TORPEDO_COOLDOWN_MS) {
        this.lastTorpedoFiredAt = nowMs
        this.fireTorpedo(
          this.ship.x,
          this.ship.y,
          this.ship.rotation,
          (TORPEDO_RANGE / TORPEDO_SPEED) * 1000,
        )
        void fetchFire({mode: 'torpedo'})
      }
    }
```

Replace with:

```typescript
    const nowMs = performance.now()
    const weapons = this.player ? SHIP_WEAPONS[this.player.line] : []
    const primaryWeapon = weapons[0]
    const secondaryWeapon = weapons[1]
    if (
      primaryWeapon &&
      (this.keys.laser.isDown || this.touchLaser?.isDown)
    ) {
      if (nowMs - this.lastLaserFiredAt > LASER_COOLDOWN_MS) {
        this.lastLaserFiredAt = nowMs
        if (primaryWeapon === 'torpedo') {
          this.fireTorpedo(
            this.ship.x,
            this.ship.y,
            this.ship.rotation,
            (TORPEDO_RANGE / TORPEDO_SPEED) * 1000,
          )
        } else {
          this.fireLaser(this.ship.x, this.ship.y, this.ship.rotation)
        }
        void fetchFire({mode: primaryWeapon})
      }
    }
    if (
      secondaryWeapon &&
      (this.keys.torpedo.isDown || this.touchMissile?.isDown)
    ) {
      if (nowMs - this.lastTorpedoFiredAt > TORPEDO_COOLDOWN_MS) {
        this.lastTorpedoFiredAt = nowMs
        this.fireTorpedo(
          this.ship.x,
          this.ship.y,
          this.ship.rotation,
          (TORPEDO_RANGE / TORPEDO_SPEED) * 1000,
        )
        void fetchFire({mode: secondaryWeapon})
      }
    }
    if (Phaser.Input.Keyboard.JustDown(this.keys.ability)) {
      void fetchAbility()
    }
```

(Every line has exactly one or two weapons in `SHIP_WEAPONS` — only Fighter has two (`laser`, `torpedo`), so `secondaryWeapon` is `undefined` and the second block never fires for any other line, matching today's cooldown-key reuse. `primaryWeapon`'s beam-vs-projectile rendering choice mirrors `SHIP_WEAPONS`: torpedo is the only travel-time weapon, so anything else renders as a beam via the existing `fireLaser` helper — reused for all hitscan weapons rather than adding per-weapon visuals in this task.)

- [ ] **Step 6: Add heal/mine/flak-intercept feedback to `handleRealtime`**

Find:

```typescript
    } else if (msg.type === 'respawn') {
      if (msg.player.userId === this.player?.userId) {
        this.player = msg.player
        this.ship.setPosition(msg.player.x, msg.player.y)
        this.ship.rotation = msg.player.rotation
        this.updateScoreHud()
      } else {
        this.spawnRemote(msg.player)
      }
    }
  }
```

Replace with:

```typescript
    } else if (msg.type === 'respawn') {
      if (msg.player.userId === this.player?.userId) {
        this.player = msg.player
        this.ship.setPosition(msg.player.x, msg.player.y)
        this.ship.rotation = msg.player.rotation
        this.updateScoreHud()
      } else {
        this.spawnRemote(msg.player)
      }
    } else if (msg.type === 'heal') {
      if (msg.targetUserId === this.player?.userId && this.player) {
        this.player.hull = msg.hull
        this.updateScoreHud()
      }
      this.flashHeal(msg.targetUserId)
    } else if (msg.type === 'mine_detonated') {
      this.fizzleMiss(msg.x, msg.y)
      if (msg.targetUserId === this.player?.userId) this.flashDamage()
    } else if (msg.type === 'flak_intercept') {
      this.fizzleMiss(msg.x, msg.y)
    }
  }
```

- [ ] **Step 7: Add `flashHeal`, right after `flashRemoteHit`**

Find:

```typescript
  private flashRemoteHit(userId: string): void {
    const r = this.others.get(userId)
    if (!r) return
    r.sprite.setTint(0xff3344).setTintMode(Phaser.TintModes.FILL)
    this.time.delayedCall(120, () => r.sprite.clearTint())
  }
```

Replace with:

```typescript
  private flashRemoteHit(userId: string): void {
    const r = this.others.get(userId)
    if (!r) return
    r.sprite.setTint(0xff3344).setTintMode(Phaser.TintModes.FILL)
    this.time.delayedCall(120, () => r.sprite.clearTint())
  }

  private flashHeal(userId: string): void {
    const sprite =
      userId === this.player?.userId ? this.ship : this.others.get(userId)?.sprite
    if (!sprite) return
    sprite.setTint(0x66ffaa).setTintMode(Phaser.TintModes.FILL)
    this.time.delayedCall(160, () => sprite.clearTint())
  }
```

- [ ] **Step 8: Update the on-screen key hint**

Find:

```typescript
    this.add
      .text(
        W - 12,
        H - 12,
        '[SPACE] LASER  ·  [E] MISSILE  ·  [L] LEADERBOARD  ·  [P] PILOT',
        {
```

Replace with:

```typescript
    this.add
      .text(
        W - 12,
        H - 12,
        '[SPACE] FIRE  ·  [E] 2ND WEAPON  ·  [Q] ABILITY  ·  [L] LEADERBOARD  ·  [P] PILOT',
        {
```

- [ ] **Step 9: Verify the full test suite passes**

Run: `npm run test`
Expected: PASS — `test:types`, `lint`, `test:unit`, and `build` all succeed with zero errors.

- [ ] **Step 10: Manual check**

Run: `npm run dev` (or `npm run playtest` if configured) and confirm, for at least two different ship lines: the primary weapon fires with the correct visual/cooldown, `Q` triggers the ability with no console error, and a Tender's `Q` heals a nearby ally (visible hull increase + green flash) when another player is in range. This task has no dedicated automated test for the visual/input wiring — this manual pass is the verification step.

- [ ] **Step 11: Commit**

```bash
git add src/client/fetch.ts src/client/scene.ts
git commit -m "Fire per-line weapons and add the ability key on the client"
```

---

Each task leaves the game in a working, testable state. Once this plan ships, every Sector Mode pilot fights with their real ship line's weapon and ability — the follow-up plan (the pirate/mission engine, per the design spec's remaining phases) reuses this directly and adds the "revert to plain laser+torpedo once a mission resolves" gating this plan's Global Constraints note as deferred.
