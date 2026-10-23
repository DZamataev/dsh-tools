/**
 * Host half of device-reservations: authenticated routes on the Web server
 * for the rn-looky machine ledger (`~/.looky/ledger.json`).
 *
 * `GET /device-reservations/devices` lists every device with the project
 * (worktree) that reserved it, the run or agent-device session leasing it, and
 * whether it is connected. Connection state comes from
 * `scripts/projectTooling.js device list --json` (adb / simctl / devicectl;
 * claims unchanged) of one registered worktree; the tooling's own listing
 * judges standing relative to the worktree it runs in, so the machine-wide
 * view is rebuilt from the raw records, the ledger's worktree registry, and
 * the tooling's process-identity rule for leases.
 *
 * `POST /device-reservations/action` reserves, releases, takes over, or
 * stops the run on one device by running the tooling of the worktree the
 * action is for (see `planAction`), then answers the fresh list. Actions run
 * one at a time. Nothing here writes the ledger itself.
 */

import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { ActionError, ACTIONS, bootIdOf, deviceRows, devicesOf, envelopeData, planAction, projectName, sameBoot } from './normalize.js'

/** Cordis function-plugin name. */
export const name = 'device-reservations'
/** The route carrier and the browser trust fence guarding the routes. */
export const inject = ['webServer', 'connection']

/** GET route returning the devices payload. */
export const DEVICES_PATH = '/device-reservations/devices'
/** POST route performing one device action and returning the devices payload. */
export const ACTION_PATH = '/device-reservations/action'

const TOOLING = ['scripts', 'projectTooling.js']
const MAX_BODY_BYTES = 4096

const DEFAULTS = {
  checkout: '',
  ledgerPath: '~/.looky/ledger.json',
  node: '',
  timeoutMs: 30_000,
  actionTimeoutMs: 120_000,
}

const expandHome = path => (path === '~' ? homedir() : path.startsWith('~/') ? join(homedir(), path.slice(2)) : path)

function validate(raw) {
  if (raw !== undefined && raw !== null && (typeof raw !== 'object' || Array.isArray(raw))) {
    return { issues: [{ message: 'device-reservations: config must be an object' }] }
  }
  const value = { ...DEFAULTS, ...(raw ?? {}) }
  const issues = []
  const issue = (path, message) => issues.push({ path: [path], message: `device-reservations: ${path} ${message}` })
  const absolute = path => typeof path === 'string' && expandHome(path).startsWith('/')
  if (!(value.checkout === '' || absolute(value.checkout))) issue('checkout', 'must be empty (any registered worktree) or an absolute path / ~/ path')
  if (!absolute(value.ledgerPath)) issue('ledgerPath', 'must be an absolute path or start with ~/')
  if (typeof value.node !== 'string') issue('node', 'must be a path to a Node executable, or empty for the DSH runtime')
  for (const key of ['timeoutMs', 'actionTimeoutMs']) {
    if (!Number.isInteger(value[key]) || value[key] < 1_000 || value[key] > 600_000) issue(key, 'must be an integer from 1000 to 600000')
  }
  if (issues.length > 0) return { issues }
  return { value: { ...value, checkout: value.checkout === '' ? '' : expandHome(value.checkout), ledgerPath: expandHome(value.ledgerPath) } }
}

/** Plugin configuration validated at activation (Standard Schema form). */
export const Config = { '~standard': { version: 1, vendor: 'device-reservations', validate } }

/**
 * Run a command; resolves with stdout, rejects with an Error carrying `stdout`, `stderr` and `code`.
 * @param {string} file - executable.
 * @param {string[]} args - arguments.
 * @param {import('node:child_process').ExecFileOptions} options - spawn options.
 * @returns {Promise<string>} standard output.
 */
function run(file, args, options) {
  return new Promise((resolve, reject) => {
    execFile(file, args, { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024, ...options }, (error, stdout, stderr) => {
      if (error) {
        reject(Object.assign(error, { stdout, stderr }))
        return
      }
      resolve(stdout)
    })
  })
}

/** `ps -o <field>= -p <pid>`: the value, '' when the pid is gone, null when ps itself failed. */
async function psField(pid, field, signal) {
  try {
    return (await run('ps', ['-o', `${field}=`, '-p', String(pid)], { signal })).trim()
  } catch (error) {
    if (error?.code === 1 && !error.killed) return ''
    return null
  }
}

/**
 * Whether a recorded lease still names the same live process ({pid, bootId, startTime}).
 * @param {Record<string, any>} lease - ledger lease record.
 * @param {string | null} bootId - current boot id, null when unknown.
 * @param {AbortSignal} signal - request lifetime.
 * @returns {Promise<boolean>} liveness.
 */
async function leaseLive(lease, bootId, signal) {
  if (!Number.isInteger(lease.pid) || lease.pid <= 0) return false
  if (bootId === null || !sameBoot(lease.bootId, bootId)) return false
  try {
    process.kill(lease.pid, 0)
  } catch (error) {
    // EPERM: the process exists under another user.
    if (error?.code !== 'EPERM') return false
  }
  const state = await psField(lease.pid, 'stat', signal)
  // An unreadable state is not evidence of death; the start-time check below still applies.
  if (state === '' || (state !== null && state.startsWith('Z'))) return false
  if (lease.startTime) {
    const startTime = await psField(lease.pid, 'lstart', signal)
    if (!startTime || startTime !== lease.startTime) return false
  }
  return true
}

function failureText(error) {
  if (error instanceof ActionError) return error.message
  if (error?.name === 'AbortError') return 'aborted'
  if (error?.killed) return 'rn-looky tooling timed out'
  if (error?.code === 'ENOENT') return `cannot run ${error.path ?? 'command'}`
  const stderr = typeof error?.stderr === 'string' ? error.stderr.trim().split('\n').filter(Boolean).pop() : ''
  return stderr || (error instanceof Error ? error.message : String(error))
}

function sendJson(res, status, body) {
  res.statusCode = status
  res.setHeader('content-type', 'application/json; charset=utf-8')
  res.setHeader('cache-control', 'no-store')
  res.end(JSON.stringify(body))
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0
    const chunks = []
    req.on('data', (chunk) => {
      size += chunk.length
      if (size > MAX_BODY_BYTES) {
        reject(new ActionError('invalid', 'request body too large'))
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
    req.on('error', reject)
  })
}

function parseRequest(text) {
  let body
  try {
    body = JSON.parse(text)
  } catch {
    throw new ActionError('invalid', 'request body is not JSON')
  }
  if (body === null || typeof body !== 'object' || !ACTIONS.includes(body.action) || typeof body.alias !== 'string') {
    throw new ActionError('invalid', `request needs action (${ACTIONS.join(', ')}) and alias`)
  }
  if (body.worktreeId !== undefined && typeof body.worktreeId !== 'string') throw new ActionError('invalid', 'worktreeId must be a string')
  if (body.force !== undefined && typeof body.force !== 'boolean') throw new ActionError('invalid', 'force must be a boolean')
  return { action: body.action, alias: body.alias, worktreeId: body.worktreeId, force: body.force === true }
}

/**
 * Register the routes; in-flight tooling runs end with the plugin.
 * @param {import('@deepseek-ai/cordis').Context} ctx - plugin context.
 * @param {typeof DEFAULTS} config - validated configuration (paths expanded).
 */
export function apply(ctx, config) {
  const lifetime = new AbortController()
  ctx.effect(() => () => lifetime.abort(), 'device-reservations: abort tooling runs')

  const node = config.node === '' ? process.execPath : config.node
  // The DSH runtime's executable is Electron; it runs scripts as Node only with this flag.
  const env = config.node === '' ? { ...process.env, ELECTRON_RUN_AS_NODE: '1' } : process.env
  const hasTooling = path => existsSync(join(path, ...TOOLING))

  /** Run one worktree's tooling with `--json`; a failing command's envelope message becomes the error. */
  const tooling = async (cwd, args, timeout, signal) => {
    let stdout
    try {
      stdout = await run(node, [join(cwd, ...TOOLING), ...args, '--json'], { cwd, env, timeout, signal })
    } catch (error) {
      if (typeof error?.stdout === 'string' && error.stdout.trim().startsWith('{')) return error.stdout
      throw error
    }
    return stdout
  }

  const readLedger = async () => {
    let ledger
    try {
      ledger = JSON.parse(await readFile(config.ledgerPath, 'utf8'))
    } catch (error) {
      throw new Error(`cannot read the ledger ${config.ledgerPath} (${error?.code ?? error?.name ?? 'Error'})`)
    }
    const worktrees = (Array.isArray(ledger?.worktrees) ? ledger.worktrees : [])
      .filter(item => item !== null && typeof item === 'object' && typeof item.id === 'string' && typeof item.path === 'string')
      .map(item => ({ id: item.id, path: item.path, project: projectName(item.path), usable: existsSync(item.path) && hasTooling(item.path) }))
    const devices = (Array.isArray(ledger?.devices) ? ledger.devices : []).filter(item => item !== null && typeof item === 'object')
    return { worktrees, devices }
  }

  const listingCheckout = (worktrees) => {
    if (config.checkout !== '') {
      if (!hasTooling(config.checkout)) throw new Error(`no rn-looky tooling at ${join(config.checkout, ...TOOLING)}`)
      return config.checkout
    }
    const found = worktrees.find(item => item.usable)
    if (found === undefined) throw new Error(`no worktree registered in ${config.ledgerPath} has ${join(...TOOLING)}`)
    return found.path
  }

  const readBootId = async (signal) => {
    try {
      return bootIdOf(await run('sysctl', ['-n', 'kern.boottime'], { signal }))
    } catch (error) {
      ctx.logger.warn(`device-reservations: boot id unavailable, leases count as ended: ${failureText(error)}`)
      return null
    }
  }

  /** Rows from the ledger; `discover` refreshes connection state through the tooling first. */
  const collect = async (discover) => {
    const signal = AbortSignal.any([lifetime.signal, AbortSignal.timeout(config.timeoutMs)])
    const [ledger, bootId] = await Promise.all([readLedger(), readBootId(signal)])
    const devices = discover
      ? devicesOf(await tooling(listingCheckout(ledger.worktrees), ['device', 'list'], config.timeoutMs, signal))
      : ledger.devices
    const live = new Map()
    await Promise.all(devices.map(async (device) => {
      if (device.lease !== null && typeof device.lease === 'object') live.set(device.lease, await leaseLive(device.lease, bootId, signal))
    }))
    return { worktrees: ledger.worktrees, devices: deviceRows(devices, ledger.worktrees, lease => live.get(lease) === true, existsSync) }
  }

  // Concurrent list requests share one collection; actions queue behind each other.
  let inflight
  const shared = () => {
    inflight ??= collect(true).finally(() => { inflight = undefined })
    return inflight
  }
  let queue = Promise.resolve()
  const perform = (request) => {
    const next = queue.then(async () => {
      const { worktrees, devices } = await collect(false)
      const plan = planAction(request, devices, worktrees)
      const signal = AbortSignal.any([lifetime.signal, AbortSignal.timeout(config.actionTimeoutMs)])
      ctx.logger.info(`device-reservations: ${plan.args.join(' ')} (in ${plan.cwd})`)
      const data = envelopeData(await tooling(plan.cwd, plan.args, config.actionTimeoutMs, signal))
      return typeof data.outcome === 'string' ? data.outcome : 'ok'
    })
    queue = next.catch(() => {})
    return next
  }

  const rejected = (req, res) => {
    const rejection = ctx.connection.requestRejection(req)
    if (rejection === undefined) return false
    res.statusCode = rejection
    res.end()
    return true
  }

  const payload = async (extra) => {
    try {
      return { fetchedAt: Date.now(), ...(await shared()), error: null, ...extra }
    } catch (error) {
      const message = failureText(error)
      ctx.logger.warn(`device-reservations: collection failed: ${message}`)
      return { fetchedAt: Date.now(), worktrees: [], devices: null, error: message, ...extra }
    }
  }

  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: DEVICES_PATH,
    handler: async (req, res) => {
      if (rejected(req, res)) return
      if (req.method !== 'GET') {
        res.setHeader('allow', 'GET')
        sendJson(res, 405, { error: 'method not allowed' })
        return
      }
      const body = await payload({})
      if (!lifetime.signal.aborted) sendJson(res, 200, body)
    },
  }), `device-reservations: GET ${DEVICES_PATH}`)

  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: ACTION_PATH,
    handler: async (req, res) => {
      if (rejected(req, res)) return
      if (req.method !== 'POST') {
        res.setHeader('allow', 'POST')
        sendJson(res, 405, { error: 'method not allowed' })
        return
      }
      let action
      let alias = null
      try {
        const request = parseRequest(await readBody(req))
        alias = request.alias
        action = { alias, ok: true, outcome: await perform(request), error: null, code: null }
      } catch (error) {
        if (lifetime.signal.aborted) return
        const message = failureText(error)
        ctx.logger.warn(`device-reservations: action failed: ${message}`)
        action = { alias, ok: false, outcome: null, error: message, code: error instanceof ActionError ? error.code : 'failed' }
      }
      const body = await payload({ action })
      if (!lifetime.signal.aborted) sendJson(res, 200, body)
    },
  }), `device-reservations: POST ${ACTION_PATH}`)
}
