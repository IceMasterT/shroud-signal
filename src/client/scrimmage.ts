import {showForm} from '@devvit/web/client'
import {fetchScrimmageCreate, isErrorRsp} from './fetch.ts'

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

async function runSetup(): Promise<void> {
  render('<div class="panel"><p>Setting up your scrimmage…</p></div>')
  const result = await showForm({
    title: 'Start a Scrimmage',
    fields: [
      {
        type: 'select',
        name: 'matchSize',
        label: 'Match size',
        options: [
          {label: '5v5', value: '5v5'},
          {label: '10v10', value: '10v10'},
        ],
        defaultValue: ['5v5'],
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
      '<div class="panel"><p>Scrimmage setup cancelled.</p><button id="retry">Try again</button></div>',
    )
    document
      .getElementById('retry')
      ?.addEventListener('click', () => void runSetup())
    return
  }
  const matchSize = result.values.matchSize?.[0] === '10v10' ? '10v10' : '5v5'
  const rsp = await fetchScrimmageCreate({
    matchSize,
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
  render(`
    <div class="panel">
      <h1>Scrimmage created!</h1>
      <p>Purple vs Orange, <span class="stat">${escapeHtml(matchSize)}</span>.</p>
      <a class="enter" href="${escapeHtml(rsp.arenaUrl)}"><button>Enter the arena</button></a>
    </div>
  `)
}

void runSetup()
