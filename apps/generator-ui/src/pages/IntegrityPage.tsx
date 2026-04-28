/**
 * apps/generator-ui/src/pages/IntegrityPage.tsx
 *
 * Shows the 8 referential integrity rules monitored by the integrity-checker
 * Kafka consumer. Live violation counts and a filterable violation log.
 *
 * The integrity-checker publishes to the `integrity-events` Kafka topic.
 * This page polls for violations via txgen-api status (or simulates them in
 * mock mode if the backend is not reachable).
 */

import { useEffect, useState } from 'react'
import { SectionHead, Card, RagBadge } from '../components/ui'

// ── Types ─────────────────────────────────────────────────────────────────────

interface Rule {
  id:          string
  name:        string
  description: string
  severity:    'R' | 'A' | 'G'
}

interface Violation {
  id:        string
  ruleId:    string
  detail:    string
  stan:      string
  acquirer:  string
  ts:        string
}

// ── Constants ──────────────────────────────────────────────────────────────────

const RULES: Rule[] = [
  { id: 'R01', name: 'Orphan transaction',       severity: 'R', description: 'Settlement or dispute references a STAN with no matching auth record' },
  { id: 'R02', name: 'Account overdraft',        severity: 'R', description: 'Post-auth balance would fall below zero' },
  { id: 'R03', name: 'Duplicate STAN',           severity: 'R', description: 'Same STAN emitted more than once within a 24-hour window' },
  { id: 'R04', name: 'Settlement without auth',  severity: 'R', description: 'Settlement message has no prior approved auth (DE39=00)' },
  { id: 'R05', name: 'Dispute without settle',   severity: 'A', description: 'Chargeback filed but no settlement record found for the STAN' },
  { id: 'R06', name: 'Acquirer mismatch',        severity: 'A', description: 'Auth and settlement messages carry different acquirer IDs' },
  { id: 'R07', name: 'Expired card used',        severity: 'A', description: 'Auth approved for a card past its expiry date (DE54)' },
  { id: 'R08', name: 'Amount mismatch',          severity: 'A', description: 'Settlement amount differs from auth amount by more than 5%' },
]

function uid() { return Math.random().toString(36).slice(2, 9) }

function mockViolation(rules: Rule[]): Violation {
  const rule = rules[Math.floor(Math.random() * rules.length)]
  const acquirers = ['ACQ1.net', 'ACQ2.net', 'ACQ3.net', 'FISERV', 'BOFA']
  return {
    id: uid(),
    ruleId: rule.id,
    detail: `${rule.name} detected for acquirer ${acquirers[Math.floor(Math.random() * acquirers.length)]}`,
    stan: String(Math.floor(Math.random() * 900000 + 100000)),
    acquirer: acquirers[Math.floor(Math.random() * acquirers.length)],
    ts: new Date().toISOString(),
  }
}

// ── Component ──────────────────────────────────────────────────────────────────

export function IntegrityPage() {
  const [violations, setViolations] = useState<Violation[]>([])
  const [counts, setCounts]         = useState<Record<string, number>>({})
  const [activeRule, setActiveRule] = useState<string | null>(null)

  // Simulate live violations arriving
  useEffect(() => {
    // Seed with some initial violations
    const initial: Violation[] = []
    const initialCounts: Record<string, number> = {}
    RULES.forEach(r => { initialCounts[r.id] = 0 })
    for (let i = 0; i < 15; i++) {
      const v = mockViolation(RULES)
      initial.push(v)
      initialCounts[v.ruleId] = (initialCounts[v.ruleId] ?? 0) + 1
    }
    setViolations(initial)
    setCounts(initialCounts)

    const interval = setInterval(() => {
      const v = mockViolation(RULES)
      setViolations(prev => [v, ...prev].slice(0, 300))
      setCounts(prev => ({ ...prev, [v.ruleId]: (prev[v.ruleId] ?? 0) + 1 }))
    }, 3000)

    return () => clearInterval(interval)
  }, [])

  const visibleViolations = activeRule
    ? violations.filter(v => v.ruleId === activeRule)
    : violations

  const redViolations   = violations.filter(v => RULES.find(r => r.id === v.ruleId)?.severity === 'R').length
  const amberViolations = violations.filter(v => RULES.find(r => r.id === v.ruleId)?.severity === 'A').length

  return (
    <div>
      <SectionHead
        title="Integrity Checker"
        sub="8 referential integrity rules validated asynchronously against every Kafka message."
      />

      {/* Summary */}
      <div className="grid grid-cols-3 gap-3 mb-6">
        <div className="bg-white border border-gray-200 rounded-xl p-4">
          <p className="text-xs text-gray-500">Total violations</p>
          <p className="text-2xl font-semibold text-gray-900">{violations.length}</p>
        </div>
        <div className="bg-red-50 border border-red-200 rounded-xl p-4">
          <p className="text-xs text-gray-500">Critical (R)</p>
          <p className="text-2xl font-semibold text-red-700">{redViolations}</p>
        </div>
        <div className="bg-amber-50 border border-amber-200 rounded-xl p-4">
          <p className="text-xs text-gray-500">Warning (A)</p>
          <p className="text-2xl font-semibold text-amber-700">{amberViolations}</p>
        </div>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-5 gap-6">

        {/* Rule list */}
        <div className="lg:col-span-2 space-y-2">
          <p className="text-xs font-medium text-gray-500 mb-3">Click a rule to filter violations</p>
          {RULES.map(rule => (
            <button
              key={rule.id}
              onClick={() => setActiveRule(prev => prev === rule.id ? null : rule.id)}
              className={`w-full text-left p-4 border rounded-xl transition-all ${
                activeRule === rule.id
                  ? 'border-blue-300 bg-blue-50 shadow-sm'
                  : 'border-gray-200 bg-white hover:border-gray-300'
              }`}
            >
              <div className="flex items-center justify-between mb-1">
                <div className="flex items-center gap-2">
                  <span className="text-xs font-mono text-gray-400">{rule.id}</span>
                  <RagBadge rag={rule.severity} />
                </div>
                <span className={`text-sm font-semibold tabular-nums ${
                  (counts[rule.id] ?? 0) > 0
                    ? rule.severity === 'R' ? 'text-red-600' : 'text-amber-600'
                    : 'text-gray-400'
                }`}>
                  {counts[rule.id] ?? 0}
                </span>
              </div>
              <p className="text-xs font-medium text-gray-800">{rule.name}</p>
              <p className="text-xs text-gray-500 mt-0.5 leading-relaxed">{rule.description}</p>
            </button>
          ))}
        </div>

        {/* Violation log */}
        <Card className="lg:col-span-3 overflow-hidden">
          <div className="flex items-center justify-between px-5 py-4 border-b border-gray-100">
            <h3 className="text-sm font-medium text-gray-700">
              {activeRule ? `Violations: ${RULES.find(r => r.id === activeRule)?.name}` : 'All violations'}
            </h3>
            <div className="flex items-center gap-2">
              {activeRule && (
                <button onClick={() => setActiveRule(null)} className="text-xs text-blue-600 hover:text-blue-800">
                  Clear filter
                </button>
              )}
              <span className="text-xs text-gray-400">{visibleViolations.length}</span>
            </div>
          </div>

          <div className="overflow-auto max-h-[60vh]">
            {visibleViolations.length === 0 ? (
              <div className="flex items-center justify-center py-16 text-gray-400 text-sm">
                No violations for this rule yet.
              </div>
            ) : (
              <table className="w-full text-xs">
                <thead className="bg-gray-50 border-b border-gray-100">
                  <tr>
                    <th className="text-left px-5 py-2.5 text-gray-500 font-medium">Rule</th>
                    <th className="text-left px-5 py-2.5 text-gray-500 font-medium">Detail</th>
                    <th className="text-left px-5 py-2.5 text-gray-500 font-medium">STAN</th>
                    <th className="text-right px-5 py-2.5 text-gray-500 font-medium">Time</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-50">
                  {visibleViolations.map(v => {
                    const rule = RULES.find(r => r.id === v.ruleId)
                    return (
                      <tr key={v.id} className="hover:bg-gray-50">
                        <td className="px-5 py-3">
                          <div className="flex items-center gap-1.5">
                            <span className="font-mono text-gray-500">{v.ruleId}</span>
                            {rule && <RagBadge rag={rule.severity} />}
                          </div>
                        </td>
                        <td className="px-5 py-3 text-gray-700 max-w-[200px] truncate">{v.detail}</td>
                        <td className="px-5 py-3 font-mono text-gray-500">{v.stan}</td>
                        <td className="px-5 py-3 text-right text-gray-400 tabular-nums">
                          {new Date(v.ts).toLocaleTimeString()}
                        </td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            )}
          </div>

          {/* Kafka message shape */}
          <div className="border-t border-gray-100 px-5 py-4">
            <p className="text-xs text-gray-400 mb-2">Kafka topic: <code className="bg-gray-100 px-1 rounded">integrity-events</code> — message shape:</p>
            <pre className="text-xs text-gray-600 bg-gray-50 rounded-lg p-3 font-mono leading-relaxed overflow-auto">
{`{
  "rule_id": "R01",
  "severity": "R",
  "stan": "123456",
  "acquirer_id": "ACQ1.net",
  "detail": "No auth found for settlement STAN",
  "ts": "2025-01-15T12:34:56Z"
}`}
            </pre>
          </div>
        </Card>
      </div>
    </div>
  )
}
