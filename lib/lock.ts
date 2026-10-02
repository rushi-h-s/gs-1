// Per-key async mutex: callers with the same key run one at a time, in order.
// ponytail: in-process only. Fine for one server instance; with several instances (serverless)
// the reconcile route's run_id supersede check still protects results, but imports would need a DB lock.
const tails = new Map<string, Promise<void>>()

export async function withLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const prev = tails.get(key) ?? Promise.resolve()
  let release!: () => void
  const mine = new Promise<void>(r => { release = r })
  const tail = prev.then(() => mine)
  tails.set(key, tail)
  await prev
  try {
    return await fn()
  } finally {
    release()
    if (tails.get(key) === tail) tails.delete(key)
  }
}
