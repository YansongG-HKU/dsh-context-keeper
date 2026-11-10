import { parentPort, workerData } from 'node:worker_threads'
import { searchEvents } from './events.js'

const { options, events, nodes } = workerData
try {
  const session = { snapshotEvents: () => events, surface: { nodes } }
  parentPort.postMessage({ result: searchEvents({ ...options, session, regex: true }) })
} catch (error) {
  parentPort.postMessage({ error: error instanceof Error ? error.message : String(error) })
}
