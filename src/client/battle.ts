import {connectRealtime, context} from '@devvit/web/client'
import * as Phaser from 'phaser'
import type {
  Match,
  MatchMsg,
  PlayerState,
  PostKind,
  Team,
} from '../shared/api.ts'
import {
  LASER_COOLDOWN_MS,
  LASER_RANGE,
  matchChannel,
  TORPEDO_COOLDOWN_MS,
  TORPEDO_RANGE,
} from '../shared/api.ts'
import {
  fetchFire,
  fetchMatchJoin,
  fetchMatchState,
  fetchMove,
  isErrorRsp,
} from './fetch.ts'

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

function getKind(): PostKind | undefined {
  const data = context.postData
  if (!data || typeof data.kind !== 'string') return undefined
  return data as unknown as PostKind
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
  team: Team
  eliminated: boolean
  targetX: number
  targetY: number
  targetRotation: number
}

class BattleScene extends Phaser.Scene {
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
  } | null = null
  lastLaserFiredAt = 0
  lastTorpedoFiredAt = 0
  others = new Map<string, RemoteShip>()
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
      existing.container.setVisible(true)
      return
    }
    const sprite = this.add.image(0, 0, p.line).setDisplaySize(42, 42)
    if (p.team === 'B') sprite.setTint(0xffb060)
    else sprite.setTint(0x8fd6ff)
    const label = this.add
      .text(0, 30, `${p.username} · ${p.team}`, {
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
      team: p.team,
      eliminated: false,
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

  resetForNewRound(self: PlayerState, others: PlayerState[]): void {
    for (const r of this.others.values()) r.container.destroy()
    this.others.clear()
    this.spawnSelf(self)
    for (const p of others) this.spawnRemote(p)
  }

  fireLaser(x: number, y: number, rotation: number): void {
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

  updateHud(): void {
    if (!this.self) return
    const alive = [...this.others.values()].filter(r => !r.eliminated)
    const aliveA =
      (this.self.team === 'A' ? 1 : 0) +
      alive.filter(r => r.team === 'A').length
    const aliveB =
      (this.self.team === 'B' ? 1 : 0) +
      alive.filter(r => r.team === 'B').length
    this.hudTop.setText(
      `TEAM ${this.self.team}  ·  A ${aliveA} vs B ${aliveB} remaining`,
    )
    this.hudBottom.setText(
      `${this.self.username}  ·  ${SHIP_LABEL[this.self.line]}  ·  HULL ${this.self.hull}${this.selfEliminated ? '  ·  ELIMINATED (spectating)' : ''}`,
    )
  }

  handleMsg(msg: MatchMsg): void {
    if (msg.type === 'roster') {
      this.spawnRemote(msg.player)
    } else if (msg.type === 'move') {
      this.spawnRemote(msg.player)
    } else if (msg.type === 'shot') {
      if (msg.mode === 'laser') {
        if (msg.userId !== this.self?.userId)
          this.fireLaser(msg.x, msg.y, msg.rotation)
      } else {
        this.fireTorpedo(msg.x, msg.y, msg.rotation, msg.travelMs)
      }
    } else if (msg.type === 'miss') {
      this.fizzleMiss(msg.x, msg.y)
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
    }
  }

  update(_time: number, deltaMs: number): void {
    if (!this.ship || !this.self || !this.keys || this.selfEliminated) return
    const dt = Math.min(deltaMs / 1000, 0.05)

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

function rosterList(players: PlayerState[], cap: number): string {
  const names = players.map(p => escapeHtml(p.username)).join(', ') || '(empty)'
  return `<b>${players.length}/${cap}</b> ${names}`
}

async function joinBattle(): Promise<void> {
  const rsp = await fetchMatchJoin()
  if (isErrorRsp(rsp)) {
    showOverlay(
      `<div class="panel"><p class="error">${escapeHtml(rsp.error)}</p></div>`,
    )
  }
  await poll()
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
    showOverlay(`
      <div class="panel">
        <h1>Last One Standing</h1>
        <p>r/${escapeHtml(match.subredditAName)} vs r/${escapeHtml(match.subredditBName)}</p>
        <p>Warm-up: <span class="stat">${secsLeft}s</span> left, or when both teams are full.</p>
        <div class="rosters">
          <div class="roster">TEAM A<br>${rosterList(rosterA, match.playerCap)}</div>
          <div class="roster">TEAM B<br>${rosterList(rosterB, match.playerCap)}</div>
        </div>
        ${self ? '<p>You are in. Waiting for the round to start…</p>' : '<button id="join">Join battle</button>'}
      </div>
    `)
    document
      .getElementById('join')
      ?.addEventListener('click', () => void joinBattle())
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
        : `Team ${match.lastRoundWinner} wins the round`
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
        : `Team ${match.winner} wins the battle!`
    showOverlay(`
      <div class="panel">
        <h1>${winnerText}</h1>
        <p>Final: <span class="stat">A ${match.roundWinsA}</span> — <span class="stat">B ${match.roundWinsB}</span></p>
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
  if (kind?.kind !== 'match-arena') {
    showOverlay('<div class="panel"><p>Nothing to see here.</p></div>')
    return
  }

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
  game.events.once('ready', () => {
    scene = game.scene.getScene('battle') as BattleScene
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
