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
    accountApi
      .get<User>('/api/auth/me')
      .then((res) => setUser(mapUser(res.data)))
      .catch(() => setUser(null))      // 401 is expected — not an error
      .finally(() => setLoading(false))
  }, [])

  /**
   * Listen for session expiry events dispatched by the axios response interceptor.
   * When FastAPI returns 401 on any request (session fully expired), we clear
   * the React user state so the login page is shown.
   */
  useEffect(() => {
    const handleExpiry = () => setUser(null)
    window.addEventListener('auth:session-expired', handleExpiry)
    return () => window.removeEventListener('auth:session-expired', handleExpiry)
  }, [])

  const login = useCallback(async (username: string, password: string) => {
    /**
     * POST credentials to FastAPI. FastAPI calls Keycloak server-side,
     * stores tokens in Redis, and sets the HttpOnly cookie via Set-Cookie header.
     *
     * The `withCredentials: true` on the axios client ensures the browser
     * accepts and stores the Set-Cookie header from the cross-origin FastAPI response.
     *
     * If credentials are wrong, FastAPI returns 401 and axios throws — the
     * LoginPage catches this and shows the error message.
     */
    const res = await accountApi.post<User>('/api/auth/login', {
      username,
      password,
    })
    setUser(mapUser(res.data))
  }, [])

  const logout = useCallback(async () => {
    /**
     * POST to /api/auth/logout. FastAPI deletes the Redis session, calls
     * Keycloak's logout endpoint, and responds with Set-Cookie: session=; Max-Age=0
     * which tells the browser to immediately discard the session cookie.
     */
    await accountApi.post('/api/auth/logout').catch(() => {
      // Even if the request fails (e.g. network error), clear local state
    })
    setUser(null)
  }, [])

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
