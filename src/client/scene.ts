import {connectRealtime} from '@devvit/web/client'
import * as Phaser from 'phaser'
import type {PlayerState, RealtimeMsg} from '../shared/api.ts'
import {
  LASER_COOLDOWN_MS,
  LASER_RANGE,
  TORPEDO_COOLDOWN_MS,
  TORPEDO_RANGE,
  TORPEDO_SPEED,
} from '../shared/api.ts'
import {
  fetchFire,
  fetchInit,
  fetchLeaderboard,
  fetchLeave,
  fetchMove,
  fetchScore,
} from './fetch.ts'
import {TouchButton, VirtualJoystick} from './touchControls.ts'

const WORLD_HALF = 900
const THRUST = 340
const DRAG = 0.985
const MAX_SPEED = 260
const TURN_SPEED = 3.6
const MOVE_SEND_MS = 140

const SHIP_LABEL: Record<PlayerState['line'], string> = {
  fighter: 'FIGHTER',
  miner: 'MINER',
  transport: 'TRANSPORT',
  pathfinder: 'PATHFINDER',
  tender: 'TENDER',
}

type RemoteShip = {
  container: Phaser.GameObjects.Container
  sprite: Phaser.GameObjects.Image
  label: Phaser.GameObjects.Text
  targetX: number
  targetY: number
  targetRotation: number
}

export class SectorScene extends Phaser.Scene {
  private ship!: Phaser.GameObjects.Image
  private velX = 0
  private velY = 0
  private keys!: {
    up: Phaser.Input.Keyboard.Key
    down: Phaser.Input.Keyboard.Key
    left: Phaser.Input.Keyboard.Key
    right: Phaser.Input.Keyboard.Key
    laser: Phaser.Input.Keyboard.Key
    torpedo: Phaser.Input.Keyboard.Key
  }
  private lastLaserFiredAt = 0
  private lastTorpedoFiredAt = 0
  private joystick: VirtualJoystick | null = null
  private touchLaser: TouchButton | null = null
  private touchMissile: TouchButton | null = null
  private others = new Map<string, RemoteShip>()
  private hudName!: Phaser.GameObjects.Text
  private hudScore!: Phaser.GameObjects.Text
  private hudCount!: Phaser.GameObjects.Text
  private starGfx!: Phaser.GameObjects.Graphics
  private player: PlayerState | null = null
  private lastSentAt = 0
  private lastSentX = 0
  private lastSentY = 0
  private stars: {x: number; y: number; r: number; a: number}[] = []
  private leaderboardPanel!: Phaser.GameObjects.Text
  private leaderboardOpen = false
  private hudPulse!: Phaser.GameObjects.Text
  private pulseHideEvent: Phaser.Time.TimerEvent | null = null

  constructor() {
    super('sector')
  }

  preload(): void {
    this.load.image('fighter', 'assets/ships/fighter.webp')
    this.load.image('miner', 'assets/ships/miner.webp')
    this.load.image('transport', 'assets/ships/transport.webp')
    this.load.image('pathfinder', 'assets/ships/pathfinder.webp')
    this.load.image('tender', 'assets/ships/tender.webp')
  }

  async create(): Promise<void> {
    const W = this.scale.width
    const H = this.scale.height

    // Starfield — pre-rolled positions, drawn once, cheap.
    this.starGfx = this.add.graphics().setDepth(0)
    for (let i = 0; i < 220; i++) {
      this.stars.push({
        x: (Math.random() - 0.5) * WORLD_HALF * 3,
        y: (Math.random() - 0.5) * WORLD_HALF * 3,
        r: Math.random() < 0.1 ? 1.6 : 1,
        a: 0.25 + Math.random() * 0.6,
      })
    }

    const kb = this.input.keyboard
    if (!kb) throw new Error('keyboard input plugin unavailable')
    this.keys = {
      up: kb.addKey(Phaser.Input.Keyboard.KeyCodes.W),
      down: kb.addKey(Phaser.Input.Keyboard.KeyCodes.S),
      left: kb.addKey(Phaser.Input.Keyboard.KeyCodes.A),
      right: kb.addKey(Phaser.Input.Keyboard.KeyCodes.D),
      laser: kb.addKey(Phaser.Input.Keyboard.KeyCodes.SPACE),
      torpedo: kb.addKey(Phaser.Input.Keyboard.KeyCodes.E),
    }

    this.hudName = this.add
      .text(12, 10, 'Connecting…', {
        fontFamily: 'monospace',
        fontSize: '13px',
        color: '#7fd4ff',
      })
      .setScrollFactor(0)
      .setDepth(50)
    this.hudScore = this.add
      .text(12, 30, '', {
        fontFamily: 'monospace',
        fontSize: '12px',
        color: '#88bbaa',
      })
      .setScrollFactor(0)
      .setDepth(50)
    this.hudCount = this.add
      .text(W - 12, 10, '', {
        fontFamily: 'monospace',
        fontSize: '12px',
        color: '#9fb4c9',
      })
      .setOrigin(1, 0)
      .setScrollFactor(0)
      .setDepth(50)
    this.hudPulse = this.add
      .text(W / 2, 14, '', {
        fontFamily: 'monospace',
        fontSize: '12px',
        color: '#c9a4ff',
        align: 'center',
      })
      .setOrigin(0.5, 0)
      .setScrollFactor(0)
      .setDepth(50)
      .setAlpha(0)
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
    new TouchButton(
      this,
      W - 115,
      H - 160,
      34,
      'LDR',
      () => void this.toggleLeaderboard(),
    )

    this.leaderboardPanel = this.add
      .text(W / 2, H / 2, '', {
        fontFamily: 'monospace',
        fontSize: '13px',
        color: '#eef6ff',
        align: 'center',
        backgroundColor: '#050c18',
        padding: {x: 18, y: 14},
      })
      .setOrigin(0.5, 0.5)
      .setScrollFactor(0)
      .setDepth(60)
      .setVisible(false)
    kb.on('keydown-L', () => void this.toggleLeaderboard())

    const init = await fetchInit()
    if (!init) {
      this.hudName.setText('Failed to connect — reload to retry')
      return
    }
    this.player = init.player
    this.hudName.setText(
      `${init.player.username} · ${SHIP_LABEL[init.player.line]}`,
    )
    this.updateScoreHud()

    this.ship = this.add
      .image(init.player.x, init.player.y, init.player.line)
      .setDisplaySize(48, 48)
      .setDepth(20)

    this.cameras.main.startFollow(this.ship, true, 0.12, 0.12)
    this.cameras.main.setBounds(
      -WORLD_HALF - 200,
      -WORLD_HALF - 200,
      (WORLD_HALF + 200) * 2,
      (WORLD_HALF + 200) * 2,
    )

    for (const p of init.others) this.spawnRemote(p)
    this.updateCountHud()

    connectRealtime<RealtimeMsg>({
      channel: init.channel,
      onMessage: msg => this.handleRealtime(msg),
    })

    // Best-effort presence cleanup — keepalive fetch survives the page unload.
    window.addEventListener('pagehide', () => void fetchLeave())

    // Score a point every 20s just by surviving in the sector — a tiny,
    // always-on hook until real objectives (mining/combat) land.
    this.time.addEvent({
      delay: 20000,
      loop: true,
      callback: () => {
        void fetchScore({amount: 5}).then(r => {
          if (r && this.player) {
            this.player.score = r.score
            this.updateScoreHud()
          }
        })
      },
    })
  }

  private async toggleLeaderboard(): Promise<void> {
    this.leaderboardOpen = !this.leaderboardOpen
    if (!this.leaderboardOpen) {
      this.leaderboardPanel.setVisible(false)
      return
    }
    this.leaderboardPanel.setText('Loading…').setVisible(true)
    const rsp = await fetchLeaderboard()
    if (!this.leaderboardOpen) return // toggled off while awaiting
    if (!rsp || rsp.entries.length === 0) {
      this.leaderboardPanel.setText(
        'TOP PILOTS\n\nNo scores yet — be the first.',
      )
      return
    }
    const lines = rsp.entries
      .map(
        (e, i) =>
          `${String(i + 1).padStart(2, ' ')}.  ${e.username}  —  ${e.score}  (${e.kills} kills)`,
      )
      .join('\n')
    this.leaderboardPanel.setText(`TOP PILOTS\n\n${lines}`)
  }

  private showPulse(text: string): void {
    this.hudPulse.setText(`✦ ${text}`)
    this.tweens.killTweensOf(this.hudPulse)
    this.hudPulse.setAlpha(1)
    this.pulseHideEvent?.remove()
    this.pulseHideEvent = this.time.delayedCall(6000, () => {
      this.tweens.add({
        targets: this.hudPulse,
        alpha: 0,
        duration: 1200,
      })
    })
  }

  private updateScoreHud(): void {
    if (this.player)
      this.hudScore.setText(
        `SCORE  ${this.player.score}   KILLS  ${this.player.kills}   HULL  ${this.player.hull}`,
      )
  }

  private fireLaser(x: number, y: number, rotation: number): void {
    const dirAngle = rotation - Math.PI / 2
    const midX = x + Math.cos(dirAngle) * (LASER_RANGE / 2)
    const midY = y + Math.sin(dirAngle) * (LASER_RANGE / 2)
    const beam = this.add
      .rectangle(midX, midY, LASER_RANGE, 3, 0xff5566, 0.9)
      .setRotation(dirAngle)
      .setDepth(18)
    this.tweens.add({
      targets: beam,
      alpha: 0,
      duration: 180,
      onComplete: () => beam.destroy(),
    })
  }

  private fireTorpedo(
    x: number,
    y: number,
    rotation: number,
    travelMs: number,
  ): void {
    const dirAngle = rotation - Math.PI / 2
    const endX = x + Math.cos(dirAngle) * TORPEDO_RANGE
    const endY = y + Math.sin(dirAngle) * TORPEDO_RANGE
    const bolt = this.add
      .circle(x, y, 6, 0xff9500, 1)
      .setStrokeStyle(2, 0xffe0b0, 0.8)
      .setDepth(18)
    this.tweens.add({
      targets: bolt,
      x: endX,
      y: endY,
      duration: travelMs,
      ease: 'Linear',
      onComplete: () => bolt.destroy(),
    })
  }

  private fizzleMiss(x: number, y: number): void {
    const ring = this.add
      .circle(x, y, 8, 0x000000, 0)
      .setStrokeStyle(2, 0xff9500, 0.8)
      .setDepth(18)
    this.tweens.add({
      targets: ring,
      radius: 34,
      alpha: 0,
      duration: 320,
      onComplete: () => ring.destroy(),
    })
  }

  private flashDamage(): void {
    if (!this.ship) return
    this.tweens.add({targets: this.ship, alpha: 0.3, duration: 80, yoyo: true})
  }

  private flashRemoteHit(userId: string): void {
    const r = this.others.get(userId)
    if (!r) return
    r.sprite.setTint(0xff3344).setTintMode(Phaser.TintModes.FILL)
    this.time.delayedCall(120, () => r.sprite.clearTint())
  }

  private updateCountHud(): void {
    this.hudCount.setText(
      `SECTOR · ${this.others.size + 1} pilot${this.others.size === 0 ? '' : 's'}`,
    )
  }

  private spawnRemote(p: PlayerState): void {
    if (p.userId === this.player?.userId) return
    const existing = this.others.get(p.userId)
    if (existing) {
      existing.targetX = p.x
      existing.targetY = p.y
      existing.targetRotation = p.rotation
      return
    }
    const sprite = this.add.image(0, 0, p.line).setDisplaySize(42, 42)
    const label = this.add
      .text(0, 30, p.username, {
        fontFamily: 'monospace',
        fontSize: '10px',
        color: '#9fb4c9',
      })
      .setOrigin(0.5, 0)
    const container = this.add.container(p.x, p.y, [sprite, label]).setDepth(15)
    this.others.set(p.userId, {
      container,
      sprite,
      label,
      targetX: p.x,
      targetY: p.y,
      targetRotation: p.rotation,
    })
    this.updateCountHud()
  }

  private removeRemote(userId: string): void {
    const r = this.others.get(userId)
    if (!r) return
    r.container.destroy()
    this.others.delete(userId)
    this.updateCountHud()
  }

  private handleRealtime(msg: RealtimeMsg): void {
    if (msg.type === 'join' || msg.type === 'move') {
      this.spawnRemote(msg.player)
    } else if (msg.type === 'leave') {
      this.removeRemote(msg.userId)
    } else if (msg.type === 'score' && msg.userId === this.player?.userId) {
      if (this.player) {
        this.player.score = msg.score
        this.updateScoreHud()
      }
    } else if (msg.type === 'kills' && msg.userId === this.player?.userId) {
      if (this.player) {
        this.player.kills = msg.kills
        this.updateScoreHud()
      }
    } else if (msg.type === 'pulse') {
      this.showPulse(msg.text)
    } else if (msg.type === 'shot') {
      if (msg.userId === this.player?.userId) {
        // Already drawn optimistically the instant the local player fired.
      } else if (msg.mode === 'laser') {
        this.fireLaser(msg.x, msg.y, msg.rotation)
      } else {
        this.fireTorpedo(msg.x, msg.y, msg.rotation, msg.travelMs)
      }
    } else if (msg.type === 'miss') {
      this.fizzleMiss(msg.x, msg.y)
    } else if (msg.type === 'hit') {
      if (msg.targetUserId === this.player?.userId) {
        if (this.player) {
          this.player.hull = msg.hull
          this.updateScoreHud()
          this.flashDamage()
        }
      } else {
        this.flashRemoteHit(msg.targetUserId)
      }
    } else if (msg.type === 'respawn') {
      if (msg.player.userId === this.player?.userId) {
        this.player = msg.player
        this.ship.setPosition(msg.player.x, msg.player.y)
        this.ship.rotation = msg.player.rotation
        this.updateScoreHud()
      } else {
        this.spawnRemote(msg.player)
      }
    }
  }

  update(_time: number, deltaMs: number): void {
    if (!this.ship || !this.player) return
    const dt = Math.min(deltaMs / 1000, 0.05)

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
        this.fireTorpedo(
          this.ship.x,
          this.ship.y,
          this.ship.rotation,
          (TORPEDO_RANGE / TORPEDO_SPEED) * 1000,
        )
        void fetchFire({mode: 'torpedo'})
      }
    }

    const speed = Math.hypot(this.velX, this.velY)
    if (speed > MAX_SPEED) {
      const s = MAX_SPEED / speed
      this.velX *= s
      this.velY *= s
    }
    this.velX *= DRAG
    this.velY *= DRAG

    this.ship.x = Math.max(
      -WORLD_HALF,
      Math.min(WORLD_HALF, this.ship.x + this.velX * dt),
    )
    this.ship.y = Math.max(
      -WORLD_HALF,
      Math.min(WORLD_HALF, this.ship.y + this.velY * dt),
    )

    // Interpolate remote ships toward their last known position.
    for (const r of this.others.values()) {
      r.container.x += (r.targetX - r.container.x) * Math.min(1, dt * 8)
      r.container.y += (r.targetY - r.container.y) * Math.min(1, dt * 8)
      r.sprite.rotation +=
        (r.targetRotation - r.sprite.rotation) * Math.min(1, dt * 8)
    }

    // Throttled position broadcast — only when moved enough or on a timer.
    const now = performance.now()
    const moved =
      Math.hypot(this.ship.x - this.lastSentX, this.ship.y - this.lastSentY) > 2
    if (moved && now - this.lastSentAt > MOVE_SEND_MS) {
      this.lastSentAt = now
      this.lastSentX = this.ship.x
      this.lastSentY = this.ship.y
      void fetchMove({
        x: this.ship.x,
        y: this.ship.y,
        rotation: this.ship.rotation,
      })
    }

    this.drawStars()
  }

  private drawStars(): void {
    const cam = this.cameras.main
    this.starGfx.clear()
    this.starGfx.fillStyle(0xffffff, 1)
    for (const s of this.stars) {
      const sx = s.x - cam.scrollX * 0.3
      const sy = s.y - cam.scrollY * 0.3
      if (sx < cam.scrollX - 40 || sx > cam.scrollX + cam.width + 40) continue
      if (sy < cam.scrollY - 40 || sy > cam.scrollY + cam.height + 40) continue
      this.starGfx.fillStyle(0xffffff, s.a)
      this.starGfx.fillRect(sx, sy, s.r, s.r)
    }
  }
}

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
