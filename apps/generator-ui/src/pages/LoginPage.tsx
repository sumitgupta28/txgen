/**
 * apps/generator-ui/src/pages/LoginPage.tsx
 *
 * The custom React login page. This is the entire "auth UI" — a simple form
 * that posts credentials to FastAPI. No Keycloak redirect, no OAuth library,
 * no external dependency beyond axios (which is already needed for everything else).
 *
 * Design choices:
 *  - No "Register" link — users are predefined in Keycloak admin
 *  - No "Forgot password" link — passwords are managed by the admin
 *  - Clear error message for invalid credentials
 *  - Disabled state during submission to prevent double-submits
 */

import { type FormEvent, useState } from 'react'
import { useAuth } from '../context/AuthContext'

export function LoginPage() {
  const { login } = useAuth()

  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [error,    setError]    = useState('')
  const [loading,  setLoading]  = useState(false)

  async function handleSubmit(e: FormEvent) {
    e.preventDefault()
    if (!username.trim() || !password) return

    setLoading(true)
    setError('')

    try {
      await login(username.trim(), password)
      // On success, AuthContext sets the user — App re-renders to show the main UI.
      // No navigation needed — the conditional render in App.tsx handles it.
    } catch (err: unknown) {
      // FastAPI returns 401 for bad credentials. Show a user-friendly message.
      // We deliberately do not distinguish "wrong password" from "user not found"
      // to avoid leaking which usernames exist in the system.
      setError('Invalid username or password. Please try again.')
      setPassword('')   // clear password field on failure — security best practice
    } finally {
      setLoading(false)
    }
  }

  return (
    <div className="min-h-screen bg-gray-50 flex items-center justify-center px-4">
      <div className="w-full max-w-sm">

        {/* Platform identity */}
        <div className="mb-8 text-center">
          <div className="inline-flex items-center gap-2 mb-3">
            <div className="w-8 h-8 rounded-lg bg-blue-600 flex items-center justify-center">
              {/* Simple geometric mark — no icon library needed */}
              <svg viewBox="0 0 24 24" className="w-4 h-4 text-white fill-current">
                <path d="M4 6h16v2H4zm0 5h16v2H4zm0 5h16v2H4z"/>
              </svg>
            </div>
            <span className="text-lg font-semibold text-gray-900 tracking-tight">
              TxGen
            </span>
          </div>
          <h1 className="text-2xl font-semibold text-gray-900 mb-1">Sign in</h1>
          <p className="text-sm text-gray-500">
            Payment network simulation platform
          </p>
        </div>

        {/* Login card */}
        <div className="bg-white border border-gray-200 rounded-2xl p-8 shadow-sm">
          <form onSubmit={handleSubmit} className="space-y-5" noValidate>

            <div>
              <label
                htmlFor="username"
                className="block text-sm font-medium text-gray-700 mb-1.5"
              >
                Username
              </label>
              <input
                id="username"
                type="text"
                autoComplete="username"
                autoFocus
                required
                value={username}
                onChange={(e) => setUsername(e.target.value)}
                disabled={loading}
                placeholder="e.g. operator_alice"
                className="
                  w-full px-3.5 py-2.5 text-sm text-gray-900
                  border border-gray-300 rounded-lg
                  placeholder-gray-400
                  focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent
                  disabled:bg-gray-50 disabled:text-gray-400 disabled:cursor-not-allowed
                  transition-colors
                "
              />
            </div>

            <div>
              <label
                htmlFor="password"
                className="block text-sm font-medium text-gray-700 mb-1.5"
              >
                Password
              </label>
              <input
                id="password"
                type="password"
                autoComplete="current-password"
                required
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                disabled={loading}
                className="
                  w-full px-3.5 py-2.5 text-sm text-gray-900
                  border border-gray-300 rounded-lg
                  focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent
                  disabled:bg-gray-50 disabled:text-gray-400 disabled:cursor-not-allowed
                  transition-colors
                "
              />
            </div>

            {/* Error message — shown below the password field */}
            {error && (
              <div
                role="alert"
                className="flex items-start gap-2.5 p-3 bg-red-50 border border-red-200 rounded-lg"
              >
                <svg
                  className="w-4 h-4 text-red-500 mt-0.5 flex-shrink-0"
                  viewBox="0 0 20 20"
                  fill="currentColor"
                >
                  <path
                    fillRule="evenodd"
                    d="M18 10a8 8 0 11-16 0 8 8 0 0116 0zm-8-5a.75.75 0 01.75.75v4.5a.75.75 0 01-1.5 0v-4.5A.75.75 0 0110 5zm0 10a1 1 0 100-2 1 1 0 000 2z"
                    clipRule="evenodd"
                  />
                </svg>
                <p className="text-sm text-red-700">{error}</p>
              </div>
            )}

            <button
              type="submit"
              disabled={loading || !username.trim() || !password}
              className="
                w-full py-2.5 px-4
                bg-blue-600 hover:bg-blue-700 active:bg-blue-800
                disabled:bg-blue-300 disabled:cursor-not-allowed
                text-white text-sm font-medium
                rounded-lg
                transition-colors
                focus:outline-none focus:ring-2 focus:ring-blue-500 focus:ring-offset-2
              "
            >
              {loading ? (
                <span className="flex items-center justify-center gap-2">
                  <svg
                    className="w-4 h-4 animate-spin"
                    viewBox="0 0 24 24"
                    fill="none"
                  >
                    <circle
                      className="opacity-25"
                      cx="12" cy="12" r="10"
                      stroke="currentColor" strokeWidth="4"
                    />
                    <path
                      className="opacity-75"
                      fill="currentColor"
                      d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z"
                    />
                  </svg>
                  Signing in...
                </span>
              ) : (
                'Sign in'
              )}
            </button>
          </form>
        </div>

        {/* Footer note — no registration link */}
        <p className="mt-6 text-center text-xs text-gray-400">
          Access is by invitation only.{' '}
          <span className="text-gray-500">Contact your administrator.</span>
        </p>
      </div>
    </div>
  )
}
