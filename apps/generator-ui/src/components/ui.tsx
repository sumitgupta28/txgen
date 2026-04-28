/**
 * apps/generator-ui/src/components/ui.tsx
 *
 * Shared primitive components used across all pages.
 * Import from here so style changes propagate everywhere.
 */

import { type ReactNode } from 'react'

// ── Stat card ──────────────────────────────────────────────────────────────────
export function StatCard({ label, value, sub, accent }: {
  label: string
  value: string | number
  sub?: string
  accent?: 'blue' | 'green' | 'amber' | 'red' | 'gray'
}) {
  const ring = {
    blue:  'border-blue-200 bg-blue-50',
    green: 'border-emerald-200 bg-emerald-50',
    amber: 'border-amber-200 bg-amber-50',
    red:   'border-red-200 bg-red-50',
    gray:  'border-gray-200 bg-white',
  }[accent ?? 'gray']
  const text = {
    blue:  'text-blue-700',
    green: 'text-emerald-700',
    amber: 'text-amber-700',
    red:   'text-red-700',
    gray:  'text-gray-900',
  }[accent ?? 'gray']

  return (
    <div className={`border rounded-xl p-4 ${ring}`}>
      <p className="text-xs text-gray-500 mb-1">{label}</p>
      <p className={`text-2xl font-semibold tabular-nums ${text}`}>{value}</p>
      {sub && <p className="text-xs text-gray-400 mt-0.5">{sub}</p>}
    </div>
  )
}

// ── RAG badge ──────────────────────────────────────────────────────────────────
export function RagBadge({ rag }: { rag: 'R' | 'A' | 'G' | string }) {
  const styles = {
    R: 'bg-red-100 text-red-700 border-red-200',
    A: 'bg-amber-100 text-amber-700 border-amber-200',
    G: 'bg-emerald-100 text-emerald-700 border-emerald-200',
  }[rag] ?? 'bg-gray-100 text-gray-500 border-gray-200'
  const labels = { R: 'Red', A: 'Amber', G: 'Green' } as Record<string, string>
  return (
    <span className={`inline-flex items-center gap-1 text-xs font-medium px-2 py-0.5 rounded-full border ${styles}`}>
      <span className="font-bold">{rag}</span>
      {labels[rag] && <span className="hidden sm:inline">· {labels[rag]}</span>}
    </span>
  )
}

// ── Progress bar ───────────────────────────────────────────────────────────────
export function ProgressBar({ value, max, color = 'blue', animated = false }: {
  value: number
  max: number
  color?: 'blue' | 'green' | 'amber' | 'red'
  animated?: boolean
}) {
  const pct = max === 0 ? 0 : Math.min(100, Math.round((value / max) * 100))
  const track = { blue: 'bg-blue-500', green: 'bg-emerald-500', amber: 'bg-amber-500', red: 'bg-red-500' }[color]
  return (
    <div className="w-full bg-gray-100 rounded-full h-1.5 overflow-hidden">
      <div
        className={`h-full rounded-full transition-all duration-500 ${track} ${animated ? 'animate-pulse' : ''}`}
        style={{ width: `${pct}%` }}
      />
    </div>
  )
}

// ── Card ───────────────────────────────────────────────────────────────────────
export function Card({ children, className = '' }: { children: ReactNode; className?: string }) {
  return (
    <div className={`bg-white border border-gray-200 rounded-2xl ${className}`}>
      {children}
    </div>
  )
}

// ── Section heading ────────────────────────────────────────────────────────────
export function SectionHead({ title, sub }: { title: string; sub?: string }) {
  return (
    <div className="mb-5">
      <h2 className="text-base font-semibold text-gray-900">{title}</h2>
      {sub && <p className="text-sm text-gray-500 mt-0.5">{sub}</p>}
    </div>
  )
}

// ── Sub-tab bar ────────────────────────────────────────────────────────────────
export function SubTabs<T extends string>({ tabs, active, onChange }: {
  tabs: { id: T; label: string }[]
  active: T
  onChange: (id: T) => void
}) {
  return (
    <div className="flex gap-1 p-1 bg-gray-100 rounded-xl w-fit mb-6">
      {tabs.map(t => (
        <button
          key={t.id}
          onClick={() => onChange(t.id)}
          className={`px-4 py-1.5 text-sm font-medium rounded-lg transition-all ${
            active === t.id ? 'bg-white text-gray-900 shadow-sm' : 'text-gray-500 hover:text-gray-700'
          }`}
        >
          {t.label}
        </button>
      ))}
    </div>
  )
}

// ── Empty state ────────────────────────────────────────────────────────────────
export function EmptyState({ icon, message }: { icon: ReactNode; message: string }) {
  return (
    <div className="flex flex-col items-center justify-center py-16 text-gray-400 gap-3">
      <div className="w-10 h-10 opacity-40">{icon}</div>
      <p className="text-sm">{message}</p>
    </div>
  )
}

// ── Spinner ────────────────────────────────────────────────────────────────────
export function Spinner() {
  return (
    <svg className="w-4 h-4 animate-spin" viewBox="0 0 24 24" fill="none">
      <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"/>
      <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z"/>
    </svg>
  )
}

// ── Info banner ────────────────────────────────────────────────────────────────
export function InfoBanner({ type, children }: { type: 'info' | 'warn' | 'error' | 'success'; children: ReactNode }) {
  const s = {
    info:    'bg-blue-50 border-blue-200 text-blue-800',
    warn:    'bg-amber-50 border-amber-200 text-amber-800',
    error:   'bg-red-50 border-red-200 text-red-800',
    success: 'bg-emerald-50 border-emerald-200 text-emerald-800',
  }[type]
  return (
    <div className={`flex items-start gap-2.5 p-3.5 border rounded-xl text-sm ${s}`}>
      {children}
    </div>
  )
}
