# Squad Presets and Custom Squad Rule

Status: approved design, not yet planned/implemented.
Scope: `shroud-signal` battle arenas and the challenge setup flow (`src/server/challenge.ts`, `src/client/challenge.ts`, `src/server/match.ts`, `src/client/battle.ts`). Free-play sectors are unaffected.

## Why

The ship-squad system just shipped (`docs/superpowers/specs/2026-07-15-battle-ship-squads-design.md`) gives every player a free pick of any line, capped at 2 duplicates per team. Two follow-ups were requested:

1. **Prebuilt squads** — curated compositions a team can drop into instead of everyone individually picking.
2. **Custom squads by agreement** — a way for a team to lift the 2-per-line cap when they want to.

## Decisions made during design review

- **(1) sits alongside the existing picker, not replacing it.** A team's first joiner picks one of: individual (today's flow), or a preset. Whoever joins after follows whatever the first joiner chose.
- **(2) is a challenge-setup term, not an in-match vote.** The original idea (propose custom, unanimous in-lobby vote) was replaced after clarifying with the user: custom is decided once, when the challenge is created — exactly like `playerCap` and `warmupMinutes` already are — and the target subreddit can counter it through the exact same accept/counter/accept-counter flow that exists today. This is a much smaller change: no voting UI, no per-team runtime negotiation, no new realtime messages. It rides the pipeline `challenge.ts` already has.
- **`squadRule` is match-wide, not per-team.** Both teams play under the same rule for a given match — there's no scenario where Team A is capped and Team B isn't; that would make one team's "custom" advantage meaningless when the other side chooses individual/capped anyway, and the challenge-terms UI already presents single shared terms (cap, warmup) for the whole match.
- **Presets are exempt from the cap regardless of `squadRule`.** They're pre-authored, so "capped" vs "custom" doesn't apply to them — a preset's composition is whatever it is.

## Part 1: Custom squad rule (challenge-level term)

Exactly parallel to the existing `playerCap`/`counterPlayerCap` pattern:

- `Challenge` gains `squadRule: 'capped' | 'custom'` and `counterSquadRule: 'capped' | 'custom' | null`.
- `CreateChallengeReq` gains `squadRule: 'capped' | 'custom'`. The setup form (`src/client/challenge.ts`'s `runSetup`) gains a `type: 'select'` field (Devvit's dropdown field type — returns `string[]`, so read `result.values.squadRule?.[0]`, default `'capped'`).
- `RespondChallengeReq` gains an optional `squadRule?: 'capped' | 'custom'`, read the same way in the counter-offer form (`counter()` in `challenge.ts`).
- `respondChallenge` in `src/server/challenge.ts` sets `challenge.counterSquadRule` on a `counter` action, and folds it into the final `challenge.squadRule` on `accept-counter`, mirroring exactly how `counterPlayerCap`/`counterWarmupMinutes` already fold in.
- `Match` gains `squadRule: 'capped' | 'custom'`, copied from `challenge.squadRule` in `createMatch`, same moment `playerCap`/`warmupMinutes` already copy over.
- `canJoinLine` (`src/server/abilities.ts`) is unchanged as a pure function — the caller (`joinMatch` in `match.ts`) skips calling it entirely when `match.squadRule === 'custom'`, matching how the plan already threads `match.playerCap` into the existing team-size check ahead of the line-cap check.

No new realtime messages, no new client polling, no new Redis keys — `squadRule` is just one more field that already flows through `Challenge` → `Match` → `joinMatch`.

## Part 2: Squad presets (in-match, per-team)

- New shared constant `SQUAD_PRESETS: Record<PresetId, ShipLine[]>`, each an ordered list up to 10 entries long (the max team size). A team's available preset slots are the first `match.playerCap` entries of the chosen preset's list.
- Four presets to start: **Balanced Wing** (the 5-line rotation, repeated), **Aggro Rush** (fighter/pathfinder heavy), **Turtle Wall** (transport/tender heavy), **Recon Strike** (pathfinder/miner heavy). Exact slot lists are a plan-time/tuning detail, not spec-time.
- `Match` gains, per side: `joinModeA`/`joinModeB: 'individual' | 'preset' | null` (null until the first joiner picks) and `presetIdA`/`presetIdB: PresetId | null`.
- `joinMatch` gains a `mode: 'individual' | 'preset'` and (if preset) `presetId` parameter alongside the existing `line`. First joiner on a side sets `joinMode`/`presetId` on the `Match`; subsequent joiners on that side must match the already-set mode (reject with a clear error if they try to switch modes mid-lobby — e.g. "this team already committed to Aggro Rush").
- Preset slot claiming: when `mode === 'preset'`, the requested `line` must be one of the still-open slots in that preset's list for that team (i.e. `line` must appear in `SQUAD_PRESETS[presetId].slice(0, playerCap)` at a position not yet claimed by a teammate) — this reuses the same "count how many teammates are already on this line" logic `canJoinLine` already has, just checking against the preset's slot list instead of a flat cap of 2.
- Client: the warmup screen (`src/client/battle.ts`) gains a mode-choice screen ahead of today's ship picker, shown only when `joinMode` is still `null` for that team: "Pick your own ship" (existing picker) or a preset list (each preset shows its slot composition, greyed out once a team has committed to a different mode).

## Data model summary (exact Redis keys/signatures are plan-time detail, not spec-time)

- `Challenge.squadRule`/`counterSquadRule` — plain fields on the existing JSON-blob-stored `Challenge`, no new storage.
- `Match.squadRule`/`joinModeA`/`joinModeB`/`presetIdA`/`presetIdB` — plain fields on the existing JSON-blob-stored `Match`, no new storage.
- `SQUAD_PRESETS` — a new shared constant in `src/shared/api.ts`, analogous to `SHIP_STATS`.

## Suggested implementation phases

1. **Custom squad rule end-to-end:** shared types, `challenge.ts`'s create/respond logic, the two client forms, `Match.squadRule` copy-over, and the `canJoinLine` skip in `joinMatch`. Fully testable on its own — a challenge can be created/countered/accepted with a custom rule and the cap genuinely lifts.
2. **Squad presets:** `SQUAD_PRESETS` constant, `Match`'s per-side join-mode fields, `joinMatch`'s mode/preset handling, and the client's mode-choice screen. Builds on nothing from phase 1 (independent axis), so could ship in either order, but sequenced second since it's the larger UI change.

Each phase leaves the game in a working, testable state.
