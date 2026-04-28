/**
 * apps/generator-ui/src/pages/EventFeedPage.tsx
 *
 * Live rolling event feed — connects to the txgen-api WebSocket and displays
 * the last 200 ISO-JSON events in a filterable table.
 *
 * Falls back to mock data if no real session cookie is present (dev/demo mode).
 *
 * WebSocket: ws://localhost:8002/api/ws/events?session_id={txgen_session}
 */

import { useEffect, useRef, useState } from 'react'
import { SectionHead } from '../components/ui'

// ── Types ─────────────────────────────────────────────────────────────────────

interface FeedEvent {
  id:          string
  mti:         string
  acquirer_id: string
  result:      string   // DE39 code
  amount:      number   // USD
  ts:          string   // ISO timestamp
  type:        string   // 'event' | 'ping'
  domain?:     string   // derived from MTI
}

// ── Helpers ───────────────────────────────────────────────────────────────────

const MTI_LABELS: Record<string, { label: string; domain: string }> = {
  '0100': { label: 'Auth Request',  domain: 'auth' },
  '0110': { label: 'Auth Response', domain: 'auth' },
  '0200': { label: 'Settlement',    domain: 'settlement' },
  '0210': { label: 'Settlement Resp', domain: 'settlement' },
  '0400': { label: 'Reversal',      domain: 'dispute' },
  '0410': { label: 'Reversal Resp', domain: 'dispute' },
}

const DE39_LABELS: Record<string, { label: string; ok: boolean }> = {
  '00': { label: 'Approved',         ok: true },
  '05': { label: 'Do Not Honour',    ok: false },
  '51': { label: 'Insufficient Funds', ok: false },
  '54': { label: 'Expired Card',     ok: false },
  '65': { label: 'Exceeds Limit',    ok: false },
  '91': { label: 'Issuer Unavailable', ok: false },
}

function uid() { return Math.random().toString(36).slice(2, 9) }

function mockEvent(): FeedEvent {
  const mtis = Object.keys(MTI_LABELS)
  const mti  = mtis[Math.floor(Math.random() * mtis.length)]
  const codes = ['00', '00', '00', '05', '51', '91']
  const result = codes[Math.floor(Math.random() * codes.length)]
  return {
    id: uid(), mti, acquirer_id: `ACQ${Math.floor(Math.random() * 9 + 1)}.net`,
    result, amount: +(Math.random() * 400 + 1).toFixed(2),
    ts: new Date().toISOString(), type: 'event',
    domain: MTI_LABELS[mti]?.domain ?? 'auth',
  }
}

function getSessionId() {
  return document.cookie.split(';')
    .map(c => c.trim())
    .find(c => c.startsWith('txgen_session='))
    ?.split('=')[1] ?? ''
}

// ── Component ──────────────────────────────────────────────────────────────────

const MAX_EVENTS = 200

export function EventFeedPage() {
  const [events, setEvents]     = useState<FeedEvent[]>([])
  const [filter, setFilter]     = useState<'all' | 'auth' | 'settlement' | 'dispute' | 'errors'>('all')
  const [connected, setConnected] = useState(false)
  const [mockMode, setMockMode] = useState(false)
  const wsRef    = useRef<WebSocket | null>(null)
  const mockRef  = useRef<ReturnType<typeof setInterval> | null>(null)
  const tableRef = useRef<HTMLDivElement | null>(null)

  useEffect(() => {
    const sid = getSessionId()

    if (sid) {
      // Real WebSocket connection
      const base = (import.meta.env.VITE_TXGEN_API_URL ?? 'http://localhost:8002').replace(/^http/, 'ws')
      const ws = new WebSocket(`${base}/api/ws/events?session_id=${sid}`)
      wsRef.current = ws
      ws.onopen  = () => { setConnected(true); setMockMode(false) }
      ws.onclose = () => setConnected(false)
      ws.onerror = () => {
        setConnected(false)
        startMock()
      }
      ws.onmessage = e => {
        const raw = JSON.parse(e.data)
        if (raw.type !== 'event') return
        const ev: FeedEvent = {
          id: uid(), ...raw,
          domain: MTI_LABELS[raw.mti]?.domain ?? 'auth',
        }
        push(ev)
      }
    } else {
      // No session cookie — use mock data
      startMock()
    }

    return () => {
      wsRef.current?.close()
      if (mockRef.current) clearInterval(mockRef.current)
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  function startMock() {
    setMockMode(true)
    // Seed with initial events
    setEvents(Array.from({ length: 20 }, mockEvent))
    mockRef.current = setInterval(() => push(mockEvent()), 800)
  }

  function push(ev: FeedEvent) {
    setEvents(prev => [ev, ...prev].slice(0, MAX_EVENTS))
  }

  const visible = events.filter(e => {
    if (filter === 'errors') return e.result !== '00'
    if (filter === 'all')    return true
    return e.domain === filter
  })

  const approvedCount = events.filter(e => e.result === '00').length
  const failedCount   = events.length - approvedCount

  return (
    <div>
      <div className="flex items-start justify-between flex-wrap gap-4 mb-5">
        <SectionHead
          title="Event Feed"
          sub="Live ISO 8583 messages from the active emission scenario (last 200 events)."
        />
        {/* Connection status */}
        <div className="flex items-center gap-2 text-xs">
          {mockMode ? (
            <span className="flex items-center gap-1.5 px-2.5 py-1 bg-amber-50 border border-amber-200 text-amber-700 rounded-full">
              <span className="w-1.5 h-1.5 rounded-full bg-amber-400"/>Mock data
            </span>
          ) : connected ? (
            <span className="flex items-center gap-1.5 px-2.5 py-1 bg-emerald-50 border border-emerald-200 text-emerald-700 rounded-full">
              <span className="relative flex h-1.5 w-1.5">
                <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-emerald-400 opacity-75"/>
                <span className="relative inline-flex rounded-full h-1.5 w-1.5 bg-emerald-500"/>
              </span>
              Live
            </span>
          ) : (
            <span className="flex items-center gap-1.5 px-2.5 py-1 bg-gray-100 text-gray-500 rounded-full">
              <span className="w-1.5 h-1.5 rounded-full bg-gray-400"/>Disconnected
            </span>
          )}
        </div>
      </div>

      {/* Summary stats */}
      <div className="grid grid-cols-3 gap-3 mb-5">
        <div className="bg-white border border-gray-200 rounded-xl p-4">
          <p className="text-xs text-gray-500">Total events</p>
          <p className="text-2xl font-semibold text-gray-900 tabular-nums">{events.length}</p>
        </div>
        <div className="bg-emerald-50 border border-emerald-200 rounded-xl p-4">
          <p className="text-xs text-gray-500">Approved</p>
          <p className="text-2xl font-semibold text-emerald-700 tabular-nums">{approvedCount}</p>
        </div>
        <div className="bg-red-50 border border-red-200 rounded-xl p-4">
          <p className="text-xs text-gray-500">Failed</p>
          <p className="text-2xl font-semibold text-red-700 tabular-nums">{failedCount}</p>
        </div>
      </div>

      {/* Filter bar */}
      <div className="flex gap-2 mb-4 flex-wrap">
        {(['all', 'auth', 'settlement', 'dispute', 'errors'] as const).map(f => (
          <button
            key={f}
            onClick={() => setFilter(f)}
            className={`px-3 py-1.5 text-xs font-medium rounded-lg transition-colors capitalize ${
              filter === f
                ? f === 'errors' ? 'bg-red-100 text-red-700' : 'bg-blue-100 text-blue-700'
                : 'bg-white border border-gray-200 text-gray-500 hover:border-gray-300'
            }`}
          >
            {f}
            {f === 'errors' && failedCount > 0 && (
              <span className="ml-1.5 bg-red-500 text-white text-[10px] px-1 rounded-full">{failedCount}</span>
            )}
          </button>
        ))}
        <span className="ml-auto text-xs text-gray-400 self-center">{visible.length} events</span>
      </div>

      {/* Table */}
      <div ref={tableRef} className="bg-white border border-gray-200 rounded-2xl overflow-hidden">
        <div className="overflow-auto max-h-[60vh]">
          <table className="w-full text-xs">
            <thead className="sticky top-0 bg-gray-50 border-b border-gray-200">
              <tr>
                <th className="text-left px-4 py-3 text-gray-500 font-medium">MTI</th>
                <th className="text-left px-4 py-3 text-gray-500 font-medium">Acquirer</th>
                <th className="text-left px-4 py-3 text-gray-500 font-medium">Domain</th>
                <th className="text-left px-4 py-3 text-gray-500 font-medium">DE39</th>
                <th className="text-left px-4 py-3 text-gray-500 font-medium">Result</th>
                <th className="text-right px-4 py-3 text-gray-500 font-medium">Amount</th>
                <th className="text-right px-4 py-3 text-gray-500 font-medium">Time</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-50">
              {visible.length === 0 ? (
                <tr>
                  <td colSpan={7} className="px-4 py-16 text-center text-gray-400">
                    Waiting for events…
                  </td>
                </tr>
              ) : visible.map(ev => {
                const de39  = DE39_LABELS[ev.result]
                const mtiMeta = MTI_LABELS[ev.mti]
                const ok    = de39?.ok ?? false
                const time  = new Date(ev.ts).toLocaleTimeString()

                return (
                  <tr key={ev.id} className="hover:bg-gray-50 transition-colors">
                    <td className="px-4 py-2.5">
                      <span className="font-mono text-gray-800">{ev.mti}</span>
                      {mtiMeta && <span className="ml-1.5 text-gray-400">{mtiMeta.label}</span>}
                    </td>
                    <td className="px-4 py-2.5 text-gray-600 font-mono">{ev.acquirer_id}</td>
                    <td className="px-4 py-2.5">
                      <span className={`inline-flex px-1.5 py-0.5 rounded text-[10px] font-medium ${
                        ev.domain === 'auth'       ? 'bg-blue-100 text-blue-700' :
                        ev.domain === 'settlement' ? 'bg-purple-100 text-purple-700' :
                        'bg-orange-100 text-orange-700'
                      }`}>
                        {ev.domain}
                      </span>
                    </td>
                    <td className="px-4 py-2.5 font-mono text-gray-600">{ev.result}</td>
                    <td className="px-4 py-2.5">
                      <span className={`text-[10px] font-medium px-1.5 py-0.5 rounded ${
                        ok ? 'bg-emerald-100 text-emerald-700' : 'bg-red-100 text-red-700'
                      }`}>
                        {de39?.label ?? ev.result}
                      </span>
                    </td>
                    <td className="px-4 py-2.5 text-right font-mono text-gray-700">
                      ${ev.amount.toFixed(2)}
                    </td>
                    <td className="px-4 py-2.5 text-right text-gray-400 tabular-nums">{time}</td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  )
}
