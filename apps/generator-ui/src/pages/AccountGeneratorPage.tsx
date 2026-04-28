/**
 * apps/generator-ui/src/pages/AccountGeneratorPage.tsx
 *
 * Admin-only tab for seeding synthetic cardholders, accounts, and cards
 * into MongoDB. Operators can view seed status; only admins can start a run.
 *
 * API surface (account-api :8001):
 *   POST /api/seed/start   — admin only
 *   GET  /api/seed/status  — admin + operator
 *   WS   /api/seed/ws/progress?session_id=...
 */

import { useEffect, useRef, useState } from 'react'
import { accountApi } from '../api/client'
import { useAuth } from '../context/AuthContext'
import {
  Card, InfoBanner, ProgressBar, SectionHead, Spinner, StatCard, SubTabs,
} from '../components/ui'

// ── Types ─────────────────────────────────────────────────────────────────────

interface SeedConfig {
  cardholders:         number
  accounts_per_holder: string
  cards_per_account:   string
  balance_high_pct:    number
  balance_mid_pct:     number
  balance_low_pct:     number
  visa_pct:            number
  mastercard_pct:      number
  amex_pct:            number
  discover_pct:        number
}

interface SeedProgress {
  phase: 'idle' | 'cardholders' | 'accounts' | 'cards' | 'kafka' | 'complete'
  count: number
  total: number
}

// ── Constants ──────────────────────────────────────────────────────────────────

const DEFAULT: SeedConfig = {
  cardholders: 1000,
  accounts_per_holder: '2-3',
  cards_per_account: '1-2',
  balance_high_pct: 20,
  balance_mid_pct: 70,
  balance_low_pct: 10,
  visa_pct: 55,
  mastercard_pct: 28,
  amex_pct: 10,
  discover_pct: 7,
}

const PHASES = ['cardholders', 'accounts', 'cards', 'kafka'] as const
const PHASE_LABEL: Record<string, string> = {
  idle: 'Idle', cardholders: 'Creating cardholders',
  accounts: 'Opening accounts', cards: 'Issuing cards',
  kafka: 'Publishing to Kafka', complete: 'Complete',
}

type SubTab = 'config' | 'progress'

// ── Component ──────────────────────────────────────────────────────────────────

export function AccountGeneratorPage() {
  const { isAdmin, isOperator } = useAuth()
  const [tab, setTab]         = useState<SubTab>('config')
  const [cfg, setCfg]         = useState<SeedConfig>(DEFAULT)
  const [progress, setProgress] = useState<SeedProgress>({ phase: 'idle', count: 0, total: 0 })
  const [runState, setRunState] = useState<'idle' | 'running' | 'complete'>('idle')
  const [error, setError]     = useState('')
  const [busy, setBusy]       = useState(false)
  const wsRef = useRef<WebSocket | null>(null)

  // On mount: fetch current status (to resume if seed already running)
  useEffect(() => {
    if (!isOperator) return
    accountApi.get<SeedProgress>('/api/seed/status').then(r => {
      const p = r.data
      setProgress(p)
      if (p.phase === 'complete') setRunState('complete')
      else if (p.phase !== 'idle') { setRunState('running'); openWs() }
    }).catch(() => {})
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isOperator])

  function getSessionId() {
    return document.cookie.split(';')
      .map(c => c.trim())
      .find(c => c.startsWith('txgen_session='))
      ?.split('=')[1] ?? ''
  }

  function openWs() {
    const sid = getSessionId()
    if (!sid) return
    const base = (import.meta.env.VITE_ACCOUNT_API_URL ?? 'http://localhost:8001').replace(/^http/, 'ws')
    const ws = new WebSocket(`${base}/api/seed/ws/progress?session_id=${sid}`)
    wsRef.current = ws
    ws.onmessage = e => {
      const p: SeedProgress = JSON.parse(e.data)
      setProgress(p)
      if (p.phase === 'complete') { setRunState('complete'); ws.close() }
    }
    ws.onerror = () => ws.close()
  }

  async function handleStart() {
    setBusy(true); setError('')
    try {
      await accountApi.post('/api/seed/start', cfg)
      setRunState('running')
      setTab('progress')
      openWs()
    } catch (err: unknown) {
      const e = err as { response?: { data?: { detail?: string } } }
      setError(e.response?.data?.detail ?? 'Failed to start seed.')
    } finally {
      setBusy(false)
    }
  }

  // Derived progress metrics
  const phaseIdx   = PHASES.indexOf(progress.phase as typeof PHASES[number])
  const phasePct   = progress.total === 0 ? 0 : Math.round((progress.count / progress.total) * 100)
  const overallPct = progress.phase === 'complete' ? 100
    : progress.phase === 'idle' ? 0
    : Math.round(((phaseIdx + phasePct / 100) / PHASES.length) * 100)

  // Estimated totals from config
  const est = {
    cardholders: cfg.cardholders,
    accounts:    cfg.cardholders * 2,
    cards:       cfg.cardholders * 3,
    records:     cfg.cardholders * 6,
  }

  return (
    <div>
      <SectionHead
        title="Account Generator"
        sub="Seed synthetic cardholders, accounts, and cards into MongoDB. Admin role required to start."
      />

      {!isAdmin && (
        <InfoBanner type="warn">
          <svg className="w-4 h-4 flex-shrink-0 text-amber-500 mt-0.5" viewBox="0 0 20 20" fill="currentColor">
            <path fillRule="evenodd" d="M8.485 2.495c.673-1.167 2.357-1.167 3.03 0l6.28 10.875c.673 1.167-.17 2.625-1.516 2.625H3.72c-1.347 0-2.189-1.458-1.515-2.625L8.485 2.495zM10 5a.75.75 0 01.75.75v3.5a.75.75 0 01-1.5 0v-3.5A.75.75 0 0110 5zm0 9a1 1 0 100-2 1 1 0 000 2z" clipRule="evenodd"/>
          </svg>
          Admin role required to start a seed run. You can view status only.
        </InfoBanner>
      )}

      <div className="mt-5">
        <SubTabs
          tabs={[{ id: 'config', label: 'Configuration' }, { id: 'progress', label: 'Progress' }]}
          active={tab}
          onChange={setTab}
        />
      </div>

      {/* ── Config tab ─────────────────────────────────────────────────── */}
      {tab === 'config' && (
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">

          {/* Left: volume + ranges */}
          <Card className="p-6 space-y-5">
            <h3 className="text-sm font-medium text-gray-700">Volume</h3>

            <div>
              <label className="block text-xs font-medium text-gray-600 mb-1.5">Cardholders</label>
              <input type="number" value={cfg.cardholders} min={100} max={100000}
                disabled={!isAdmin || runState === 'running'}
                onChange={e => setCfg(c => ({ ...c, cardholders: +e.target.value }))}
                className="w-full px-3 py-2 text-sm border border-gray-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500 disabled:bg-gray-50 disabled:text-gray-400"
              />
              <p className="text-xs text-gray-400 mt-1">
                → ~{est.accounts.toLocaleString()} accounts · ~{est.cards.toLocaleString()} cards · ~{est.records.toLocaleString()} Kafka events
              </p>
            </div>

            <div className="grid grid-cols-2 gap-3">
              {([
                ['accounts_per_holder', 'Accounts / holder', '2-3'],
                ['cards_per_account',   'Cards / account',   '1-2'],
              ] as const).map(([key, label, ph]) => (
                <div key={key}>
                  <label className="block text-xs font-medium text-gray-600 mb-1.5">{label}</label>
                  <input type="text" value={cfg[key]} placeholder={ph}
                    disabled={!isAdmin || runState === 'running'}
                    onChange={e => setCfg(c => ({ ...c, [key]: e.target.value }))}
                    className="w-full px-3 py-2 text-sm border border-gray-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500 disabled:bg-gray-50 disabled:text-gray-400"
                  />
                </div>
              ))}
            </div>

            <div>
              <p className="text-xs font-medium text-gray-600 mb-2">Balance distribution (%)</p>
              <div className="grid grid-cols-3 gap-3">
                {([
                  ['balance_high_pct', 'High'],
                  ['balance_mid_pct',  'Mid'],
                  ['balance_low_pct',  'Low'],
                ] as const).map(([key, label]) => (
                  <div key={key}>
                    <label className="block text-xs text-gray-500 mb-1">{label}</label>
                    <input type="number" value={cfg[key]} min={0} max={100}
                      disabled={!isAdmin || runState === 'running'}
                      onChange={e => setCfg(c => ({ ...c, [key]: +e.target.value }))}
                      className="w-full px-3 py-2 text-sm border border-gray-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500 disabled:bg-gray-50 disabled:text-gray-400"
                    />
                  </div>
                ))}
              </div>
              {/* Stacked bar preview */}
              <div className="mt-2 h-2 rounded-full overflow-hidden flex">
                <div className="bg-emerald-500 transition-all duration-300" style={{ width: `${cfg.balance_high_pct}%` }}/>
                <div className="bg-amber-400 transition-all duration-300"  style={{ width: `${cfg.balance_mid_pct}%` }}/>
                <div className="bg-red-400 transition-all duration-300"    style={{ width: `${cfg.balance_low_pct}%` }}/>
              </div>
              <div className="flex gap-4 mt-1 text-xs text-gray-400">
                <span className="flex items-center gap-1"><span className="w-2 h-2 rounded-full bg-emerald-500 inline-block"/>High</span>
                <span className="flex items-center gap-1"><span className="w-2 h-2 rounded-full bg-amber-400 inline-block"/>Mid</span>
                <span className="flex items-center gap-1"><span className="w-2 h-2 rounded-full bg-red-400 inline-block"/>Low</span>
              </div>
            </div>
          </Card>

          {/* Right: card schemes + start */}
          <Card className="p-6 space-y-5">
            <h3 className="text-sm font-medium text-gray-700">Card Scheme Mix (%)</h3>
            <div className="grid grid-cols-2 gap-3">
              {([
                ['visa_pct', 'Visa'],
                ['mastercard_pct', 'Mastercard'],
                ['amex_pct', 'Amex'],
                ['discover_pct', 'Discover'],
              ] as const).map(([key, label]) => (
                <div key={key}>
                  <label className="block text-xs text-gray-500 mb-1">{label}</label>
                  <input type="number" value={cfg[key]} min={0} max={100}
                    disabled={!isAdmin || runState === 'running'}
                    onChange={e => setCfg(c => ({ ...c, [key]: +e.target.value }))}
                    className="w-full px-3 py-2 text-sm border border-gray-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500 disabled:bg-gray-50 disabled:text-gray-400"
                  />
                </div>
              ))}
            </div>
            {/* Stacked bar preview */}
            <div className="h-2 rounded-full overflow-hidden flex">
              <div className="bg-blue-500  transition-all duration-300" style={{ width: `${cfg.visa_pct}%` }}/>
              <div className="bg-red-500   transition-all duration-300" style={{ width: `${cfg.mastercard_pct}%` }}/>
              <div className="bg-indigo-500 transition-all duration-300" style={{ width: `${cfg.amex_pct}%` }}/>
              <div className="bg-orange-500 transition-all duration-300" style={{ width: `${cfg.discover_pct}%` }}/>
            </div>

            {error && (
              <p className="text-xs text-red-600 bg-red-50 border border-red-200 rounded-lg px-3 py-2">{error}</p>
            )}

            <button
              onClick={handleStart}
              disabled={!isAdmin || runState === 'running' || busy}
              className="w-full py-2.5 text-sm font-medium rounded-xl transition-colors focus:outline-none focus:ring-2 focus:ring-blue-500 focus:ring-offset-2 flex items-center justify-center gap-2
                bg-blue-600 hover:bg-blue-700 text-white
                disabled:bg-gray-100 disabled:text-gray-400 disabled:cursor-not-allowed"
            >
              {busy && <Spinner />}
              {busy ? 'Starting…' : runState === 'running' ? 'Seed in progress…' : runState === 'complete' ? 'Re-seed' : 'Start seed'}
            </button>

            {runState === 'complete' && (
              <InfoBanner type="success">
                <svg className="w-4 h-4 text-emerald-500 flex-shrink-0" viewBox="0 0 20 20" fill="currentColor">
                  <path fillRule="evenodd" d="M10 18a8 8 0 100-16 8 8 0 000 16zm3.857-9.809a.75.75 0 00-1.214-.882l-3.483 4.79-1.88-1.88a.75.75 0 10-1.06 1.061l2.5 2.5a.75.75 0 001.137-.089l4-5.5z" clipRule="evenodd"/>
                </svg>
                Seed complete — PAN pool ready for transaction generation.
              </InfoBanner>
            )}
          </Card>
        </div>
      )}

      {/* ── Progress tab ───────────────────────────────────────────────── */}
      {tab === 'progress' && (
        <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">

          {/* Stats */}
          <div className="space-y-4">
            <StatCard label="Status" value={PHASE_LABEL[progress.phase] ?? progress.phase}
              accent={runState === 'complete' ? 'green' : runState === 'running' ? 'blue' : 'gray'} />
            <StatCard label="Overall progress" value={`${overallPct}%`}
              sub={`Phase ${Math.max(0, phaseIdx + 1)} of ${PHASES.length}`}
              accent={runState === 'complete' ? 'green' : 'blue'} />
            {progress.total > 0 && (
              <StatCard label="Current phase" value={`${progress.count.toLocaleString()} / ${progress.total.toLocaleString()}`}
                sub={PHASE_LABEL[progress.phase]} accent="blue" />
            )}
          </div>

          {/* Phase bars */}
          <Card className="p-6 lg:col-span-2 space-y-4">
            <div className="flex items-center justify-between mb-1">
              <h3 className="text-sm font-medium text-gray-700">Phase breakdown</h3>
              <span className={`text-xs font-medium px-2 py-0.5 rounded-full ${
                runState === 'complete' ? 'bg-emerald-100 text-emerald-700'
                : runState === 'running' ? 'bg-blue-100 text-blue-700'
                : 'bg-gray-100 text-gray-500'
              }`}>
                {runState === 'complete' ? 'Done' : runState === 'running' ? 'Running' : 'Idle'}
              </span>
            </div>

            {/* Overall bar */}
            <div className="space-y-1.5">
              <div className="flex justify-between text-xs text-gray-500">
                <span>Overall</span><span>{overallPct}%</span>
              </div>
              <ProgressBar value={overallPct} max={100}
                color={runState === 'complete' ? 'green' : 'blue'}
                animated={runState === 'running'} />
            </div>

            <div className="border-t border-gray-100 pt-4 space-y-4">
              {PHASES.map((phase, i) => {
                const curIdx = PHASES.indexOf(progress.phase as typeof PHASES[number])
                const done = progress.phase === 'complete' || i < curIdx
                const current = phase === progress.phase
                const pct = current ? phasePct : done ? 100 : 0
                return (
                  <div key={phase} className="space-y-1.5">
                    <div className="flex justify-between text-xs">
                      <span className={current ? 'text-blue-600 font-medium' : done ? 'text-gray-700' : 'text-gray-400'}>
                        {PHASE_LABEL[phase]}
                      </span>
                      <span className={done ? 'text-emerald-600' : current ? 'text-blue-600' : 'text-gray-300'}>
                        {done ? '✓' : current ? `${progress.count.toLocaleString()} / ${progress.total.toLocaleString()}` : '—'}
                      </span>
                    </div>
                    <ProgressBar value={pct} max={100}
                      color={done ? 'green' : 'blue'}
                      animated={current && runState === 'running'} />
                  </div>
                )
              })}
            </div>
          </Card>
        </div>
      )}
    </div>
  )
}
