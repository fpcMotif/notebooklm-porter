/** One serialized storage domain. */
type Lane = <A>(run: () => Promise<A>) => Promise<A>

export interface StorageLaneScheduler<Domain> {
  /** Runs after earlier work in every named domain. */
  readonly run: <A>(domains: readonly Domain[], task: () => Promise<A>) => Promise<A>
}

function makeLane(): Lane {
  let tail: Promise<void> = Promise.resolve()
  return (run) => {
    const next = tail.then(run, run)
    tail = next.then(
      () => undefined,
      () => undefined,
    )
    return next
  }
}

/**
 * Serializes storage consistency footprints by domain. Work spanning domains
 * acquires them in the supplied order, so callers cannot introduce lock-order deadlocks.
 */
export function makeStorageLaneScheduler<Domain>(
  order: readonly Domain[],
): StorageLaneScheduler<Domain> {
  const orderedDomains = [...new Set(order)]
  const lanes = new Map(orderedDomains.map((domain) => [domain, makeLane()] as const))

  function run<A>(domains: readonly Domain[], task: () => Promise<A>): Promise<A> {
    const selected = orderedDomains.filter((domain) => domains.includes(domain))

    function acquire(index: number): Promise<A> {
      const domain = selected[index]
      if (domain === undefined) return task()
      const lane = lanes.get(domain)
      if (lane === undefined) return acquire(index + 1)
      return lane(() => acquire(index + 1))
    }

    return acquire(0)
  }

  return { run }
}
