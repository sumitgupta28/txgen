/**
 * apps/generator-ui/src/pages/DashboardsPage.tsx
 *
 * RAG-based operational intelligence dashboard.
 * Displays rag_metrics from TimescaleDB (via mock/polling) and links
 * to the five auto-provisioned Grafana dashboards.
 *
 * Three sub-tabs:
 *   RAG Metrics   — full rag_metrics table, sorted Red-first
 *   Top Acquirers — horizontal bar charts per domain
 *   Grafana Links — direct links to provisioned dashboards
 */

import { useEffect, useState } from 'react'
import { SectionHead, Card, RagBadge, SubTabs } from '../components/ui'

// ── Types ─────────────────────────────────────────────────────────────────────

interface RagMetric {
  id:          string
  domain:      string
  metric_name: string
  acquirer_id: string
  value:       number
  rag:         'R' | 'A' | 'G'
  window_sec:  number
  evaluated_at: string
}

type SubTab = 'metrics' | 'acquirers' | 'grafana'

// ── Grafana dashboards ────────────────────────────────────────────────────────

const GRAFANA_DASHBOARDS = [
  { title: 'Auth Approval Rate',      desc: 'DE39 breakdown by acquirer — 60-second tumbling windows', path: '/d/auth-approval' },
  { title: 'Settlement Throughput',   desc: 'Settlement TPS and capture rate by acquirer',             path: '/d/settlement' },
  { title: 'Dispute & Chargeback',    desc: 'Chargeback rate and dispute resolution latency',          path: '/d/disputes' },
  { title: 'Integrity Violations',    desc: 'Referential integrity rule breach counts over time',      path: '/d/integrity' },
  { title: 'RAG Overview',            desc: 'Red/Amber/Green traffic light across all acquirers',     path: '/d/rag-overview' },
]

// ── Mock data generators ──────────────────────────────────────────────────────

const ACQUIRERS = ['ACQ1.net', 'ACQ2.net', 'ACQ3.net', 'ACQ4.net', 'FISERV', 'BOFA', 'CHASE', 'WFC']
const DOMAINS   = ['auth', 'settlement', 'dispute']
const METRICS   = ['approval_rate', 'tps', 'avg_response_ms', 'fraud_rate']

function uid() { return Math.random().toString(36).slice(2, 9) }

function makeRag(value: number, metric: string): 'R' | 'A' | 'G' {
  if (metric === 'approval_rate') {
    return value >= 0.95 ? 'G' : value >= 0.85 ? 'A' : 'R'
  }
  if (metric === 'fraud_rate') {
    return value < 0.03 ? 'G' : value < 0.08 ? 'A' : 'R'
  }
  return value < 500 ? 'G' : value < 1000 ? 'A' : 'R'
}

function generateMetrics(): RagMetric[] {
  const out: RagMetric[] = []
  for (const acquirer of ACQUIRERS) {
    for (const domain of DOMAINS) {
      for (const metric of METRICS) {
        let value = 0
        if (metric === 'approval_rate') value = Math.random() * 0.3 + 0.7
        else if (metric === 'tps')       value = Math.random() * 200 + 10
        else if (metric === 'avg_response_ms') value = Math.random() * 1200 + 100
        else                             value = Math.random() * 0.15
        out.push({
          id: uid(), domain, metric_name: metric, acquirer_id: acquirer,
          value, rag: makeRag(value, metric), window_sec: 60,
          evaluated_at: new Date().toISOString(),
        })
      }
    }
  }
  // Sort R first, then A, then G
  return out.sort((a, b) => {
    const ord = { R: 0, A: 1, G: 2 }
    return ord[a.rag] - ord[b.rag]
  })
}

function formatValue(metric: string, value: number) {
  if (metric === 'approval_rate') return `${(value * 100).toFixed(1)}%`
  if (metric === 'fraud_rate')    return `${(value * 100).toFixed(2)}%`
  if (metric === 'tps')           return value.toFixed(0)
  return `${value.toFixed(0)}ms`
}

// ── Component ──────────────────────────────────────────────────────────────────

export function DashboardsPage() {
  const [subTab, setSubTab]   = useState<SubTab>('metrics')
  const [metrics, setMetrics] = useState<RagMetric[]>([])
  const [domainFilter, setDomainFilter] = useState<string>('all')
  const [ragFilter, setRagFilter]       = useState<string>('all')

  useEffect(() => {
    setMetrics(generateMetrics())
    const interval = setInterval(() => setMetrics(generateMetrics()), 15000)
    return () => clearInterval(interval)
  }, [])

  const filtered = metrics.filter(m => {
    if (domainFilter !== 'all' && m.domain !== domainFilter) return false
    if (ragFilter    !== 'all' && m.rag    !== ragFilter)    return false
    return true
  })

  // Top-10 acquirers by auth approval rate
  const authApproval = metrics
    .filter(m => m.domain === 'auth' && m.metric_name === 'approval_rate')
    .sort((a, b) => b.value - a.value)
    .slice(0, 10)

  const maxApproval = Math.max(...authApproval.map(m => m.value), 0.01)

  return (
    <div>
      <SectionHead
        title="Dashboards"
        sub="RAG-classified operational metrics — 60-second tumbling windows from TimescaleDB."
      />

      <SubTabs
        tabs={[
          { id: 'metrics',   label: 'RAG Metrics' },
          { id: 'acquirers', label: 'Top Acquirers' },
          { id: 'grafana',   label: 'Grafana' },
        ]}
        active={subTab}
        onChange={setSubTab}
      />

      {/* ── RAG Metrics ──────────────────────────────────────────────── */}
      {subTab === 'metrics' && (
        <div>
          {/* Filters */}
          <div className="flex gap-3 mb-4 flex-wrap">
            <div className="flex gap-1">
              {['all', 'auth', 'settlement', 'dispute'].map(d => (
                <button key={d} onClick={() => setDomainFilter(d)}
                  className={`px-3 py-1.5 text-xs font-medium rounded-lg capitalize transition-colors ${
                    domainFilter === d ? 'bg-blue-100 text-blue-700' : 'bg-white border border-gray-200 text-gray-500 hover:border-gray-300'
                  }`}>{d}</button>
              ))}
            </div>
            <div className="flex gap-1">
              {['all', 'R', 'A', 'G'].map(r => (
                <button key={r} onClick={() => setRagFilter(r)}
                  className={`px-3 py-1.5 text-xs font-medium rounded-lg transition-colors ${
                    ragFilter === r
                      ? r === 'R' ? 'bg-red-100 text-red-700'
                        : r === 'A' ? 'bg-amber-100 text-amber-700'
                        : r === 'G' ? 'bg-emerald-100 text-emerald-700'
                        : 'bg-blue-100 text-blue-700'
                      : 'bg-white border border-gray-200 text-gray-500 hover:border-gray-300'
                  }`}>{r === 'all' ? 'All RAG' : r}</button>
              ))}
            </div>
            <span className="ml-auto text-xs text-gray-400 self-center">{filtered.length} rows</span>
          </div>

          <Card className="overflow-hidden">
            <div className="overflow-auto max-h-[65vh]">
              <table className="w-full text-xs">
                <thead className="sticky top-0 bg-gray-50 border-b border-gray-100">
                  <tr>
                    <th className="text-left px-5 py-3 text-gray-500 font-medium">Domain</th>
                    <th className="text-left px-5 py-3 text-gray-500 font-medium">Metric</th>
                    <th className="text-left px-5 py-3 text-gray-500 font-medium">Acquirer</th>
                    <th className="text-right px-5 py-3 text-gray-500 font-medium">Value</th>
                    <th className="text-center px-5 py-3 text-gray-500 font-medium">RAG</th>
                    <th className="text-center px-5 py-3 text-gray-500 font-medium">Window</th>
                    <th className="text-right px-5 py-3 text-gray-500 font-medium">Evaluated</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-50">
                  {filtered.map(m => (
                    <tr key={m.id} className={`hover:bg-gray-50 transition-colors ${m.rag === 'R' ? 'bg-red-50/40' : ''}`}>
                      <td className="px-5 py-2.5">
                        <span className={`text-[10px] font-medium px-1.5 py-0.5 rounded ${
                          m.domain === 'auth' ? 'bg-blue-100 text-blue-700'
                          : m.domain === 'settlement' ? 'bg-purple-100 text-purple-700'
                          : 'bg-orange-100 text-orange-700'
                        }`}>{m.domain}</span>
                      </td>
                      <td className="px-5 py-2.5 text-gray-700 font-mono">{m.metric_name}</td>
                      <td className="px-5 py-2.5 text-gray-600">{m.acquirer_id}</td>
                      <td className="px-5 py-2.5 text-right font-semibold tabular-nums text-gray-800">
                        {formatValue(m.metric_name, m.value)}
                      </td>
                      <td className="px-5 py-2.5 text-center"><RagBadge rag={m.rag} /></td>
                      <td className="px-5 py-2.5 text-center text-gray-500">{m.window_sec}s</td>
                      <td className="px-5 py-2.5 text-right text-gray-400 tabular-nums">
                        {new Date(m.evaluated_at).toLocaleTimeString()}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </Card>
        </div>
      )}

      {/* ── Top Acquirers ─────────────────────────────────────────────── */}
      {subTab === 'acquirers' && (
        <div className="space-y-6">
          <Card className="p-6">
            <h3 className="text-sm font-semibold text-gray-800 mb-1">Auth Approval Rate — Top 10 Acquirers</h3>
            <p className="text-xs text-gray-400 mb-5">60-second window · sorted by rate</p>
            <div className="space-y-3">
              {authApproval.map(m => (
                <div key={m.acquirer_id} className="flex items-center gap-3">
                  <span className="text-xs text-gray-600 w-20 shrink-0 text-right font-mono">{m.acquirer_id}</span>
                  <div className="flex-1 h-6 bg-gray-100 rounded overflow-hidden relative">
                    <div
                      className={`h-full rounded transition-all duration-500 flex items-center pl-2 ${
                        m.rag === 'G' ? 'bg-emerald-500' : m.rag === 'A' ? 'bg-amber-500' : 'bg-red-500'
                      }`}
                      style={{ width: `${(m.value / maxApproval) * 100}%` }}
                    >
                      <span className="text-[10px] text-white font-medium">{formatValue('approval_rate', m.value)}</span>
                    </div>
                  </div>
                  <RagBadge rag={m.rag} />
                </div>
              ))}
            </div>
          </Card>

          {/* RAG breakdown summary */}
          <div className="grid grid-cols-3 gap-4">
            {(['R', 'A', 'G'] as const).map(rag => {
              const cnt = metrics.filter(m => m.rag === rag).length
              return (
                <div key={rag} className={`border rounded-xl p-5 ${
                  rag === 'R' ? 'border-red-200 bg-red-50' : rag === 'A' ? 'border-amber-200 bg-amber-50' : 'border-emerald-200 bg-emerald-50'
                }`}>
                  <div className="flex items-center justify-between mb-1">
                    <RagBadge rag={rag} />
                    <span className={`text-2xl font-bold tabular-nums ${
                      rag === 'R' ? 'text-red-700' : rag === 'A' ? 'text-amber-700' : 'text-emerald-700'
                    }`}>{cnt}</span>
                  </div>
                  <p className="text-xs text-gray-500 mt-2">
                    {rag === 'R' ? 'Critical — immediate attention required'
                      : rag === 'A' ? 'Warning — monitor closely'
                      : 'Healthy — within thresholds'}
                  </p>
                </div>
              )
            })}
          </div>
        </div>
      )}

      {/* ── Grafana links ─────────────────────────────────────────────── */}
      {subTab === 'grafana' && (
        <div className="space-y-3">
          <div className="flex items-center gap-2.5 px-4 py-3 bg-gray-50 border border-gray-200 rounded-xl text-xs text-gray-600 mb-5">
            <svg className="w-4 h-4 text-gray-400" fill="none" stroke="currentColor" strokeWidth={1.5} viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" d="M11.25 11.25l.041-.02a.75.75 0 011.063.852l-.708 2.836a.75.75 0 001.063.853l.041-.021M21 12a9 9 0 11-18 0 9 9 0 0118 0zm-9-3.75h.008v.008H12V8.25z"/>
            </svg>
            Grafana at <code className="bg-white px-1.5 py-0.5 rounded border border-gray-200 mx-1">http://localhost:3000</code> · login <code className="bg-white px-1.5 py-0.5 rounded border border-gray-200 mx-1">admin / admin</code> · datasource TimescaleDB is auto-provisioned.
          </div>

          {GRAFANA_DASHBOARDS.map(d => (
            <Card key={d.title} className="p-5">
              <div className="flex items-center justify-between gap-4">
                <div>
                  <p className="text-sm font-semibold text-gray-800">{d.title}</p>
                  <p className="text-xs text-gray-500 mt-0.5">{d.desc}</p>
                </div>
                <a
                  href={`http://localhost:3000${d.path}`}
                  target="_blank"
                  rel="noreferrer"
                  className="shrink-0 flex items-center gap-1.5 px-4 py-2 text-sm font-medium text-blue-700 bg-blue-50 hover:bg-blue-100 border border-blue-200 rounded-lg transition-colors"
                >
                  Open
                  <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" d="M13.5 6H5.25A2.25 2.25 0 003 8.25v10.5A2.25 2.25 0 005.25 21h10.5A2.25 2.25 0 0018 18.75V10.5m-10.5 6L21 3m0 0h-5.25M21 3v5.25"/>
                  </svg>
                </a>
              </div>
            </Card>
          ))}
        </div>
      )}
    </div>
  )
}
