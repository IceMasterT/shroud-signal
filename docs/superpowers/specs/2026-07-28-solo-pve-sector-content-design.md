# Solo PvE Sector Content: Pirate Missions

Status: approved design, not yet planned/implemented.
Scope: sub-project #3 of the Sector Mode progression effort (sub-project #1, the persistent pilot profile, has shipped; sub-project #2, the ship-upgrade/module-catalog economy, has not started). Gives Sector Mode (`src/server/sector.ts`) "personality" — every new sector is randomly assigned a mission theme, most of them pirate-antagonist encounters with escalating waves and a capital-ship boss. Battle Mode (`src/server/match.ts`, `src/server/challenge.ts`, and the Skirmish/Challenge/Scrimmage clients) is not touched.

## Why

Sector Mode today is pure PvP with no NPCs, no objectives, and no reason to keep coming back to a given post beyond fighting other players. The ask is to give sectors "personality": pirates to fight, resources to mine, things to defend, cargo/VIP runs, and a wreck worth racing for — five mission types, all built around a shared pirate-invasion engine (escalating waves, capital-ship boss, module loot) so that most of the engineering is written once and reused, not five times.

## Decisions made during design review

- **Same shared sector, not instanced.** PvE content spawns into the exact multiplayer sector everyone's already in — you might be dogfighting another player while a pirate wave is inbound. Matches Sector Mode's existing "everyone can play together" identity.
- **NPCs fight back.** Pirates deal real damage to nearby players — this is combat with stakes, not target practice.
- **No fine-grained server tick exists** (`galaxyPulse` runs every 5 minutes and only broadcasts flavor text), so NPC "AI" piggybacks on request traffic that's already frequent — every `movePlayer`/`fireWeapon` call from any player in the sector also advances nearby NPCs a step. No new scheduler infrastructure. The 5-minute cron is repurposed only for coarse idle-mission cleanup.
- **Every new sector gets a theme, always** — plain free-play sectors are no longer a creation-time outcome. Not every theme has to be pirates forever, but the five themes designed here all are; non-pirate themes are a future addition using the same tagging system, not designed now.
- **Both players and pirates use the full Battle-Mode weapon/ability kit** (`SHIP_WEAPONS`, `SHIP_STATS`, `computeDamage`, per-line abilities) while a mission is active in that sector — Sector Mode's current plain-laser-and-torpedo restriction only applies once a sector has no active mission (a resolved or theme-less state). This is sector-wide, not target-type-specific, since a shot doesn't know whether it'll land on a pirate or another player before it's resolved.
- **Theme is assigned once, at sector creation, for the sector's lifetime.** A resolved mission (won or lost) does not regenerate — the sector permanently reverts to plain PvP free-play afterward.
- **Module loot rolls once per mission, only on a win**, one roll per participant, scoped to that participant's own ship line — not per-kill. Ambient combat rewards (credits/XP) already work automatically via the existing generic reward pipeline from the persistent pilot profile, so pirate kills need no new code for that part.

## Part 1: Data model

**Sector theme** — a new field on the sector's `PostKind` (`src/shared/api.ts`), assigned once at creation:

```typescript
export type SectorTheme =
  | 'mining-raid'      // mine resources; pirates ambush partway through
  | 'starbase-defense' // survive waves defending a stationary starbase
  | 'escort-repair'    // protect a disabled frigate until it repairs itself
  | 'cargo-recovery'   // hold a landing zone against pirates to claim cargo/VIP/medicine
  | 'salvage-race'      // reach and salvage a wreck before pirates do
```

`PostKind`'s `{kind: 'sector'}` variant gains `theme: SectorTheme`. Deliberately a plain string union, not hardcoded to imply pirates forever — a future non-pirate theme just adds a new value and its own objective handling without touching this design's core.

**Mission state** — one Redis-backed record per sector post, mirroring the existing `players`-hash pattern (`sector:{postId}:mission`):

```typescript
export type Mission = {
  theme: SectorTheme
  wave: number             // 1-based; the last wave is always the boss
  totalWaves: number        // randomly rolled 3-8 at mission start
  npcs: NpcState[]          // currently-alive hostiles
  participants: string[]    // userIds who've dealt NPC damage or hit `interact` — loot eligibility
  status: 'active' | 'won' | 'lost'
} & ThemeObjective

export type ThemeObjective =
  | {theme: 'mining-raid'; resourceTarget: number; resourceMined: number; ambushTriggered: boolean}
  | {theme: 'starbase-defense'; starbaseHull: number; starbaseMaxHull: number}
  | {theme: 'escort-repair'; escortHull: number; repairEndsAt: number}
  | {theme: 'cargo-recovery'; zoneHull: number; zoneMaxHull: number}
  | {theme: 'salvage-race'; yourSalvageProgress: number; pirateSalvageProgress: number; salvageTarget: number}
```

**NPC entity** — one per hostile currently alive in a mission:

```typescript
export type NpcState = {
  npcId: string
  kind: 'raider' | 'capital' // 'raider' = regular wave pirate, 'capital' = boss (final wave only, exactly one)
  x: number
  y: number
  rotation: number
  hull: number
  maxHull: number
  weapon: WeaponMode          // reuses the existing WeaponMode type
  lastFiredAt: number
  targetUserId: string | null
}
```

The core engine (waves, NPCs, participants) is identical across all five themes — only `ThemeObjective`'s variant and a small per-theme win/loss handler differ. `cargo-recovery` is deliberately mechanically identical to `starbase-defense` (a defended hull pool), just reflavored as "the landing zone's integrity" rather than a starbase's — this avoids a sixth mechanic for a purely narrative difference.

## Part 2: Combat — reusing Battle Mode's weapon/ability system

Sector Mode's `fireWeapon` (`sector.ts`) hardcodes plain laser+torpedo today. Once a sector has an active mission (`Mission.status === 'active'`), combat there switches to the same kit Battle Mode already uses:

- **Weapon validation**: `SHIP_WEAPONS[shooter.line].includes(mode)` instead of "must be laser or torpedo" — the same check `match.ts` already performs.
- **Damage**: `computeDamage(...)` (from `abilities.ts`) instead of the flat `LASER_DAMAGE`/`TORPEDO_DAMAGE` constants, so line multipliers and active abilities (Overcharge, Bulwark) apply.
- **Abilities are new to Sector Mode** — today it has no ability-activation path at all (`PlayerState.abilityActiveUntil`/`lastAbilityAt` exist but are never touched by `sector.ts`). A new `api/mission/ability` route, gated on an active mission in that sector, activates the caller's line's ability — Tender's heal (`nearestAlly`) is genuinely useful for cooperative wave defense.
- **Scope of the switch is sector-wide, not per-shot**: since a shot's target type isn't known before it resolves, weapon/ability entitlement is a property of "does this sector currently have an active mission," covering PvP fights that happen to occur there too. Once the mission resolves (won or lost), the sector permanently reverts to plain laser+torpedo.
- **Pirate NPCs** get their own weapon assignment, independent of the player `ShipLine` union: each `raider` is assigned one weapon at spawn from the punchier Battle-Mode pool (autocannon/burst/plasma/flak), for visual variety across the four `pirate_standard` art variants. The `capital` boss gets a heavier-hitting weapon and a much larger hull pool. NPCs don't use the player-style aiming cone — just a range + line-of-sight check against `targetUserId`.

## Part 3: Wave engine — spawning, advancement, and the reactive tick

**Mission start timing** varies by theme:
- `starbase-defense`, `escort-repair`, `cargo-recovery`, `salvage-race`: combat begins as soon as the first player enters the sector.
- `mining-raid`: starts in a combat-free mining phase; the ambush triggers once `resourceMined` crosses half of `resourceTarget`, converting into a normal wave sequence.

**Spawn geometry**: each wave's NPCs spawn at a random point along the world boundary (`x`/`y` near ±`WORLD_HALF`, i.e. ±900) rather than near the center like players do, then head inward toward whatever they're threatening — nearest player by default, or the theme's defended point (starbase/escort ship/landing zone) for `starbase-defense`/`escort-repair`/`cargo-recovery`.

**Wave advancement is event-driven, not timed**: when an NPC dies, the same handler checks whether any NPCs from the current wave remain alive. If none do and `wave < totalWaves`, the next wave spawns immediately from fresh edge points. If `wave === totalWaves` (the boss wave — always exactly one `capital` NPC, no escorts) and it dies, the mission resolves as won (subject to each theme's own win condition in Part 4).

**The reactive tick**: every `movePlayer`/`fireWeapon` call from any player already in the sector also runs a lightweight `tickMission(postId)` step — for each alive NPC: acquire the nearest player as `targetUserId` if it has none, take one small step toward that target (straight-line, no pathfinding — open space, no obstacles), and if within its weapon's range with cooldown elapsed, fire (through the same `computeDamage`/hit-broadcast path a player shot uses, pirate-as-shooter). This is O(alive NPCs) per call, and naturally idles when nobody's sending requests in that sector — no wasted work on empty sectors, no new scheduled infrastructure.

## Part 4: Per-theme objectives

Two themes need a "work an objective while nearby" interaction — mining a resource node, salvaging a wreck. This is one shared `api/mission/interact` action rather than two near-identical endpoints: the player must be within a small radius of the theme's interaction point and off cooldown; each call ticks the relevant progress counter.

- **`mining-raid`**: `interact` at resource nodes raises `resourceMined`, no combat until the ambush triggers. **Win:** `resourceMined ≥ resourceTarget` and all triggered waves are cleared (mining can resume after a wave clears if short). **No hard loss** — leaving early just leaves the mission unfinished and resumable; nothing is destroyed. (No permadeath anywhere in this design — dying just respawns you, per the existing `applyDamage` respawn path.)
- **`starbase-defense`**: **Win:** all waves + boss cleared with `starbaseHull > 0`. **Lose:** `starbaseHull` hits 0 — no completion loot (already-earned ambient kill rewards aren't clawed back).
- **`escort-repair`**: **Win:** `repairEndsAt` elapses with `escortHull > 0`. **Lose:** `escortHull` hits 0 first.
- **`cargo-recovery`**: same engine as `starbase-defense` with `zoneHull` in place of `starbaseHull`.
- **`salvage-race`**: `interact` at the wreck raises `yourSalvageProgress`; `pirateSalvageProgress` ticks up passively the whole mission (their crew racing in parallel), while a guard wave has to be cleared before it's safe to sit still and salvage. **Win:** `yourSalvageProgress` reaches `salvageTarget` first. **Lose:** `pirateSalvageProgress` does.

## Part 5: Loot

Ambient combat rewards (credits/XP) need no new code — `grantCombatReward` (from the persistent pilot profile) is already generic over any Sector Mode hit/kill.

Module loot is new: on a `won` resolution only (never per-kill), each `userId` in `Mission.participants` gets one rolled `PilotModuleInstance`. Participation is earned two ways, so a mining-raid or salvage-race win doesn't shut out players who never fired a shot: dealing damage to a mission NPC (threaded through the same `shooterId` path `applyDamage` already uses) or calling `api/mission/interact` at least once. — `rarity` weighted common/rare/epic/legendary at 55/30/12/3%, `quality` uniform 0-1, and `moduleId` scoped to that participant's own ship line. Since the real module catalog is sub-project #2's job, `moduleId` here is a placeholder per-line identifier (e.g. `tender-pirate-salvage`) — inert data, matching the precedent already set for `moduleInventory`. A new `pilot.ts` function, `grantLootModule(userId, line)`, appends the rolled instance; a new realtime message (mirroring `pilot_reward`'s own-userId-only toast pattern) tells each participant what they got.

## Part 6: Client / UI

- A togglable "MISSION" HUD panel (same pattern as the existing leaderboard/pilot panels) shows theme, wave X/`totalWaves`, and the theme-specific objective readout (resource progress, a hull bar for starbase/escort/zone, the repair countdown, or the salvage race's two progress bars).
- NPCs render with the real pirate assets (`public/assets/ships/Menta-Pirates/`) — one of the four `pirate_standard` variants picked randomly per raider, `Black Horizon` (`pirate_capital_ship/`) for the boss.
- An "interact" prompt appears when in range of a mining node or the salvage wreck.
- Weapon/ability selection needs UI beyond Sector Mode's current fixed space/E hotkeys, since a line can have up to two weapons plus an ability during a mission — mirrors whatever `battle.ts` already exposes for Battle Mode's per-line kit; exact wiring is a plan-time detail.

## Part 7: Edge cases

- Idle-mission cleanup uses the existing 5-minute `galaxyPulse` cron — not to delete anything, just so a stalled mission's state doesn't linger forever; the reactive tick already does nothing when nobody's sending requests, so idling has no gameplay impact.
- A player joining mid-mission needs no special handling — their client reads the current `Mission`/NPC state the same way `others` already works for players.
- Concurrent sectors are fully independent — everything keyed per-`postId`, same as today.

## Part 8: Testing

Pure, unit-testable logic (following the `abilities.ts`/`abilities.test.ts` precedent): wave-count rolling bounds (3-8), edge-spawn coordinate generation, the loot rarity-roll distribution, and each theme's win/loss evaluator as small functions over primitives, not Redis state. The Redis-backed mission/tick/interact functions follow the established convention of type-checked-only, no mocking.

## Explicitly out of scope

- Battle Mode (`match.ts`, `challenge.ts`, Skirmish/Challenge/Scrimmage clients) — never touched.
- The real module catalog (effects, prices, upgrade costs) — sub-project #2. This design only grants placeholder, inert `PilotModuleInstance` records.
- Non-pirate sector themes — the tagging system supports adding them later; none are designed here.

## Suggested implementation phases

1. **Core engine, proven on one theme.** Theme assignment at sector creation, `Mission`/`NpcState` storage, edge-spawn, the reactive tick, event-driven wave advancement, and the full weapon/ability switch for players and pirates — built and proven against `starbase-defense` alone, the simplest theme (no `interact` endpoint needed). Ambient combat rewards already work for free.
2. **Loot.** `grantLootModule`, the rarity/quality roll, the participant-scoped mission-end grant, and the toast broadcast.
3. **Remaining hull-pool themes.** `escort-repair` and `cargo-recovery` — both reuse the core engine directly, no new subsystems.
4. **Interact-based themes.** `mining-raid` and `salvage-race` — add the shared `api/mission/interact` endpoint and each theme's progress-tracking objective.
5. **Client UI.** The MISSION HUD panel, NPC rendering with the pirate/boss art, the interact prompt, and weapon/ability selection UI.

Each phase leaves the game in a working, testable state.
