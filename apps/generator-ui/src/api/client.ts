/**
 * apps/generator-ui/src/api/client.ts
 *
 * Axios instances for the two FastAPI services.
 *
 * The single most important line in this entire file is:
 *   withCredentials: true
 *
 * Without it, the browser treats every API call as anonymous because it strips
 * the session cookie from cross-origin requests. With it, the browser
 * automatically attaches the HttpOnly cookie that FastAPI set on login — and
 * the user stays authenticated without React doing anything special.
 *
 * Notice what is NOT in this file:
 *   - No Authorization header injection
 *   - No token storage (localStorage, sessionStorage, memory)
 *   - No token expiry checking
 *   - No token refresh logic
 *   - No Keycloak URLs
 *
 * All of that complexity lives inside FastAPI. React just makes API calls.
 */

import axios, { type AxiosInstance } from 'axios'

/**
 * Creates a pre-configured axios instance for a FastAPI service.
 * Both account-api and txgen-api share this factory so their clients
 * behave identically.
 */
function createApiClient(baseURL: string): AxiosInstance {
  const client = axios.create({
    baseURL,
    withCredentials: true,     // ← the entire BFF session mechanism in one line
    headers: {
      'Content-Type': 'application/json',
    },
  })

  /**
   * Response interceptor: the only auth-related code React needs.
   *
   * When FastAPI returns 401 (session expired, cookie missing, or tampered),
   * we dispatch a custom event. The AuthContext listens for this event and
   * clears the user state, causing the login page to render.
   *
   * We use a custom event rather than directly calling setUser(null) because
   * this interceptor lives outside of React's component tree and cannot
   * call React state setters directly.
   */
  client.interceptors.response.use(
    (response) => response,
    (error) => {
      if (error.response?.status === 401) {
        // Notify AuthContext that the session has expired
        window.dispatchEvent(new CustomEvent('auth:session-expired'))
      }
      return Promise.reject(error)
    }
  )

  return client
}

// One client per FastAPI service.
// React components import whichever client they need.
export const accountApi = createApiClient(
  import.meta.env.VITE_ACCOUNT_API_URL ?? 'http://localhost:8001'
)

export const txgenApi = createApiClient(
  import.meta.env.VITE_TXGEN_API_URL ?? 'http://localhost:8002'
)
