import {connectRealtime, context} from '@devvit/web/client'
import * as Phaser from 'phaser'
import type {
  Match,
  MatchMsg,
  PlayerState,
  PostKind,
  PresetId,
  Team,
  WeaponMode,
} from '../shared/api.ts'
import {
  ABILITY_COOLDOWN_MS,
  AUTOCANNON_COOLDOWN_MS,
  AUTOCANNON_RANGE,
  BURST_COOLDOWN_MS,
  BURST_RANGE,
  FLAK_COOLDOWN_MS,
  FLAK_RANGE,
  LASER_COOLDOWN_MS,
  LASER_RANGE,
  MISSILE_COOLDOWN_MS,
  MISSILE_SPEED,
  matchChannel,
  PLASMA_COOLDOWN_MS,
  PLASMA_RANGE,
  RADAR_PING_DURATION_MS,
  SHIP_LINES,
  SHIP_STATS,
  SHIP_WEAPONS,
  SQUAD_PRESETS,
  TORPEDO_RANGE,
} from '../shared/api.ts'
import {
  fetchFire,
  fetchMatchAbility,
  fetchMatchJoin,
  fetchMatchState,
  fetchMove,
  fetchScrimmageJoin,
  isErrorRsp,
} from './fetch.ts'
import {isTouchDevice, TouchButton, VirtualJoystick} from './touchControls.ts'

const WORLD_HALF = 900
const THRUST = 340
const DRAG = 0.985
const MAX_SPEED = 260
const TURN_SPEED = 3.6
const MOVE_SEND_MS = 140
const POLL_MS = 2000

const SHIP_LABEL: Record<PlayerState['line'], string> = {
  fighter: 'FIGHTER',
  miner: 'MINER',
  transport: 'TRANSPORT',
  pathfinder: 'PATHFINDER',
  tender: 'TENDER',
}

const ABILITY_BLURB: Record<PlayerState['line'], string> = {
  fighter: 'Overcharge: +50% weapon damage for 5s',
  miner: 'Deploy Mine: plants a proximity mine',
  transport: 'Bulwark: -40% damage taken for 4s',
  pathfinder: 'Radar Ping: reveals enemy hull for 6s',
  tender: 'Repair Beam: heals your nearest ally',
}

const WEAPON_LABEL: Record<PlayerState['line'], string> = {
  fighter: 'Laser + Missile',
  miner: 'Autocannon',
  transport: 'Burst Cannon',
  pathfinder: 'Plasma Cannon',
  tender: 'Flak Battery — shotgun + shoots down missiles',
}

/** Visuals + cooldown for every hit-scan (instant) weapon — torpedo is drawn separately since it travels. */
const HITSCAN_VISUAL: Record<
  Exclude<WeaponMode, 'torpedo'>,
  {range: number; cooldownMs: number; color: number; thickness: number}
> = {
  laser: {
    range: LASER_RANGE,
    cooldownMs: LASER_COOLDOWN_MS,
    color: 0xff5566,
    thickness: 3,
  },
  autocannon: {
    range: AUTOCANNON_RANGE,
    cooldownMs: AUTOCANNON_COOLDOWN_MS,
    color: 0xffe066,
    thickness: 2,
  },
  burst: {
    range: BURST_RANGE,
    cooldownMs: BURST_COOLDOWN_MS,
    color: 0xff9955,
    thickness: 4,
  },
  plasma: {
    range: PLASMA_RANGE,
    cooldownMs: PLASMA_COOLDOWN_MS,
    color: 0x66ffcc,
    thickness: 4,
  },
  flak: {
    range: FLAK_RANGE,
    cooldownMs: FLAK_COOLDOWN_MS,
    color: 0xdadada,
    thickness: 5,
  },
}

const PRESET_LABEL: Record<PresetId, string> = {
  balanced: 'Balanced Wing — one of each role, twice over',
  aggro: 'Aggro Rush — fighters and miners, hit fast and often',
  turtle: 'Turtle Wall — mostly transports, outlast them',
  recon: 'Recon Strike — miners with pathfinder scouts, control the field',
}

function presetSlotSummary(presetId: PresetId, playerCap: number): string {
  const slots = SQUAD_PRESETS[presetId].slice(0, playerCap)
  const counts = new Map<string, number>()
  for (const line of slots) counts.set(line, (counts.get(line) ?? 0) + 1)
  return [...counts.entries()]
    .map(
      ([line, count]) => `${count}x ${SHIP_LABEL[line as PlayerState['line']]}`,
    )
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

function shipPickerHtml(): string {
  return SHIP_LINES.map(
    line => `
      <button class="ship-pick" data-line="${line}">
        <b>${SHIP_LABEL[line]}</b><br>
        <span class="stat">SPD ${Math.round(SHIP_STATS[line].speedMul * 100)}%</span>
        <span class="stat">HULL ${Math.round(SHIP_STATS[line].hullMul * 100)}%</span>
        <span class="stat">DMG ${Math.round(SHIP_STATS[line].dmgMul * 100)}%</span><br>
        <small>${WEAPON_LABEL[line]}</small><br>
        <small>${ABILITY_BLURB[line]}</small>
      </button>`,
  ).join('')
}

function getKind(): PostKind | undefined {
  const data = context.postData
  if (!data || typeof data.kind !== 'string') return undefined
  return data as unknown as PostKind
}

/** Scrimmages display Purple/Orange instead of Team A/B — a display-only relabeling, `Team` itself always stays 'A'|'B'. */
function teamLabel(team: Team, scrimmage: boolean): string {
  if (!scrimmage) return team
  return team === 'A' ? 'Purple' : 'Orange'
}

function escapeHtml(s: string): string {
  return s.replace(
    /[&<>"']/g,
    c =>
      ({'&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'})[
        c
      ] ?? c,
  )
}

type RemoteShip = {
  container: Phaser.GameObjects.Container
  sprite: Phaser.GameObjects.Image
  label: Phaser.GameObjects.Text
  hullLabel: Phaser.GameObjects.Text
  team: Team
  eliminated: boolean
  hull: number
  targetX: number
  targetY: number
  targetRotation: number
}

class BattleScene extends Phaser.Scene {
  isScrimmage = false
  ship: Phaser.GameObjects.Image | null = null
  velX = 0
  velY = 0
  keys: {
    up: Phaser.Input.Keyboard.Key
    down: Phaser.Input.Keyboard.Key
    left: Phaser.Input.Keyboard.Key
    right: Phaser.Input.Keyboard.Key
    laser: Phaser.Input.Keyboard.Key
    torpedo: Phaser.Input.Keyboard.Key
    ability: Phaser.Input.Keyboard.Key
  } | null = null
  lastLaserFiredAt = 0
  lastTorpedoFiredAt = 0
  lastAbilityFiredAt = 0
  joystick: VirtualJoystick | null = null
  // Two buttons always exist even though only Fighter has two weapons —
  // touch buttons are built before the player's own ship line is known
  // (create() runs before spawnSelf()), so which ship needs which button
  // can't be decided at construction time. For every other line, the
  // second button just falls back to firing the same one weapon.
  touchPrimary: TouchButton | null = null
  touchSecondary: TouchButton | null = null
  touchAbility: TouchButton | null = null
  others = new Map<string, RemoteShip>()
  mines = new Map<string, Phaser.GameObjects.Arc>()
  hudTop!: Phaser.GameObjects.Text
  hudBottom!: Phaser.GameObjects.Text
  starGfx!: Phaser.GameObjects.Graphics
  stars: {x: number; y: number; r: number; a: number}[] = []
  self: PlayerState | null = null
  selfEliminated = false
  lastSentAt = 0
  lastSentX = 0
  lastSentY = 0

  constructor() {
    super('battle')
  }

  preload(): void {
    this.load.image('fighter', 'assets/ships/fighter.webp')
    this.load.image('miner', 'assets/ships/miner.webp')
    this.load.image('transport', 'assets/ships/transport.webp')
    this.load.image('pathfinder', 'assets/ships/pathfinder.webp')
    this.load.image('tender', 'assets/ships/tender.webp')
  }

  create(): void {
    const W = this.scale.width
    const H = this.scale.height
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
      ability: kb.addKey(Phaser.Input.Keyboard.KeyCodes.R),
    }

    this.hudTop = this.add
      .text(W / 2, 10, '', {
        fontFamily: 'monospace',
        fontSize: '13px',
        color: '#eef6ff',
        align: 'center',
      })
      .setOrigin(0.5, 0)
      .setScrollFactor(0)
      .setDepth(50)
    this.hudBottom = this.add
      .text(12, H - 12, '', {
        fontFamily: 'monospace',
        fontSize: '11px',
        color: '#88bbaa',
      })
      .setOrigin(0, 1)
      .setScrollFactor(0)
      .setDepth(50)
    this.add
      .text(W - 12, H - 12, '[SPACE/E] FIRE  ·  [R] ABILITY', {
        fontFamily: 'monospace',
        fontSize: '10px',
        color: '#446688',
      })
      .setOrigin(1, 1)
      .setScrollFactor(0)
      .setDepth(50)

    if (isTouchDevice()) {
      this.joystick = new VirtualJoystick(this, 110, H - 110, 70)
      this.touchPrimary = new TouchButton(this, W - 160, H - 70, 34, 'FIRE')
      this.touchSecondary = new TouchButton(this, W - 70, H - 70, 34, 'ALT')
      this.touchAbility = new TouchButton(this, W - 115, H - 160, 34, 'ABL')
    }
  }

  spawnSelf(player: PlayerState): void {
    this.self = player
    this.selfEliminated = false
    if (this.ship) this.ship.destroy()
    this.ship = this.add
      .image(player.x, player.y, player.line)
      .setDisplaySize(48, 48)
      .setDepth(20)
    this.cameras.main.startFollow(this.ship, true, 0.12, 0.12)
    this.cameras.main.setBounds(
      -WORLD_HALF - 400,
      -WORLD_HALF - 400,
      (WORLD_HALF + 400) * 2,
      (WORLD_HALF + 400) * 2,
    )
    this.updateHud()
  }

  spawnRemote(p: PlayerState): void {
    if (p.userId === this.self?.userId || !p.team) return
    const existing = this.others.get(p.userId)
    if (existing) {
      existing.targetX = p.x
      existing.targetY = p.y
      existing.targetRotation = p.rotation
      existing.eliminated = false
      existing.hull = p.hull
      existing.container.setVisible(true)
      return
    }
    const sprite = this.add.image(0, 0, p.line).setDisplaySize(42, 42)
    if (p.team === 'B') sprite.setTint(0xffb060)
    else sprite.setTint(0x8fd6ff)
    const label = this.add
      .text(0, 30, `${p.username} · ${teamLabel(p.team, this.isScrimmage)}`, {
        fontFamily: 'monospace',
        fontSize: '10px',
        color: '#9fb4c9',
      })
      .setOrigin(0.5, 0)
    const hullLabel = this.add
      .text(0, -30, '', {
        fontFamily: 'monospace',
        fontSize: '10px',
        color: '#ffe08a',
      })
      .setOrigin(0.5, 1)
      .setVisible(false)
    const container = this.add
      .container(p.x, p.y, [sprite, label, hullLabel])
      .setDepth(15)
    this.others.set(p.userId, {
      container,
      sprite,
      label,
      hullLabel,
      team: p.team,
      eliminated: false,
      hull: p.hull,
      targetX: p.x,
      targetY: p.y,
      targetRotation: p.rotation,
    })
    this.updateHud()
  }

  eliminateRemote(userId: string): void {
    const r = this.others.get(userId)
    if (!r) return
    r.eliminated = true
    r.container.setAlpha(0.25)
    this.updateHud()
  }

  placeMineVisual(mineId: string, x: number, y: number): void {
    const mine = this.add
      .circle(x, y, 8, 0xff9500, 0.5)
      .setStrokeStyle(2, 0xff9500, 0.9)
      .setDepth(12)
    this.mines.set(mineId, mine)
  }

  detonateMineVisual(mineId: string, x: number, y: number): void {
    this.mines.get(mineId)?.destroy()
    this.mines.delete(mineId)
    const ring = this.add
      .circle(x, y, 10, 0xff5522, 0.6)
      .setStrokeStyle(3, 0xffcc66, 1)
      .setDepth(19)
    this.tweens.add({
      targets: ring,
      radius: 70,
      alpha: 0,
      duration: 260,
      onComplete: () => ring.destroy(),
    })
  }

  resetForNewRound(self: PlayerState, others: PlayerState[]): void {
    for (const r of this.others.values()) r.container.destroy()
    this.others.clear()
    for (const m of this.mines.values()) m.destroy()
    this.mines.clear()
    this.spawnSelf(self)
    for (const p of others) this.spawnRemote(p)
  }

  /** Draws any instant hit-scan weapon's beam — laser, autocannon, burst, plasma, or flak. */
  fireHitscanBeam(
    x: number,
    y: number,
    rotation: number,
    mode: Exclude<WeaponMode, 'torpedo'>,
  ): void {
    const {range, color, thickness} = HITSCAN_VISUAL[mode]
    const dirAngle = rotation - Math.PI / 2
    const midX = x + Math.cos(dirAngle) * (range / 2)
    const midY = y + Math.sin(dirAngle) * (range / 2)
    const beam = this.add
      .rectangle(midX, midY, range, thickness, color, 0.9)
      .setRotation(dirAngle)
      .setDepth(18)
    this.tweens.add({
      targets: beam,
      alpha: 0,
      duration: 180,
      onComplete: () => beam.destroy(),
    })
  }

  /** Dispatches to the right visual for whichever weapon actually fired. */
  fireWeaponVisual(
    mode: WeaponMode,
    x: number,
    y: number,
    rotation: number,
    travelMs: number,
  ): void {
    if (mode === 'torpedo') this.fireTorpedo(x, y, rotation, travelMs)
    else this.fireHitscanBeam(x, y, rotation, mode)
  }

  flakBurst(x: number, y: number): void {
    const burst = this.add
      .circle(x, y, 10, 0xffffff, 0)
      .setStrokeStyle(3, 0xffffff, 0.9)
      .setDepth(19)
    this.tweens.add({
      targets: burst,
      radius: 30,
      alpha: 0,
      duration: 250,
      onComplete: () => burst.destroy(),
    })
  }

  fireTorpedo(x: number, y: number, rotation: number, travelMs: number): void {
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

  fizzleMiss(x: number, y: number): void {
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

  flashDamage(): void {
    if (!this.ship) return
    this.tweens.add({
      targets: this.ship,
      alpha: 0.3,
      duration: 80,
      yoyo: true,
      repeat: 1,
    })
  }

  radarPing(): void {
    for (const r of this.others.values()) {
      r.hullLabel.setText(String(r.hull)).setVisible(true)
    }
    this.time.delayedCall(RADAR_PING_DURATION_MS, () => {
      for (const r of this.others.values()) r.hullLabel.setVisible(false)
    })
  }

  updateHud(): void {
    const alive = [...this.others.values()].filter(r => !r.eliminated)
    const aliveA =
      (this.self?.team === 'A' ? 1 : 0) +
      alive.filter(r => r.team === 'A').length
    const aliveB =
      (this.self?.team === 'B' ? 1 : 0) +
      alive.filter(r => r.team === 'B').length
    const teamLine = this.self
      ? `TEAM ${teamLabel(this.self.team ?? 'A', this.isScrimmage)}`
      : 'SPECTATING'
    this.hudTop.setText(
      `${teamLine}  ·  ${teamLabel('A', this.isScrimmage)} ${aliveA} vs ${teamLabel('B', this.isScrimmage)} ${aliveB} remaining`,
    )
    this.hudBottom.setText(
      this.self
        ? `${this.self.username}  ·  ${SHIP_LABEL[this.self.line]}  ·  HULL ${this.self.hull}  ·  KILLS ${this.self.kills}${this.selfEliminated ? '  ·  ELIMINATED (spectating)' : ''}`
        : 'Spectator view',
    )
  }

  handleMsg(msg: MatchMsg): void {
    if (msg.type === 'roster') {
      this.spawnRemote(msg.player)
    } else if (msg.type === 'move') {
      this.spawnRemote(msg.player)
    } else if (msg.type === 'shot') {
      if (msg.userId === this.self?.userId) {
        // Already drawn optimistically the instant the local player fired —
        // re-drawing here would either double it up (hit-scan) or make it wait
        // on the realtime round-trip before appearing at all (torpedo).
      } else {
        this.fireWeaponVisual(
          msg.mode,
          msg.x,
          msg.y,
          msg.rotation,
          msg.travelMs,
        )
      }
    } else if (msg.type === 'miss') {
      this.fizzleMiss(msg.x, msg.y)
    } else if (msg.type === 'flak_intercept') {
      this.flakBurst(msg.x, msg.y)
    } else if (msg.type === 'hit') {
      if (msg.targetUserId === this.self?.userId) {
        if (this.self) {
          this.self.hull = msg.hull
          this.flashDamage()
          this.updateHud()
        }
      } else {
        const r = this.others.get(msg.targetUserId)
        if (r) {
          r.hull = msg.hull
          r.sprite.setTint(0xff3344).setTintMode(Phaser.TintModes.FILL)
          this.time.delayedCall(120, () => {
            if (r.team === 'B') r.sprite.setTint(0xffb060)
            else r.sprite.setTint(0x8fd6ff)
          })
        }
      }
    } else if (msg.type === 'eliminated') {
      if (msg.userId === this.self?.userId) {
        this.selfEliminated = true
        this.updateHud()
      } else {
        this.eliminateRemote(msg.userId)
      }
    } else if (msg.type === 'kills' && msg.userId === this.self?.userId) {
      if (this.self) {
        this.self.kills = msg.kills
        this.updateHud()
      }
    } else if (msg.type === 'ability') {
      const r = this.others.get(msg.userId)
      if (r) {
        const pulse = this.add
          .circle(r.container.x, r.container.y, 26, 0xfff2a8, 0)
          .setStrokeStyle(2, 0xfff2a8, 0.9)
          .setDepth(19)
        this.tweens.add({
          targets: pulse,
          radius: 40,
          alpha: 0,
          duration: 300,
          onComplete: () => pulse.destroy(),
        })
        // Radar Ping is a team recon tool, not a solo one — the whole team
        // shares the reveal, not just the pathfinder who triggered it.
        if (msg.line === 'pathfinder' && r.team === this.self?.team) {
          this.radarPing()
        }
      }
    } else if (msg.type === 'heal') {
      if (msg.targetUserId === this.self?.userId && this.self) {
        this.self.hull = msg.hull
        this.updateHud()
      } else if (msg.targetUserId !== this.self?.userId) {
        const r = this.others.get(msg.targetUserId)
        if (r) r.hull = msg.hull
      }
      const target =
        msg.targetUserId === this.self?.userId
          ? this.ship
          : this.others.get(msg.targetUserId)?.sprite
      if (target) {
        this.tweens.add({
          targets: target,
          alpha: 0.4,
          duration: 100,
          yoyo: true,
          repeat: 1,
        })
      }
    } else if (msg.type === 'mine_placed') {
      this.placeMineVisual(msg.mineId, msg.x, msg.y)
    } else if (msg.type === 'mine_detonated') {
      this.detonateMineVisual(msg.mineId, msg.x, msg.y)
    }
  }

  update(_time: number, deltaMs: number): void {
    if (!this.ship || !this.self || !this.keys || this.selfEliminated) return
    const dt = Math.min(deltaMs / 1000, 0.05)
    const spd = this.self.line ? SHIP_STATS[this.self.line].speedMul : 1

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

    // Each line carries its own weapon(s) — Fighter alone has two (primary
    // laser + secondary missile); every other line has one, so its second
    // fire input (E key / ALT button) just falls back to the same weapon
    // rather than being a dead input.
    const nowMs = performance.now()
    const myWeapons = SHIP_WEAPONS[this.self.line]
    const primaryMode = myWeapons[0]
    const secondaryMode = myWeapons[1]
    const spacePressed = this.keys.laser.isDown || this.touchPrimary?.isDown
    const ePressed = this.keys.torpedo.isDown || this.touchSecondary?.isDown

    if (primaryMode && (spacePressed || (!secondaryMode && ePressed))) {
      const cooldownMs =
        primaryMode === 'torpedo'
          ? MISSILE_COOLDOWN_MS
          : HITSCAN_VISUAL[primaryMode].cooldownMs
      if (nowMs - this.lastLaserFiredAt > cooldownMs) {
        this.lastLaserFiredAt = nowMs
        this.fireWeaponVisual(
          primaryMode,
          this.ship.x,
          this.ship.y,
          this.ship.rotation,
          (TORPEDO_RANGE / MISSILE_SPEED) * 1000,
        )
        void fetchFire({mode: primaryMode})
      }
    }
    if (secondaryMode && ePressed) {
      const cooldownMs =
        secondaryMode === 'torpedo'
          ? MISSILE_COOLDOWN_MS
          : HITSCAN_VISUAL[secondaryMode].cooldownMs
      if (nowMs - this.lastTorpedoFiredAt > cooldownMs) {
        this.lastTorpedoFiredAt = nowMs
        this.fireWeaponVisual(
          secondaryMode,
          this.ship.x,
          this.ship.y,
          this.ship.rotation,
          (TORPEDO_RANGE / MISSILE_SPEED) * 1000,
        )
        void fetchFire({mode: secondaryMode})
      }
    }
    if (
      (this.keys.ability.isDown || this.touchAbility?.isDown) &&
      nowMs - this.lastAbilityFiredAt > ABILITY_COOLDOWN_MS[this.self.line]
    ) {
      this.lastAbilityFiredAt = nowMs
      if (this.self.line === 'pathfinder') this.radarPing()
      void fetchMatchAbility()
    }

    const speed = Math.hypot(this.velX, this.velY)
    if (speed > MAX_SPEED * spd) {
      const s = (MAX_SPEED * spd) / speed
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

    for (const r of this.others.values()) {
      r.container.x += (r.targetX - r.container.x) * Math.min(1, dt * 8)
      r.container.y += (r.targetY - r.container.y) * Math.min(1, dt * 8)
      r.sprite.rotation +=
        (r.targetRotation - r.sprite.rotation) * Math.min(1, dt * 8)
    }

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

  drawStars(): void {
    const cam = this.cameras.main
    this.starGfx.clear()
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

const overlayEl = document.getElementById('overlay')
if (!overlayEl) throw new Error('missing #overlay')
const overlay: HTMLElement = overlayEl

function showOverlay(html: string): void {
  overlay.innerHTML = html
  overlay.classList.remove('hidden')
}

function hideOverlay(): void {
  overlay.classList.add('hidden')
}

let scene: BattleScene | null = null
let lastRound = 0
let mySide: Team = 'A'
let isScrimmage = false
let scrimmageTeamChoice: Team | null = null

function rosterList(players: PlayerState[], cap: number): string {
  const names = players.map(p => escapeHtml(p.username)).join(', ') || '(empty)'
  return `<b>${players.length}/${cap}</b> ${names}`
}

function killsScoreboard(
  rosterA: PlayerState[],
  rosterB: PlayerState[],
): string {
  const ranked = [...rosterA, ...rosterB]
    .filter(p => p.kills > 0)
    .sort((a, b) => b.kills - a.kills)
    .slice(0, 5)
  if (ranked.length === 0) return ''
  const rows = ranked
    .map(
      (p, i) =>
        `${i + 1}. ${escapeHtml(p.username)} (${teamLabel(p.team ?? 'A', isScrimmage)}) — ${p.kills} kill${p.kills === 1 ? '' : 's'}`,
    )
    .join('<br>')
  return `<p><b>TOP KILLS</b><br>${rows}</p>`
}

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

async function joinScrimmageBattle(
  line: PlayerState['line'],
  team: Team | null,
): Promise<void> {
  const rsp = await fetchScrimmageJoin({line, team})
  if (isErrorRsp(rsp)) {
    showOverlay(
      `<div class="panel"><p class="error">${escapeHtml(rsp.error)}</p></div>`,
    )
  }
  await poll()
}

function renderScrimmageJoinChoice(match: Match): string {
  if (match.teamAssignMode === 'manual' && !scrimmageTeamChoice) {
    return `
      <p>Pick your team:</p>
      <div class="row">
        <button id="pick-purple">Purple Team</button>
        <button id="pick-orange">Orange Team</button>
      </div>
    `
  }
  return `<div class="ship-picker">${shipPickerHtml()}</div>`
}

function renderJoinChoice(match: Match): string {
  const joinMode = mySide === 'A' ? match.joinModeA : match.joinModeB
  const presetId = mySide === 'A' ? match.presetIdA : match.presetIdB
  if (joinMode === 'individual') {
    return `<div class="ship-picker">${shipPickerHtml()}</div>`
  }
  if (joinMode === 'preset' && presetId) {
    return `
      <p>Your team committed to a squad preset:</p>
      <div class="ship-picker">
        <button class="preset-pick" data-preset="${presetId}">
          <b>${PRESET_LABEL[presetId]}</b><br>
          <small>${presetSlotSummary(presetId, match.playerCap)}</small>
        </button>
      </div>
    `
  }
  return `
    <p>Pick your own ship, or commit your team to a squad preset:</p>
    <div class="ship-picker">${shipPickerHtml()}</div>
    <p>— or —</p>
    <div class="ship-picker">${presetPickerHtml(match.playerCap)}</div>
  `
}

function renderMatch(
  match: Match,
  self: PlayerState | null,
  rosterA: PlayerState[],
  rosterB: PlayerState[],
): void {
  if (match.status === 'warmup') {
    const secsLeft = Math.max(
      0,
      Math.round((match.warmupEndsAt - Date.now()) / 1000),
    )
    const title = isScrimmage
      ? `Practice Scrimmage · ${escapeHtml(match.subredditAName)}`
      : `r/${escapeHtml(match.subredditAName)} vs r/${escapeHtml(match.subredditBName)}`
    showOverlay(`
      <div class="panel">
        <h1>Last One Standing</h1>
        <p>${title}</p>
        <p>Warm-up: <span class="stat">${secsLeft}s</span> left, or when both teams are full.</p>
        <div class="rosters">
          <div class="roster">TEAM ${teamLabel('A', isScrimmage).toUpperCase()}<br>${rosterList(rosterA, match.playerCap)}</div>
          <div class="roster">TEAM ${teamLabel('B', isScrimmage).toUpperCase()}<br>${rosterList(rosterB, match.playerCap)}</div>
        </div>
        ${self ? '<p>You are in. Waiting for the round to start…</p>' : isScrimmage ? renderScrimmageJoinChoice(match) : renderJoinChoice(match)}
      </div>
    `)
    if (!self) {
      if (isScrimmage) {
        document
          .getElementById('pick-purple')
          ?.addEventListener('click', () => {
            scrimmageTeamChoice = 'A'
            void poll()
          })
        document
          .getElementById('pick-orange')
          ?.addEventListener('click', () => {
            scrimmageTeamChoice = 'B'
            void poll()
          })
        for (const btn of document.querySelectorAll<HTMLButtonElement>(
          '.ship-pick',
        )) {
          btn.addEventListener('click', () => {
            const line = btn.dataset.line as PlayerState['line']
            void joinScrimmageBattle(line, scrimmageTeamChoice)
          })
        }
      } else {
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
    }
    return
  }

  if (match.status === 'round_active') {
    hideOverlay()
    if (!scene) return
    if (
      self &&
      (!scene.self ||
        scene.self.userId !== self.userId ||
        match.round !== lastRound)
    ) {
      lastRound = match.round
      scene.resetForNewRound(self, [...rosterA, ...rosterB])
    }
    return
  }

  if (match.status === 'round_result') {
    const winnerText =
      match.lastRoundWinner === 'tie'
        ? 'Round tied (time limit)'
        : `Team ${teamLabel(match.lastRoundWinner ?? 'A', isScrimmage)} wins the round`
    showOverlay(`
      <div class="panel">
        <h1>Round ${match.round} complete</h1>
        <p>${winnerText}</p>
        <p>Series: <span class="stat">A ${match.roundWinsA}</span> — <span class="stat">B ${match.roundWinsB}</span></p>
        <p>Next round starting shortly…</p>
      </div>
    `)
    return
  }

  if (match.status === 'complete') {
    const winnerText =
      match.winner === 'tie'
        ? "It's a tie!"
        : `Team ${teamLabel(match.winner ?? 'A', isScrimmage)} wins the battle!`
    showOverlay(`
      <div class="panel">
        <h1>${winnerText}</h1>
        <p>Final: <span class="stat">A ${match.roundWinsA}</span> — <span class="stat">B ${match.roundWinsB}</span></p>
        ${killsScoreboard(rosterA, rosterB)}
      </div>
    `)
  }
}

async function poll(): Promise<void> {
  const rsp = await fetchMatchState()
  if (isErrorRsp(rsp)) {
    showOverlay(
      `<div class="panel"><p class="error">${escapeHtml(rsp.error)}</p></div>`,
    )
    return
  }
  renderMatch(rsp.match, rsp.self, rsp.rosterA, rsp.rosterB)
}

async function boot(): Promise<void> {
  const kind = getKind()
  if (kind?.kind !== 'match-arena' && kind?.kind !== 'scrimmage') {
    showOverlay('<div class="panel"><p>Nothing to see here.</p></div>')
    return
  }
  isScrimmage = kind.kind === 'scrimmage'
  if (kind.kind === 'match-arena') mySide = kind.side

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
  game.events.once('ready', () => {
    scene = game.scene.getScene('battle') as BattleScene
    scene.isScrimmage = isScrimmage
  })

  connectRealtime<MatchMsg>({
    channel: matchChannel(kind.matchId),
    onMessage: msg => {
      scene?.handleMsg(msg)
      if (
        msg.type === 'round_start' ||
        msg.type === 'round_end' ||
        msg.type === 'match_end' ||
        msg.type === 'roster'
      ) {
        void poll()
      }
    },
  })

  await poll()
  setInterval(() => void poll(), POLL_MS)
}

void boot()
