/**
 * apps/generator-ui/src/components/MainLayout.tsx
 *
 * The authenticated application shell. Shown only when user != null.
 *
 * Tab visibility is role-gated:
 *   - Account Generator: admin only  (seed MongoDB)
 *   - Transaction Generator: admin + operator  (run scenarios)
 *   - Event Feed: all authenticated users
 *   - Integrity: admin + operator
 *   - Dashboards: all authenticated users
 */

import { useState } from 'react'
import { useAuth } from '../context/AuthContext'
import { AccountGeneratorPage } from '../pages/AccountGeneratorPage'
import { TransactionGeneratorPage } from '../pages/TransactionGeneratorPage'
import { EventFeedPage } from '../pages/EventFeedPage'
import { IntegrityPage } from '../pages/IntegrityPage'
import { DashboardsPage } from '../pages/DashboardsPage'

type Tab = 'account' | 'txgen' | 'feed' | 'integrity' | 'dashboards'

const ALL_TABS: { id: Tab; label: string; adminOnly?: boolean; operatorOnly?: boolean }[] = [
  { id: 'account',    label: 'Account Generator',     adminOnly: true },
  { id: 'txgen',      label: 'Transaction Generator', operatorOnly: true },
  { id: 'feed',       label: 'Event Feed' },
  { id: 'integrity',  label: 'Integrity',             operatorOnly: true },
  { id: 'dashboards', label: 'Dashboards' },
]

// Inline SVG icons — no icon library dependency
function IconUsers()   { return <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" strokeWidth={1.8} viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" d="M17 20h5v-2a4 4 0 00-5-3.87M9 20H4v-2a4 4 0 015-3.87m6-4.13a4 4 0 11-8 0 4 4 0 018 0zm6 0a3 3 0 11-6 0 3 3 0 016 0z"/></svg> }
function IconZap()     { return <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" strokeWidth={1.8} viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" d="M13 10V3L4 14h7v7l9-11h-7z"/></svg> }
function IconFeed()    { return <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" strokeWidth={1.8} viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" d="M22 12h-4l-3 9L9 3l-3 9H2"/></svg> }
function IconShield()  { return <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" strokeWidth={1.8} viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" d="M9 12l2 2 4-4m5.618-4.016A11.955 11.955 0 0112 2.944a11.955 11.955 0 01-8.618 3.04A12.02 12.02 0 003 9c0 5.591 3.824 10.29 9 11.622 5.176-1.332 9-6.03 9-11.622 0-1.042-.133-2.052-.382-3.016z"/></svg> }
function IconChart()   { return <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" strokeWidth={1.8} viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" d="M9 19v-6a2 2 0 00-2-2H5a2 2 0 00-2 2v6a2 2 0 002 2h2a2 2 0 002-2zm0 0V9a2 2 0 012-2h2a2 2 0 012 2v10m-6 0a2 2 0 002 2h2a2 2 0 002-2m0 0V5a2 2 0 012-2h2a2 2 0 012 2v14a2 2 0 01-2 2h-2a2 2 0 01-2-2z"/></svg> }

const TAB_ICONS: Record<Tab, () => JSX.Element> = {
  account:    IconUsers,
  txgen:      IconZap,
  feed:       IconFeed,
  integrity:  IconShield,
  dashboards: IconChart,
}

export function MainLayout() {
  const { user, isAdmin, isOperator, logout } = useAuth()

  const visibleTabs = ALL_TABS.filter(t => {
    if (t.adminOnly)    return isAdmin
    if (t.operatorOnly) return isOperator
    return true
  })

  const [activeTab, setActiveTab] = useState<Tab>(visibleTabs[0]?.id ?? 'feed')

  return (
    <div className="min-h-screen bg-gray-50">

      {/* ── Top nav ───────────────────────────────────────────────────── */}
      <header className="bg-white border-b border-gray-200 sticky top-0 z-10">
        <div className="max-w-screen-xl mx-auto px-6">
          <div className="flex items-center justify-between h-14">

            {/* Brand + desktop tabs */}
            <div className="flex items-center gap-6">
              <div className="flex items-center gap-2 shrink-0">
                <div className="w-7 h-7 rounded-md bg-blue-600 flex items-center justify-center">
                  <svg viewBox="0 0 24 24" className="w-3.5 h-3.5 text-white fill-current">
                    <path d="M4 6h16v2H4zm0 5h16v2H4zm0 5h16v2H4z"/>
                  </svg>
                </div>
                <span className="text-sm font-semibold text-gray-900 hidden sm:block">TxGen</span>
              </div>

              {/* Desktop nav tabs */}
              <nav className="hidden md:flex items-center gap-0.5">
                {visibleTabs.map(tab => {
                  const Icon = TAB_ICONS[tab.id]
                  const active = activeTab === tab.id
                  return (
                    <button
                      key={tab.id}
                      onClick={() => setActiveTab(tab.id)}
                      className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-sm font-medium transition-all ${
                        active
                          ? 'bg-blue-50 text-blue-700'
                          : 'text-gray-500 hover:text-gray-800 hover:bg-gray-100'
                      }`}
                    >
                      <Icon />
                      {tab.label}
                    </button>
                  )
                })}
              </nav>
            </div>

            {/* User chip + logout */}
            <div className="flex items-center gap-3">
              <span className={`text-[10px] font-semibold px-2 py-0.5 rounded-full tracking-wide uppercase ${
                isAdmin    ? 'bg-red-100 text-red-700'
                : isOperator ? 'bg-amber-100 text-amber-700'
                : 'bg-blue-100 text-blue-700'
              }`}>
                {isAdmin ? 'Admin' : isOperator ? 'Operator' : 'Viewer'}
              </span>
              <span className="text-sm text-gray-600 hidden sm:block">{user?.displayName}</span>
              <button
                onClick={logout}
                className="text-xs text-gray-400 hover:text-gray-700 border border-gray-200 hover:border-gray-300 px-3 py-1.5 rounded-lg transition-colors"
              >
                Sign out
              </button>
            </div>
          </div>
        </div>

        {/* Mobile tab bar */}
        <div className="md:hidden flex overflow-x-auto border-t border-gray-100 px-4 gap-1 py-1.5">
          {visibleTabs.map(tab => {
            const Icon = TAB_ICONS[tab.id]
            const active = activeTab === tab.id
            return (
              <button
                key={tab.id}
                onClick={() => setActiveTab(tab.id)}
                className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium whitespace-nowrap transition-all ${
                  active ? 'bg-blue-50 text-blue-700' : 'text-gray-500'
                }`}
              >
                <Icon />
                {tab.label}
              </button>
            )
          })}
        </div>
      </header>

      {/* ── Page content ──────────────────────────────────────────────── */}
      <main className="max-w-screen-xl mx-auto px-6 py-8">
        {activeTab === 'account'    && <AccountGeneratorPage />}
        {activeTab === 'txgen'      && <TransactionGeneratorPage />}
        {activeTab === 'feed'       && <EventFeedPage />}
        {activeTab === 'integrity'  && <IntegrityPage />}
        {activeTab === 'dashboards' && <DashboardsPage />}
      </main>
    </div>
  )
}
