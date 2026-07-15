import {context, showForm} from '@devvit/web/client'
import type {Challenge, PostKind} from '../shared/api.ts'
import {
  fetchChallengeCreate,
  fetchChallengeRespond,
  fetchChallengeState,
  isErrorRsp,
} from './fetch.ts'

const rootEl = document.getElementById('root')
if (!rootEl) throw new Error('missing #root')
const root: HTMLElement = rootEl

function render(html: string): void {
  root.innerHTML = html
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

function getKind(): PostKind | undefined {
  const data = context.postData
  if (!data || typeof data.kind !== 'string') return undefined
  return data as unknown as PostKind
}

async function boot(): Promise<void> {
  const kind = getKind()
  if (kind?.kind === 'challenge-setup') {
    await runSetup()
    return
  }
  if (kind?.kind === 'challenge') {
    await runStatus(kind.role)
    return
  }
  render('<div class="panel"><p>Nothing to see here.</p></div>')
}

async function runSetup(): Promise<void> {
  render('<div class="panel"><p>Setting up your challenge…</p></div>')
  const result = await showForm({
    title: 'Challenge a Subreddit',
    fields: [
      {
        type: 'string',
        name: 'targetSubredditName',
        label: 'Target subreddit (without r/)',
        required: true,
      },
      {
        type: 'number',
        name: 'playerCap',
        label: 'Players per team (1-10)',
        defaultValue: 5,
      },
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
    ],
  })
  if (result.action !== 'SUBMITTED') {
    render(
      '<div class="panel"><p>Challenge setup cancelled.</p><button id="retry">Try again</button></div>',
    )
    document
      .getElementById('retry')
      ?.addEventListener('click', () => void runSetup())
    return
  }
  const rsp = await fetchChallengeCreate({
    targetSubredditName: String(result.values.targetSubredditName ?? ''),
    playerCap: Number(result.values.playerCap ?? 5),
    warmupMinutes: Number(result.values.warmupMinutes ?? 2),
    squadRule: result.values.customSquadRule ? 'custom' : 'capped',
  })
  if (isErrorRsp(rsp)) {
    render(
      `<div class="panel"><p class="error">${escapeHtml(rsp.error)}</p><button id="retry">Try again</button></div>`,
    )
    document
      .getElementById('retry')
      ?.addEventListener('click', () => void runSetup())
    return
  }
  location.reload()
}

async function runStatus(role: 'challenger' | 'target'): Promise<void> {
  const rsp = await fetchChallengeState()
  if (isErrorRsp(rsp)) {
    render(
      `<div class="panel"><p class="error">${escapeHtml(rsp.error)}</p></div>`,
    )
    return
  }
  renderChallenge(rsp.challenge, role)
}

function renderChallenge(
  challenge: Challenge,
  role: 'challenger' | 'target',
): void {
  const cap = challenge.playerCap
  const warmup = challenge.warmupMinutes
  const ruleLabel = (rule: 'capped' | 'custom') =>
    rule === 'custom' ? 'custom (no line cap)' : 'capped at 2 per line'

  if (challenge.status === 'declined') {
    render(
      '<div class="panel"><h1>Shroud Signal</h1><p>Challenge declined.</p></div>',
    )
    return
  }
  if (challenge.status === 'cancelled') {
    render(
      '<div class="panel"><h1>Shroud Signal</h1><p>Challenge cancelled.</p></div>',
    )
    return
  }
  if (challenge.status === 'accepted') {
    const url =
      role === 'challenger' ? challenge.arenaUrlA : challenge.arenaUrlB
    render(`
      <div class="panel">
        <h1>Battle accepted!</h1>
        <p>r/${escapeHtml(challenge.challengerSubredditName)} vs r/${escapeHtml(challenge.targetSubredditName)}. <span class="stat">${cap}</span> per team, <span class="stat">${warmup}</span> min warm-up, squad rule <span class="stat">${ruleLabel(challenge.squadRule)}</span>.</p>
        ${url ? `<a class="enter" href="${escapeHtml(url)}"><button>Enter your arena</button></a>` : ''}
      </div>
    `)
    return
  }

  if (challenge.status === 'pending') {
    if (role === 'target') {
      render(`
        <div class="panel">
          <h1>Incoming challenge</h1>
          <p>r/${escapeHtml(challenge.challengerSubredditName)} wants to fight r/${escapeHtml(challenge.targetSubredditName)}: Last One Standing.</p>
          <p><span class="stat">${cap}</span> players per team, <span class="stat">${warmup}</span> min warm-up, squad rule <span class="stat">${ruleLabel(challenge.squadRule)}</span>.</p>
          <div class="row">
            <button id="accept">Accept</button>
            <button id="counter" class="secondary">Counter</button>
            <button id="decline" class="secondary">Decline</button>
          </div>
        </div>
      `)
      document
        .getElementById('accept')
        ?.addEventListener('click', () => void respond('accept'))
      document
        .getElementById('counter')
        ?.addEventListener('click', () => void counter())
      document
        .getElementById('decline')
        ?.addEventListener('click', () => void respond('decline'))
    } else {
      render(`
        <div class="panel">
          <h1>Challenge sent</h1>
          <p>Waiting for r/${escapeHtml(challenge.targetSubredditName)} to respond…</p>
          <p><span class="stat">${cap}</span> per team, <span class="stat">${warmup}</span> min warm-up, squad rule <span class="stat">${ruleLabel(challenge.squadRule)}</span>.</p>
          <button id="decline" class="secondary">Cancel challenge</button>
        </div>
      `)
      document
        .getElementById('decline')
        ?.addEventListener('click', () => void respond('decline'))
    }
    return
  }

  if (challenge.status === 'countered') {
    const counterCap = challenge.counterPlayerCap ?? cap
    const counterWarmup = challenge.counterWarmupMinutes ?? warmup
    const counterRule = challenge.counterSquadRule ?? challenge.squadRule
    if (role === 'challenger') {
      render(`
        <div class="panel">
          <h1>Counter-offer</h1>
          <p>r/${escapeHtml(challenge.targetSubredditName)} countered: <span class="stat">${counterCap}</span> per team, <span class="stat">${counterWarmup}</span> min warm-up, squad rule <span class="stat">${ruleLabel(counterRule)}</span>.</p>
          <div class="row">
            <button id="accept">Accept counter</button>
            <button id="decline" class="secondary">Decline</button>
          </div>
        </div>
      `)
      document
        .getElementById('accept')
        ?.addEventListener('click', () => void respond('accept-counter'))
      document
        .getElementById('decline')
        ?.addEventListener('click', () => void respond('decline'))
    } else {
      render(`
        <div class="panel">
          <h1>Counter sent</h1>
          <p>Waiting for r/${escapeHtml(challenge.challengerSubredditName)} to respond to your counter…</p>
        </div>
      `)
    }
    return
  }

  render('<div class="panel"><p>Loading…</p></div>')
}

async function respond(
  action: 'accept' | 'accept-counter' | 'decline',
): Promise<void> {
  const kind = getKind()
  if (kind?.kind !== 'challenge') return
  render('<div class="panel"><p>Sending…</p></div>')
  const rsp = await fetchChallengeRespond({
    challengeId: kind.challengeId,
    action,
  })
  if (isErrorRsp(rsp)) {
    render(
      `<div class="panel"><p class="error">${escapeHtml(rsp.error)}</p></div>`,
    )
    return
  }
  await runStatus(kind.role)
}

async function counter(): Promise<void> {
  const kind = getKind()
  if (kind?.kind !== 'challenge') return
  const result = await showForm({
    title: 'Counter-offer',
    fields: [
      {
        type: 'number',
        name: 'playerCap',
        label: 'Players per team (1-10)',
        defaultValue: 5,
      },
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
    ],
  })
  if (result.action !== 'SUBMITTED') {
    await runStatus(kind.role)
    return
  }
  render('<div class="panel"><p>Sending…</p></div>')
  const rsp = await fetchChallengeRespond({
    challengeId: kind.challengeId,
    action: 'counter',
    playerCap: Number(result.values.playerCap ?? 5),
    warmupMinutes: Number(result.values.warmupMinutes ?? 2),
    squadRule: result.values.customSquadRule ? 'custom' : 'capped',
  })
  if (isErrorRsp(rsp)) {
    render(
      `<div class="panel"><p class="error">${escapeHtml(rsp.error)}</p></div>`,
    )
    return
  }
  await runStatus(kind.role)
}

void boot()
