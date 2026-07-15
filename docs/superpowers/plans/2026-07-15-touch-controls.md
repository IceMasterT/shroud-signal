# Universal Touch Controls Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add an always-visible on-screen virtual joystick + action buttons to both game scenes, so the game is playable on mobile (currently has zero touch input) and so desktop players have a working fallback for the `E`/missile key, which live testing shows something in Reddit's host page swallows before it reaches the game.

**Architecture:** A new shared client module, `src/client/touchControls.ts`, exports `VirtualJoystick` (screen-fixed drag joystick exposing `active`/`angle`/`magnitude`) and `TouchButton` (a tap target shaped like Phaser's own `Key` object — exposes `.isDown` — plus an optional one-shot `onPress` callback for click-style actions like the leaderboard toggle). Both `src/client/battle.ts` and `src/client/scene.ts` instantiate these in `create()` alongside their existing keyboard `addKey` calls; the two input sources coexist, keyboard unchanged. Movement branches per-frame: joystick active → ship snaps to face the joystick's angle and thrusts by its pull magnitude; joystick inactive → today's keyboard turn/thrust code runs exactly as before. Fire/ability checks become `(keyboardKey.isDown || touchButton.isDown)`.

**Tech Stack:** TypeScript, Phaser 4 (`Phaser.GameObjects.Arc`/`Text`, pointer events), Devvit Web client.

## Global Constraints

- Touch controls are always visible on every device — not gated behind touch-capability detection.
- Movement control is joystick-active-or-keyboard, never blended in the same frame.
- Both `Phaser.Game` configs (in `src/client/battle.ts`'s `boot()` and `src/client/scene.ts`'s `bootGame()`) need `input: {activePointers: 2}` — Phaser defaults to tracking a single active pointer, which would make it impossible to hold the joystick with one thumb while tapping a fire button with the other. This is easy to miss and must be added in both files.
- No automated test coverage exists for any client-side Phaser code in this codebase (confirmed: `battle.ts`, `scene.ts`, `challenge.ts` have zero unit tests, verified only via `npm run test:types`/build and manual `devvit playtest`) — this plan follows the same precedent. `touchControls.ts` is verified via type-check, build, and a controller-run Playwright pointer-event simulation (not a subagent task — see the plan's closing verification note), plus manual `devvit playtest` for the real mobile experience.
- Codebase style: Biome-formatted (single quotes, no semicolons, 2-space indent), `npm run test` = `test:types && lint && test:unit && build`, lint uses `--error-on-warnings`.

---

## File Structure

- **Create** `src/client/touchControls.ts` — `VirtualJoystick`, `TouchButton`.
- **Modify** `src/client/battle.ts` — `activePointers: 2` config, joystick + 3 buttons (MSL/LSR/ABL), movement branch, fire/ability checks OR-in touch state.
- **Modify** `src/client/scene.ts` — `activePointers: 2` config, joystick + 3 buttons (MSL/LSR/LDR), movement branch, fire checks OR-in touch state, LDR button triggers `toggleLeaderboard()`.

---

## Task 1: `touchControls.ts` — `VirtualJoystick` and `TouchButton`

**Files:**
- Create: `src/client/touchControls.ts`

**Interfaces:**
- Produces: `VirtualJoystick` class (`active: boolean`, `angle: number`, `magnitude: number`), `TouchButton` class (`isDown: boolean`)

- [ ] **Step 1: Write the module**

Create `src/client/touchControls.ts`:

```typescript
import * as Phaser from 'phaser'

/**
 * A screen-fixed drag joystick. While a pointer is held inside its base
 * radius (or dragged from there), `active` is true and `angle`/`magnitude`
 * describe the drag — `angle` in the same convention `ship.rotation` uses
 * (0 = up), `magnitude` clamped to 0-1 by the base's radius.
 */
export class VirtualJoystick {
  active = false
  angle = 0
  magnitude = 0

  private centerX: number
  private centerY: number
  private radius: number
  private nub: Phaser.GameObjects.Arc
  private pointerId: number | null = null

  constructor(scene: Phaser.Scene, x: number, y: number, radius: number) {
    this.centerX = x
    this.centerY = y
    this.radius = radius

    const base = scene.add
      .circle(x, y, radius, 0xeef6ff, 0.08)
      .setStrokeStyle(2, 0xff9500, 0.5)
      .setScrollFactor(0)
      .setDepth(100)
      .setInteractive({useHandCursor: false})
    this.nub = scene.add
      .circle(x, y, radius * 0.4, 0xff9500, 0.35)
      .setScrollFactor(0)
      .setDepth(101)

    base.on('pointerdown', (pointer: Phaser.Input.Pointer) => {
      this.pointerId = pointer.id
      this.updateFromPointer(pointer)
    })
    scene.input.on('pointermove', (pointer: Phaser.Input.Pointer) => {
      if (pointer.id === this.pointerId) this.updateFromPointer(pointer)
    })
    scene.input.on('pointerup', (pointer: Phaser.Input.Pointer) => {
      if (pointer.id === this.pointerId) this.release()
    })
    scene.input.on('pointerupoutside', (pointer: Phaser.Input.Pointer) => {
      if (pointer.id === this.pointerId) this.release()
    })
  }

  private updateFromPointer(pointer: Phaser.Input.Pointer): void {
    const dx = pointer.x - this.centerX
    const dy = pointer.y - this.centerY
    const rawAngle = Math.atan2(dy, dx)
    const dist = Math.hypot(dx, dy)
    const clamped = Math.min(dist, this.radius)

    this.active = true
    this.angle = rawAngle + Math.PI / 2
    this.magnitude = Math.min(1, dist / this.radius)
    this.nub.x = this.centerX + Math.cos(rawAngle) * clamped
    this.nub.y = this.centerY + Math.sin(rawAngle) * clamped
  }

  private release(): void {
    this.pointerId = null
    this.active = false
    this.magnitude = 0
    this.nub.x = this.centerX
    this.nub.y = this.centerY
  }
}

/**
 * A tap target shaped like Phaser's own `Key` object — exposes `isDown` so
 * it drops into an existing `if (this.keys.x.isDown && ...)` cooldown check
 * with a one-line `||` addition. `onPress` (optional) fires once per tap,
 * for click-style actions (e.g. toggling the leaderboard) rather than
 * held-down polling.
 */
export class TouchButton {
  isDown = false

  constructor(
    scene: Phaser.Scene,
    x: number,
    y: number,
    radius: number,
    label: string,
    onPress?: () => void,
  ) {
    const circle = scene.add
      .circle(x, y, radius, 0x141a28, 0.75)
      .setStrokeStyle(2, 0xff9500, 0.9)
      .setScrollFactor(0)
      .setDepth(100)
      .setInteractive({useHandCursor: false})
    scene.add
      .text(x, y, label, {
        fontFamily: 'monospace',
        fontSize: '11px',
        color: '#eef6ff',
      })
      .setOrigin(0.5, 0.5)
      .setScrollFactor(0)
      .setDepth(101)

    circle.on('pointerdown', () => {
      this.isDown = true
      onPress?.()
    })
    circle.on('pointerup', () => {
      this.isDown = false
    })
    circle.on('pointerout', () => {
      this.isDown = false
    })
  }
}
```

- [ ] **Step 2: Verify it compiles**

Run: `npm run test:types`
Expected: no output, exit code 0 (nothing imports this module yet, so this only confirms the new file itself is valid TypeScript).

- [ ] **Step 3: Commit**

```bash
git add src/client/touchControls.ts
git commit -m "Add VirtualJoystick and TouchButton for universal touch input"
```

---

## Task 2: Wire touch controls into `battle.ts`

**Files:**
- Modify: `src/client/battle.ts`

**Interfaces:**
- Consumes: `VirtualJoystick`, `TouchButton` from `./touchControls.ts` (Task 1)

- [ ] **Step 1: Import the new module**

Add near the top of `src/client/battle.ts`:

```typescript
import {TouchButton, VirtualJoystick} from './touchControls.ts'
```

- [ ] **Step 2: Enable multi-touch on the Phaser.Game config**

Find, in `boot()`:

```typescript
  const game = new Phaser.Game({
    type: Phaser.AUTO,
    parent: 'game-root',
    backgroundColor: '#01030a',
    scale: {
      mode: Phaser.Scale.RESIZE,
      autoCenter: Phaser.Scale.CENTER_BOTH,
      width: window.innerWidth,
      height: window.innerHeight,
    },
    scene: [BattleScene],
  })
```

and change it to:

```typescript
  const game = new Phaser.Game({
    type: Phaser.AUTO,
    parent: 'game-root',
    backgroundColor: '#01030a',
    scale: {
      mode: Phaser.Scale.RESIZE,
      autoCenter: Phaser.Scale.CENTER_BOTH,
      width: window.innerWidth,
      height: window.innerHeight,
    },
    input: {activePointers: 2},
    scene: [BattleScene],
  })
```

Without this, Phaser only tracks one active pointer — holding the joystick with one thumb would make button taps from the other thumb invisible to the game.

- [ ] **Step 3: Add class fields for the joystick and buttons**

Find:

```typescript
  lastLaserFiredAt = 0
  lastTorpedoFiredAt = 0
  lastAbilityFiredAt = 0
  others = new Map<string, RemoteShip>()
```

and change it to:

```typescript
  lastLaserFiredAt = 0
  lastTorpedoFiredAt = 0
  lastAbilityFiredAt = 0
  joystick: VirtualJoystick | null = null
  touchLaser: TouchButton | null = null
  touchMissile: TouchButton | null = null
  touchAbility: TouchButton | null = null
  others = new Map<string, RemoteShip>()
```

- [ ] **Step 4: Instantiate the joystick and buttons in `create()`**

Find, in `create()`:

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
  }
```

and change it to:

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

    this.joystick = new VirtualJoystick(this, 110, H - 110, 70)
    this.touchMissile = new TouchButton(this, W - 70, H - 70, 34, 'MSL')
    this.touchLaser = new TouchButton(this, W - 160, H - 70, 34, 'LSR')
    this.touchAbility = new TouchButton(this, W - 115, H - 160, 34, 'ABL')
  }
```

- [ ] **Step 5: Branch the movement code on joystick activity**

Find, in `update()`:

```typescript
    if (this.keys.left.isDown) this.ship.rotation -= TURN_SPEED * spd * dt
    if (this.keys.right.isDown) this.ship.rotation += TURN_SPEED * spd * dt
    if (this.keys.up.isDown) {
      this.velX +=
        Math.cos(this.ship.rotation - Math.PI / 2) * THRUST * spd * dt
      this.velY +=
        Math.sin(this.ship.rotation - Math.PI / 2) * THRUST * spd * dt
    }
    if (this.keys.down.isDown) {
      this.velX -=
        Math.cos(this.ship.rotation - Math.PI / 2) * THRUST * spd * 0.5 * dt
      this.velY -=
        Math.sin(this.ship.rotation - Math.PI / 2) * THRUST * spd * 0.5 * dt
    }
```

and change it to:

```typescript
    if (this.joystick?.active) {
      this.ship.rotation = this.joystick.angle
      const thrust = THRUST * spd * this.joystick.magnitude
      this.velX += Math.cos(this.ship.rotation - Math.PI / 2) * thrust * dt
      this.velY += Math.sin(this.ship.rotation - Math.PI / 2) * thrust * dt
    } else {
      if (this.keys.left.isDown) this.ship.rotation -= TURN_SPEED * spd * dt
      if (this.keys.right.isDown) this.ship.rotation += TURN_SPEED * spd * dt
      if (this.keys.up.isDown) {
        this.velX +=
          Math.cos(this.ship.rotation - Math.PI / 2) * THRUST * spd * dt
        this.velY +=
          Math.sin(this.ship.rotation - Math.PI / 2) * THRUST * spd * dt
      }
      if (this.keys.down.isDown) {
        this.velX -=
          Math.cos(this.ship.rotation - Math.PI / 2) * THRUST * spd * 0.5 * dt
        this.velY -=
          Math.sin(this.ship.rotation - Math.PI / 2) * THRUST * spd * 0.5 * dt
      }
    }
```

- [ ] **Step 6: OR the touch buttons into the fire/ability checks**

Find:

```typescript
    const nowMs = performance.now()
    if (
      this.keys.laser.isDown &&
      nowMs - this.lastLaserFiredAt > LASER_COOLDOWN_MS
    ) {
      this.lastLaserFiredAt = nowMs
      this.fireLaser(this.ship.x, this.ship.y, this.ship.rotation)
      void fetchFire({mode: 'laser'})
    }
    if (
      this.keys.torpedo.isDown &&
      nowMs - this.lastTorpedoFiredAt > TORPEDO_COOLDOWN_MS
    ) {
      this.lastTorpedoFiredAt = nowMs
      void fetchFire({mode: 'torpedo'})
    }
    if (
      this.keys.ability.isDown &&
      nowMs - this.lastAbilityFiredAt > ABILITY_COOLDOWN_MS[this.self.line]
    ) {
      this.lastAbilityFiredAt = nowMs
      if (this.self.line === 'pathfinder') this.radarPing()
      void fetchMatchAbility()
    }
```

and change it to:

```typescript
    const nowMs = performance.now()
    if (
      (this.keys.laser.isDown || this.touchLaser?.isDown) &&
      nowMs - this.lastLaserFiredAt > LASER_COOLDOWN_MS
    ) {
      this.lastLaserFiredAt = nowMs
      this.fireLaser(this.ship.x, this.ship.y, this.ship.rotation)
      void fetchFire({mode: 'laser'})
    }
    if (
      (this.keys.torpedo.isDown || this.touchMissile?.isDown) &&
      nowMs - this.lastTorpedoFiredAt > TORPEDO_COOLDOWN_MS
    ) {
      this.lastTorpedoFiredAt = nowMs
      void fetchFire({mode: 'torpedo'})
    }
    if (
      (this.keys.ability.isDown || this.touchAbility?.isDown) &&
      nowMs - this.lastAbilityFiredAt > ABILITY_COOLDOWN_MS[this.self.line]
    ) {
      this.lastAbilityFiredAt = nowMs
      if (this.self.line === 'pathfinder') this.radarPing()
      void fetchMatchAbility()
    }
```

- [ ] **Step 7: Run the full test suite**

Run: `npm run test`
Expected: all pass, `public/battle.js` rebuilt.

- [ ] **Step 8: Manual verification (devvit playtest)**

1. `npx devvit playtest <your-test-subreddit>`
2. On desktop, open a battle arena. Confirm the joystick (bottom-left) and 3 buttons (bottom-right: MSL/LSR/ABL) render without overlapping the existing HUD text.
3. Click-and-drag the joystick with a mouse — confirm the ship rotates to face the drag direction and thrusts proportional to how far you drag, and releasing stops rotation/thrust control (keyboard WASD should immediately work again).
4. Click each button — confirm MSL/LSR/ABL fire exactly like their keyboard equivalents (E/Space/R), respecting the same cooldowns.
5. If you have a touch device or can use your browser's device-emulation mode, confirm you can hold the joystick with one input point while tapping a button with a second simultaneously (this is what `activePointers: 2` enables) — both should register at once, not just one.

- [ ] **Step 9: Commit**

```bash
git add src/client/battle.ts
git commit -m "Add touch joystick and action buttons to battle arenas"
```

---

## Task 3: Wire touch controls into `scene.ts`

**Files:**
- Modify: `src/client/scene.ts` (this includes `bootGame()`, which lives in `scene.ts` itself — `src/client/game.ts` is just a one-line entry point that calls it and is not touched by this task)

**Interfaces:**
- Consumes: `VirtualJoystick`, `TouchButton` from `./touchControls.ts` (Task 1)

- [ ] **Step 1: Import the new module**

Add near the top of `src/client/scene.ts`:

```typescript
import {TouchButton, VirtualJoystick} from './touchControls.ts'
```

- [ ] **Step 2: Enable multi-touch on the Phaser.Game config**

Find, in `bootGame()`:

```typescript
export function bootGame(): void {
  new Phaser.Game({
    type: Phaser.AUTO,
    parent: 'game-root',
    backgroundColor: '#01030a',
    scale: {
      mode: Phaser.Scale.RESIZE,
      autoCenter: Phaser.Scale.CENTER_BOTH,
      width: window.innerWidth,
      height: window.innerHeight,
    },
    scene: [SectorScene],
  })
}
```

and change it to:

```typescript
export function bootGame(): void {
  new Phaser.Game({
    type: Phaser.AUTO,
    parent: 'game-root',
    backgroundColor: '#01030a',
    scale: {
      mode: Phaser.Scale.RESIZE,
      autoCenter: Phaser.Scale.CENTER_BOTH,
      width: window.innerWidth,
      height: window.innerHeight,
    },
    input: {activePointers: 2},
    scene: [SectorScene],
  })
}
```

- [ ] **Step 3: Add class fields for the joystick and buttons**

Find:

```typescript
  private lastLaserFiredAt = 0
  private lastTorpedoFiredAt = 0
  private others = new Map<string, RemoteShip>()
```

and change it to:

```typescript
  private lastLaserFiredAt = 0
  private lastTorpedoFiredAt = 0
  private joystick: VirtualJoystick | null = null
  private touchLaser: TouchButton | null = null
  private touchMissile: TouchButton | null = null
  private others = new Map<string, RemoteShip>()
```

(no `touchLeaderboard` field is needed — the leaderboard button's `onPress` callback handles the toggle directly, there's no per-frame `.isDown` polling for it, matching how the existing `kb.on('keydown-L', ...)` listener already works)

- [ ] **Step 4: Instantiate the joystick and buttons in `create()`**

Find, in `create()`:

```typescript
    this.add
      .text(
        W - 12,
        H - 12,
        '[SPACE] LASER  ·  [E] MISSILE  ·  [L] LEADERBOARD',
        {
          fontFamily: 'monospace',
          fontSize: '10px',
          color: '#446688',
        },
      )
      .setOrigin(1, 1)
      .setScrollFactor(0)
      .setDepth(50)
    this.leaderboardPanel = this.add
```

and change it to:

```typescript
    this.add
      .text(
        W - 12,
        H - 12,
        '[SPACE] LASER  ·  [E] MISSILE  ·  [L] LEADERBOARD',
        {
          fontFamily: 'monospace',
          fontSize: '10px',
          color: '#446688',
        },
      )
      .setOrigin(1, 1)
      .setScrollFactor(0)
      .setDepth(50)

    this.joystick = new VirtualJoystick(this, 110, H - 110, 70)
    this.touchMissile = new TouchButton(this, W - 70, H - 70, 34, 'MSL')
    this.touchLaser = new TouchButton(this, W - 160, H - 70, 34, 'LSR')
    new TouchButton(this, W - 115, H - 160, 34, 'LDR', () =>
      void this.toggleLeaderboard(),
    )

    this.leaderboardPanel = this.add
```

(the leaderboard `TouchButton` doesn't need to be stored in a field — nothing polls its `.isDown`, its only job is the one-shot `onPress` callback, so the constructed instance can be discarded immediately after wiring the callback, same as how `kb.on('keydown-L', ...)` doesn't keep a reference to anything either)

- [ ] **Step 5: Branch the movement code on joystick activity**

Find, in `update()`:

```typescript
    if (this.keys.left.isDown) this.ship.rotation -= TURN_SPEED * dt
    if (this.keys.right.isDown) this.ship.rotation += TURN_SPEED * dt
    if (this.keys.up.isDown) {
      this.velX += Math.cos(this.ship.rotation - Math.PI / 2) * THRUST * dt
      this.velY += Math.sin(this.ship.rotation - Math.PI / 2) * THRUST * dt
    }
    if (this.keys.down.isDown) {
      this.velX -=
        Math.cos(this.ship.rotation - Math.PI / 2) * THRUST * 0.5 * dt
      this.velY -=
        Math.sin(this.ship.rotation - Math.PI / 2) * THRUST * 0.5 * dt
    }
```

and change it to:

```typescript
    if (this.joystick?.active) {
      this.ship.rotation = this.joystick.angle
      const thrust = THRUST * this.joystick.magnitude
      this.velX += Math.cos(this.ship.rotation - Math.PI / 2) * thrust * dt
      this.velY += Math.sin(this.ship.rotation - Math.PI / 2) * thrust * dt
    } else {
      if (this.keys.left.isDown) this.ship.rotation -= TURN_SPEED * dt
      if (this.keys.right.isDown) this.ship.rotation += TURN_SPEED * dt
      if (this.keys.up.isDown) {
        this.velX += Math.cos(this.ship.rotation - Math.PI / 2) * THRUST * dt
        this.velY += Math.sin(this.ship.rotation - Math.PI / 2) * THRUST * dt
      }
      if (this.keys.down.isDown) {
        this.velX -=
          Math.cos(this.ship.rotation - Math.PI / 2) * THRUST * 0.5 * dt
        this.velY -=
          Math.sin(this.ship.rotation - Math.PI / 2) * THRUST * 0.5 * dt
      }
    }
```

(this scene has no per-line `speedMul` — that's a battle-arena-only concept from the ship-squads feature — so unlike Task 2, this movement block has no `spd` multiplier to preserve; the structure otherwise mirrors it exactly)

- [ ] **Step 6: OR the touch buttons into the fire checks**

Find:

```typescript
    const nowMs = performance.now()
    if (this.keys.laser.isDown) {
      if (nowMs - this.lastLaserFiredAt > LASER_COOLDOWN_MS) {
        this.lastLaserFiredAt = nowMs
        this.fireLaser(this.ship.x, this.ship.y, this.ship.rotation)
        void fetchFire({mode: 'laser'})
      }
    }
    if (this.keys.torpedo.isDown) {
      if (nowMs - this.lastTorpedoFiredAt > TORPEDO_COOLDOWN_MS) {
        this.lastTorpedoFiredAt = nowMs
        void fetchFire({mode: 'torpedo'})
      }
    }
```

and change it to:

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
        void fetchFire({mode: 'torpedo'})
      }
    }
```

- [ ] **Step 7: Run the full test suite**

Run: `npm run test`
Expected: all pass, `public/game.js` rebuilt.

- [ ] **Step 8: Manual verification (devvit playtest)**

1. `npx devvit playtest <your-test-subreddit>`
2. Post "Chart a New Sector," open it. Confirm the joystick and 3 buttons (MSL/LSR/LDR) render without overlapping the existing HUD.
3. Drag the joystick — confirm the ship points and flies toward the drag, same as Task 2's battle-arena verification.
4. Tap MSL/LSR — confirm they fire exactly like keyboard E/Space.
5. Tap LDR — confirm it toggles the leaderboard panel open/closed, same as pressing `L`.

- [ ] **Step 9: Commit**

```bash
git add src/client/scene.ts
git commit -m "Add touch joystick and action buttons to free-play sectors"
```

---

## Closing verification note (controller-run, not a task)

Neither task above has automated coverage for the actual pointer-drag/tap mechanics (this codebase has no client-side test harness). Before considering this plan done, the controller should run a Playwright-driven local check against the built `public/battle.html` and `public/game.html` — mocking `/api/init`/`/api/match/state` the same way the earlier missile-key investigation did — simulating `mouse.move`/`mouse.down`/`mouse.up` sequences over the joystick and button regions, and confirming (via injected `window.__fireLog`-style hooks or reading back `scene.ship.rotation`) that the joystick actually changes ship rotation and the buttons actually trigger fire calls. This is a real mechanism check the plan's own tasks can't fully self-verify, distinct from the `devvit playtest` steps above (which check the real Reddit-hosted experience, not the underlying logic in isolation).
