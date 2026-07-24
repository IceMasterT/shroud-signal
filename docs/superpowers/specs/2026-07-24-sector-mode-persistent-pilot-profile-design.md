# Sector Mode Persistent Pilot Profile

Status: approved design, not yet planned/implemented.
Scope: gives Sector Mode (`src/server/sector.ts`) a persistent, cross-post pilot identity — level/XP, credits, a locked ship line, ship tier, and a module inventory/loadout. This is sub-project #1 of a larger "Sector Mode progression" effort. Battle Mode (`src/server/match.ts`, `src/server/challenge.ts`, and the Skirmish/Challenge/Scrimmage clients) is explicitly untouched by this spec and gets its own, separate profile concept later if ever needed.

## Why

Sector Mode today is fully ephemeral: hull, score, kills, and even ship-line assignment (`lineForUser`) are all scoped to a single Reddit post and reset on respawn or when a new sector post is created. There's no sense of a pilot's identity carrying forward. The ask is to make ships and characters persistent and let them grow across sectors, so playing Sector Mode repeatedly (across different posts) builds toward something durable — without touching the existing multiplayer nature of Sector Mode (still shared, still real-time PvP/PvE with whoever else is there) and without touching Battle Mode at all.

## Decisions made during design review

- **Global per Reddit user, not per-subreddit.** One profile per `userId`, valid across every sector post on every subreddit.
- **Sector Mode only.** Combat rewards, death penalties, and profile reads/writes are wired into `sector.ts` alone. `match.ts`/`challenge.ts` never call into pilot-profile code.
- **Progression currency is Credits + Pilot Level**, both driven by XP/credit gains from Sector Mode combat (hits and kills).
- **One ship line per pilot, chosen once.** No respeccing. Once `chooseLine` succeeds, it can never be called again for that pilot. This replaces Sector Mode's current behavior where a line is auto-assigned by a hash of `userId` or freely changed via `setPlayerLine` — that flexibility goes away for any pilot who has gone through the new choose-line flow (see Migration below for pilots who predate this feature).
- **Ship tiers Mk.1–Mk.7 exist per line**, with real art assets already in the repo (see Asset mapping below). This spec only stores *which tier a pilot has*; the costs/stat-scaling to buy the next tier are sub-project #2's job (out of scope here — `shipTier` starts at 1 and this spec does not add any way to raise it yet beyond a placeholder-safe default).
- **Modules**: an inventory + a 3-slot equipped loadout, modules can be universal (any line) or line-specific, four rarities (Common/Rare/Epic/Legendary), and a random quality roll at acquisition that scales effect magnitude within a rarity. This spec defines the *data shapes* only (inventory entries, equip slots, rarity/quality fields) — the actual module catalog, drop sources, and effect implementations are sub-project #2's job. No module-granting code ships as part of this spec; the fields simply exist and read as empty.
- **Small currency loss on death** (not "no loss," which was the recommended default but not what was chosen) — a flat percentage of current credits, floored at 0, so it scales with a pilot's wealth instead of becoming trivial or crushing at the extremes.
- **Reward hooks are generic**, not tied to a fixed activity list: `grantCombatReward(userId, kind)` is called wherever Sector Mode combat already scores a hit/kill today. This means the PvE content from sub-project #3 (NPC pirates, defense objectives, etc.) can plug into the same reward path later without changing this spec's API.

## Part 1: Data model

### Redis storage (mirrors `sector.ts`'s existing hash-per-concern pattern)

- **`pilots`** — global hash, field = `userId`, value = JSON blob:
  ```ts
  type PilotProfile = {
    userId: string
    username: string
    line: ShipLine | null       // null until chooseLine() succeeds; locked forever after
    shipTier: number             // 1-7, starts at 1
    moduleInventory: {instanceId: string; moduleId: string; rarity: Rarity; quality: number}[]
    equippedModuleIds: (string | null)[]  // length 3, entries are instanceId or null
    createdAt: number
  }
  type Rarity = 'common' | 'rare' | 'epic' | 'legendary'
  ```
- **`pilot:{userId}:credits`** — plain redis string, mutated only via `INCRBY`/`DECRBY`. Kept out of the JSON blob so concurrent reward grants (e.g. the same pilot active in two sector posts in two tabs) never lose an update to a read-modify-write race — the same reason `sector.ts` already keeps `hull`/`score`/`kills` in dedicated hashes instead of a single JSON blob.
- **`pilot:{userId}:xp`** — plain redis string, mutated only via `INCRBY`. Level is *derived* from total XP via `xpToNextLevel`, never stored separately, so there's a single source of truth and no drift.

`level`/`xpIntoLevel`/`xpToNext` are computed on read from the raw `xp` counter — they are never persisted fields.

### Pure functions — new `src/server/pilot.ts` (unit-testable, no redis, following the `abilities.ts`/`abilities.test.ts` pattern)

- `xpToNextLevel(level: number): number` — XP required to advance from `level` to `level + 1`. Proposed curve: `Math.floor(100 * Math.pow(level, 1.4))`, giving a gentle, ever-slowing climb rather than a linear or explosive one. Tunable constant, same spirit as `SHIP_STATS` in `api.ts`.
- `levelForXp(totalXp: number): {level: number; xpIntoLevel: number; xpToNext: number}` — walks the curve to turn a raw XP total into a displayable level + progress bar.
- `applyDeathPenalty(credits: number): number` — returns `Math.max(0, credits - Math.floor(credits * DEATH_PENALTY_PCT))`. Proposed `DEATH_PENALTY_PCT = 0.1` (10%), tunable.
- `canChooseLine(profile: PilotProfile): boolean` — `profile.line === null`.
- `COMBAT_REWARDS = {hit: {xp: 2, credits: 1}, kill: {xp: 15, credits: 10}}` — tunable constants, mirroring how `HIT_SCORE`/`KILL_SCORE` already exist in `sector.ts`.

### Redis-backed functions — same file

- `getOrCreatePilotProfile(userId, username): Promise<PilotProfile & {credits: number; xp: number; level: number; xpIntoLevel: number; xpToNext: number}>` — reads `pilots[userId]`; if absent, creates one (see Migration below for the seeding rule), merges in the live `credits`/`xp` counters and derived level fields, same merge pattern `getOrCreatePlayer` already uses for hull/score/kills.
- `chooseLine(userId, username, line): Promise<PilotProfile>` — loads the profile, rejects (no-op / error) if `canChooseLine` is false, otherwise sets `line` and persists.
- `grantCombatReward(userId, kind: 'hit' | 'kill'): Promise<void>` — `INCRBY` on both the credits and xp counters using `COMBAT_REWARDS[kind]`.
- `applyDeathPenaltyFor(userId): Promise<void>` — reads current credits, computes `applyDeathPenalty`, and `DECRBY`s the difference (never sets a negative floor issue since the pure function already floors at 0).

### Asset mapping (ship tier art, `public/assets/ships/`)

Confirmed by matching byte-identical loose top-level files to each line's `mk.1` image:

| Line | Folder | File prefix |
|---|---|---|
| fighter | `Menta-Talon` | `MT-mk.N` |
| miner | `Menta-Prospector` | `MP-mk.N` |
| transport | `Menta-Drayman` | `DM-mk.N` |
| pathfinder | `Menta-Pathfinder` | `PF-mk.N` |
| tender | `Menta-Tender` | `MD-mk.N` |

This is an explicit lookup table (prefixes don't derive algorithmically from folder names), added as a small constant map in `src/shared/api.ts` or `pilot.ts` — e.g. `SHIP_TIER_ASSET: Record<ShipLine, {folder: string; prefix: string}>`. This spec only adds the table; actually surfacing tier-specific art in the client HUD/ship-picker is UI wiring, not blocked on sub-project #2.

## Part 2: Integration points (Sector Mode only)

All changes below are confined to `src/server/sector.ts`. `match.ts`/`challenge.ts` are not touched.

- **`getOrCreatePlayer`**: instead of assigning `line` via the `lineForUser` hash/hash-of-userId fallback, it now calls `getOrCreatePilotProfile(userId, username)` and uses `profile.line` (which may be `null`). The per-sector `lineForUser` hash and `setPlayerLine`'s free-swap behavior are removed for the new flow — see Migration for existing players.
- **`applyDamage`**: everywhere it already calls `addScore`/`addKill` for the shooter, it now also calls `grantCombatReward(shooterUserId, 'hit' | 'kill')`.
- **Respawn path**: wherever a player's hull reaching 0 currently triggers a respawn, it now also calls `applyDeathPenaltyFor(deadUserId)` before/at respawn.
- **New HTTP routes**:
  - `GET /api/pilot/profile` → `getOrCreatePilotProfile(userId, username)`, returns the merged profile + derived level fields.
  - `POST /api/pilot/choose-line {line}` → `chooseLine(userId, username, line)`; responds `409` if the pilot already has a line (client should never show the picker in that case, but the server enforces it regardless).

## Part 3: Edge cases

- **Concurrent updates**: the same pilot could be active in two sector posts in two tabs at once. Credits/XP are atomic `INCRBY`/`DECRBY` counters (never read-modify-write on the JSON blob), so simultaneous reward grants from different sectors never lose an update.
- **Migration for existing players**: `sector.ts` already has players with a per-sector-assigned line from before this feature. On the first `getOrCreatePilotProfile` call for a `userId` with no profile yet, if the caller's current `PlayerState` for that sector already has a `line`, seed the new profile's `line` from it (best-effort single-sector snapshot) instead of leaving it `null` — so returning players don't get forced through the picker again or lose their identity. If a player happens to have two different sector-assigned lines in two different posts, whichever post triggers profile creation first wins; acceptable for a one-time migration.
- **Ship-picker flow**: client calls `GET /api/pilot/profile`; if `line === null`, show the existing ship-picker UI, then `POST /api/pilot/choose-line`. If `line` is already set, skip the picker entirely and show a "your ship: Mk.N [Line]" panel instead.
- **Reward feedback**: hit/kill rewards broadcast a `pilot_reward` message on the existing sector realtime channel (same transport as today's `score`/`kills` broadcasts), carrying the earning `userId`. Clients only show a toast for their own `userId`; everyone else's client silently ignores it — avoids sector-wide noise over a personal stat that isn't relevant to other players.
- **Death penalty floor**: `applyDeathPenalty` never goes below 0 credits.
- **Module-equip validation** (data-shape only, no catalog yet): equipping references an `instanceId` that isn't in `moduleInventory`, or a line-specific module on the wrong line, is rejected — trivial today since `moduleInventory` starts empty for every pilot until sub-project #2 adds a way to acquire modules.

## Part 4: UI surfacing (this spec's scope only)

A read-only HUD strip in the sector view — level, XP progress bar, credits, ship tier — sourced from `GET /api/pilot/profile`. Full purchase/equip screens (spending credits on tiers, swapping modules) are sub-project #2's UI and not built here.

## Part 5: Testing

Unit tests for the pure functions only (`xpToNextLevel`, `levelForXp`, `applyDeathPenalty`, `canChooseLine`), following the existing `abilities.test.ts` pattern — no redis dependency, following the current project convention that `npm run test` runs `test:unit` alongside type-check/lint/build.

## Explicitly out of scope

- Battle Mode (`match.ts`, `challenge.ts`, Skirmish/Challenge/Scrimmage clients) — never reads or writes pilot profiles.
- Ship tier upgrade costs, stat scaling per tier, and the module catalog/effects/prices — sub-project #2.
- PvE sector content (NPC pirates, mining, defense objectives, base assaults, etc.) — sub-project #3. This spec's `grantCombatReward` hook is intentionally generic so that content can plug in later without changing this API.

## Suggested implementation phases

1. **Profile core + line lock-in.** `pilot.ts` pure functions and their tests, `pilots` hash, `getOrCreatePilotProfile`/`chooseLine`, the two HTTP routes, and `getOrCreatePlayer`'s switch to reading `line` from the profile (with migration seeding). Playable/testable end-to-end: a pilot's chosen line now survives across posts.
2. **Combat rewards + death penalty.** `grantCombatReward`/`applyDeathPenaltyFor` wired into `applyDamage` and the respawn path, plus the `pilot_reward` broadcast and client-side toast filtering.
3. **Read-only HUD.** Level/XP bar/credits/ship-tier display sourced from the profile endpoint. Fully additive, no server changes.

Each phase leaves the game in a working, testable state. Module inventory/equip fields exist from phase 1 onward but stay inert (empty) until sub-project #2 adds a way to populate them.
