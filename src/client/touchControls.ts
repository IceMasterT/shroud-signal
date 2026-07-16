import type * as Phaser from 'phaser'

/** True on touch-primary devices (phones/tablets) — desktop mice/trackpads don't count, even on touch-enabled laptops. */
export function isTouchDevice(): boolean {
  return (
    ('ontouchstart' in window || navigator.maxTouchPoints > 0) &&
    window.matchMedia('(pointer: coarse)').matches
  )
}

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
