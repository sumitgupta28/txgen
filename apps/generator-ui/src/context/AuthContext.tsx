/**
 * apps/generator-ui/src/context/AuthContext.tsx
 *
 * The complete authentication state for the React application.
 *
 * Key design points:
 *
 * 1. React has NO knowledge of Keycloak. It only knows about FastAPI.
 *    There is no keycloak-js, no Keycloak URL, no OAuth redirect.
 *    The login flow is: React form → POST /api/auth/login → cookie set by FastAPI.
 *
 * 2. Token management is zero-effort for React. FastAPI auto-refreshes
 *    the Keycloak access token inside Redis. React never handles expiry.
 *
 * 3. The session cookie is HttpOnly — React code literally cannot read it.
 *    The browser holds it and sends it automatically. `withCredentials: true`
 *    in the axios client is the only configuration needed.
 *
 * 4. On page load, GET /api/auth/me determines auth state:
 *    - 200 → user is logged in → show the app
 *    - 401 → no session → show the login page
 *    No localStorage, no sessionStorage, no token parsing in React.
 */

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useState,
} from 'react'
import { accountApi } from '../api/client'
import { createLogger } from '../utils/logger'

const log = createLogger('AuthContext')

// ── Types ─────────────────────────────────────────────────────────────────────

export interface User {
  username:    string
  displayName: string
  roles:       string[]
}

interface AuthContextValue {
  user:      User | null
  isLoading: boolean       // true during the initial /api/auth/me check
  isAdmin:      boolean    // convenience flags derived from roles
  isOperator:   boolean    // true for both "operator" and "admin"
  isViewer:     boolean    // true for all authenticated users
  login:  (username: string, password: string) => Promise<void>
  logout: () => Promise<void>
}

// ── Context ───────────────────────────────────────────────────────────────────

const AuthContext = createContext<AuthContextValue>({} as AuthContextValue)

// ── Provider ──────────────────────────────────────────────────────────────────

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [user, setUser]         = useState<User | null>(null)
  const [isLoading, setLoading] = useState(true)

  /**
   * On first render, call /api/auth/me to see if the browser already has
   * a valid session cookie from a previous visit. This is how "remember me"
   * works — Redis keeps the session alive as long as the refresh token is valid.
   *
   * If 401 is returned → no session → user sees the login page.
   * If 200 is returned → session exists → user goes straight to the app.
   */
  useEffect(() => {
    log.debug('checking existing session via /api/auth/me')
    accountApi
      .get<User>('/api/auth/me')
      .then((res) => {
        log.info('session restored | user=%s roles=%s', res.data.username, res.data.roles?.join(','))
        setUser(mapUser(res.data))
      })
      .catch(() => {
        log.debug('no active session — showing login page')
        setUser(null)
      })
      .finally(() => setLoading(false))
  }, [])

  /**
   * Listen for session expiry events dispatched by the axios response interceptor.
   * When FastAPI returns 401 on any request (session fully expired), we clear
   * the React user state so the login page is shown.
   */
  useEffect(() => {
    const handleExpiry = () => {
      log.warn('session expired event received — clearing user state')
      setUser(null)
    }
    window.addEventListener('auth:session-expired', handleExpiry)
    return () => window.removeEventListener('auth:session-expired', handleExpiry)
  }, [])

  const login = useCallback(async (username: string, password: string) => {
    log.info('login attempt | user=%s', username)
    const res = await accountApi.post<User>('/api/auth/login', {
      username,
      password,
    })
    log.info('login success | user=%s roles=%s', res.data.username, res.data.roles?.join(','))
    setUser(mapUser(res.data))
  }, [])

  const logout = useCallback(async () => {
    log.info('logout | user=%s', user?.username ?? 'unknown')
    await accountApi.post('/api/auth/logout').catch((err) => {
      log.warn('logout request failed (clearing local state anyway) | error=%s', err?.message)
    })
    setUser(null)
  }, [user])

  // Derived role flags — computed from the user's roles array
  const isAdmin    = user?.roles.includes('admin') ?? false
  const isOperator = (user?.roles?.includes('operator') ?? false) || isAdmin;
  const isViewer   = user !== null   // any authenticated user can view

  return (
    <AuthContext.Provider
      value={{ user, isLoading, isAdmin, isOperator, isViewer, login, logout }}
    >
      {children}
    </AuthContext.Provider>
  )
}

export function useAuth(): AuthContextValue {
  return useContext(AuthContext)
}

// ── Helpers ───────────────────────────────────────────────────────────────────

/** Map the snake_case API response to camelCase TypeScript. */
function mapUser(data: { username: string; display_name: string; roles: string[] }): User {
  return {
    username:    data.username,
    displayName: data.display_name,
    roles:       data.roles,
  }
}
