// Worker entry: runs one search so a slow user regular expression can be
// stopped by terminating this thread instead of blocking the Host.
import { parentPort, workerData } from 'node:worker_threads'
import { compileQuery, findMatches } from './search.js'

const { documents, query, regex, limits } = workerData
parentPort.postMessage(findMatches(documents, compileQuery(query, regex), limits))
