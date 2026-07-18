import { useRef } from 'preact/hooks'

/**
 * Guards async completions against stale application: begin() a run, and
 * apply results only while isCurrent(token) — i.e. no later begin() has
 * superseded this one.
 */
export function useGenerationGuard(): {
  begin: () => number
  isCurrent: (token: number) => boolean
} {
  const ref = useRef(0)
  return {
    begin: () => ++ref.current,
    isCurrent: (token: number) => ref.current === token,
  }
}
