/** Host-side search runner: one worker thread per search, bounded by a deadline. */
import { Worker } from 'node:worker_threads'

const WORKER_URL = new URL('./match-worker.js', import.meta.url)

/** A search that did not finish: `timeout` past the deadline, `aborted` by the caller, `failed` otherwise. */
export class SearchStopped extends Error {
  /**
   * @param {'timeout' | 'aborted' | 'failed'} reason - why the search stopped.
   * @param {string} [detail] - worker failure message, for `failed`.
   */
  constructor(reason, detail) {
    super(detail === undefined ? `search ${reason}` : `search ${reason}: ${detail}`)
    this.name = 'SearchStopped'
    this.reason = reason
  }
}

/**
 * Match documents in a worker thread and terminate it at the deadline or on abort.
 * @param {{ documents: object[], query: string, regex: boolean, limits: object }} input - worker data; the query must already compile.
 * @param {number} timeoutMs - deadline for the whole search.
 * @param {AbortSignal} [signal] - caller cancellation.
 * @returns {Promise<ReturnType<import('./search.js').findMatches>>} matches.
 */
export function runSearch(input, timeoutMs, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) { reject(new SearchStopped('aborted')); return }
    const worker = new Worker(WORKER_URL, { workerData: input })
    let settled = false
    const finish = (settle) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      signal?.removeEventListener('abort', onAbort)
      // terminate() resolves once the thread has stopped; nothing awaits it.
      void worker.terminate()
      settle()
    }
    const onAbort = () => { finish(() => { reject(new SearchStopped('aborted')) }) }
    const timer = setTimeout(() => { finish(() => { reject(new SearchStopped('timeout')) }) }, timeoutMs)
    signal?.addEventListener('abort', onAbort, { once: true })
    worker.once('message', (result) => { finish(() => { resolve(result) }) })
    worker.once('error', (error) => { finish(() => { reject(new SearchStopped('failed', error?.message ?? String(error))) }) })
    worker.once('exit', (code) => { finish(() => { reject(new SearchStopped('failed', `worker exited with code ${code}`)) }) })
  })
}
