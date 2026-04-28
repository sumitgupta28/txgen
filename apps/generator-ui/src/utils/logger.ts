/**
 * apps/generator-ui/src/utils/logger.ts
 *
 * Thin structured logger for browser-side code.
 * DEBUG logs are suppressed in production builds (import.meta.env.PROD).
 * All other levels always emit so errors are visible in prod DevTools.
 *
 * Usage:
 *   import { createLogger } from '../utils/logger'
 *   const log = createLogger('AuthContext')
 *   log.info('login attempt | user=%s', username)
 */

const isProd = import.meta.env.PROD

type LogArgs = [string, ...unknown[]]

function timestamp(): string {
  return new Date().toISOString()
}

export interface Logger {
  debug(...args: LogArgs): void
  info(...args: LogArgs): void
  warn(...args: LogArgs): void
  error(...args: LogArgs): void
}

export function createLogger(prefix: string): Logger {
  const tag = `[${prefix}]`

  return {
    debug(...args: LogArgs) {
      if (!isProd) console.debug(`${timestamp()} DEBUG ${tag}`, ...args)
    },
    info(...args: LogArgs) {
      console.info(`${timestamp()} INFO  ${tag}`, ...args)
    },
    warn(...args: LogArgs) {
      console.warn(`${timestamp()} WARN  ${tag}`, ...args)
    },
    error(...args: LogArgs) {
      console.error(`${timestamp()} ERROR ${tag}`, ...args)
    },
  }
}
