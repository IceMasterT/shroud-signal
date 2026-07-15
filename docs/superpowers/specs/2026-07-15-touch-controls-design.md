# Universal Touch Controls (Virtual Joystick + Buttons)

Status: approved design, not yet planned/implemented.
Scope: `src/client/scene.ts` (free-play sectors) and `src/client/battle.ts` (battle arenas). New shared client module `src/client/touchControls.ts`. No server changes.

## Why

Real playtesting on live Reddit surfaced two problems:

1. **Mobile is completely unplayable.** There's no touch input handling anywhere in the client — only keyboard (WASD/Space/E/R). Reddit's mobile app and mobile web have no physical keyboard, so a mobile player currently can't move or fire at all.
2. **Desktop's `E` key (missile) doesn't fire, while `Space` (laser) does.** Real Reddit-hosted testing shows something in the host page reliably swallows `E` before Phaser's canvas sees it, while `Space` reaches the game fine. The exact interception point (Reddit's own page-level shortcuts, the Devvit iframe's focus handling, or something else specific to that key) isn't directly diagnosable from outside a live Reddit session.

Rather than continue chasing which physical key Reddit's page won't steal, the fix is to make the game's controls not depend on keyboard delivery being reliable at all: on-screen touch/click controls, visible on every device, become the primary universal input path. Keyboard keeps working as a faster optional path for desktop players whose keys do reach the game.

## Decisions made during design review

- **Always visible on all devices**, not gated behind touch-capability detection. This is what makes it double as the desktop `E`-key fix, not just a mobile feature.
- **Virtual joystick + tap buttons** (the standard mobile twin-stick-shooter layout), not tap-to-fly. This game already has a twin-stick-shooter movement model (rotate + thrust); a joystick maps onto that far more naturally than a single-tap-target scheme, and it's a control language most players already know.
- **Both scenes in one pass.** `scene.ts` and `battle.ts` share near-identical movement constants (`THRUST`, `MAX_SPEED`, `TURN_SPEED`) and structure, so the joystick math is genuinely shared logic, not gameplay-specific — worth extracting once rather than duplicating or doing one scene now and one later.
- **Touch input handling is shared code**, breaking from this codebase's established precedent of deliberately duplicating movement/combat code between `scene.ts` and `battle.ts` (to avoid coupling gameplay logic that might need to diverge). Touch/pointer handling isn't gameplay logic — it's generic device input, the same category as `src/client/fetch.ts`, which is already shared. A new `src/client/touchControls.ts` houses it.

## Control model

**Joystick (bottom-left).** A translucent base circle plus a draggable nub, screen-fixed (`setScrollFactor(0)`), listening to Phaser pointer events within its radius. While a pointer is down inside it, the joystick is "active" and exposes a direction (angle) and pull magnitude (0–1, clamped at the base's radius). Released, it snaps back to center and goes inactive.

**Movement, joystick vs. keyboard — not blended.** When the joystick is active, it takes over completely for that frame: the ship's rotation is set directly to the joystick's angle (immediate, not eased — snappy touch response is what mobile players expect from a virtual stick) and thrust is applied in that direction, scaled by pull magnitude. When the joystick is inactive, today's keyboard turn-rate/thrust model runs exactly as it does now, completely unchanged. The two control schemes are mutually exclusive per-frame (whichever is "active" that frame wins), not merged into some blended input value — simpler to implement correctly and avoids fighting between two control philosophies (rate-based turning vs. absolute-angle pointing).

**Buttons (bottom-right).** Circular, labeled, styled to match the existing monospace/orange UI already established across the game. Free-play sectors get **LSR** (laser) / **MSL** (missile) / **LDR** (leaderboard toggle) — the exact three actions `scene.ts`'s existing hint text already documents. Battle arenas get **LSR** / **MSL** / **ABL** (ability) — the three from `battle.ts`'s hint text. (Neither scene needs a movement button beyond the joystick; free-play has no ability key to expose, battle has no leaderboard toggle today.)

Each button is deliberately shaped like Phaser's own `Key` object: it exposes a boolean `.isDown`, set `true` on `pointerdown` and `false` on `pointerup`/`pointerout`/`pointercancel`. This means the existing fire-cooldown logic in each scene's `update()` needs only a one-line change per action — e.g. `if (this.keys.laser.isDown && ...)` becomes `if ((this.keys.laser.isDown || this.touchLaser.isDown) && ...)` — rather than a parallel input-handling path.

## Architecture

`src/client/touchControls.ts` exports two classes, both taking a `Phaser.Scene` in their constructor and drawing their own graphics/hit areas:

- `VirtualJoystick(scene, x, y, radius)` — exposes `active: boolean`, `angle: number`, `magnitude: number` (0–1), and an `update()`/positioning method called once per game frame from the owning scene's own `update()`.
- `TouchButton(scene, x, y, radius, label)` — exposes `isDown: boolean`.

Both `scene.ts` and `battle.ts` instantiate one `VirtualJoystick` and their respective set of `TouchButton`s in `create()`, alongside their existing keyboard `addKey` calls — the two input sources coexist as siblings, not a replacement.

## Suggested implementation phases

1. **`touchControls.ts` + wiring into `battle.ts`** (the more complex scene — 3 weapons + ability — proves the pattern once, including the movement-model switch). Fully testable/playable on its own.
2. **Wiring into `scene.ts`** (free-play) — by this point the shared module is proven, so this phase is mostly instantiation + the one-line fire-check changes, following the same pattern battle.ts already established.

Each phase leaves the game working and playable on both keyboard and touch.
