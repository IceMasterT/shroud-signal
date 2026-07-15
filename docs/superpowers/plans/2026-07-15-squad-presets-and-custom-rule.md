# Squad Presets and Custom Rule Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a challenge-setup "custom squad rule" term (lifts the 2-per-line cap for the whole match) and an in-match "squad preset" join path (curated ship-line slot lists a team can commit to instead of free-picking), both alongside the existing individual ship picker.

**Architecture:** Custom rule rides the exact accept/counter/accept-counter pipeline `challenge.ts` already has for `playerCap`/`warmupMinutes` — one more field, no new mechanic. Presets are new per-team, per-match state on `Match` (`joinModeA`/`joinModeB`, `presetIdA`/`presetIdB`), enforced in `joinMatch` the same way the team-size and line-cap checks already are. New pure logic (`canClaimPresetSlot`) lives in `src/server/abilities.ts` alongside `canJoinLine`, unit-tested with zero Redis mocking, matching this codebase's established pattern.

**Tech Stack:** TypeScript, Devvit Web (`@devvit/web/server`/`client`), Redis (via Devvit's client), `node:test` for unit tests, Biome for lint/format.

## Global Constraints

- Custom rule is match-wide (both teams), decided once at challenge creation, counterable by the target subreddit — never an in-match vote, never per-team.
- Squad presets are exempt from both the 2-per-line cap AND the custom-rule cap — a preset's composition is whatever it is, regardless of `squadRule`.
- A team's join mode (`individual` or `preset`) is set by whoever joins that team first and is fixed for the rest of that team's warmup — later joiners on the same side must match it.
- Design spec is `docs/superpowers/specs/2026-07-15-squad-presets-and-custom-rule-design.md` — refer back to it if a task here seems to contradict it.
- Codebase style: Biome-formatted (single quotes, no semicolons, 2-space indent), `npm run test` = `test:types && lint && test:unit && build`, lint uses `--error-on-warnings` (an unformatted import line has broken this pipeline before in this codebase — always run the FULL `npm run test`, never just `test:types`/`test:unit` individually).

---

## File Structure

- **Modify** `src/shared/api.ts` — `SquadRule` type + `SQUAD_RULES` array, `Challenge.squadRule`/`counterSquadRule`, `CreateChallengeReq.squadRule`, `RespondChallengeReq.squadRule`, `Match.squadRule`/`joinModeA`/`joinModeB`/`presetIdA`/`presetIdB`, `PresetId` type, `SQUAD_PRESETS` constant, `JoinMatchReq` restructured to carry `mode`/`presetId`.
- **Modify** `src/server/challenge.ts` — `createChallenge`/`respondChallenge` accept and thread `squadRule`.
- **Modify** `src/server/server.ts` — `routeChallengeCreate`/`routeChallengeRespond` validate and pass `squadRule`; `routeMatchJoin` validates `mode`/`presetId`.
- **Modify** `src/client/challenge.ts` — setup/counter forms gain a squad-rule toggle; status panels display it.
- **Modify** `src/server/abilities.ts` — new `canClaimPresetSlot` pure function.
- **Modify** `src/server/abilities.test.ts` — its tests.
- **Modify** `src/server/match.ts` — `createMatch` copies `squadRule` and seeds `joinModeA`/`joinModeB`/`presetIdA`/`presetIdB` to `null`; `joinMatch` handles mode-locking, preset-slot claiming, and skips the cap when `squadRule === 'custom'`.
- **Modify** `src/client/battle.ts` — mode-choice screen ahead of the existing ship picker; preset button rendering; updated join call sites.

---

## Phase 1 — Custom squad rule (challenge-setup term)

### Task 1: Shared types for the squad rule

**Files:**
- Modify: `src/shared/api.ts`

**Interfaces:**
- Produces: `SquadRule = 'capped' | 'custom'`, `SQUAD_RULES: readonly SquadRule[]`, `Challenge.squadRule: SquadRule`, `Challenge.counterSquadRule: SquadRule | null`, `CreateChallengeReq.squadRule: SquadRule`, `RespondChallengeReq.squadRule?: SquadRule`, `Match.squadRule: SquadRule`

- [ ] **Step 1: Add the `SquadRule` type and validation array**

Find `export type ChallengeStatus =` in `src/shared/api.ts` and add immediately before it:

```typescript
export type SquadRule = 'capped' | 'custom'
export const SQUAD_RULES: readonly SquadRule[] = ['capped', 'custom']
```

- [ ] **Step 2: Add `squadRule`/`counterSquadRule` to `Challenge`**

Find:

```typescript
export type Challenge = {
  challengeId: string
  challengerPostId: string
  targetPostId: string | null
  challengerSubredditId: string
  challengerSubredditName: string
  targetSubredditName: string
  playerCap: number
  warmupMinutes: number
  counterPlayerCap: number | null
  counterWarmupMinutes: number | null
  status: ChallengeStatus
  createdAt: number
  matchId: string | null
  arenaUrlA: string | null
  arenaUrlB: string | null
}
```

and change it to:

```typescript
export type Challenge = {
  challengeId: string
  challengerPostId: string
  targetPostId: string | null
  challengerSubredditId: string
  challengerSubredditName: string
  targetSubredditName: string
  playerCap: number
  warmupMinutes: number
  squadRule: SquadRule
  counterPlayerCap: number | null
  counterWarmupMinutes: number | null
  counterSquadRule: SquadRule | null
  status: ChallengeStatus
  createdAt: number
  matchId: string | null
  arenaUrlA: string | null
  arenaUrlB: string | null
}
```

- [ ] **Step 3: Add `squadRule` to `CreateChallengeReq` and `RespondChallengeReq`**

Find:

```typescript
export type CreateChallengeReq = {
  targetSubredditName: string
  playerCap: number
  warmupMinutes: number
}
```

and change it to:

```typescript
export type CreateChallengeReq = {
  targetSubredditName: string
  playerCap: number
  warmupMinutes: number
  squadRule: SquadRule
}
```

Find:

```typescript
export type RespondChallengeReq = {
  challengeId: string
  action: ChallengeAction
  playerCap?: number
  warmupMinutes?: number
}
```

and change it to:

```typescript
export type RespondChallengeReq = {
  challengeId: string
  action: ChallengeAction
  playerCap?: number
  warmupMinutes?: number
  squadRule?: SquadRule
}
```

- [ ] **Step 4: Add `squadRule` to `Match`**

Find `export type Match = {` and, right after `warmupMinutes: number`, add `squadRule: SquadRule`:

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
  status: MatchStatus
  round: number
  roundWinsA: number
  roundWinsB: number
  survivalMsA: number
  survivalMsB: number
  warmupEndsAt: number
  roundStartedAt: number
  roundEndsAt: number
  roundResultAt: number
  lastRoundWinner: Team | 'tie' | null
  winner: Team | 'tie' | null
}
```

- [ ] **Step 5: Verify it compiles**

Run: `npm run test:types`
Expected: errors at every place that constructs a `Challenge` or `Match` literal without the new required fields (`src/server/challenge.ts`'s `createChallenge`, `src/server/match.ts`'s `createMatch`) — that's expected, fixed in Tasks 2 and 4. Confirm there are no OTHER errors.

- [ ] **Step 6: Commit**

```bash
git add src/shared/api.ts
git commit -m "Add SquadRule type and thread it through Challenge/Match types"
```

---

### Task 2: `challenge.ts` accepts and threads `squadRule`

**Files:**
- Modify: `src/server/challenge.ts`

**Interfaces:**
- Consumes: `SquadRule` from `../shared/api.ts` (Task 1)
- Produces: `createChallenge(..., squadRule: SquadRule): Promise<Challenge>` (7th param added), `respondChallenge(..., squadRule: SquadRule | undefined): Promise<...>` (new param added)

- [ ] **Step 1: Update `createChallenge`'s signature and literal**

Replace the entire function:

```typescript
export async function createChallenge(
  setupPostId: string,
  challengerSubredditId: string,
  challengerSubredditName: string,
  targetSubredditName: string,
  playerCap: number,
  warmupMinutes: number,
  squadRule: SquadRule,
): Promise<Challenge> {
  const challengeId = randomId()
  const cap = clampPlayerCap(playerCap)
  const warmup = clampWarmupMinutes(warmupMinutes)

  const targetPost = await reddit.submitCustomPost({
    subredditName: targetSubredditName,
    title: `r/${challengerSubredditName} has challenged you to a Last One Standing battle!`,
    entry: 'challenge',
    postData: {kind: 'challenge', challengeId, role: 'target'},
  })

  const challenge: Challenge = {
    challengeId,
    challengerPostId: setupPostId,
    targetPostId: targetPost.id,
    challengerSubredditId,
    challengerSubredditName,
    targetSubredditName,
    playerCap: cap,
    warmupMinutes: warmup,
    squadRule,
    counterPlayerCap: null,
    counterWarmupMinutes: null,
    counterSquadRule: null,
    status: 'pending',
    createdAt: Date.now(),
    matchId: null,
    arenaUrlA: null,
    arenaUrlB: null,
  }
  await saveChallenge(challenge)
  await reddit.setPostData(setupPostId as `t3_${string}`, {
    kind: 'challenge',
    challengeId,
    role: 'challenger',
  })
  return challenge
}
```

Add `type SquadRule,` to the existing `import type {Challenge, ChallengeAction, ChallengeStatus} from '../shared/api.ts'` line (alphabetical).

- [ ] **Step 2: Update `respondChallenge`'s signature and counter/accept-counter branches**

Replace the entire function:

```typescript
export async function respondChallenge(
  challengeId: string,
  role: 'challenger' | 'target',
  action: ChallengeAction,
  playerCap: number | undefined,
  warmupMinutes: number | undefined,
  squadRule: SquadRule | undefined,
): Promise<{challengeStatus: ChallengeStatus; matchId: string | null}> {
  const challenge = await getChallenge(challengeId)
  if (!challenge) throw new Error('challenge not found')

  if (action === 'decline') {
    if (challenge.status !== 'pending' && challenge.status !== 'countered') {
      throw new Error('challenge cannot be declined in its current state')
    }
    challenge.status = 'declined'
    await saveChallenge(challenge)
    return {challengeStatus: challenge.status, matchId: null}
  }

  if (action === 'accept' || action === 'counter') {
    if (role !== 'target')
      throw new Error('only the challenged subreddit can do that')
    if (challenge.status !== 'pending')
      throw new Error('challenge is not pending')
    if (action === 'counter') {
      challenge.counterPlayerCap = clampPlayerCap(
        playerCap ?? challenge.playerCap,
      )
      challenge.counterWarmupMinutes = clampWarmupMinutes(
        warmupMinutes ?? challenge.warmupMinutes,
      )
      challenge.counterSquadRule = squadRule ?? challenge.squadRule
      challenge.status = 'countered'
      await saveChallenge(challenge)
      return {challengeStatus: challenge.status, matchId: null}
    }
  } else if (action === 'accept-counter') {
    if (role !== 'challenger') {
      throw new Error('only the challenger can accept a counter offer')
    }
    if (challenge.status !== 'countered')
      throw new Error('no counter to accept')
    challenge.playerCap = challenge.counterPlayerCap ?? challenge.playerCap
    challenge.warmupMinutes =
      challenge.counterWarmupMinutes ?? challenge.warmupMinutes
    challenge.squadRule = challenge.counterSquadRule ?? challenge.squadRule
  }

  const match = await createMatch(challenge)
  challenge.status = 'accepted'
  challenge.matchId = match.matchId
  challenge.arenaUrlA = match.arenaUrlA
  challenge.arenaUrlB = match.arenaUrlB
  await saveChallenge(challenge)
  return {challengeStatus: challenge.status, matchId: match.matchId}
}
```

(the only changes from the current version: the new `squadRule` parameter, `counterSquadRule` set alongside the other two counter fields in the `counter` branch, and `challenge.squadRule` folded in alongside the other two in the `accept-counter` branch)

- [ ] **Step 3: Verify it compiles**

Run: `npm run test:types`
Expected: errors at `createChallenge`'s and `respondChallenge`'s call sites in `src/server/server.ts` (missing the new argument) — expected, fixed in Task 3. Confirm no other errors.

- [ ] **Step 4: Commit**

```bash
git add src/server/challenge.ts
git commit -m "Thread squadRule through createChallenge/respondChallenge"
```

---

### Task 3: Server routes validate and pass `squadRule`

**Files:**
- Modify: `src/server/server.ts`

**Interfaces:**
- Consumes: `createChallenge(..., squadRule)`, `respondChallenge(..., squadRule)` (Task 2); `SQUAD_RULES` from `../shared/api.ts` (Task 1)

- [ ] **Step 1: Add `SQUAD_RULES` import**

Add `SQUAD_RULES,` to the `'../shared/api.ts'` value-import block (alphabetical, near `SHIP_LINES,`).

- [ ] **Step 2: Update `routeChallengeCreate` to validate and pass `squadRule`**

Find the body of `routeChallengeCreate` and, right after the existing:

```typescript
  if (!isFiniteNumber(req.playerCap) || !isFiniteNumber(req.warmupMinutes)) {
    return {error: 'invalid challenge payload', status: 400}
  }
```

add:

```typescript
  if (!SQUAD_RULES.includes(req.squadRule)) {
    return {error: 'invalid squad rule', status: 400}
  }
```

Then find the `createChallenge(...)` call inside the `try` block and add `req.squadRule` as the final argument:

```typescript
    const challenge = await createChallenge(
      postId,
      subredditId,
      subredditName,
      req.targetSubredditName.replace(/^r\//i, '').trim(),
      clampPlayerCap(req.playerCap),
      clampWarmupMinutes(req.warmupMinutes),
      req.squadRule,
    )
```

- [ ] **Step 3: Update `routeChallengeRespond` to validate (when present) and pass `squadRule`**

Find the body of `routeChallengeRespond` and, right after the existing action-validation block:

```typescript
  if (!validActions.includes(req.action)) {
    return {error: 'invalid challenge action', status: 400}
  }
```

add:

```typescript
  if (req.squadRule !== undefined && !SQUAD_RULES.includes(req.squadRule)) {
    return {error: 'invalid squad rule', status: 400}
  }
```

Then find the `respondChallenge(...)` call inside the `try` block and add `req.squadRule` as the final argument:

```typescript
    const result = await respondChallenge(
      kind.challengeId,
      kind.role,
      req.action,
      req.playerCap,
      req.warmupMinutes,
      req.squadRule,
    )
```

- [ ] **Step 4: Verify it compiles**

Run: `npm run test:types`
Expected: an error in `src/client/challenge.ts` at the `fetchChallengeCreate({...})` call site (missing the now-required `squadRule` field on `CreateChallengeReq`) — expected, fixed in Task 5. Confirm no other errors (Task 4, `match.ts`, is independent and should already be clean or show its own separate expected error — see Task 4).

- [ ] **Step 5: Commit**

```bash
git add src/server/server.ts
git commit -m "Validate and pass squadRule in challenge routes"
```

---

### Task 4: `Match` gets `squadRule` and preset-mode fields; cap check respects `squadRule`

**Files:**
- Modify: `src/server/match.ts`

**Interfaces:**
- Consumes: `canJoinLine` from `./abilities.ts` (existing)
- Produces: `createMatch` now also sets `squadRule`, `joinModeA`, `joinModeB`, `presetIdA`, `presetIdB` on the created `Match`

- [ ] **Step 1: Update `createMatch`'s `Match` literal**

Replace:

```typescript
  const now = Date.now()
  const match: Match = {
    matchId,
    arenaPostIdA: arenaA.id,
    arenaPostIdB: arenaB.id,
    arenaUrlA: arenaA.url,
    arenaUrlB: arenaB.url,
    subredditAName: challenge.challengerSubredditName,
    subredditBName: challenge.targetSubredditName,
    playerCap: challenge.playerCap,
    warmupMinutes: challenge.warmupMinutes,
    status: 'warmup',
    round: 1,
    roundWinsA: 0,
    roundWinsB: 0,
    survivalMsA: 0,
    survivalMsB: 0,
    warmupEndsAt: now + challenge.warmupMinutes * 60_000,
    roundStartedAt: 0,
    roundEndsAt: 0,
    roundResultAt: 0,
    lastRoundWinner: null,
    winner: null,
  }
```

with:

```typescript
  const now = Date.now()
  const match: Match = {
    matchId,
    arenaPostIdA: arenaA.id,
    arenaPostIdB: arenaB.id,
    arenaUrlA: arenaA.url,
    arenaUrlB: arenaB.url,
    subredditAName: challenge.challengerSubredditName,
    subredditBName: challenge.targetSubredditName,
    playerCap: challenge.playerCap,
    warmupMinutes: challenge.warmupMinutes,
    squadRule: challenge.squadRule,
    status: 'warmup',
    round: 1,
    roundWinsA: 0,
    roundWinsB: 0,
    survivalMsA: 0,
    survivalMsB: 0,
    warmupEndsAt: now + challenge.warmupMinutes * 60_000,
    roundStartedAt: 0,
    roundEndsAt: 0,
    roundResultAt: 0,
    lastRoundWinner: null,
    winner: null,
  }
```

(the `joinModeA`/`joinModeB`/`presetIdA`/`presetIdB` fields are added to this same literal in Task 9, once those fields exist on the `Match` type — adding them here now would be premature since Task 1 didn't add them yet; they're introduced together with the preset feature in Phase 2)

- [ ] **Step 2: Skip the line cap when `squadRule === 'custom'`**

In `joinMatch`, find:

```typescript
  const players = await getMatchPlayers(matchId)
  const teammates = players.filter(p => p.team === side)
  if (teammates.length >= match.playerCap) throw new Error('team is full')
  if (!canJoinLine(teammates, line))
    throw new Error(`${line} is full for this team (max 2)`)
```

and change it to:

```typescript
  const players = await getMatchPlayers(matchId)
  const teammates = players.filter(p => p.team === side)
  if (teammates.length >= match.playerCap) throw new Error('team is full')
  if (match.squadRule === 'capped' && !canJoinLine(teammates, line))
    throw new Error(`${line} is full for this team (max 2)`)
```

- [ ] **Step 3: Verify it compiles**

Run: `npm run test:types`
Expected: no errors (this task's own changes are internally consistent — `challenge.squadRule` and `match.squadRule` both now exist per Tasks 1-2).

- [ ] **Step 4: Commit**

```bash
git add src/server/match.ts
git commit -m "Copy squadRule onto Match and skip the line cap when custom"
```

---

### Task 5: Client challenge setup/counter forms and status display

**Files:**
- Modify: `src/client/challenge.ts`

**Interfaces:**
- Consumes: `CreateChallengeReq.squadRule`, `RespondChallengeReq.squadRule` (Task 1)

- [ ] **Step 1: Add the squad-rule toggle to the setup form**

In `runSetup`, find the `showForm({...})` call's `fields` array and add a new field after `warmupMinutes`:

```typescript
      {
        type: 'number',
        name: 'warmupMinutes',
        label: 'Warm-up minutes (1-5)',
        defaultValue: 2,
      },
      {
        type: 'boolean',
        name: 'customSquadRule',
        label: 'Custom squad rule (no 2-per-line cap)',
        defaultValue: false,
      },
```

Then find:

```typescript
  const rsp = await fetchChallengeCreate({
    targetSubredditName: String(result.values.targetSubredditName ?? ''),
    playerCap: Number(result.values.playerCap ?? 5),
    warmupMinutes: Number(result.values.warmupMinutes ?? 2),
  })
```

and change it to:

```typescript
  const rsp = await fetchChallengeCreate({
    targetSubredditName: String(result.values.targetSubredditName ?? ''),
    playerCap: Number(result.values.playerCap ?? 5),
    warmupMinutes: Number(result.values.warmupMinutes ?? 2),
    squadRule: result.values.customSquadRule ? 'custom' : 'capped',
  })
```

- [ ] **Step 2: Add the same toggle to the counter-offer form**

In `counter()`, find the `showForm({...})` call's `fields` array and add the identical boolean field shown in Step 1 after `warmupMinutes`.

Then find:

```typescript
  const rsp = await fetchChallengeRespond({
    challengeId: kind.challengeId,
    action: 'counter',
    playerCap: Number(result.values.playerCap ?? 5),
    warmupMinutes: Number(result.values.warmupMinutes ?? 2),
  })
```

and change it to:

```typescript
  const rsp = await fetchChallengeRespond({
    challengeId: kind.challengeId,
    action: 'counter',
    playerCap: Number(result.values.playerCap ?? 5),
    warmupMinutes: Number(result.values.warmupMinutes ?? 2),
    squadRule: result.values.customSquadRule ? 'custom' : 'capped',
  })
```

- [ ] **Step 3: Show the squad rule on the pending/countered/accepted panels**

In `renderChallenge`, find:

```typescript
  const cap = challenge.playerCap
  const warmup = challenge.warmupMinutes
```

and change it to:

```typescript
  const cap = challenge.playerCap
  const warmup = challenge.warmupMinutes
  const ruleLabel = (rule: 'capped' | 'custom') =>
    rule === 'custom' ? 'custom (no line cap)' : 'capped at 2 per line'
```

Then, in the `'accepted'` branch, find:

```typescript
        <p>r/${escapeHtml(challenge.challengerSubredditName)} vs r/${escapeHtml(challenge.targetSubredditName)}. <span class="stat">${cap}</span> per team, <span class="stat">${warmup}</span> min warm-up.</p>
```

and change it to:

```typescript
        <p>r/${escapeHtml(challenge.challengerSubredditName)} vs r/${escapeHtml(challenge.targetSubredditName)}. <span class="stat">${cap}</span> per team, <span class="stat">${warmup}</span> min warm-up, squad rule <span class="stat">${ruleLabel(challenge.squadRule)}</span>.</p>
```

In the `'pending'` branch's target sub-panel, find:

```typescript
          <p><span class="stat">${cap}</span> players per team, <span class="stat">${warmup}</span> min warm-up.</p>
```

and change it to:

```typescript
          <p><span class="stat">${cap}</span> players per team, <span class="stat">${warmup}</span> min warm-up, squad rule <span class="stat">${ruleLabel(challenge.squadRule)}</span>.</p>
```

In the `'pending'` branch's challenger sub-panel, find:

```typescript
          <p><span class="stat">${cap}</span> per team, <span class="stat">${warmup}</span> min warm-up.</p>
```

and change it to:

```typescript
          <p><span class="stat">${cap}</span> per team, <span class="stat">${warmup}</span> min warm-up, squad rule <span class="stat">${ruleLabel(challenge.squadRule)}</span>.</p>
```

In the `'countered'` branch, find:

```typescript
          <p>r/${escapeHtml(challenge.targetSubredditName)} countered: <span class="stat">${counterCap}</span> per team, <span class="stat">${counterWarmup}</span> min warm-up.</p>
```

and, right above it, add a line reading the counter squad rule (default to the original if no counter value was set), then include it in the paragraph:

```typescript
    const counterCap = challenge.counterPlayerCap ?? cap
    const counterWarmup = challenge.counterWarmupMinutes ?? warmup
    const counterRule = challenge.counterSquadRule ?? challenge.squadRule
```

(this replaces the existing two-line `const counterCap`/`const counterWarmup` declarations — add the third line alongside them) and change the paragraph to:

```typescript
          <p>r/${escapeHtml(challenge.targetSubredditName)} countered: <span class="stat">${counterCap}</span> per team, <span class="stat">${counterWarmup}</span> min warm-up, squad rule <span class="stat">${ruleLabel(counterRule)}</span>.</p>
```

- [ ] **Step 4: Run the full test suite**

Run: `npm run test`
Expected: all pass, `public/challenge.js` rebuilt.

- [ ] **Step 5: Manual verification (devvit playtest — no automated coverage for forms)**

1. `npx devvit playtest <your-test-subreddit>`
2. Run "Challenge a Subreddit," toggle "Custom squad rule" on, submit.
3. From the target subreddit's challenge post, confirm the pending panel shows "squad rule custom (no line cap)."
4. Counter with the toggle left off (capped), confirm the challenger sees "squad rule capped at 2 per line" in the counter panel.
5. Accept the counter, confirm the accepted panel shows "capped at 2 per line," and once in the arena, confirm a 3rd player of the same line on one team is rejected (Phase 1 working end-to-end).

- [ ] **Step 6: Commit**

```bash
git add src/client/challenge.ts
git commit -m "Add squad rule toggle to challenge setup/counter forms"
```

---

## Phase 2 — Squad presets

### Task 6: Preset pure logic

**Files:**
- Modify: `src/server/abilities.ts`
- Modify: `src/server/abilities.test.ts`

**Interfaces:**
- Produces: `canClaimPresetSlot(teammates: Pick<PlayerState, 'line'>[], slots: ShipLine[], line: ShipLine): boolean`

- [ ] **Step 1: Write the failing tests**

Append to `src/server/abilities.test.ts` (add `canClaimPresetSlot` to the existing import from `./abilities.ts`):

```typescript
test('canClaimPresetSlot allows a line up to how many times it appears in the slot list', () => {
  const slots = ['fighter', 'fighter', 'tender'] as const
  assert.equal(canClaimPresetSlot([], [...slots], 'fighter'), true)
  assert.equal(canClaimPresetSlot([{line: 'fighter'}], [...slots], 'fighter'), true)
  assert.equal(
    canClaimPresetSlot(
      [{line: 'fighter'}, {line: 'fighter'}],
      [...slots],
      'fighter',
    ),
    false,
  )
})

test('canClaimPresetSlot rejects a line not present in the slot list at all', () => {
  const slots = ['fighter', 'fighter', 'tender'] as const
  assert.equal(canClaimPresetSlot([], [...slots], 'miner'), false)
})
```

- [ ] **Step 2: Run to verify failure**

Run: `node --experimental-strip-types --no-warnings=ExperimentalWarning --test src/server/abilities.test.ts`
Expected: FAIL — `canClaimPresetSlot` not exported

- [ ] **Step 3: Implement**

Add to `src/server/abilities.ts`:

```typescript
/**
 * A line can be claimed from a preset's slot list as many times as it
 * appears in that list — e.g. a preset with two 'fighter' slots allows up
 * to 2 fighters on that team, independent of the general 2-per-line cap.
 */
export function canClaimPresetSlot(
  teammates: Pick<PlayerState, 'line'>[],
  slots: ShipLine[],
  line: ShipLine,
): boolean {
  const available = slots.filter(l => l === line).length
  const claimed = teammates.filter(p => p.line === line).length
  return claimed < available
}
```

- [ ] **Step 4: Run to verify pass**

Run: `node --experimental-strip-types --no-warnings=ExperimentalWarning --test src/server/abilities.test.ts`
Expected: PASS — 2 new tests passing, none of the existing tests broken

- [ ] **Step 5: Run the full pipeline**

Run: `npm run test`
Expected: clean (types, lint, all unit tests, build).

- [ ] **Step 6: Commit**

```bash
git add src/server/abilities.ts src/server/abilities.test.ts
git commit -m "Add canClaimPresetSlot pure function"
```

---

### Task 7: Shared preset data and `JoinMatchReq`/`Match` fields

**Files:**
- Modify: `src/shared/api.ts`

**Interfaces:**
- Produces: `PresetId` type, `SQUAD_PRESETS: Record<PresetId, ShipLine[]>`, `Match.joinModeA`/`joinModeB: 'individual' | 'preset' | null`, `Match.presetIdA`/`presetIdB: PresetId | null`, `JoinMatchReq` restructured to `{line: ShipLine; mode: 'individual' | 'preset'; presetId: PresetId | null}`

- [ ] **Step 1: Add `PresetId` and `SQUAD_PRESETS`**

Find the `SHIP_STATS` constant block in `src/shared/api.ts` and add immediately after it:

```typescript
/** Curated ship-line slot lists a team can commit to instead of free-picking. Exempt from both the 2-per-line cap and the custom squad rule. */
export type PresetId = 'balanced' | 'aggro' | 'turtle' | 'recon'
export const SQUAD_PRESETS: Record<PresetId, ShipLine[]> = {
  balanced: [
    'fighter',
    'tender',
    'transport',
    'pathfinder',
    'miner',
    'fighter',
    'tender',
    'transport',
    'pathfinder',
    'miner',
  ],
  aggro: [
    'fighter',
    'fighter',
    'pathfinder',
    'fighter',
    'pathfinder',
    'fighter',
    'fighter',
    'pathfinder',
    'fighter',
    'pathfinder',
  ],
  turtle: [
    'transport',
    'transport',
    'tender',
    'transport',
    'tender',
    'transport',
    'transport',
    'tender',
    'transport',
    'tender',
  ],
  recon: [
    'pathfinder',
    'pathfinder',
    'miner',
    'tender',
    'pathfinder',
    'pathfinder',
    'pathfinder',
    'miner',
    'tender',
    'pathfinder',
  ],
}
```

- [ ] **Step 2: Add the join-mode fields to `Match`**

Find `export type Match = {` and, right after `squadRule: SquadRule` (added in Task 1), add the four new fields:

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
  joinModeB: 'individual' | 'preset' | null
  presetIdA: PresetId | null
  presetIdB: PresetId | null
  status: MatchStatus
  round: number
  roundWinsA: number
  roundWinsB: number
  survivalMsA: number
  survivalMsB: number
  warmupEndsAt: number
  roundStartedAt: number
  roundEndsAt: number
  roundResultAt: number
  lastRoundWinner: Team | 'tie' | null
  winner: Team | 'tie' | null
}
```

- [ ] **Step 3: Restructure `JoinMatchReq`**

Find `export type JoinMatchReq = {line: ShipLine}` and change it to:

```typescript
export type JoinMatchReq = {
  line: ShipLine
  mode: 'individual' | 'preset'
  presetId: PresetId | null
}
```

- [ ] **Step 4: Verify it compiles**

Run: `npm run test:types`
Expected: errors at `createMatch`'s `Match` literal in `src/server/match.ts` (missing the 4 new required fields — expected, fixed in Task 9) and at every `fetchMatchJoin({...})` call site in `src/client/battle.ts` (missing `mode`/`presetId` on the request — expected, fixed in Task 10). Confirm no other errors.

- [ ] **Step 5: Commit**

```bash
git add src/shared/api.ts
git commit -m "Add SQUAD_PRESETS and Match/JoinMatchReq fields for squad presets"
```

---

### Task 8: `server.ts` validates `mode`/`presetId`

**Files:**
- Modify: `src/server/server.ts`

**Interfaces:**
- Consumes: `PresetId` is not directly needed here — validate `presetId` against `Object.keys(SQUAD_PRESETS)` instead of importing the type (types don't exist at runtime)

- [ ] **Step 1: Import `SQUAD_PRESETS`**

Add `SQUAD_PRESETS,` to the `'../shared/api.ts'` import block (this file mixes type and value imports in one sorted list — add it near `SQUAD_RULES,`/`SHIP_LINES,` and let `npm run format` fix the exact ordering, same as earlier tasks in this codebase have relied on Biome's auto-sort for this file's import block rather than hand-computing the precise position).

- [ ] **Step 2: Validate `mode`/`presetId` in `routeMatchJoin`**

Find:

```typescript
  const req = await readJson<JoinMatchReq>(reqMsg)
  if (!SHIP_LINES.includes(req.line)) {
    return {error: 'invalid ship line', status: 400}
  }
```

and change it to:

```typescript
  const req = await readJson<JoinMatchReq>(reqMsg)
  if (!SHIP_LINES.includes(req.line)) {
    return {error: 'invalid ship line', status: 400}
  }
  if (req.mode !== 'individual' && req.mode !== 'preset') {
    return {error: 'invalid join mode', status: 400}
  }
  if (
    req.mode === 'preset' &&
    (!req.presetId || !(req.presetId in SQUAD_PRESETS))
  ) {
    return {error: 'invalid preset', status: 400}
  }
```

(note the explicit parens around `req.presetId in SQUAD_PRESETS`: `in` binds tighter than `??`/`||` but this is easy to get wrong the other way — e.g. `!(req.presetId ?? '' in SQUAD_PRESETS)` would parse as `!(req.presetId ?? ('' in SQUAD_PRESETS))`, which is a real bug, not just a style nit — double-check the parens land where shown)

Then find the `joinMatch(...)` call and add `req.mode` and `req.presetId` as the final two arguments:

```typescript
    await joinMatch(
      kind.matchId,
      kind.side,
      userId,
      username,
      context.snoovatar,
      req.line,
      req.mode,
      req.presetId,
    )
```

- [ ] **Step 3: Verify it compiles**

Run: `npm run test:types`
Expected: an error at `joinMatch`'s definition in `src/server/match.ts` (it doesn't accept these two extra arguments yet — expected, fixed in Task 9). Confirm no other errors.

- [ ] **Step 4: Commit**

```bash
git add src/server/server.ts
git commit -m "Validate join mode and preset in routeMatchJoin"
```

---

### Task 9: `joinMatch` handles mode-locking and preset-slot claiming

**Files:**
- Modify: `src/server/match.ts`

**Interfaces:**
- Consumes: `canClaimPresetSlot` from `./abilities.ts` (Task 6), `SQUAD_PRESETS` from `../shared/api.ts` (Task 7)
- Produces: `joinMatch(matchId, side, userId, username, snoovatar, line, mode, presetId): Promise<PlayerState>` (2 params added)

- [ ] **Step 1: Import `canClaimPresetSlot` and `SQUAD_PRESETS`**

Add `canClaimPresetSlot` to the existing `import {canJoinLine, maxHullFor, ...} from './abilities.ts'` line.
Add `SQUAD_PRESETS,` to the `'../shared/api.ts'` value-import block.

- [ ] **Step 2: Add the 4 new fields to `createMatch`'s `Match` literal**

Find (as left by Task 4):

```typescript
    playerCap: challenge.playerCap,
    warmupMinutes: challenge.warmupMinutes,
    squadRule: challenge.squadRule,
    status: 'warmup',
```

and change it to:

```typescript
    playerCap: challenge.playerCap,
    warmupMinutes: challenge.warmupMinutes,
    squadRule: challenge.squadRule,
    joinModeA: null,
    joinModeB: null,
    presetIdA: null,
    presetIdB: null,
    status: 'warmup',
```

- [ ] **Step 3: Replace `joinMatch`'s body**

Replace the entire function:

```typescript
export async function joinMatch(
  matchId: string,
  side: Team,
  userId: string,
  username: string,
  snoovatar: string | undefined,
  line: ShipLine,
  mode: 'individual' | 'preset',
  presetId: PresetId | null,
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

  const committedMode = side === 'A' ? match.joinModeA : match.joinModeB
  const committedPresetId = side === 'A' ? match.presetIdA : match.presetIdB

  if (committedMode === null) {
    if (mode === 'preset') {
      if (!presetId) throw new Error('preset is required for preset mode')
      if (side === 'A') {
        match.joinModeA = 'preset'
        match.presetIdA = presetId
      } else {
        match.joinModeB = 'preset'
        match.presetIdB = presetId
      }
    } else if (side === 'A') {
      match.joinModeA = 'individual'
    } else {
      match.joinModeB = 'individual'
    }
    await saveMatch(match)
  } else if (committedMode !== mode) {
    throw new Error(
      `this team already committed to ${committedMode === 'preset' ? 'a squad preset' : 'individual picks'}`,
    )
  } else if (mode === 'preset' && presetId !== committedPresetId) {
    throw new Error('this team is using a different squad preset')
  }

  if (mode === 'preset') {
    const activePresetId = presetId ?? committedPresetId
    if (!activePresetId) throw new Error('preset is required for preset mode')
    const slots = SQUAD_PRESETS[activePresetId].slice(0, match.playerCap)
    if (!canClaimPresetSlot(teammates, slots, line))
      throw new Error(`${line} slot is already taken in this preset`)
  } else if (match.squadRule === 'capped' && !canJoinLine(teammates, line)) {
    throw new Error(`${line} is full for this team (max 2)`)
  }

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

Note the ordering: the mode-lock/preset-selection logic runs first (and persists via `saveMatch` if this is the first joiner on that side), THEN the slot/cap check runs against the now-settled mode. This matters because the very first joiner on a side is simultaneously the one SETTING the mode and the one whose OWN join must be validated against it.

- [ ] **Step 4: Verify it compiles**

Run: `npm run test:types`
Expected: an error at every `fetchMatchJoin({...})` call site in `src/client/battle.ts` (missing `mode`/`presetId` — expected, fixed in Task 10). Confirm no other errors.

- [ ] **Step 5: Commit**

```bash
git add src/server/match.ts
git commit -m "Add mode-locking and preset-slot claiming to joinMatch"
```

---

### Task 10: Client mode-choice screen and preset picker

**Files:**
- Modify: `src/client/battle.ts`
- Modify: `public/battle.html`

**Interfaces:**
- Consumes: `fetchMatchJoin({line, mode, presetId})` (Task 7's type change; no `fetch.ts` code change needed since it's a generic pass-through), `SQUAD_PRESETS`, `PresetId` from `../shared/api.ts` (Task 7)

- [ ] **Step 1: Import `SQUAD_PRESETS` and `PresetId`**

Add `SQUAD_PRESETS,` to the value-import block and `type PresetId,` to the type-import block from `'../shared/api.ts'`.

- [ ] **Step 2: Add preset display labels and a slot-list HTML builder**

Add near the existing `ABILITY_BLURB` constant:

```typescript
const PRESET_LABEL: Record<PresetId, string> = {
  balanced: 'Balanced Wing — one of each role, twice over',
  aggro: 'Aggro Rush — fighters and pathfinders, hit fast',
  turtle: 'Turtle Wall — transports and tenders, outlast them',
  recon: 'Recon Strike — pathfinders and miners, control the field',
}

function presetSlotSummary(presetId: PresetId, playerCap: number): string {
  const slots = SQUAD_PRESETS[presetId].slice(0, playerCap)
  const counts = new Map<string, number>()
  for (const line of slots) counts.set(line, (counts.get(line) ?? 0) + 1)
  return [...counts.entries()]
    .map(([line, count]) => `${count}x ${SHIP_LABEL[line as PlayerState['line']]}`)
    .join(', ')
}

function presetPickerHtml(playerCap: number): string {
  const ids: PresetId[] = ['balanced', 'aggro', 'turtle', 'recon']
  return ids
    .map(
      id => `
      <button class="preset-pick" data-preset="${id}">
        <b>${PRESET_LABEL[id]}</b><br>
        <small>${presetSlotSummary(id, playerCap)}</small>
      </button>`,
    )
    .join('')
}
```

- [ ] **Step 3: Store this arena post's side in a module-level variable**

`renderMatch` needs to know whether this arena post is side `'A'` or `'B'` (to read `match.joinModeA`/`joinModeB` and `presetIdA`/`presetIdB`), but nothing in this file currently reads `kind.side` — `PostKind`'s `match-arena` variant carries it, `boot()` already destructures `kind`, it's just unused today.

Find, near the top of the file:

```typescript
let scene: BattleScene | null = null
let lastRound = 0
```

and change it to:

```typescript
let scene: BattleScene | null = null
let lastRound = 0
let mySide: Team = 'A'
```

(`Team` is already imported in this file's `import type {Match, MatchMsg, PlayerState, PostKind, Team} from '../shared/api.ts'` block — no import change needed)

In `boot()`, find:

```typescript
async function boot(): Promise<void> {
  const kind = getKind()
  if (kind?.kind !== 'match-arena') {
    showOverlay('<div class="panel"><p>Nothing to see here.</p></div>')
    return
  }
```

and change it to:

```typescript
async function boot(): Promise<void> {
  const kind = getKind()
  if (kind?.kind !== 'match-arena') {
    showOverlay('<div class="panel"><p>Nothing to see here.</p></div>')
    return
  }
  mySide = kind.side
```

- [ ] **Step 4: Update `joinBattle` to take mode/presetId, and add mode-choice rendering to the warmup panel**

Replace:

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

with:

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

In `renderMatch`'s `warmup` branch, replace:

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

with:

```typescript
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

Note: for a genuinely open preset slot pick (letting the joiner choose WHICH open slot/line within the preset, not just always the first), a fuller UI would list each remaining open line as its own button — that's a reasonable follow-up but out of scope here; this task claims the first line in the preset's slot list, and the server's `canClaimPresetSlot` check will reject it if that particular line is already full, surfacing the existing error-panel message asking the player to try again. Note this simplification in your commit/report so it's a visible, intentional scope cut, not a silent gap.

Add a new function above `renderMatch`, using the `mySide` module-level variable set in Step 3 (no parameter threading needed — `scene` and `lastRound` already follow this same module-level-state convention in this file):

```typescript
function renderJoinChoice(match: Match): string {
  const joinMode = mySide === 'A' ? match.joinModeA : match.joinModeB
  if (joinMode === 'individual') {
    return `<div class="ship-picker">${shipPickerHtml()}</div>`
  }
  if (joinMode === 'preset') {
    return `<div class="ship-picker">${presetPickerHtml(match.playerCap)}</div>`
  }
  return `
    <p>Pick your own ship, or commit your team to a squad preset:</p>
    <div class="ship-picker">${shipPickerHtml()}</div>
    <p>— or —</p>
    <div class="ship-picker">${presetPickerHtml(match.playerCap)}</div>
  `
}
```

- [ ] **Step 5: Add preset button CSS**

In `public/battle.html`, inside the existing `<style>` block, add after the `.ship-pick small` rule:

```css
    .preset-pick {
      display: block;
      text-align: left;
      font-size: 11px;
      line-height: 1.4;
    }
    .preset-pick small {
      color: #9fb4c9;
      font-size: 10px;
      text-transform: none;
      letter-spacing: normal;
    }
```

- [ ] **Step 6: Run the full test suite**

Run: `npm run test`
Expected: all pass, `public/battle.js` rebuilt.

- [ ] **Step 7: Manual verification (devvit playtest)**

1. Create a match, open one side's arena as the first joiner.
2. Confirm the warmup screen shows both the individual picker AND the 4 preset buttons (each with a role summary).
3. Click a preset. Confirm you join with the preset's first slot's line, and the panel now shows only that preset's remaining slots for subsequent teammates (not the individual picker).
4. From a second account, join the SAME team — confirm they see only that team's committed preset, not the individual picker, and can't claim a line the preset doesn't include (or has run out of).
5. On the OTHER team, confirm the first joiner there independently sees the full choice (their team's mode is unset) and can pick "individual" instead — confirming team modes are genuinely independent per side.

- [ ] **Step 8: Commit**

```bash
git add src/client/battle.ts public/battle.html
git commit -m "Add squad preset picker to the battle join flow"
```

---

## Self-review notes (fixed inline while writing this plan)

- Confirmed `fetchMatchJoin`'s own code needs no change for Task 10 — it's a generic `postJsonOrError<JoinMatchReq, JoinMatchRsp>` pass-through, so widening `JoinMatchReq`'s shape in Task 7 is sufficient; no separate `fetch.ts` task was invented for a change that isn't needed.
- Verified `canClaimPresetSlot` takes an already-sliced `slots: ShipLine[]` rather than a `presetId` + internal lookup, keeping `abilities.ts` free of any dependency on `SQUAD_PRESETS` — the caller (`match.ts`) does the slicing, consistent with how `abilities.ts` stays a pure-math-only module with no knowledge of match-specific data shapes beyond what's passed as arguments.
- Task 10's "always claims the first slot line" simplification is called out explicitly as a deliberate scope cut (not a silent gap) — a fuller per-slot picker is a reasonable but separate follow-up.
- Confirmed the mode-lock-then-check ordering in `joinMatch` (Task 9) handles the first-joiner-sets-and-is-validated-against-it case correctly: `committedMode` is read as `null` for the very first joiner, the mode is set and saved, and the slot/cap check that follows uses the now-current `mode`/`presetId` values (not the stale `committedMode`/`committedPresetId` read before the assignment) — re-read the code once more here to confirm: yes, the check block uses `mode`/`presetId` (the caller's own request), not `committedMode`/`committedPresetId`, so this is correct regardless of join order.
- Found (not fixed) a narrow read-then-write race in Task 9: if two players join the SAME side as its first-ever joiner at the exact same moment, both observe `committedMode === null` and both write their own mode/presetId, with whichever `saveMatch` call lands last silently winning. This requires two players joining one specific team in the same instant (far narrower than the Phase-5 mine-detonation race from the prior plan, which naturally arose from normal movement) — left as an accepted, low-probability edge case consistent with this codebase's existing tolerance for similarly narrow races (e.g. the accepted non-atomic Tender-heal read-then-write), not something this plan fixes.
- Fixed an operator-precedence bug caught while writing Task 8: `!(req.presetId ?? '' in SQUAD_PRESETS)` parses as `!(req.presetId ?? ('' in SQUAD_PRESETS))` — `in` binds tighter than `??`, which is not the intended check at all. Replaced with an explicit `!req.presetId || !(req.presetId in SQUAD_PRESETS)`.
