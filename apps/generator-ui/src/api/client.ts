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
import { createLogger } from '../utils/logger'

const log = createLogger('api')

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

  // Log outgoing requests in dev so engineers can trace which calls fired.
  client.interceptors.request.use((config) => {
    (config as { _sentAt?: number })._sentAt = Date.now()
    log.debug('%s %s', config.method?.toUpperCase(), config.url)
    return config
  })

  /**
   * Response interceptor: logs timing + handles auth expiry.
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
    (response) => {
      const sentAt = (response.config as { _sentAt?: number })._sentAt
      const ms = sentAt ? Date.now() - sentAt : -1
      log.debug('%s %s %d %dms', response.config.method?.toUpperCase(), response.config.url, response.status, ms)
      return response
    },
    (error) => {
      const config = error.config ?? {}
      const sentAt = (config as { _sentAt?: number })._sentAt
      const ms = sentAt ? Date.now() - sentAt : -1
      const status: number = error.response?.status ?? 0

      if (status === 401) {
        log.info('session expired | url=%s — dispatching auth:session-expired', config.url)
        window.dispatchEvent(new CustomEvent('auth:session-expired'))
      } else if (status >= 500) {
        log.error('server error | %s %s %d %dms', config.method?.toUpperCase(), config.url, status, ms)
      } else if (status >= 400) {
        log.warn('client error | %s %s %d %dms', config.method?.toUpperCase(), config.url, status, ms)
      } else {
        log.error('request failed (no response) | %s %s error=%s', config.method?.toUpperCase(), config.url, error.message)
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
