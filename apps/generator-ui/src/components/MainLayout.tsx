/**
 * apps/generator-ui/src/components/MainLayout.tsx
 *
 * The authenticated application shell. Shown only when user != null.
 *
 * Role-aware rendering pattern used throughout:
 *   {isAdmin && <AdminOnlyThing />}         → hidden entirely for non-admins
 *   <button disabled={!isOperator}>...</>   → visible but disabled for viewers
 *
 * The role check in React is a UX convenience, not a security boundary.
 * FastAPI enforces roles independently on every API call regardless of
 * what the React UI shows. A determined user who bypasses the UI check
 * will still get a 403 from FastAPI.
 */

import { useAuth } from '../context/AuthContext'

export function MainLayout() {
  const { user, isAdmin, isOperator, logout } = useAuth()

  return (
    <div className="min-h-screen bg-gray-50">

      {/* Top navigation bar */}
      <nav className="bg-white border-b border-gray-200 px-6 py-3">
        <div className="max-w-7xl mx-auto flex items-center justify-between">

          {/* Brand */}
          <div className="flex items-center gap-2">
            <div className="w-7 h-7 rounded-md bg-blue-600 flex items-center justify-center">
              <svg viewBox="0 0 24 24" className="w-3.5 h-3.5 text-white fill-current">
                <path d="M4 6h16v2H4zm0 5h16v2H4zm0 5h16v2H4z"/>
              </svg>
            </div>
            <span className="text-sm font-semibold text-gray-900">TxGen Platform</span>
          </div>

          {/* User info + logout */}
          <div className="flex items-center gap-4">
            <div className="flex items-center gap-2.5">
              {/* Role badge — colour-coded so role is obvious at a glance */}
              <span className={`
                text-xs font-medium px-2 py-0.5 rounded-full
                ${isAdmin
                  ? 'bg-red-100 text-red-700'
                  : isOperator
                    ? 'bg-amber-100 text-amber-700'
                    : 'bg-blue-100 text-blue-700'
                }
              `}>
                {isAdmin ? 'Admin' : isOperator ? 'Operator' : 'Viewer'}
              </span>
              <span className="text-sm text-gray-600">{user?.displayName}</span>
            </div>
            <button
              onClick={logout}
              className="
                text-xs text-gray-500 hover:text-gray-900
                border border-gray-200 hover:border-gray-300
                px-3 py-1.5 rounded-lg
                transition-colors
              "
            >
              Sign out
            </button>
          </div>
        </div>
      </nav>

      {/* Main content area — tabs for each service */}
      <main className="max-w-7xl mx-auto px-6 py-8">
        <div className="text-sm text-gray-500 mb-6">
          {/* Show a contextual hint based on role */}
          {isAdmin && (
            <span className="inline-flex items-center gap-1.5 bg-red-50 text-red-700
              border border-red-200 px-3 py-1 rounded-full text-xs font-medium">
              Full access — seed accounts, manage scenarios, view all dashboards
            </span>
          )}
          {isOperator && !isAdmin && (
            <span className="inline-flex items-center gap-1.5 bg-amber-50 text-amber-700
              border border-amber-200 px-3 py-1 rounded-full text-xs font-medium">
              Operator — run scenarios and view dashboards
            </span>
          )}
          {!isOperator && (
            <span className="inline-flex items-center gap-1.5 bg-blue-50 text-blue-700
              border border-blue-200 px-3 py-1 rounded-full text-xs font-medium">
              Viewer — dashboards and event feed (read-only)
            </span>
          )}
        </div>

        {/*
          The full tab UI (Account Generator, Transaction Generator, etc.)
          slots in here. Each tab receives the role flags as props so they
          can conditionally render buttons and controls.

          Example:
            <AccountGeneratorTab canSeed={isAdmin} canViewStatus={isOperator} />
            <TransactionGeneratorTab canControl={isOperator} />
            <EventFeedTab />   ← visible to all authenticated users
        */}
        <div className="bg-white border border-gray-200 rounded-2xl p-8 text-center text-gray-400 text-sm">
          Application tabs load here
          <br/>
          (AccountGeneratorTab, TransactionGeneratorTab, EventFeedTab)
        </div>
      </main>
    </div>
  )
}
