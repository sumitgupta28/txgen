/**
 * apps/generator-ui/src/App.tsx
 *
 * Root application component. The auth gate is the key pattern here:
 * the entire application is either the login page OR the main UI,
 * determined solely by whether useAuth().user is null or not.
 *
 * Role-based rendering happens inside the main UI components —
 * App.tsx itself only cares about "logged in vs not logged in".
 */

import { useAuth } from './context/AuthContext'
import { LoginPage } from './pages/LoginPage'
import { MainLayout } from './components/MainLayout'

export default function App() {
  const { user, isLoading } = useAuth()

  // During the initial /api/auth/me check, show a neutral loading state.
  // This prevents the login page from flashing briefly before the session
  // check completes on users who are already authenticated.
  if (isLoading) {
    return (
      <div className="min-h-screen bg-gray-50 flex items-center justify-center">
        <div className="flex items-center gap-3 text-gray-500">
          <svg className="w-5 h-5 animate-spin" viewBox="0 0 24 24" fill="none">
            <circle className="opacity-25" cx="12" cy="12" r="10"
              stroke="currentColor" strokeWidth="4" />
            <path className="opacity-75" fill="currentColor"
              d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
          </svg>
          <span className="text-sm">Loading...</span>
        </div>
      </div>
    )
  }

  // The entire auth decision is this single line.
  // No route guards, no HOCs, no redirect logic needed.
  return user ? <MainLayout /> : <LoginPage />
}
