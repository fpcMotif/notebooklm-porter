/** Shared structural guard for persisted/foreign values before shape-trusting them. */
export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
