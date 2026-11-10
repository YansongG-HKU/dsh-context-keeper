import { Worker } from 'node:worker_threads'

const TIMEOUT_MS = 1000
const MAX_WORKERS = 2
let activeWorkers = 0

/** Run untrusted regular expressions away from the Host event loop. */
export async function searchRegex({ session, signal, ...options }) {
  signal?.throwIfAborted()
  if (activeWorkers >= MAX_WORKERS) throw new Error('regular expression search is busy; retry or use a keyword')
  const worker = new Worker(new URL('./regex-worker.js', import.meta.url), {
    execArgv: [],
    workerData: { options, events: session.snapshotEvents(), nodes: [...session.surface.nodes] },
  })
  activeWorkers += 1
  let timer
  let onAbort
  try {
    return await new Promise((resolve, reject) => {
      onAbort = () => reject(signal.reason)
      worker.once('error', reject)
      worker.once('exit', (code) => reject(new Error(`regular expression worker exited (${code})`)))
      worker.once('message', (message) => {
        if (message.error !== undefined) reject(new Error(message.error))
        else resolve(message.result)
      })
      timer = setTimeout(() => reject(new Error('regular expression search timed out; try a simpler expression or a keyword')), TIMEOUT_MS)
      signal?.addEventListener('abort', onAbort, { once: true })
      if (signal?.aborted) onAbort()
    })
  } finally {
    clearTimeout(timer)
    signal?.removeEventListener('abort', onAbort)
    try {
      await worker.terminate()
    } finally {
      activeWorkers -= 1
    }
  }
}
