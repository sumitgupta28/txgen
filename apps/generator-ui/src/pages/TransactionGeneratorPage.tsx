/**
 * apps/generator-ui/src/pages/TransactionGeneratorPage.tsx
 *
 * Control panel for ISO 8583 transaction emission scenarios.
 * Operators + admins can start/stop/adjust. Viewers see read-only status.
 *
 * API surface (txgen-api :8002):
 *   POST  /api/scenarios/start
 *   POST  /api/scenarios/stop
 *   PATCH /api/domains/{domain}/tps
 *   GET   /api/scenarios/status
 */

import { useEffect, useRef, useState } from 'react'
import { txgenApi } from '../api/client'
import { useAuth } from '../context/AuthContext'
import {
  Card, InfoBanner, SectionHead, Spinner, StatCard, SubTabs,
} from '../components/ui'

// ── Types ─────────────────────────────────────────────────────────────────────

interface ScenarioConfig {
  name:         string
  domain:       string
  tps:          number
  failure_rate: number
  fraud_rate:   number
  response_ms:  number
}

interface ScenarioStatus {
  running:  boolean
  tps:      number
  scenario: string | null
  emitted:  number
}

type SubTab = 'builder' | 'controls' | 'presets'

// ── Constants ──────────────────────────────────────────────────────────────────

const DOMAINS = [
  { value: 'auth',       label: 'Auth',       desc: 'MTI 0100/0110 — authorisation requests' },
  { value: 'settlement', label: 'Settlement',  desc: 'MTI 0200/0210 — settlement captures' },
  { value: 'dispute',    label: 'Dispute',     desc: 'MTI 0400/0410 — chargebacks & reversals' },
]

const PRESETS: (ScenarioConfig & { description: string })[] = [
  { name: 'normal-traffic',  domain: 'auth',       tps: 50,  failure_rate: 0.03, fraud_rate: 0.02, response_ms: 300,  description: 'Baseline steady-state traffic' },
  { name: 'fiserv-spike',    domain: 'auth',       tps: 250, failure_rate: 0.08, fraud_rate: 0.05, response_ms: 800,  description: 'High TPS spike with degraded response time' },
  { name: 'fraud-surge',     domain: 'auth',       tps: 80,  failure_rate: 0.05, fraud_rate: 0.25, response_ms: 400,  description: 'Elevated fraud pattern for RAG testing' },
  { name: 'settlement-bulk', domain: 'settlement', tps: 120, failure_rate: 0.01, fraud_rate: 0.00, response_ms: 200,  description: 'End-of-day settlement batch' },
  { name: 'dispute-wave',    domain: 'dispute',    tps: 30,  failure_rate: 0.02, fraud_rate: 0.00, response_ms: 600,  description: 'Chargeback surge — integrity checker stress test' },
]

const DEFAULT_CONFIG: ScenarioConfig = {
  name: 'scenario-1', domain: 'auth', tps: 50, failure_rate: 0.03, fraud_rate: 0.07, response_ms: 500,
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function buildPreviewMessage(cfg: ScenarioConfig) {
  const de39 = Math.random() < cfg.failure_rate ? '05' : '00'
  return JSON.stringify({
    mti: '0110', bitmap: [],
    de: {
      '2': '4111 **** **** 1234', '3': '000000', '4': '000000012500',
      '11': String(Math.floor(Math.random() * 900000) + 100000),
      '39': de39, '41': 'TERM4821', '49': '840',
      '63': (Math.random() * 0.95 + 0.05).toFixed(2),
    },
    _meta: { scenario: cfg.name, domain: cfg.domain, response_ms: cfg.response_ms },
  }, null, 2)
}

// ── Component ──────────────────────────────────────────────────────────────────

export function TransactionGeneratorPage() {
  const { isOperator } = useAuth()
  const [tab, setTab]           = useState<SubTab>('builder')
  const [cfg, setCfg]           = useState<ScenarioConfig>(DEFAULT_CONFIG)
  const [status, setStatus]     = useState<ScenarioStatus>({ running: false, tps: 0, scenario: null, emitted: 0 })
  const [error, setError]       = useState('')
  const [busy, setBusy]         = useState(false)
  const [preview, setPreview]   = useState('')
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null)

  // Poll scenario status every 2 s
  useEffect(() => {
    const fetchStatus = () => {
      txgenApi.get<ScenarioStatus>('/api/scenarios/status').then(r => setStatus(r.data)).catch(() => {})
    }
    fetchStatus()
    pollRef.current = setInterval(fetchStatus, 2000)
    return () => { if (pollRef.current) clearInterval(pollRef.current) }
  }, [])

  // Refresh preview JSON when config changes
  useEffect(() => {
    setPreview(buildPreviewMessage(cfg))
  }, [cfg])

  async function handleStart() {
    setBusy(true); setError('')
    try {
      await txgenApi.post('/api/scenarios/start', cfg)
    } catch (err: unknown) {
      const e = err as { response?: { data?: { detail?: string } } }
      setError(e.response?.data?.detail ?? 'Failed to start scenario.')
    } finally {
      setBusy(false)
    }
  }

  async function handleStop() {
    setBusy(true)
    try { await txgenApi.post('/api/scenarios/stop') }
    catch { /* ignore */ }
    finally { setBusy(false) }
  }

  async function updateTps(tps: number) {
    setCfg(c => ({ ...c, tps }))
    if (status.running) {
      try { await txgenApi.patch(`/api/domains/${cfg.domain}/tps`, undefined, { params: { tps } }) }
      catch { /* non-critical */ }
    }
  }

  function loadPreset(p: typeof PRESETS[number]) {
    const { description: _, ...conf } = p
    setCfg(conf)
    setTab('builder')
  }

  return (
    <div>
      <SectionHead
        title="Transaction Generator"
        sub="Configure and run ISO 8583 emission scenarios. Operators and admins can start and stop."
      />

      {!isOperator && (
        <InfoBanner type="info">
          <svg className="w-4 h-4 text-blue-500 flex-shrink-0 mt-0.5" viewBox="0 0 20 20" fill="currentColor">
            <path fillRule="evenodd" d="M18 10a8 8 0 11-16 0 8 8 0 0116 0zm-7-4a1 1 0 11-2 0 1 1 0 012 0zM9 9a.75.75 0 000 1.5h.253a.25.25 0 01.244.304l-.459 2.066A1.75 1.75 0 0010.747 15H11a.75.75 0 000-1.5h-.253a.25.25 0 01-.244-.304l.459-2.066A1.75 1.75 0 009.253 9H9z" clipRule="evenodd"/>
          </svg>
          Viewer access — scenario controls are read-only.
        </InfoBanner>
      )}

      {/* Live status bar */}
      {status.running && (
        <div className="mt-4 mb-2 flex items-center gap-3 px-4 py-3 bg-blue-50 border border-blue-200 rounded-xl text-sm text-blue-800">
          <span className="relative flex h-2.5 w-2.5">
            <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-blue-400 opacity-75"/>
            <span className="relative inline-flex rounded-full h-2.5 w-2.5 bg-blue-600"/>
          </span>
          <span className="font-medium">Running:</span>
          <span>{status.scenario}</span>
          <span className="text-blue-600">·</span>
          <span>{status.tps} TPS</span>
          <span className="text-blue-600">·</span>
          <span>{status.emitted.toLocaleString()} messages emitted</span>
        </div>
      )}

      <div className="mt-5">
        <SubTabs
          tabs={[
            { id: 'builder',  label: 'Scenario Builder' },
            { id: 'controls', label: 'Domain Controls' },
            { id: 'presets',  label: 'Saved Presets' },
          ]}
          active={tab}
          onChange={setTab}
        />
      </div>

      {/* ── Scenario Builder ───────────────────────────────────────────── */}
      {tab === 'builder' && (
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">

          {/* Left: form */}
          <Card className="p-6 space-y-5">
            <div>
              <label className="block text-xs font-medium text-gray-600 mb-1.5">Scenario name</label>
              <input type="text" value={cfg.name}
                disabled={!isOperator || status.running}
                onChange={e => setCfg(c => ({ ...c, name: e.target.value }))}
                className="w-full px-3 py-2 text-sm border border-gray-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500 disabled:bg-gray-50 disabled:text-gray-400"
              />
            </div>

            <div>
              <label className="block text-xs font-medium text-gray-600 mb-2">Domain</label>
              <div className="space-y-2">
                {DOMAINS.map(d => (
                  <label key={d.value} className={`flex items-start gap-3 p-3 border rounded-xl cursor-pointer transition-colors ${
                    cfg.domain === d.value ? 'border-blue-300 bg-blue-50' : 'border-gray-200 hover:border-gray-300'
                  } ${(!isOperator || status.running) ? 'opacity-50 pointer-events-none' : ''}`}>
                    <input type="radio" value={d.value} checked={cfg.domain === d.value}
                      onChange={() => setCfg(c => ({ ...c, domain: d.value }))}
                      className="mt-0.5" />
                    <div>
                      <p className="text-sm font-medium text-gray-800">{d.label}</p>
                      <p className="text-xs text-gray-500">{d.desc}</p>
                    </div>
                  </label>
                ))}
              </div>
            </div>

            {/* TPS slider */}
            <div>
              <div className="flex justify-between items-center mb-1.5">
                <label className="text-xs font-medium text-gray-600">TPS</label>
                <span className="text-sm font-semibold text-blue-600">{cfg.tps}</span>
              </div>
              <input type="range" min={1} max={500} value={cfg.tps}
                disabled={!isOperator}
                onChange={e => updateTps(+e.target.value)}
                className="w-full accent-blue-600"
              />
              <div className="flex justify-between text-xs text-gray-400 mt-0.5">
                <span>1</span><span>500</span>
              </div>
            </div>

            {/* Failure & fraud */}
            <div className="grid grid-cols-2 gap-4">
              <div>
                <div className="flex justify-between items-center mb-1.5">
                  <label className="text-xs font-medium text-gray-600">Failure rate</label>
                  <span className="text-xs font-semibold text-red-600">{(cfg.failure_rate * 100).toFixed(0)}%</span>
                </div>
                <input type="range" min={0} max={0.5} step={0.01} value={cfg.failure_rate}
                  disabled={!isOperator || status.running}
                  onChange={e => setCfg(c => ({ ...c, failure_rate: +e.target.value }))}
                  className="w-full accent-red-500"
                />
              </div>
              <div>
                <div className="flex justify-between items-center mb-1.5">
                  <label className="text-xs font-medium text-gray-600">Fraud rate</label>
                  <span className="text-xs font-semibold text-amber-600">{(cfg.fraud_rate * 100).toFixed(0)}%</span>
                </div>
                <input type="range" min={0} max={0.5} step={0.01} value={cfg.fraud_rate}
                  disabled={!isOperator || status.running}
                  onChange={e => setCfg(c => ({ ...c, fraud_rate: +e.target.value }))}
                  className="w-full accent-amber-500"
                />
              </div>
            </div>

            <div>
              <div className="flex justify-between items-center mb-1.5">
                <label className="text-xs font-medium text-gray-600">Avg response (ms)</label>
                <span className="text-xs font-semibold text-gray-700">{cfg.response_ms}ms</span>
              </div>
              <input type="range" min={50} max={2000} step={50} value={cfg.response_ms}
                disabled={!isOperator || status.running}
                onChange={e => setCfg(c => ({ ...c, response_ms: +e.target.value }))}
                className="w-full accent-blue-600"
              />
            </div>

            {error && <p className="text-xs text-red-600 bg-red-50 border border-red-200 rounded-lg px-3 py-2">{error}</p>}

            <div className="flex gap-3">
              <button
                onClick={status.running ? handleStop : handleStart}
                disabled={!isOperator || busy}
                className={`flex-1 py-2.5 text-sm font-medium rounded-xl transition-colors focus:outline-none focus:ring-2 focus:ring-offset-2 flex items-center justify-center gap-2
                  ${status.running
                    ? 'bg-red-600 hover:bg-red-700 text-white focus:ring-red-500'
                    : 'bg-blue-600 hover:bg-blue-700 text-white focus:ring-blue-500'
                  }
                  disabled:bg-gray-100 disabled:text-gray-400 disabled:cursor-not-allowed`}
              >
                {busy && <Spinner />}
                {status.running ? 'Stop scenario' : busy ? 'Starting…' : 'Start scenario'}
              </button>
            </div>
          </Card>

          {/* Right: ISO-JSON preview */}
          <Card className="p-6">
            <h3 className="text-sm font-medium text-gray-700 mb-3">ISO-JSON preview</h3>
            <p className="text-xs text-gray-400 mb-3">
              Representative message shape emitted to Kafka topic <code className="bg-gray-100 px-1 rounded">iso-{cfg.domain}</code>
            </p>
            <pre className="text-xs text-gray-700 bg-gray-50 border border-gray-100 rounded-xl p-4 overflow-auto max-h-96 font-mono leading-relaxed">
              {preview}
            </pre>
          </Card>
        </div>
      )}

      {/* ── Domain Controls ────────────────────────────────────────────── */}
      {tab === 'controls' && (
        <div className="space-y-4">
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-4 mb-6">
            <StatCard label="Status"   value={status.running ? 'Running' : 'Stopped'} accent={status.running ? 'green' : 'gray'} />
            <StatCard label="TPS"      value={status.running ? status.tps : '—'} accent={status.running ? 'blue' : 'gray'} />
            <StatCard label="Emitted"  value={status.emitted.toLocaleString()} sub="total messages" />
          </div>

          {DOMAINS.map(d => (
            <Card key={d.value} className="p-5">
              <div className="flex items-center justify-between flex-wrap gap-4">
                <div>
                  <p className="text-sm font-semibold text-gray-800">{d.label}</p>
                  <p className="text-xs text-gray-500 mt-0.5">{d.desc}</p>
                </div>
                <div className="flex items-center gap-4">
                  <div className="flex items-center gap-2">
                    <label className="text-xs text-gray-500">TPS</label>
                    <input type="number" min={1} max={500} defaultValue={50}
                      disabled={!isOperator}
                      onBlur={e => { if (status.running && cfg.domain === d.value) updateTps(+e.target.value) }}
                      className="w-20 px-2 py-1.5 text-sm border border-gray-200 rounded-lg text-center focus:outline-none focus:ring-2 focus:ring-blue-500 disabled:bg-gray-50"
                    />
                  </div>
                  <span className={`text-xs px-2 py-0.5 rounded-full font-medium ${
                    status.running && cfg.domain === d.value
                      ? 'bg-emerald-100 text-emerald-700'
                      : 'bg-gray-100 text-gray-500'
                  }`}>
                    {status.running && cfg.domain === d.value ? 'Active' : 'Idle'}
                  </span>
                </div>
              </div>
            </Card>
          ))}
        </div>
      )}

      {/* ── Presets ────────────────────────────────────────────────────── */}
      {tab === 'presets' && (
        <div className="space-y-3">
          {PRESETS.map(p => (
            <Card key={p.name} className="p-5">
              <div className="flex items-start justify-between gap-4 flex-wrap">
                <div className="space-y-1 flex-1">
                  <div className="flex items-center gap-2">
                    <p className="text-sm font-semibold text-gray-800 font-mono">{p.name}</p>
                    <span className="text-xs px-1.5 py-0.5 bg-gray-100 text-gray-600 rounded font-medium capitalize">{p.domain}</span>
                  </div>
                  <p className="text-xs text-gray-500">{p.description}</p>
                  <div className="flex gap-4 pt-1 text-xs text-gray-400">
                    <span>{p.tps} TPS</span>
                    <span>{(p.failure_rate * 100).toFixed(0)}% fail</span>
                    <span>{(p.fraud_rate * 100).toFixed(0)}% fraud</span>
                    <span>{p.response_ms}ms</span>
                  </div>
                </div>
                <button
                  onClick={() => loadPreset(p)}
                  disabled={!isOperator}
                  className="px-4 py-2 text-sm font-medium bg-blue-50 hover:bg-blue-100 text-blue-700 rounded-lg transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
                >
                  Load
                </button>
              </div>
            </Card>
          ))}
        </div>
      )}
    </div>
  )
}
