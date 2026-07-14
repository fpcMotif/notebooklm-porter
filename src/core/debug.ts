/**
 * Persistent debug ring (design: real debuggability without the SW console).
 * The popup can't see `console.log` from the service worker, so every
 * diagnosable step also gets appended to a capped ring in storage.local that
 * the popup can pull and copy. Redaction runs on every write — token VALUES
 * must never survive into storage.
 *
 * appendEntry/redact are pure and unit-tested. dbg/getDebugLog/clearDebugLog
 * are thin SW-side glue — untested, per CLAUDE.md (pure core vs entrypoint
 * glue split).
 */

export type DebugLevel = 'info' | 'warn' | 'error'

export interface DebugEntry {
  t: string
  scope: string
  msg: string
  /** Omitted for the common `info` case to keep entries small and back-compatible. */
  level?: DebugLevel
  /** Wall-clock duration of a timed operation, when the caller measured one. */
  elapsedMs?: number
  /** Correlation id tying a burst of entries together (one queue job, one capture). */
  run?: string
  data?: unknown
}

/** Optional per-call metadata; all fields default to absent. */
export interface DebugMeta {
  level?: DebugLevel
  elapsedMs?: number
  run?: string
}

const RING_KEY = 'porter/debug'
/**
 * Ring size for live writes. Deliberately larger than appendEntry's tested
 * default (100): a single playlist ingest can emit dozens of per-unit/per-tier
 * entries and must not evict its own opening session/route lines.
 */
const RING_CAP = 500

/** Appends `entry`, dropping the oldest entries past `cap`. Never mutates `ring`. */
export function appendEntry(ring: DebugEntry[], entry: DebugEntry, cap = 100): DebugEntry[] {
  const next = [...ring, entry]
  return next.length > cap ? next.slice(next.length - cap) : next
}

const MAX_STRING_LEN = 300
const TRUNCATE_SUFFIX = '…[truncated]'

const URL_TOKEN_RE = /([?&](?:at|f\.sid|access_token)=)[^&\s]+/g
const WIZ_KEY_RE = /"(SNlM0e|FdrFJe)":"[^"]+"/g

function redactString(value: string): string {
  const withoutTokens = value
    .replace(URL_TOKEN_RE, '$1<redacted>')
    .replace(WIZ_KEY_RE, '"$1":"<redacted>"')
  return withoutTokens.length > MAX_STRING_LEN
    ? withoutTokens.slice(0, MAX_STRING_LEN) + TRUNCATE_SUFFIX
    : withoutTokens
}

/**
 * Deep-clones `value` into something JSON-safe, redacting token-shaped
 * strings and truncating long ones. Values that don't survive JSON
 * round-tripping (functions, symbols, undefined-in-arrays, etc.) collapse to
 * whatever JSON.stringify/parse would produce for them.
 */
export function redact(value: unknown): unknown {
  if (typeof value === 'string') return redactString(value)
  if (typeof value !== 'object' || value === null) return value

  if (Array.isArray(value)) return value.map((item) => redact(item))

  const out: Record<string, unknown> = {}
  for (const [key, val] of Object.entries(value)) {
    out[key] = redact(val)
  }
  return out
}

function jsonSafe(value: unknown): unknown {
  try {
    return JSON.parse(JSON.stringify(value)) as unknown
  } catch {
    return String(value)
  }
}

let writeChain: Promise<void> = Promise.resolve()

/**
 * Logs to the console AND persists to storage.local, fire-and-forget.
 * Writes are serialized through a module-level chain so concurrent dbg
 * calls read-modify-write the ring without clobbering each other.
 *
 * `meta.level` routes the console sink (warn/error stand out) and is stored so
 * the popup viewer can colour and filter; `info` is left implicit. `elapsedMs`
 * and `run` are recorded when the caller supplies them.
 */
export function dbg(scope: string, msg: string, data?: unknown, meta: DebugMeta = {}): void {
  const safeData = data !== undefined ? redact(jsonSafe(data)) : undefined
  const level = meta.level ?? 'info'
  const sink = level === 'error' ? console.error : level === 'warn' ? console.warn : console.log
  sink(
    '[porter]',
    scope,
    msg,
    ...(meta.elapsedMs !== undefined ? [`(${meta.elapsedMs}ms)`] : []),
    safeData ?? '',
  )

  const entry: DebugEntry = {
    t: new Date().toISOString(),
    scope,
    msg,
    ...(level !== 'info' ? { level } : {}),
    ...(meta.elapsedMs !== undefined ? { elapsedMs: meta.elapsedMs } : {}),
    ...(meta.run !== undefined ? { run: meta.run } : {}),
    ...(safeData !== undefined ? { data: safeData } : {}),
  }

  writeChain = writeChain
    .then(async () => {
      const got = await browser.storage.local.get(RING_KEY)
      const ring = (got[RING_KEY] ?? []) as DebugEntry[]
      return browser.storage.local.set({ [RING_KEY]: appendEntry(ring, entry, RING_CAP) })
    })
    .catch(() => {
      // Debug logging must never throw into caller code paths.
    })
}

export async function getDebugLog(): Promise<DebugEntry[]> {
  const got = await browser.storage.local.get(RING_KEY)
  return (got[RING_KEY] ?? []) as DebugEntry[]
}

export async function clearDebugLog(): Promise<void> {
  writeChain = writeChain.then(() => browser.storage.local.set({ [RING_KEY]: [] }))
  await writeChain
}
