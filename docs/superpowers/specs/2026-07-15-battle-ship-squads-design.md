# Ship Squads: Purpose-Built Ships for Last One Standing

Status: approved design, not yet planned/implemented.
Scope: `shroud-signal` battle arenas (`src/server/match.ts`, `src/client/battle.ts`) only. Free-play sectors (`src/server/sector.ts`, `src/client/scene.ts`) are untouched.

## Why

Today, `line` (fighter/miner/transport/pathfinder/tender) is assigned by hashing the player's Reddit user ID (`lineForUser` in both `sector.ts` and `match.ts`) and is purely cosmetic — all five ships share identical stats, weapons, and no abilities. "Build special squads out of the 5 ships" isn't possible because there's nothing to build around.

This spec turns the 5 ships into 5 real combat roles, chosen deliberately at battle join time, so a team's composition is an actual strategic decision.

## Decisions made during design review

- **Battle-only.** Free-play sectors keep random/cosmetic assignment. Smaller blast radius, and free-play has no team/squad concept for this to attach to.
- **Player-chosen ship**, picked once at join (battle join flow gains a picker instead of just a "Join battle" button). Locked in once you've joined, matching the existing "can't rejoin mid-match" behavior.
- **Stats + one unique active ability per line**, not stats-only. The ability is the actual "purpose."
- **Max 2 of any one line per team.** This isn't arbitrary: `MAX_PLAYER_CAP` is already 10 (`challenge.ts`) and there are exactly 5 lines, so "cap 2 per line" is the natural ceiling that still permits a full 10-player roster with real composition choice, never an impossible constraint.
- **Abilities are player-triggered** on a new key (`R`), cooldown-gated server-side — the exact same pattern already proven by laser (`Space`) and missile (`E`): client-side cooldown is feel-only, server is authoritative.

## Design correction found during review

The original ability sketch had Pathfinder's ability as "reveals enemy positions." That's not meaningful as designed: both teams' clients already subscribe to the *same* realtime channel (`matchChannel(matchId)` — both arena posts share one `matchId` and one channel) and already receive every `'move'`/`'roster'` broadcast from both teams. There is no fog of war in this game; positions are already always visible to everyone. Shipping "reveal positions" as an ability would do nothing.

What *isn't* currently visible: enemy hull. `applyDamageInMatch` broadcasts `{type: 'hit', targetUserId, shooterUserId, hull}` to the whole channel, so the data already reaches every client — `battle.ts` just doesn't render hull for anyone but `self`. So Pathfinder's ability is redefined as **Radar Ping: reveals live hull numbers above every enemy ship for 6s.** Same recon fantasy, and it's cheap: the client already has the data, this just toggles a render mode. No fog-of-war subsystem needed.

## The 5 ships

Stat multipliers apply to `battle.ts`'s existing `THRUST` / `MAX_SPEED` / `TURN_SPEED` and `match.ts`'s `START_HULL` / weapon damage constants, for that player only, for that match.

| Ship | Speed | Hull | Weapon dmg | Role |
|---|---|---|---|---|
| Fighter | +20% | -20% | +15% | Glass-cannon striker |
| Miner | -10% | +10% | normal | Area-denial trapper |
| Transport | -25% | +40% | -15% | Tank |
| Pathfinder | +30% | -30% | normal | Fast scout |
| Tender | -10% | +10% | -20% | Support/healer |

**Abilities** (`R` key, server-authoritative cooldown, mirrors `fireWeaponInMatch`'s cooldown-gate pattern):

- **Fighter — Overcharge:** +50% weapon damage for 5s. Cooldown 20s. Implemented as a timestamp field (`abilityActiveUntil`), checked wherever weapon damage is computed — same lazy-timestamp-check style already used for match warmup/round timers, not a server tick loop.
- **Miner — Deploy Mine:** drops a stationary mine at the ship's current position. Detonates (torpedo-tier damage, `TORPEDO_DAMAGE`) on the first enemy that comes within blast radius. Cooldown 12s. Detonation is checked inside `movePlayerInMatch` — every move already hits the server, so proximity-to-active-mines is checked on the *mover's* new position against the enemy team's mines, reusing an existing hook rather than adding a new one.
- **Transport — Bulwark:** -50% damage taken for 4s. Cooldown 18s. Same `abilityActiveUntil` mechanism as Overcharge, checked in `applyDamageInMatch` on the *target* side instead of the shooter side.
- **Pathfinder — Radar Ping:** enemy hull numbers become visible on your HUD for 6s (see correction above). Cooldown 15s. Purely a client-side reveal of data the client already receives; the server only needs to gate the cooldown and broadcast the trigger.
- **Tender — Repair Beam:** instantly heals the nearest ally within range by a flat amount (clamped to max hull). Cooldown 15s. One `hIncrBy` on the existing hull-tracking key, same as damage but positive; needs a new broadcast variant (`'heal'`) so the healed player's client updates without waiting on the next poll, mirroring how `'hit'` already works.

## Data model shape (exact keys/signatures are a plan-time detail, not spec-time)

- `PlayerState.line` — same field, but for match players it's chosen at join, not `lineForUser(userId)`.
- `PlayerState.lastAbilityAt: number` — new field, same shared-type precedent as `lastLaserAt`/`lastTorpedoAt` (present on the type, meaningless/unused in free-play, exactly like `team` already is).
- `PlayerState.abilityActiveUntil: number` — new field, generic "my buff is active until this timestamp"; which buff it is comes from `line`, so Fighter and Transport reuse the same field rather than each needing their own.
- Mines are match-scoped state that doesn't belong on `PlayerState` — a new per-match Redis structure (hash or sorted set, following `matchHullKey`/`matchEliminatedKey`'s naming convention) keyed by a generated mine ID, storing owner/team/position, read during `movePlayerInMatch`'s proximity check and deleted on detonation.
- New `MatchMsg` variants needed: ability activation (visual trigger, per-line effect), mine placement/detonation, and `'heal'`.
- New endpoint: `/api/ability` (POST, match-arena posts only) — not folded into `/api/fire`'s `WeaponMode`, since `WeaponMode` is a shared type used by free-play `sector.ts` too, and abilities are battle-only.

## Squad-cap enforcement

`joinMatch` currently takes `(matchId, side, userId, username, snoovatar)` and assigns `line` via hash. It needs to instead accept a client-chosen `line`, and reject the join (same error-throwing pattern as the existing `team is full` check) if that line already has 2 players on that side.

## UI changes

- Battle join flow (`renderMatch`'s `warmup` panel in `battle.ts`): the bare "Join battle" button becomes a 5-button ship picker, each showing the stat table row + one-line ability blurb, disabled once a line hits its cap-of-2 for that team (so you can't even attempt an invalid pick).
- In-arena hint text gains the ability key: `[SPACE] LASER · [E] MISSILE · [R] ABILITY · [L] LEADERBOARD`.
- `updateHud`'s bottom text gains an ability-cooldown indicator (mirrors how hull/kills are already shown).

## Suggested implementation phases

This is a rough shape for the follow-up implementation plan (`writing-plans` will produce the real one):

1. **Data + join flow:** shared types (`lastAbilityAt`, `abilityActiveUntil`), squad-cap-aware `joinMatch`, ship picker UI. No abilities yet — playable/testable on its own (stats already differentiate ships).
2. **Buff abilities (Fighter, Transport):** simplest category — a timestamp field checked at existing damage-application sites. Proves the `/api/ability` endpoint and cooldown-gate pattern end-to-end.
3. **Heal ability (Tender):** first ability needing a new broadcast type (`'heal'`) and nearest-ally targeting logic.
4. **Recon ability (Pathfinder):** client-only reveal toggle; smallest server surface of the remaining three.
5. **Mine ability (Miner):** most involved — new per-match entity storage, proximity detection hooked into `movePlayerInMatch`, placement/detonation broadcasts and visuals.

Each phase should leave the game in a working, testable state — this mirrors how laser shipped before missile did, rather than landing all five abilities in one unreviewable change.
