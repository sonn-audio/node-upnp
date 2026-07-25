/**
 * Optional structured logger the host app can inject. Kept structural (not a
 * concrete class) so a plain `console` or any compatible object works. When
 * omitted, the module is silent.
 */
export interface UpnpLogger {
  debug?(message: string, meta?: Record<string, unknown>): void;
  info?(message: string, meta?: Record<string, unknown>): void;
  warn?(message: string, meta?: Record<string, unknown>): void;
  error?(message: string, meta?: Record<string, unknown>): void;
}

/** A no-op logger used when the host injects none. */
export const noopLogger: UpnpLogger = {};
