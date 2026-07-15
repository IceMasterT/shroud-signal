# Battle Ship Squads Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn the 5 cosmetic ship lines into real combat roles (distinct stats + one active ability each) that players choose at battle join, so "Last One Standing" squad composition is an actual strategic decision.

**Architecture:** All new logic is additive to `src/server/match.ts` (battle arenas) and `src/client/battle.ts`. Free-play `sector.ts`/`scene.ts` are never touched. New pure game-math (squad-cap checks, damage/hull scaling, ability cooldowns, mine/heal targeting) lives in a new `src/server/abilities.ts`, unit-tested with zero Redis mocking. The thin Redis-touching orchestration in `match.ts` calls into those pure functions but is verified manually via `devvit playtest`, not automated tests — this codebase has no Redis-mock test infrastructure today (the one existing test file, `server.test.ts`, only mocks `redis.get`/`redis.incrBy` for the simple counter feature), and building a full hash/sorted-set mock is out of scope for this plan. Every new ability follows the exact cooldown-gate pattern already proven by laser/missile: client fires optimistically, server is authoritative.

**Tech Stack:** TypeScript, Devvit Web (`@devvit/web/server`/`client`), Phaser 4, Redis (via Devvit's client), `node:test` for unit tests, Biome for lint/format.

## Global Constraints

- Scope is battle arenas only (`src/server/match.ts`, `src/client/battle.ts`). Never modify `src/server/sector.ts` or `src/client/scene.ts` for this feature.
- Squad cap: max 2 players of the same ship line per team. This is exact — not "roughly balanced," a hard rejection at join time.
- `MAX_PLAYER_CAP` is 10 (`src/server/challenge.ts:10`) — 5 lines × cap-2 = 10, so the cap must never block a full valid roster.
- Abilities are player-triggered (new `R` key), server-authoritative cooldown, client cooldown is feel-only — same trust model as `LASER_COOLDOWN_MS`/`TORPEDO_COOLDOWN_MS`.
- Pathfinder's ability is "reveal enemy hull," not "reveal enemy positions" — positions are already always visible to both teams via the shared `matchChannel`, so revealing them would do nothing. Do not revert this to the original position-reveal idea.
- Design spec is `docs/superpowers/specs/2026-07-15-battle-ship-squads-design.md` — refer back to it if a task here seems to contradict it.

---

## File Structure

- **Modify** `src/shared/api.ts` — `ShipStats`/`SHIP_STATS`, ability tuning constants, `PlayerState.lastAbilityAt`/`abilityActiveUntil`, `JoinMatchReq`, `MatchAbilityReq`/`Rsp`, new `MatchMsg` variants, `Endpoint.MatchAbility`.
- **Create** `src/server/abilities.ts` — pure functions: `canJoinLine`, `maxHullFor`, `abilityReady`, `computeDamage`, `nearestAlly`, `mineTriggeredBy`, plus the `Mine` type. No Redis, no I/O.
- **Create** `src/server/abilities.test.ts` — unit tests for all of the above.
- **Modify** `src/server/match.ts` — `joinMatch` (chosen line + cap check), `startRound` (per-line max hull), `applyDamageInMatch`/`fireWeaponInMatch`/`resolveTorpedoImpactInMatch` (scaled damage), new `activateAbility`, mine storage + detonation check in `movePlayerInMatch`.
- **Modify** `src/server/server.ts` — `routeMatchJoin` reads the chosen line, new `routeMatchAbility`, router wiring.
- **Modify** `src/client/fetch.ts` — `fetchMatchJoin` takes a line, new `fetchMatchAbility`.
- **Modify** `src/client/battle.ts` — ship picker UI, `R` key + ability cooldown, visuals for ability pulses/heals/mines/radar reveal.
- **Modify** `public/battle.html` — CSS for the ship-picker grid.
- **Modify** `readme.md` — one paragraph documenting ship roles.

---

## Phase 1 — Data model and squad-capped join flow

### Task 1: Shared types and ship stat table

**Files:**
- Modify: `src/shared/api.ts`

**Interfaces:**
- Produces: `ShipStats` type, `SHIP_STATS: Record<ShipLine, ShipStats>`, `ABILITY_COOLDOWN_MS: Record<ShipLine, number>`, `OVERCHARGE_DURATION_MS`, `OVERCHARGE_DAMAGE_MUL`, `BULWARK_DURATION_MS`, `BULWARK_DAMAGE_MUL`, `RADAR_PING_DURATION_MS`, `TENDER_HEAL_AMOUNT`, `TENDER_HEAL_RANGE`, `PlayerState.lastAbilityAt: number`, `PlayerState.abilityActiveUntil: number`, `JoinMatchReq = {line: ShipLine}`, `MatchAbilityReq`, `MatchAbilityRsp`, `Endpoint.MatchAbility`, new `MatchMsg` variants (`'ability'`, `'heal'`, `'mine_placed'`, `'mine_detonated'`).

- [ ] **Step 1: Add the ship stat table and ability tuning constants**

Find the block ending in `export type WeaponMode = 'laser' | 'torpedo'` in `src/shared/api.ts` and add immediately after it:

```typescript
/** Per-line combat multipliers for battle arenas only — free-play sectors don't use these. */
export type ShipStats = {speedMul: number; hullMul: number; dmgMul: number}
export const SHIP_STATS: Record<ShipLine, ShipStats> = {
  fighter: {speedMul: 1.2, hullMul: 0.8, dmgMul: 1.15},
  miner: {speedMul: 0.9, hullMul: 1.1, dmgMul: 1.0},
  transport: {speedMul: 0.75, hullMul: 1.4, dmgMul: 0.85},
  pathfinder: {speedMul: 1.3, hullMul: 0.7, dmgMul: 1.0},
  tender: {speedMul: 0.9, hullMul: 1.1, dmgMul: 0.8},
}

/** Per-line active-ability tuning, battle arenas only. */
export const ABILITY_COOLDOWN_MS: Record<ShipLine, number> = {
  fighter: 20000,
  miner: 12000,
  transport: 18000,
  pathfinder: 15000,
  tender: 15000,
}
export const OVERCHARGE_DURATION_MS = 5000
export const OVERCHARGE_DAMAGE_MUL = 1.5
export const BULWARK_DURATION_MS = 4000
export const BULWARK_DAMAGE_MUL = 0.5
export const RADAR_PING_DURATION_MS = 6000
export const TENDER_HEAL_AMOUNT = 35
export const TENDER_HEAL_RANGE = 300
```

- [ ] **Step 2: Add the two new `PlayerState` fields**

In `PlayerState`, change:

```typescript
  hull: number
  score: number
  kills: number
  lastLaserAt: number
  lastTorpedoAt: number
  team: Team | null
}
```

to:

```typescript
  hull: number
  score: number
  kills: number
  lastLaserAt: number
  lastTorpedoAt: number
  lastAbilityAt: number
  abilityActiveUntil: number
  team: Team | null
}
```

- [ ] **Step 3: Add `JoinMatchReq` and the two `MatchAbility` types**

Find `export type JoinMatchRsp = {ok: true}` and change it to:

```typescript
export type JoinMatchReq = {line: ShipLine}
export type JoinMatchRsp = {ok: true}
export type MatchAbilityReq = Record<string, never>
export type MatchAbilityRsp = {ok: true}
```

- [ ] **Step 4: Add the 4 new `MatchMsg` variants**

Find the `MatchMsg` union's `{type: 'kills'; userId: string; kills: number}` line and add immediately after it:

```typescript
  | {type: 'kills'; userId: string; kills: number}
  | {type: 'ability'; userId: string; line: ShipLine}
  | {type: 'heal'; targetUserId: string; healerUserId: string; hull: number}
  | {type: 'mine_placed'; mineId: string; ownerId: string; x: number; y: number}
  | {
      type: 'mine_detonated'
      mineId: string
      targetUserId: string
      x: number
      y: number
    }
```

(replace the single `{type: 'kills'; ...}` line with this whole block — don't duplicate it)

- [ ] **Step 5: Add the `MatchAbility` endpoint**

In `export const Endpoint = {...}`, change:

```typescript
  MatchJoin: 'api/match/join',
  MatchState: 'api/match/state',
```

to:

```typescript
  MatchJoin: 'api/match/join',
  MatchAbility: 'api/match/ability',
  MatchState: 'api/match/state',
```

In `export const EndpointMethod = {...}`, change:

```typescript
  [Endpoint.MatchJoin]: 'POST',
  [Endpoint.MatchState]: 'GET',
```

to:

```typescript
  [Endpoint.MatchJoin]: 'POST',
  [Endpoint.MatchAbility]: 'POST',
  [Endpoint.MatchState]: 'GET',
```

- [ ] **Step 6: Verify it compiles**

Run: `npm run test:types`
Expected: no output, exit code 0 (there are no consumers of the new fields yet, so nothing should fail — this just confirms the new syntax itself is valid TypeScript).

- [ ] **Step 7: Commit**

```bash
git add src/shared/api.ts
git commit -m "Add ship stats, ability constants, and ability endpoint types"
```

---

### Task 2: Pure squad-cap and hull-scaling functions

**Files:**
- Create: `src/server/abilities.ts`
- Test: `src/server/abilities.test.ts`

**Interfaces:**
- Consumes: `ShipLine`, `SHIP_STATS`, `PlayerState` from `../shared/api.ts` (Task 1)
- Produces: `canJoinLine(teammates: Pick<PlayerState, 'line'>[], line: ShipLine): boolean`, `maxHullFor(line: ShipLine): number`

- [ ] **Step 1: Write the failing tests**

Create `src/server/abilities.test.ts`:

```typescript
import assert from 'node:assert/strict'
import {test} from 'node:test'
import {canJoinLine, maxHullFor} from './abilities.ts'

test('canJoinLine allows up to 2 of the same line', () => {
  assert.equal(canJoinLine([], 'fighter'), true)
  assert.equal(canJoinLine([{line: 'fighter'}], 'fighter'), true)
  assert.equal(
    canJoinLine([{line: 'fighter'}, {line: 'fighter'}], 'fighter'),
    false,
  )
})

test('canJoinLine ignores other lines on the team', () => {
  assert.equal(
    canJoinLine([{line: 'fighter'}, {line: 'fighter'}], 'tender'),
    true,
  )
})

test('maxHullFor scales the 100-hull baseline by the line hull multiplier', () => {
  assert.equal(maxHullFor('transport'), 140)
  assert.equal(maxHullFor('pathfinder'), 70)
  assert.equal(maxHullFor('miner'), 110)
})
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node --experimental-strip-types --no-warnings=ExperimentalWarning --test src/server/abilities.test.ts`
Expected: FAIL — `Cannot find module './abilities.ts'`

- [ ] **Step 3: Write the implementation**

Create `src/server/abilities.ts`:

```typescript
import type {PlayerState, ShipLine} from '../shared/api.ts'
import {SHIP_STATS} from '../shared/api.ts'

// Mirrors match.ts's own START_HULL — kept local rather than shared/imported,
// matching the existing precedent of sector.ts and match.ts each independently
// declaring the same 100-hull baseline.
const START_HULL = 100

/** A team may not have more than 2 players on the same ship line. */
export function canJoinLine(
  teammates: Pick<PlayerState, 'line'>[],
  line: ShipLine,
): boolean {
  return teammates.filter(p => p.line === line).length < 2
}

/** A ship line's actual max hull, scaled from the shared 100-hull baseline. */
export function maxHullFor(line: ShipLine): number {
  return Math.round(START_HULL * SHIP_STATS[line].hullMul)
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `node --experimental-strip-types --no-warnings=ExperimentalWarning --test src/server/abilities.test.ts`
Expected: PASS — 3 tests, 0 failures

- [ ] **Step 5: Commit**

```bash
git add src/server/abilities.ts src/server/abilities.test.ts
git commit -m "Add pure squad-cap and hull-scaling functions"
```

---

### Task 3: Wire chosen line and squad cap into `joinMatch`/`startRound`

**Files:**
- Modify: `src/server/match.ts`

**Interfaces:**
- Consumes: `canJoinLine`, `maxHullFor` from `./abilities.ts` (Task 2)
- Produces: `joinMatch(matchId, side, userId, username, snoovatar, line: ShipLine): Promise<PlayerState>` (signature changed — 6th param added)

- [ ] **Step 1: Import the new pure functions and remove the now-unused `lineForUser`**

At the top of `src/server/match.ts`, add:

```typescript
import {canJoinLine, maxHullFor} from './abilities.ts'
```

Delete this function entirely (it becomes unused once Step 2 lands):

```typescript
function lineForUser(userId: string): ShipLine {
  let hash = 0
  for (let i = 0; i < userId.length; i++)
    hash = (hash * 31 + userId.charCodeAt(i)) >>> 0
  return SHIP_LINES[hash % SHIP_LINES.length] ?? 'fighter'
}
```

You can also remove the now-unused `SHIP_LINES` import from `'../shared/api.ts'` if nothing else in the file uses it (check with `grep -n SHIP_LINES src/server/match.ts` after this task).

- [ ] **Step 2: Replace `joinMatch`'s body**

Replace the entire function:

```typescript
export async function joinMatch(
  matchId: string,
  side: Team,
  userId: string,
  username: string,
  snoovatar: string | undefined,
  line: ShipLine,
): Promise<PlayerState> {
  const match = await getMatch(matchId)
  if (!match) throw new Error('match not found')
  if (match.status !== 'warmup')
    throw new Error('match is not accepting players')

  const existing = await redis.hGet(matchPlayersKey(matchId), userId)
  if (existing) return JSON.parse(existing) as PlayerState

  const players = await getMatchPlayers(matchId)
  const teammates = players.filter(p => p.team === side)
  if (teammates.length >= match.playerCap) throw new Error('team is full')
  if (!canJoinLine(teammates, line))
    throw new Error(`${line} is full for this team (max 2)`)

  const spawn = randSpawn(side)
  const maxHull = maxHullFor(line)
  const player: PlayerState = {
    userId,
    username,
    snoovatar: snoovatar ?? null,
    line,
    x: spawn.x,
    y: spawn.y,
    rotation: 0,
    hull: maxHull,
    score: 0,
    kills: 0,
    lastLaserAt: 0,
    lastTorpedoAt: 0,
    lastAbilityAt: 0,
    abilityActiveUntil: 0,
    team: side,
  }
  await redis.hSet(matchPlayersKey(matchId), {[userId]: JSON.stringify(player)})
  await redis.hSet(matchHullKey(matchId), {[userId]: String(maxHull)})
  await broadcastMatch(matchId, {type: 'roster', player})
  return player
}
```

- [ ] **Step 3: Make `startRound` reset hull to each player's own max, not a flat 100**

In `startRound`, replace:

```typescript
  for (const p of players) {
    if (!p.team) continue
    const spawn = randSpawn(p.team)
    p.x = spawn.x
    p.y = spawn.y
    p.rotation = 0
    p.hull = START_HULL
    await redis.hSet(matchPlayersKey(match.matchId), {
      [p.userId]: JSON.stringify(p),
    })
    await redis.hSet(matchHullKey(match.matchId), {
      [p.userId]: String(START_HULL),
    })
  }
```

with:

```typescript
  for (const p of players) {
    if (!p.team) continue
    const spawn = randSpawn(p.team)
    const maxHull = maxHullFor(p.line)
    p.x = spawn.x
    p.y = spawn.y
    p.rotation = 0
    p.hull = maxHull
    await redis.hSet(matchPlayersKey(match.matchId), {
      [p.userId]: JSON.stringify(p),
    })
    await redis.hSet(matchHullKey(match.matchId), {
      [p.userId]: String(maxHull),
    })
  }
```

- [ ] **Step 4: Confirm it compiles**

Run: `npm run test:types`
Expected: errors at every call site of `joinMatch` that hasn't been updated yet (`src/server/server.ts`) — that's expected and gets fixed in Task 4. Confirm the *only* errors are in `server.ts` about the `joinMatch` call, not in `match.ts` itself.

- [ ] **Step 5: Commit**

```bash
git add src/server/match.ts
git commit -m "Squad-cap-aware join and per-line max hull in battle arenas"
```

---

### Task 4: Accept the chosen line in `routeMatchJoin`

**Files:**
- Modify: `src/server/server.ts`

**Interfaces:**
- Consumes: `joinMatch(..., line: ShipLine)` (Task 3), `JoinMatchReq`, `SHIP_LINES` from `../shared/api.ts` (Task 1 / existing)

- [ ] **Step 1: Add imports**

In `src/server/server.ts`'s import block from `'../shared/api.ts'`, add `JoinMatchReq` and `SHIP_LINES` to the existing named imports (alphabetical order, matching the file's existing style):

```typescript
  type JoinMatchReq,
  type JoinMatchRsp,
```

and

```typescript
  SHIP_LINES,
```

(add `SHIP_LINES` as a value import alongside `Endpoint`/`EndpointMethod`, since it's a `readonly ShipLine[]` array, not a type)

- [ ] **Step 2: Replace `routeMatchJoin`**

Replace the entire function:

```typescript
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
  try {
    await joinMatch(
      kind.matchId,
      kind.side,
      userId,
      username,
      context.snoovatar,
      req.line,
    )
    return {ok: true}
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    return {error: msg, status: 400}
  }
}
```

- [ ] **Step 3: Update the call site to pass `reqMsg`**

Find `case Endpoint.MatchJoin:` in the `route` function's switch statement. Change:

```typescript
      case Endpoint.MatchJoin:
        rsp = await routeMatchJoin()
        break
```

to:

```typescript
      case Endpoint.MatchJoin:
        rsp = await routeMatchJoin(reqMsg)
        break
```

- [ ] **Step 4: Verify it compiles and the existing test suite still passes**

Run: `npm run test`
Expected: `test:types`, `lint`, `test:unit` (4 passing tests, unrelated to this change), and `build` all succeed.

- [ ] **Step 5: Commit**

```bash
git add src/server/server.ts
git commit -m "Read the chosen ship line in the match-join route"
```

---

### Task 5: Client `fetchMatchJoin` takes a line

**Files:**
- Modify: `src/client/fetch.ts`

**Interfaces:**
- Consumes: `JoinMatchReq` from `../shared/api.ts` (Task 1)
- Produces: `fetchMatchJoin(req: JoinMatchReq): Promise<JoinMatchRsp | ErrorRsp>` (signature changed)

- [ ] **Step 1: Add the `JoinMatchReq` import**

In the import block from `'../shared/api.ts'`, add `type JoinMatchReq,` (alphabetically, right before `type JoinMatchRsp,`).

- [ ] **Step 2: Replace `fetchMatchJoin`**

Replace:

```typescript
export function fetchMatchJoin(): Promise<JoinMatchRsp | ErrorRsp> {
  return postJsonOrError<Record<string, never>, JoinMatchRsp>(
    Endpoint.MatchJoin,
    {},
  )
}
```

with:

```typescript
export function fetchMatchJoin(
  req: JoinMatchReq,
): Promise<JoinMatchRsp | ErrorRsp> {
  return postJsonOrError<JoinMatchReq, JoinMatchRsp>(Endpoint.MatchJoin, req)
}
```

- [ ] **Step 3: Verify it compiles**

Run: `npm run test:types`
Expected: an error in `src/client/battle.ts` at the existing `fetchMatchJoin()` call (no argument) — expected, fixed in Task 6.

- [ ] **Step 4: Commit**

```bash
git add src/client/fetch.ts
git commit -m "fetchMatchJoin takes the chosen ship line"
```

---

### Task 6: Ship picker UI in the battle join flow

**Files:**
- Modify: `src/client/battle.ts`
- Modify: `public/battle.html`

**Interfaces:**
- Consumes: `fetchMatchJoin({line})` (Task 5), `SHIP_LINES`, `SHIP_STATS` from `../shared/api.ts` (Task 1)

- [ ] **Step 1: Import `SHIP_LINES` and `SHIP_STATS`**

In `src/client/battle.ts`'s import block from `'../shared/api.ts'`, add `SHIP_LINES` and `SHIP_STATS` as value imports.

- [ ] **Step 2: Add the ability blurb table and picker HTML builder**

Right after the existing `SHIP_LABEL` constant, add:

```typescript
const ABILITY_BLURB: Record<PlayerState['line'], string> = {
  fighter: 'Overcharge: +50% weapon damage for 5s',
  miner: 'Deploy Mine: plants a proximity mine',
  transport: 'Bulwark: -50% damage taken for 4s',
  pathfinder: 'Radar Ping: reveals enemy hull for 6s',
  tender: 'Repair Beam: heals your nearest ally',
}

function shipPickerHtml(): string {
  return SHIP_LINES.map(
    line => `
      <button class="ship-pick" data-line="${line}">
        <b>${SHIP_LABEL[line]}</b><br>
        <span class="stat">SPD ${Math.round(SHIP_STATS[line].speedMul * 100)}%</span>
        <span class="stat">HULL ${Math.round(SHIP_STATS[line].hullMul * 100)}%</span>
        <span class="stat">DMG ${Math.round(SHIP_STATS[line].dmgMul * 100)}%</span><br>
        <small>${ABILITY_BLURB[line]}</small>
      </button>`,
  ).join('')
}
```

- [ ] **Step 3: Replace the "Join battle" button with the picker, and `joinBattle` to take a line**

Replace:

```typescript
async function joinBattle(): Promise<void> {
  const rsp = await fetchMatchJoin()
  if (isErrorRsp(rsp)) {
    showOverlay(
      `<div class="panel"><p class="error">${escapeHtml(rsp.error)}</p></div>`,
    )
  }
  await poll()
}
```

with:

```typescript
async function joinBattle(line: PlayerState['line']): Promise<void> {
  const rsp = await fetchMatchJoin({line})
  if (isErrorRsp(rsp)) {
    showOverlay(
      `<div class="panel"><p class="error">${escapeHtml(rsp.error)}</p></div>`,
    )
  }
  await poll()
}
```

In `renderMatch`'s `warmup` branch, replace:

```typescript
        ${self ? '<p>You are in. Waiting for the round to start…</p>' : '<button id="join">Join battle</button>'}
      </div>
    `)
    document
      .getElementById('join')
      ?.addEventListener('click', () => void joinBattle())
    return
  }
```

with:

```typescript
        ${self ? '<p>You are in. Waiting for the round to start…</p>' : `<div class="ship-picker">${shipPickerHtml()}</div>`}
      </div>
    `)
    for (const btn of document.querySelectorAll<HTMLButtonElement>(
      '.ship-pick',
    )) {
      btn.addEventListener('click', () => {
        const line = btn.dataset.line as PlayerState['line']
        void joinBattle(line)
      })
    }
    return
  }
```

- [ ] **Step 4: Add picker CSS**

In `public/battle.html`, inside the `<style>` block, add after the existing `.roster` rule:

```css
    .ship-picker {
      display: grid;
      grid-template-columns: repeat(2, 1fr);
      gap: 0.5rem;
    }
    .ship-pick {
      display: block;
      text-align: left;
      font-size: 11px;
      line-height: 1.4;
    }
    .ship-pick small {
      color: #9fb4c9;
      font-size: 10px;
      text-transform: none;
      letter-spacing: normal;
    }
```

- [ ] **Step 5: Run the full test/build suite**

Run: `npm run test`
Expected: all pass, `public/battle.js` rebuilt.

- [ ] **Step 6: Manual verification (devvit playtest — no automated coverage for the join UI)**

1. `npx devvit playtest <your-test-subreddit>`
2. Use "Challenge a Subreddit" to create a challenge to a second test subreddit you also have installed on, accept it.
3. Open one side's arena post, confirm the warmup screen shows 5 ship buttons with stats + ability text instead of a single "Join battle" button.
4. Join as Fighter. Confirm you spawn with visibly less hull than the default 100 (check the bottom-left HUD: fighter is `hullMul: 0.8` → 80 max hull).
5. From a second account (or incognito), join the same team as Transport, then again as a second Fighter, then attempt a *third* Fighter on that team — the third attempt should show the server's `"fighter is full for this team (max 2)"` error instead of joining.

- [ ] **Step 7: Commit**

```bash
git add src/client/battle.ts public/battle.html
git commit -m "Add ship picker to the battle join flow"
```

---

## Phase 2 — Fighter Overcharge and Transport Bulwark

### Task 7: Pure damage-scaling and cooldown functions

**Files:**
- Modify: `src/server/abilities.ts`
- Modify: `src/server/abilities.test.ts`

**Interfaces:**
- Consumes: `ABILITY_COOLDOWN_MS`, `OVERCHARGE_DAMAGE_MUL`, `BULWARK_DAMAGE_MUL`, `SHIP_STATS` from `../shared/api.ts` (Task 1)
- Produces: `abilityReady(lastAbilityAt: number, line: ShipLine, now: number): boolean`, `computeDamage(baseDamage: number, now: number, shooter: Pick<PlayerState, 'line'|'abilityActiveUntil'>, target: Pick<PlayerState, 'line'|'abilityActiveUntil'>): number`

- [ ] **Step 1: Write the failing tests**

Append to `src/server/abilities.test.ts`:

```typescript
import {abilityReady, computeDamage} from './abilities.ts'

test('abilityReady is false before cooldown elapses, true after', () => {
  assert.equal(abilityReady(1000, 'fighter', 1000), false)
  assert.equal(abilityReady(1000, 'fighter', 20999), false)
  assert.equal(abilityReady(1000, 'fighter', 21000), true)
})

test('computeDamage applies the shooter line multiplier', () => {
  const shooter = {line: 'transport' as const, abilityActiveUntil: 0}
  const target = {line: 'miner' as const, abilityActiveUntil: 0}
  assert.equal(computeDamage(20, 1000, shooter, target), 17) // 20 * 0.85 = 17
})

test('computeDamage applies Fighter Overcharge while active', () => {
  const shooter = {line: 'fighter' as const, abilityActiveUntil: 5000}
  const target = {line: 'miner' as const, abilityActiveUntil: 0}
  assert.equal(computeDamage(20, 1000, shooter, target), 35) // 20*1.15*1.5=34.5 -> 35
})

test('computeDamage applies Transport Bulwark on the target while active', () => {
  const shooter = {line: 'miner' as const, abilityActiveUntil: 0}
  const target = {line: 'transport' as const, abilityActiveUntil: 5000}
  assert.equal(computeDamage(20, 1000, shooter, target), 10) // 20*1.0*0.5=10
})

test('computeDamage ignores expired ability windows', () => {
  const shooter = {line: 'fighter' as const, abilityActiveUntil: 500}
  const target = {line: 'miner' as const, abilityActiveUntil: 0}
  assert.equal(computeDamage(20, 1000, shooter, target), 23) // now(1000) >= 500, no bonus
})
```

Add the new imports (`abilityReady`, `computeDamage`) to the existing `import {canJoinLine, maxHullFor} from './abilities.ts'` line at the top of the file instead of a second import statement.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node --experimental-strip-types --no-warnings=ExperimentalWarning --test src/server/abilities.test.ts`
Expected: FAIL — `abilityReady`/`computeDamage` are not exported

- [ ] **Step 3: Implement**

Add to `src/server/abilities.ts` (update the import line at top first):

```typescript
import type {PlayerState, ShipLine} from '../shared/api.ts'
import {
  ABILITY_COOLDOWN_MS,
  BULWARK_DAMAGE_MUL,
  OVERCHARGE_DAMAGE_MUL,
  SHIP_STATS,
} from '../shared/api.ts'
```

Then add at the bottom of the file:

```typescript
/** True once a line's ability cooldown has elapsed since it was last used. */
export function abilityReady(
  lastAbilityAt: number,
  line: ShipLine,
  now: number,
): boolean {
  return now - lastAbilityAt >= ABILITY_COOLDOWN_MS[line]
}

/**
 * Final damage for one hit: base damage scaled by the shooter's line, then
 * Fighter's Overcharge (if active) and Transport's Bulwark (if the target
 * has it active) apply on top.
 */
export function computeDamage(
  baseDamage: number,
  now: number,
  shooter: Pick<PlayerState, 'line' | 'abilityActiveUntil'>,
  target: Pick<PlayerState, 'line' | 'abilityActiveUntil'>,
): number {
  let dmg = baseDamage * SHIP_STATS[shooter.line].dmgMul
  if (shooter.line === 'fighter' && now < shooter.abilityActiveUntil) {
    dmg *= OVERCHARGE_DAMAGE_MUL
  }
  if (target.line === 'transport' && now < target.abilityActiveUntil) {
    dmg *= BULWARK_DAMAGE_MUL
  }
  return Math.max(1, Math.round(dmg))
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `node --experimental-strip-types --no-warnings=ExperimentalWarning --test src/server/abilities.test.ts`
Expected: PASS — 8 tests total, 0 failures

- [ ] **Step 5: Commit**

```bash
git add src/server/abilities.ts src/server/abilities.test.ts
git commit -m "Add ability-cooldown and damage-scaling pure functions"
```

---

### Task 8: `activateAbility` (Fighter/Transport) and scaled combat damage

**Files:**
- Modify: `src/server/match.ts`

**Interfaces:**
- Consumes: `abilityReady`, `computeDamage` from `./abilities.ts` (Task 7); `OVERCHARGE_DURATION_MS`, `BULWARK_DURATION_MS` from `../shared/api.ts` (Task 1)
- Produces: `activateAbility(matchId: string, userId: string): Promise<void>`

- [ ] **Step 1: Import the new functions/constants**

Add to the existing `import {canJoinLine, maxHullFor} from './abilities.ts'` line: `, abilityReady, computeDamage`.

Add to the existing `import {..., matchChannel, ...} from '../shared/api.ts'` block: `BULWARK_DURATION_MS,` and `OVERCHARGE_DURATION_MS,` (alphabetical).

- [ ] **Step 2: Change `applyDamageInMatch` to take the full shooter and scale damage**

Replace the entire function:

```typescript
async function applyDamageInMatch(
  matchId: string,
  shooter: PlayerState,
  target: PlayerState,
  baseDamage: number,
): Promise<void> {
  const damage = computeDamage(baseDamage, Date.now(), shooter, target)
  const hull = Math.max(
    0,
    await redis.hIncrBy(matchHullKey(matchId), target.userId, -damage),
  )
  await broadcastMatch(matchId, {
    type: 'hit',
    targetUserId: target.userId,
    shooterUserId: shooter.userId,
    hull,
  })
  if (hull > 0) return

  await redis.zAdd(matchEliminatedKey(matchId), {
    member: target.userId,
    score: Date.now(),
  })
  const kills = await redis.hIncrBy(matchKillsKey(matchId), shooter.userId, 1)
  await broadcastMatch(matchId, {type: 'kills', userId: shooter.userId, kills})
  if (!target.team) return
  await broadcastMatch(matchId, {
    type: 'eliminated',
    userId: target.userId,
    team: target.team,
  })

  const remainingEnemyTeam = target.team === 'A' ? 'B' : 'A'
  const stillAlive = await enemyRoster(matchId, remainingEnemyTeam)
  if (stillAlive.length === 0) {
    const match = await getMatch(matchId)
    if (match && match.status === 'round_active')
      await endRound(match, remainingEnemyTeam)
  }
}
```

(the only changes from the current version: the `shooterId: string` param becomes `shooter: PlayerState`, every `shooterId` reference becomes `shooter.userId`, and `damage` is now computed via `computeDamage` instead of used as the raw `baseDamage` — the function keeps its `baseDamage` parameter name to make that distinction clear at call sites)

- [ ] **Step 3: Update `fireWeaponInMatch`'s laser call site**

Find `await applyDamageInMatch(matchId, shooterId, closest.player, LASER_DAMAGE)` in the laser branch and change `shooterId` to `shooter`:

```typescript
    await applyDamageInMatch(matchId, shooter, closest.player, LASER_DAMAGE)
```

- [ ] **Step 4: Update `resolveTorpedoImpactInMatch` to re-fetch the shooter's live state**

Replace the entire function:

```typescript
async function resolveTorpedoImpactInMatch(
  matchId: string,
  shooterId: string,
  shooterTeam: Team | null,
  impactX: number,
  impactY: number,
): Promise<void> {
  const shooterJson = await redis.hGet(matchPlayersKey(matchId), shooterId)
  if (!shooterJson) return
  const shooter = JSON.parse(shooterJson) as PlayerState
  const enemies = await enemyRoster(matchId, shooterTeam)
  let closest: {player: PlayerState; distance: number} | undefined
  for (const p of enemies) {
    const distance = Math.hypot(p.x - impactX, p.y - impactY)
    if (distance > TORPEDO_IMPACT_RADIUS) continue
    if (!closest || distance < closest.distance) closest = {player: p, distance}
  }
  if (!closest) {
    await broadcastMatch(matchId, {type: 'miss', x: impactX, y: impactY})
    return
  }
  await applyDamageInMatch(matchId, shooter, closest.player, TORPEDO_DAMAGE)
}
```

(this re-fetch matters: Overcharge may have expired between firing and the torpedo landing, and the damage should reflect whether it's still active *at impact*, not at launch)

- [ ] **Step 5: Add `activateAbility`**

Add this new exported function (near `fireWeaponInMatch`, after `isEliminated`):

```typescript
export async function activateAbility(
  matchId: string,
  userId: string,
): Promise<void> {
  const match = await getMatch(matchId)
  if (match?.status !== 'round_active') throw new Error('no active round')

  const existing = await redis.hGet(matchPlayersKey(matchId), userId)
  if (!existing) throw new Error('not in this match')
  const shooter = JSON.parse(existing) as PlayerState
  if (await isEliminated(matchId, userId))
    throw new Error('you are eliminated')

  const now = Date.now()
  if (!abilityReady(shooter.lastAbilityAt, shooter.line, now)) {
    throw new Error('ability is on cooldown')
  }
  shooter.lastAbilityAt = now

  if (shooter.line === 'fighter' || shooter.line === 'transport') {
    const duration =
      shooter.line === 'fighter'
        ? OVERCHARGE_DURATION_MS
        : BULWARK_DURATION_MS
    shooter.abilityActiveUntil = now + duration
  }

  await redis.hSet(matchPlayersKey(matchId), {
    [userId]: JSON.stringify(shooter),
  })
  await broadcastMatch(matchId, {type: 'ability', userId, line: shooter.line})
}
```

(Miner/Tender branches are added in later tasks — this version is complete and correct for Fighter/Transport/Pathfinder today; Pathfinder needs no extra state here since its ability is a pure client-side reveal, see Phase 4.)

- [ ] **Step 6: Verify it compiles**

Run: `npm run test:types`
Expected: no errors.

- [ ] **Step 7: Commit**

```bash
git add src/server/match.ts
git commit -m "Add activateAbility (Fighter/Transport) and per-shot scaled damage"
```

---

### Task 9: `/api/match/ability` route

**Files:**
- Modify: `src/server/server.ts`

**Interfaces:**
- Consumes: `activateAbility` from `./match.ts` (Task 8), `MatchAbilityRsp` from `../shared/api.ts` (Task 1)

- [ ] **Step 1: Add imports**

Add `type MatchAbilityRsp,` to the `'../shared/api.ts'` import block (alphabetical, near `type LeaderboardRsp,`).

Add `activateAbility,` to the `import {..., fireWeaponInMatch, ...} from './match.ts'` block (alphabetical).

Add `MatchAbilityRsp` to the `AnyRsp` union type (alphabetical, near `MatchStateRsp`).

- [ ] **Step 2: Add the route handler**

Add after `routeMatchJoin`:

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
```

- [ ] **Step 3: Wire it into the router**

In the `route` function's switch, change:

```typescript
      case Endpoint.MatchJoin:
        rsp = await routeMatchJoin(reqMsg)
        break
      case Endpoint.MatchState:
```

to:

```typescript
      case Endpoint.MatchJoin:
        rsp = await routeMatchJoin(reqMsg)
        break
      case Endpoint.MatchAbility:
        rsp = await routeMatchAbility()
        break
      case Endpoint.MatchState:
```

- [ ] **Step 4: Run the full test suite**

Run: `npm run test`
Expected: all pass.

- [ ] **Step 5: Commit**

```bash
git add src/server/server.ts
git commit -m "Add /api/match/ability route"
```

---

### Task 10: Client `fetchMatchAbility`

**Files:**
- Modify: `src/client/fetch.ts`

**Interfaces:**
- Produces: `fetchMatchAbility(): Promise<MatchAbilityRsp | ErrorRsp>`

- [ ] **Step 1: Add imports and the fetch function**

Add `type MatchAbilityReq,` and `type MatchAbilityRsp,` to the `'../shared/api.ts'` import block.

Add after `fetchMatchJoin`:

```typescript
export function fetchMatchAbility(): Promise<MatchAbilityRsp | ErrorRsp> {
  return postJsonOrError<MatchAbilityReq, MatchAbilityRsp>(
    Endpoint.MatchAbility,
    {},
  )
}
```

- [ ] **Step 2: Verify it compiles**

Run: `npm run test:types`
Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add src/client/fetch.ts
git commit -m "Add fetchMatchAbility"
```

---

### Task 11: `R` key, ability cooldown, and ability-pulse visual

**Files:**
- Modify: `src/client/battle.ts`

**Interfaces:**
- Consumes: `fetchMatchAbility` (Task 10), `ABILITY_COOLDOWN_MS` from `../shared/api.ts` (Task 1)

- [ ] **Step 1: Import `ABILITY_COOLDOWN_MS` and `fetchMatchAbility`**

Add `ABILITY_COOLDOWN_MS,` to the value-import block from `'../shared/api.ts'`.
Add `fetchMatchAbility,` to the import block from `'./fetch.ts'`.

- [ ] **Step 2: Add the `ability` key and `lastAbilityFiredAt` field**

In the `keys` type, add `ability: Phaser.Input.Keyboard.Key` after `torpedo`. In `create()`'s `this.keys = {...}`, add `ability: kb.addKey(Phaser.Input.Keyboard.KeyCodes.R),` after the `torpedo` line.

Add `lastAbilityFiredAt = 0` as a class field, next to `lastTorpedoFiredAt = 0`.

- [ ] **Step 3: Add the hint text**

In `create()`, after the `this.hudBottom = ...` block, add:

```typescript
    this.add
      .text(W - 12, H - 12, '[SPACE] LASER  ·  [E] MISSILE  ·  [R] ABILITY', {
        fontFamily: 'monospace',
        fontSize: '10px',
        color: '#446688',
      })
      .setOrigin(1, 1)
      .setScrollFactor(0)
      .setDepth(50)
```

- [ ] **Step 4: Fire the ability on `R`**

In `update()`, after the existing torpedo-firing block, add:

```typescript
    if (
      this.keys.ability.isDown &&
      nowMs - this.lastAbilityFiredAt > ABILITY_COOLDOWN_MS[this.self.line]
    ) {
      this.lastAbilityFiredAt = nowMs
      void fetchMatchAbility()
    }
```

(this matches the existing laser/torpedo pattern exactly: fire optimistically on keydown, let the server reject silently via its own cooldown if the client's local timer drifted)

- [ ] **Step 5: Handle the `'ability'` broadcast with a visual pulse on other ships**

In `handleMsg`, add a new branch before the closing `}` of the `else if` chain:

```typescript
    } else if (msg.type === 'ability') {
      const r = this.others.get(msg.userId)
      if (r) {
        const pulse = this.add
          .circle(r.container.x, r.container.y, 26, 0xfff2a8, 0)
          .setStrokeStyle(2, 0xfff2a8, 0.9)
          .setDepth(19)
        this.tweens.add({
          targets: pulse,
          radius: 40,
          alpha: 0,
          duration: 300,
          onComplete: () => pulse.destroy(),
        })
      }
    }
```

- [ ] **Step 6: Run the full test suite**

Run: `npm run test`
Expected: all pass, `public/battle.js` rebuilt.

- [ ] **Step 7: Manual verification (devvit playtest)**

1. Join a match as Fighter on one side, Transport on the other (two accounts/browsers).
2. As Fighter: press `R`, then immediately fire lasers at the Transport — watch the Transport's hull drop faster than normal (Overcharge active) for about 5s, then back to normal.
3. As Transport: press `R` right as the Fighter is about to land a hit — the resulting hull loss should be roughly half what an un-buffed hit would do.
4. Confirm pressing `R` again immediately after does nothing until each line's cooldown (20s Fighter / 18s Transport) has elapsed — check by watching for the yellow pulse VFX on the *other* ship.

- [ ] **Step 8: Commit**

```bash
git add src/client/battle.ts
git commit -m "Add ability key, cooldown, hint text, and activation VFX"
```

---

## Phase 3 — Tender Repair Beam

### Task 12: `nearestAlly` pure function

**Files:**
- Modify: `src/server/abilities.ts`
- Modify: `src/server/abilities.test.ts`

**Interfaces:**
- Produces: `nearestAlly(allies, healer, range): Pick<PlayerState, 'userId'|'x'|'y'> | undefined`

- [ ] **Step 1: Write the failing tests**

Append to `src/server/abilities.test.ts` (add `nearestAlly` to the existing import from `./abilities.ts`):

```typescript
test('nearestAlly picks the closest ally within range and excludes self', () => {
  const healer = {userId: 'me', x: 0, y: 0}
  const far = {userId: 'far', x: 200, y: 0}
  const near = {userId: 'near', x: 50, y: 0}
  const self = {userId: 'me', x: 0, y: 0}
  assert.equal(nearestAlly([far, near, self], healer, 300)?.userId, 'near')
})

test('nearestAlly returns undefined when nobody is in range', () => {
  const healer = {userId: 'me', x: 0, y: 0}
  const far = {userId: 'far', x: 1000, y: 0}
  assert.equal(nearestAlly([far], healer, 300), undefined)
})
```

- [ ] **Step 2: Run to verify failure**

Run: `node --experimental-strip-types --no-warnings=ExperimentalWarning --test src/server/abilities.test.ts`
Expected: FAIL — `nearestAlly` not exported

- [ ] **Step 3: Implement**

Add to `src/server/abilities.ts`:

```typescript
/** Closest non-eliminated ally within range, or undefined if none qualify. */
export function nearestAlly(
  allies: Pick<PlayerState, 'userId' | 'x' | 'y'>[],
  healer: Pick<PlayerState, 'userId' | 'x' | 'y'>,
  range: number,
): Pick<PlayerState, 'userId' | 'x' | 'y'> | undefined {
  let closest:
    | {p: Pick<PlayerState, 'userId' | 'x' | 'y'>; d: number}
    | undefined
  for (const p of allies) {
    if (p.userId === healer.userId) continue
    const d = Math.hypot(p.x - healer.x, p.y - healer.y)
    if (d > range) continue
    if (!closest || d < closest.d) closest = {p, d}
  }
  return closest?.p
}
```

- [ ] **Step 4: Run to verify pass**

Run: `node --experimental-strip-types --no-warnings=ExperimentalWarning --test src/server/abilities.test.ts`
Expected: PASS — 10 tests total, 0 failures

- [ ] **Step 5: Commit**

```bash
git add src/server/abilities.ts src/server/abilities.test.ts
git commit -m "Add nearestAlly pure function"
```

---

### Task 13: Tender branch in `activateAbility`

**Files:**
- Modify: `src/server/match.ts`

**Interfaces:**
- Consumes: `nearestAlly`, `maxHullFor` from `./abilities.ts`; `TENDER_HEAL_AMOUNT`, `TENDER_HEAL_RANGE` from `../shared/api.ts` (Task 1)

- [ ] **Step 1: Import the new pieces**

Add `nearestAlly` to the `./abilities.ts` import line.
Add `TENDER_HEAL_AMOUNT,` and `TENDER_HEAL_RANGE,` to the `'../shared/api.ts'` import block.

- [ ] **Step 2: Replace `activateAbility`'s body to add the Tender branch**

Replace the whole function body between `shooter.lastAbilityAt = now` and the final `await broadcastMatch(matchId, {type: 'ability', ...})` line — i.e. replace the entire function:

```typescript
export async function activateAbility(
  matchId: string,
  userId: string,
): Promise<void> {
  const match = await getMatch(matchId)
  if (match?.status !== 'round_active') throw new Error('no active round')

  const existing = await redis.hGet(matchPlayersKey(matchId), userId)
  if (!existing) throw new Error('not in this match')
  const shooter = JSON.parse(existing) as PlayerState
  if (await isEliminated(matchId, userId))
    throw new Error('you are eliminated')

  const now = Date.now()
  if (!abilityReady(shooter.lastAbilityAt, shooter.line, now)) {
    throw new Error('ability is on cooldown')
  }
  shooter.lastAbilityAt = now

  if (shooter.line === 'fighter' || shooter.line === 'transport') {
    const duration =
      shooter.line === 'fighter'
        ? OVERCHARGE_DURATION_MS
        : BULWARK_DURATION_MS
    shooter.abilityActiveUntil = now + duration
  }

  await redis.hSet(matchPlayersKey(matchId), {
    [userId]: JSON.stringify(shooter),
  })

  if (shooter.line === 'tender') {
    const players = await getMatchPlayers(matchId)
    const allies: PlayerState[] = []
    for (const p of players) {
      if (p.team !== shooter.team) continue
      if (await isEliminated(matchId, p.userId)) continue
      allies.push(p)
    }
    const target = nearestAlly(allies, shooter, TENDER_HEAL_RANGE)
    if (target) {
      const maxHull = maxHullFor(target.line)
      const current = await redis.hGet(matchHullKey(matchId), target.userId)
      const healed = Math.min(
        maxHull,
        Number(current ?? maxHull) + TENDER_HEAL_AMOUNT,
      )
      await redis.hSet(matchHullKey(matchId), {
        [target.userId]: String(healed),
      })
      await broadcastMatch(matchId, {
        type: 'heal',
        targetUserId: target.userId,
        healerUserId: userId,
        hull: healed,
      })
    }
  }

  await broadcastMatch(matchId, {type: 'ability', userId, line: shooter.line})
}
```

Note: the heal is a read-then-write, not an atomic `hIncrBy`, because it needs an upper clamp at the target's max hull that `hIncrBy` can't express. Two simultaneous heals on the exact same target in the same tick could theoretically race — acceptable given Tender's 15s cooldown makes that essentially unreachable in practice.

- [ ] **Step 3: Verify it compiles**

Run: `npm run test:types`
Expected: no errors.

- [ ] **Step 4: Commit**

```bash
git add src/server/match.ts
git commit -m "Add Tender Repair Beam to activateAbility"
```

---

### Task 14: Client heal handling

**Files:**
- Modify: `src/client/battle.ts`

- [ ] **Step 1: Handle the `'heal'` message**

In `handleMsg`, add a branch:

```typescript
    } else if (msg.type === 'heal') {
      if (msg.targetUserId === this.self?.userId && this.self) {
        this.self.hull = msg.hull
        this.updateHud()
      }
      const target =
        msg.targetUserId === this.self?.userId
          ? this.ship
          : this.others.get(msg.targetUserId)?.sprite
      if (target) {
        this.tweens.add({
          targets: target,
          alpha: 0.4,
          duration: 100,
          yoyo: true,
          repeat: 1,
        })
      }
    }
```

- [ ] **Step 2: Run the full test suite**

Run: `npm run test`
Expected: all pass.

- [ ] **Step 3: Manual verification (devvit playtest)**

1. Join as Tender, and a teammate joins as any other line on the same team.
2. Let the teammate take laser damage from the enemy so their hull drops below max.
3. Fly the Tender within ~300 units of the damaged teammate and press `R`.
4. Confirm the teammate's hull HUD number increases by 35 (clamped to their line's max hull) and their ship briefly flashes.

- [ ] **Step 4: Commit**

```bash
git add src/client/battle.ts
git commit -m "Handle Tender heal broadcast on the client"
```

---

## Phase 4 — Pathfinder Radar Ping

No server-side task is needed for this phase — Pathfinder's ability is already fully handled by the generic `activateAbility` flow built in Task 8 (cooldown-gated, broadcasts `'ability'` with `line: 'pathfinder'`). The reveal itself is purely a client-side render toggle, since every client already receives every `'hit'` broadcast (including hull values) for both teams — it just isn't rendering that data for non-self ships today.

### Task 15: Track remote hull and add the radar reveal

**Files:**
- Modify: `src/client/battle.ts`

**Interfaces:**
- Consumes: `RADAR_PING_DURATION_MS` from `../shared/api.ts` (Task 1)

- [ ] **Step 1: Import `RADAR_PING_DURATION_MS`**

Add to the value-import block from `'../shared/api.ts'`.

- [ ] **Step 2: Add `hull` and `hullLabel` to `RemoteShip`**

Replace the `RemoteShip` type:

```typescript
type RemoteShip = {
  container: Phaser.GameObjects.Container
  sprite: Phaser.GameObjects.Image
  label: Phaser.GameObjects.Text
  hullLabel: Phaser.GameObjects.Text
  team: Team
  eliminated: boolean
  hull: number
  targetX: number
  targetY: number
  targetRotation: number
}
```

- [ ] **Step 3: Create `hullLabel` and initialize `hull` in `spawnRemote`**

Replace the whole `spawnRemote` method:

```typescript
  spawnRemote(p: PlayerState): void {
    if (p.userId === this.self?.userId || !p.team) return
    const existing = this.others.get(p.userId)
    if (existing) {
      existing.targetX = p.x
      existing.targetY = p.y
      existing.targetRotation = p.rotation
      existing.eliminated = false
      existing.hull = p.hull
      existing.container.setVisible(true)
      return
    }
    const sprite = this.add.image(0, 0, p.line).setDisplaySize(42, 42)
    if (p.team === 'B') sprite.setTint(0xffb060)
    else sprite.setTint(0x8fd6ff)
    const label = this.add
      .text(0, 30, `${p.username} · ${p.team}`, {
        fontFamily: 'monospace',
        fontSize: '10px',
        color: '#9fb4c9',
      })
      .setOrigin(0.5, 0)
    const hullLabel = this.add
      .text(0, -30, '', {
        fontFamily: 'monospace',
        fontSize: '10px',
        color: '#ffe08a',
      })
      .setOrigin(0.5, 1)
      .setVisible(false)
    const container = this.add
      .container(p.x, p.y, [sprite, label, hullLabel])
      .setDepth(15)
    this.others.set(p.userId, {
      container,
      sprite,
      label,
      hullLabel,
      team: p.team,
      eliminated: false,
      hull: p.hull,
      targetX: p.x,
      targetY: p.y,
      targetRotation: p.rotation,
    })
    this.updateHud()
  }
```

- [ ] **Step 4: Keep `hull` current on every `'hit'`**

In `handleMsg`'s `'hit'` branch, in the `else` (non-self target) case, add `r.hull = msg.hull` before the tint line:

```typescript
      } else {
        const r = this.others.get(msg.targetUserId)
        if (r) {
          r.hull = msg.hull
          r.sprite.setTint(0xff3344).setTintMode(Phaser.TintModes.FILL)
```

- [ ] **Step 5: Add the `radarPing` method**

Add to `BattleScene`:

```typescript
  radarPing(): void {
    for (const r of this.others.values()) {
      r.hullLabel.setText(String(r.hull)).setVisible(true)
    }
    this.time.delayedCall(RADAR_PING_DURATION_MS, () => {
      for (const r of this.others.values()) r.hullLabel.setVisible(false)
    })
  }
```

- [ ] **Step 6: Trigger it from the ability key handler**

In `update()`'s ability-firing block (added in Task 11), change:

```typescript
    if (
      this.keys.ability.isDown &&
      nowMs - this.lastAbilityFiredAt > ABILITY_COOLDOWN_MS[this.self.line]
    ) {
      this.lastAbilityFiredAt = nowMs
      void fetchMatchAbility()
    }
```

to:

```typescript
    if (
      this.keys.ability.isDown &&
      nowMs - this.lastAbilityFiredAt > ABILITY_COOLDOWN_MS[this.self.line]
    ) {
      this.lastAbilityFiredAt = nowMs
      if (this.self.line === 'pathfinder') this.radarPing()
      void fetchMatchAbility()
    }
```

(fired optimistically on keypress, matching how laser/torpedo VFX already fire without waiting on the fetch response)

- [ ] **Step 7: Run the full test suite**

Run: `npm run test`
Expected: all pass.

- [ ] **Step 8: Manual verification (devvit playtest)**

1. Join as Pathfinder, teammate/enemy in the same match.
2. Press `R`.
3. Confirm every enemy ship gets a small hull-number label above it for ~6 seconds, then it disappears.
4. Confirm your own ship never shows a hull label (only `others`, never `self`, are labeled).

- [ ] **Step 9: Commit**

```bash
git add src/client/battle.ts
git commit -m "Add Pathfinder Radar Ping (enemy hull reveal)"
```

---

## Phase 5 — Miner Deploy Mine

### Task 16: `Mine` type and `mineTriggeredBy`

**Files:**
- Modify: `src/server/abilities.ts`
- Modify: `src/server/abilities.test.ts`

**Interfaces:**
- Produces: `Mine = {mineId: string; ownerId: string; team: Team; x: number; y: number}`, `mineTriggeredBy(mines: Mine[], mover: {team: Team|null; x: number; y: number}): Mine | undefined`

- [ ] **Step 1: Write the failing tests**

Append to `src/server/abilities.test.ts` (add `mineTriggeredBy` to the `./abilities.ts` import):

```typescript
test('mineTriggeredBy ignores mines placed by your own team', () => {
  const mines = [{mineId: 'm1', ownerId: 'x', team: 'A' as const, x: 0, y: 0}]
  assert.equal(mineTriggeredBy(mines, {team: 'A', x: 0, y: 0}), undefined)
})

test('mineTriggeredBy detonates when an enemy is within blast radius', () => {
  const mines = [
    {mineId: 'm1', ownerId: 'x', team: 'A' as const, x: 100, y: 100},
  ]
  assert.equal(
    mineTriggeredBy(mines, {team: 'B', x: 140, y: 100})?.mineId,
    'm1',
  )
})

test('mineTriggeredBy ignores mines out of blast radius', () => {
  const mines = [{mineId: 'm1', ownerId: 'x', team: 'A' as const, x: 0, y: 0}]
  assert.equal(mineTriggeredBy(mines, {team: 'B', x: 500, y: 500}), undefined)
})
```

- [ ] **Step 2: Run to verify failure**

Run: `node --experimental-strip-types --no-warnings=ExperimentalWarning --test src/server/abilities.test.ts`
Expected: FAIL — `mineTriggeredBy` not exported

- [ ] **Step 3: Implement**

Add `type Team` to the existing `import type {PlayerState, ShipLine} from '../shared/api.ts'` line, then add to `src/server/abilities.ts`:

```typescript
export type Mine = {
  mineId: string
  ownerId: string
  team: Team
  x: number
  y: number
}

const MINE_BLAST_RADIUS = 70

/** The first enemy mine within blast radius of a mover's new position, if any. */
export function mineTriggeredBy(
  mines: Mine[],
  mover: {team: Team | null; x: number; y: number},
): Mine | undefined {
  for (const m of mines) {
    if (m.team === mover.team) continue
    const distance = Math.hypot(mover.x - m.x, mover.y - m.y)
    if (distance <= MINE_BLAST_RADIUS) return m
  }
  return undefined
}
```

- [ ] **Step 4: Run to verify pass**

Run: `node --experimental-strip-types --no-warnings=ExperimentalWarning --test src/server/abilities.test.ts`
Expected: PASS — 13 tests total, 0 failures

- [ ] **Step 5: Commit**

```bash
git add src/server/abilities.ts src/server/abilities.test.ts
git commit -m "Add Mine type and mineTriggeredBy pure function"
```

---

### Task 17: Mine storage, Miner's ability branch, and detonation on move

**Files:**
- Modify: `src/server/match.ts`

**Interfaces:**
- Consumes: `Mine`, `mineTriggeredBy` from `./abilities.ts` (Task 16)

- [ ] **Step 1: Import and add the mines key helper**

Add `type Mine, mineTriggeredBy` to the `./abilities.ts` import line.

Add next to the other key helpers (near `matchEliminatedKey`):

```typescript
function matchMinesKey(matchId: string): string {
  return `match:${matchId}:mines`
}
```

- [ ] **Step 2: Clear mines at the start of every round**

In `startRound`, change:

```typescript
  const players = await getMatchPlayers(match.matchId)
  await redis.del(matchEliminatedKey(match.matchId))
```

to:

```typescript
  const players = await getMatchPlayers(match.matchId)
  await redis.del(matchEliminatedKey(match.matchId))
  await redis.del(matchMinesKey(match.matchId))
```

- [ ] **Step 3: Add the Miner branch to `activateAbility`**

In `activateAbility`, add the Miner branch right after the Tender `if` block and before the final `await broadcastMatch(matchId, {type: 'ability', ...})`:

```typescript
  if (shooter.line === 'miner') {
    const mineId = `${now.toString(36)}${Math.random().toString(36).slice(2, 6)}`
    const mine: Mine = {
      mineId,
      ownerId: userId,
      team: shooter.team ?? 'A',
      x: shooter.x,
      y: shooter.y,
    }
    await redis.hSet(matchMinesKey(matchId), {
      [mineId]: JSON.stringify(mine),
    })
    await broadcastMatch(matchId, {
      type: 'mine_placed',
      mineId,
      ownerId: userId,
      x: shooter.x,
      y: shooter.y,
    })
  }
```

- [ ] **Step 4: Check for mine detonation on every move**

Replace `movePlayerInMatch`:

```typescript
export async function movePlayerInMatch(
  matchId: string,
  userId: string,
  x: number,
  y: number,
  rotation: number,
): Promise<void> {
  const existing = await redis.hGet(matchPlayersKey(matchId), userId)
  if (!existing) return
  const player = JSON.parse(existing) as PlayerState
  player.x = x
  player.y = y
  player.rotation = rotation
  await redis.hSet(matchPlayersKey(matchId), {[userId]: JSON.stringify(player)})
  await broadcastMatch(matchId, {type: 'move', player})

  if (await isEliminated(matchId, userId)) return
  const minesRaw = await redis.hGetAll(matchMinesKey(matchId))
  const mines: Mine[] = Object.values(minesRaw ?? {}).map(
    json => JSON.parse(json) as Mine,
  )
  const triggered = mineTriggeredBy(mines, player)
  if (!triggered) return
  await redis.hDel(matchMinesKey(matchId), [triggered.mineId])
  const ownerJson = await redis.hGet(
    matchPlayersKey(matchId),
    triggered.ownerId,
  )
  if (!ownerJson) return
  const owner = JSON.parse(ownerJson) as PlayerState
  await broadcastMatch(matchId, {
    type: 'mine_detonated',
    mineId: triggered.mineId,
    targetUserId: userId,
    x: triggered.x,
    y: triggered.y,
  })
  await applyDamageInMatch(matchId, owner, player, TORPEDO_DAMAGE)
}
```

Note the `'mine_detonated'` broadcast carries only position, not hull — the resulting hull change is already carried by `applyDamageInMatch`'s own `'hit'` broadcast, so there's no need (or accurate value available yet) to duplicate it here.

- [ ] **Step 5: Verify it compiles**

Run: `npm run test:types`
Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add src/server/match.ts
git commit -m "Add Miner Deploy Mine: placement, storage, and move-triggered detonation"
```

---

### Task 18: Client mine visuals

**Files:**
- Modify: `src/client/battle.ts`

- [ ] **Step 1: Add a mines map and placement/detonation visual methods**

Add a class field to `BattleScene`: `mines = new Map<string, Phaser.GameObjects.Arc>()`

Add methods:

```typescript
  placeMineVisual(mineId: string, x: number, y: number): void {
    const mine = this.add
      .circle(x, y, 8, 0xff9500, 0.5)
      .setStrokeStyle(2, 0xff9500, 0.9)
      .setDepth(12)
    this.mines.set(mineId, mine)
  }

  detonateMineVisual(mineId: string, x: number, y: number): void {
    this.mines.get(mineId)?.destroy()
    this.mines.delete(mineId)
    const ring = this.add
      .circle(x, y, 10, 0xff5522, 0.6)
      .setStrokeStyle(3, 0xffcc66, 1)
      .setDepth(19)
    this.tweens.add({
      targets: ring,
      radius: 70,
      alpha: 0,
      duration: 260,
      onComplete: () => ring.destroy(),
    })
  }
```

- [ ] **Step 2: Handle the two mine messages**

In `handleMsg`, add:

```typescript
    } else if (msg.type === 'mine_placed') {
      this.placeMineVisual(msg.mineId, msg.x, msg.y)
    } else if (msg.type === 'mine_detonated') {
      this.detonateMineVisual(msg.mineId, msg.x, msg.y)
    }
```

- [ ] **Step 3: Clear stale mine visuals on round reset**

Replace `resetForNewRound`:

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

- [ ] **Step 4: Run the full test suite**

Run: `npm run test`
Expected: all pass.

- [ ] **Step 5: Manual verification (devvit playtest)**

1. Join as Miner, enemy on the other team in the same match.
2. Press `R` to drop a mine — confirm an orange ring appears at your position.
3. Fly away; have the enemy account fly into that same spot.
4. Confirm: an explosion VFX plays, the enemy's hull drops by torpedo-tier damage, the mine's orange ring disappears, and (if it's a kill) the Miner's kill count on the HUD/leaderboard increments.
5. Start a new round (finish the current one) and confirm any mine left over from the previous round is gone.

- [ ] **Step 6: Commit**

```bash
git add src/client/battle.ts
git commit -m "Add mine placement/detonation visuals"
```

---

## Final task: README

### Task 19: Document ship roles

**Files:**
- Modify: `readme.md`

- [ ] **Step 1: Add a sentence after the battle-system paragraph**

Find the paragraph starting `A mod can also run **"Challenge a Subreddit"**...` and add a new paragraph immediately after it:

```markdown
In battle arenas, the 5 ship lines are a real choice, not cosmetic: each has its own speed/hull/damage profile and a unique `R`-key ability (Fighter overcharges its weapon, Miner drops proximity mines, Transport shields itself, Pathfinder reveals enemy hull, Tender heals its nearest ally), and a team can't stack more than 2 of the same line, so squad composition is an actual decision.
```

- [ ] **Step 2: Commit**

```bash
git add readme.md
git commit -m "Document battle ship roles in the README"
```

---

## Self-review notes (fixed inline while writing this plan)

- Originally sketched `'mine_detonated'` as carrying a `hull` field — dropped it once I noticed `applyDamageInMatch`'s own `'hit'` broadcast already carries the accurate post-damage hull; duplicating it in `'mine_detonated'` would have needed a placeholder value computed before the real damage call ran. Fixed by making `'mine_detonated'` position-only.
- Originally had Phase 4 as a server task + a client task. Removed the server task once I confirmed Pathfinder needs zero additional server state beyond what Task 8's generic `activateAbility` already provides — kept a note explaining why rather than inventing busywork.
- Confirmed `computeDamage`'s test values are exact integers (no ambiguous `.5` rounding except the one Overcharge case, where `Math.round(34.5) === 35` in JS, verified).
- Confirmed mine cleanup at round boundaries is handled both server-side (`matchMinesKey` deleted in `startRound`) and client-side (`this.mines` cleared in `resetForNewRound`) — a mine from round 1 lingering into round 2 would have been a real bug.
