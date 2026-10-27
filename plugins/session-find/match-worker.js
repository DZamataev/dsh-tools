// Worker entry: runs one query over Session text so a slow user regular
// expression can be stopped by terminating this thread instead of blocking
// the Host. `kind` selects the result: `search` lists matches, `highlight`
// lists the matched strings of a context window.
import { parentPort, workerData } from 'node:worker_threads'
import { compileQuery, findMatches, matchedStrings } from './search.js'

const { kind, documents, query, regex, limits, targetSeq } = workerData
const plan = compileQuery(query, regex)
parentPort.postMessage(kind === 'highlight'
  ? matchedStrings(documents, plan, targetSeq, limits)
  : findMatches(documents, plan, limits))
