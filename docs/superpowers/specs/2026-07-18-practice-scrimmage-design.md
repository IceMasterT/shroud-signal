# Practice Scrimmage Mode

Status: approved design, not yet planned/implemented.
Scope: a new intra-subreddit battle mode, separate from the existing cross-subreddit "Challenge a Subreddit" feature (`src/server/challenge.ts`, `src/client/challenge.ts`). Reuses the match/combat engine (`src/server/match.ts`, `src/client/battle.ts`) as much as possible. Free-play sectors are unaffected.

## Why

The existing Challenge system pits two different subreddits against each other: a challenger subreddit's post links to a target subreddit's post, and "team" is implicitly "which subreddit's post you're on." There's no way for a single subreddit's own members to battle each other locally.

The ask: let a moderator spin up a battle *within their own subreddit* — members split into two teams and fight, as practice for real cross-subreddit Challenges later. This also gives mods more configuration control than Challenges currently expose (discrete match-size presets, a team-assignment method, and a whitelist/spectator gate) — control that could later be considered for Challenges too, but that's out of scope here.

## Decisions made during design review

- **This is a new mode, not a change to the Challenge flow.** A new subreddit menu item, "Start a Scrimmage," creates its own setup post and match, entirely independent of `Challenge`/`respondChallenge`.
- **One post, not two.** The cross-subreddit Challenge needs two posts (one per subreddit) because a `Match`'s two sides live in two different communities. A scrimmage is single-subreddit, so it needs only one arena post — confirmed feasible because the realtime channel is already keyed by `matchChannel(matchId)` (`src/shared/api.ts:310`), not by post, so nothing about the realtime layer needs to change to have both teams share one post.
- **`Team` stays `'A'|'B'` in the data model.** Only the scrimmage client UI displays "Purple"/"Orange" (a label map keyed by team), so the existing Challenge/Match UI code is untouched.
- **"Premade squads" means curated ship-loadout presets** (the existing `SQUAD_PRESETS` concept: balanced/aggro/turtle/recon), not pre-built rosters of specific players. "Custom" means free individual line picks capped at 2 per line per team — this is exactly today's `squadRule: 'capped'|'custom'`, just exposed as a mod choice at scrimmage-creation time instead of challenge-negotiation time.
- **Match size is a discrete choice, not a raw number.** Mods pick `5v5` or `10v10`, which maps directly to the existing `playerCap` field (5 or 10).
- **Whitelist gates play, not team.** A whitelisted (or any, if `joinPolicy === 'open'`) player still goes through the normal team-assignment step (auto or manual) — the whitelist only decides *whether* you can join a team at all. Anyone who opens the post without being eligible to play becomes a read-only spectator, not a roster with pre-assigned teams.
- **Spectators get a real live view**, not a "you're blocked" message: camera watches the match, scoreboard visible, no ship, no input. This is the largest new piece of client work in this feature.
- **Round/combat/best-of-3/tie-break logic is entirely reused, unchanged.** `startRound`, `endRound`, `tickMatch`, `decideSeriesWinner`, and `survivalCredit` in `match.ts` already operate generically on a `Match` record and don't care how players joined it.

## Part 1: Data model

- New `PostKind` variants (`src/shared/api.ts`): `{kind:'scrimmage-setup'}` (mod's config post) and `{kind:'scrimmage'; matchId: string}` (the single live arena post — no `side` field, unlike `match-arena`, since side isn't known until a player joins).
- `Match` gains three fields, all set once at creation and never changed:
  - `teamAssignMode: 'auto' | 'manual'`
  - `joinPolicy: 'open' | 'whitelist'`
  - `whitelist: string[]` (Reddit usernames, lowercase-normalized; empty array when `joinPolicy === 'open'`)
- No changes to `Challenge` or `ChallengeStatus` — scrimmages have no `Challenge` record at all.
- No new Redis key namespace: a scrimmage's `Match` lives in the exact same `match:{matchId}:*` keys real Challenge-born matches use. The only distinguishing data is the three new fields above (a Challenge-born match simply has `joinPolicy: 'open'`, `whitelist: []`, and `teamAssignMode` fixed to a value equivalent to today's behavior — see Part 4).

## Part 2: Mod config flow

- `devvit.json` gains a third subreddit menu item, **"Start a Scrimmage"**, handled by a new `routeMenuNewScrimmage()` (parallel to the existing `routeMenuNewChallenge()` in `server.ts`), which creates a post with `postData: {kind:'scrimmage-setup'}` and navigates the mod there.
- New client file `src/client/scrimmage.ts` (parallel to `challenge.ts`), whose `runSetup()` shows a Devvit form with:
  - `matchSize`: select, `'5v5' | '10v10'`, default `5v5`
  - `teamAssignMode`: select, `'auto' | 'manual'`, default `auto`
  - `squadRule`: select, `'preset' | 'custom'` — note this reuses the existing `capped`/`custom` naming at the data layer; the form's `preset` option maps to `squadRule: 'capped'` plus forcing every joiner into preset mode (see Part 4's note on reusing `joinMode`), so no new squad-rule value is introduced
  - `joinPolicy`: select, `'open' | 'whitelist'`, default `open`
  - `whitelist`: string (textarea, one username per line), only meaningful when `joinPolicy === 'whitelist'`
- Submitting calls a new endpoint, `api/scrimmage/create`, which builds the `Match` record directly (a new `createScrimmage()` in `match.ts`, sibling to `createMatch()`, sharing its round/state-initialization logic but skipping the two-post/Challenge-copying steps) and creates the single arena post.

## Part 3: Join flow

New endpoint `api/scrimmage/join` (separate from `api/match/join` since the eligibility/spectator logic doesn't apply to Challenge-born matches):

1. Look up the `Match`. If `match.joinPolicy === 'whitelist'` and the requesting username isn't in `match.whitelist` and isn't a moderator of the subreddit, respond with `role: 'spectator'` — no `PlayerState` is created, no team assigned.
2. Otherwise, the player is eligible to play:
   - If `teamAssignMode === 'manual'`: the client must have already shown a Purple/Orange picker (see Part 4) and the request carries the chosen `team`. Server rejects with a clear error if that team is already at `playerCap`.
   - If `teamAssignMode === 'auto'`: server assigns to whichever team currently has fewer players (`getMatchPlayers` count by team); if tied, assigns to team A (deterministic, not random — keeps auto-assign reproducible for testing).
3. Squad-rule enforcement (per-line cap, or preset-slot claiming) reuses the existing `canJoinLine`/preset-slot logic in `abilities.ts`/`match.ts` unchanged — a scrimmage's `Match` is a real `Match`, so every existing check that reads `match.squadRule`, `match.joinModeA/B`, `match.presetIdA/B` just works.

## Part 4: Client

- `battle.ts`'s init logic (`getKind()` / around `battle.ts:943-948`) branches on `kind.kind`:
  - `'match-arena'` (existing): `mySide = kind.side`, unchanged.
  - `'scrimmage'` (new): before anything else, resolve the player's role —
    - If `teamAssignMode === 'manual'`, show a Purple/Orange picker (same UI pattern as the existing free-play ship picker in `scene.ts`) before calling `api/scrimmage/join`.
    - If `teamAssignMode === 'auto'`, call `api/scrimmage/join` immediately with no team choice.
    - The join response carries either `{role:'player', team}` (sets `mySide`, proceeds exactly like today's flow) or `{role:'spectator'}` (see below).
- **Spectator view** (new): when the join response is `{role:'spectator'}`, the scene skips ship spawn and input binding entirely. Camera either free-pans (drag to look around) or auto-follows whichever team currently has more players alive. HUD keeps the scoreboard/round-status elements but hides fire/move/ability controls (including the mobile touch controls layer).
- Team display: a small label map (`{A: 'Purple', B: 'Orange'}`) used only in scrimmage-mode HUD text and the team picker; ship tint colors stay as they are today (light-blue/orange) since spec review didn't flag them as needing to change to literal purple.

## Data model summary (exact Redis key/signature details are plan-time, not spec-time)

- `Match.teamAssignMode`/`joinPolicy`/`whitelist` — plain fields on the existing JSON-blob-stored `Match`, no new storage engine.
- `PostKind`'s two new variants — no storage impact, just discriminated-union additions.
- No new Redis key namespaces.

## Suggested implementation phases

1. **Scrimmage creation + open-join, auto-assign, single squad rule end-to-end.** Shared types, menu item, setup form, `createScrimmage()`, `api/scrimmage/join` (auto-assign path only, `joinPolicy` fixed to `'open'`), and `battle.ts`'s auto-assign branch. Fully playable and testable on its own: a mod creates a scrimmage, members join, auto-split into two teams, and fight through a normal best-of-3 series with zero changes to the round engine.
2. **Manual team pick.** The Purple/Orange picker screen and the `teamAssignMode === 'manual'` join path. Independent of phase 3.
3. **Whitelist + spectator.** `joinPolicy`/`whitelist` fields, the eligibility check in `api/scrimmage/join`, and the spectator client view (camera, HUD-without-controls). The largest single chunk of new client work — sequenced last since it's fully additive and doesn't block phases 1-2 from being playable/demoable first.
4. **Squad preset option in the setup form.** Wires the existing `SQUAD_PRESETS`/preset-join-mode machinery into the scrimmage creation form (forcing preset mode match-wide rather than per-team choice, since there's no negotiation step here). Small, independent, can slot in anywhere after phase 1.

Each phase leaves the game in a working, testable state.
