/**
 * Pure helpers of device-reservations: parse the rn-looky tooling's
 * `device list --json` envelope and turn its device records plus the ledger's
 * worktree registry into machine-wide rows (who reserved each device, whether
 * a run holds it right now, whether it is connected).
 *
 * Lease liveness follows the tooling's own rule
 * (`scripts/tooling/processState/processLiveness.js` in rn-looky): a lease is
 * live only while its {pid, bootId, startTime} still names the same process.
 */

const BOOT_ID_TOLERANCE_SECONDS = 2

function bootSeconds(bootId) {
  const match = /^boot-(\d+)$/.exec(String(bootId ?? ''))
  return match ? Number(match[1]) : null
}

/**
 * Whether two boot ids name the same boot (the kernel's rounding drifts by a second).
 * @param {unknown} left - recorded boot id.
 * @param {unknown} right - current boot id.
 * @returns {boolean} same boot.
 */
export function sameBoot(left, right) {
  if (left === right) return true
  const a = bootSeconds(left)
  const b = bootSeconds(right)
  return a !== null && b !== null && Math.abs(a - b) <= BOOT_ID_TOLERANCE_SECONDS
}

/**
 * Boot id from `sysctl -n kern.boottime` output, in the tooling's `boot-<sec>` form.
 * @param {string} output - sysctl output.
 * @returns {string} boot id.
 */
export function bootIdOf(output) {
  const match = /sec\s*=\s*(\d+)/.exec(output)
  return match ? `boot-${match[1]}` : output.trim()
}

/**
 * `data` of the CLI's JSON envelope; throws with the CLI's own message when it reports a failure.
 * @param {string} stdout - CLI standard output.
 * @returns {Record<string, any>} envelope data.
 */
export function envelopeData(stdout) {
  let envelope
  try {
    envelope = JSON.parse(stdout)
  } catch {
    throw new Error('rn-looky tooling printed no JSON envelope')
  }
  if (envelope === null || typeof envelope !== 'object') throw new Error('rn-looky tooling printed no JSON envelope')
  if (envelope.ok !== true) {
    throw new Error(String(envelope.error?.message ?? envelope.error?.code ?? 'rn-looky tooling reported a failure'))
  }
  return envelope.data !== null && typeof envelope.data === 'object' ? envelope.data : {}
}

/**
 * Device records of a `device list --json` envelope.
 * @param {string} stdout - CLI standard output.
 * @returns {Array<Record<string, any>>} reconciled device records.
 */
export function devicesOf(stdout) {
  const devices = envelopeData(stdout).devices
  if (!Array.isArray(devices)) throw new Error('device list returned no devices array')
  return devices.filter(device => device !== null && typeof device === 'object')
}

/**
 * Last path segment, used as the project name of a worktree.
 * @param {string} path - absolute worktree path.
 * @returns {string} project name.
 */
export function projectName(path) {
  const parts = path.split('/').filter(Boolean)
  return parts.length > 0 ? parts[parts.length - 1] : path
}

function holderOf(worktreeId, worktrees, pathExists) {
  const entry = worktrees.find(item => item !== null && typeof item === 'object' && item.id === worktreeId)
  if (entry === undefined || typeof entry.path !== 'string') {
    return { worktreeId, project: worktreeId.slice(0, 8), path: null, gone: true }
  }
  return { worktreeId, project: projectName(entry.path), path: entry.path, gone: !pathExists(entry.path) }
}

function detailsOf(device) {
  const model = typeof device.model === 'string' && device.model !== '' ? device.model : String(device.name ?? '')
  const release = String(device.release ?? '')
  const os = device.platform === 'android'
    ? `Android ${release || '?'}`
    : device.platform === 'ios' && release !== '' && !release.startsWith('iOS') ? `iOS ${release}` : release
  return [model, os].filter(Boolean).join(', ')
}

/**
 * Machine-wide rows for every device in the ledger inventory.
 * `state` is `busy` while a live lease holds the device (a run or an agent-device session),
 * else `reserved` while a reservation exists, else `free`.
 * @param {Array<Record<string, any>>} devices - reconciled device records from `device list --json`.
 * @param {Array<Record<string, any>>} worktrees - ledger worktree registry ({id, path}).
 * @param {(lease: Record<string, any>) => boolean} isLeaseLive - lease liveness by recorded process identity.
 * @param {(path: string) => boolean} pathExists - directory check.
 * @returns {Array<Record<string, any>>} rows in ledger order.
 */
export function deviceRows(devices, worktrees, isLeaseLive, pathExists) {
  return devices.map((device) => {
    const reserved = device.reservation?.worktreeId
    const reservation = typeof reserved === 'string'
      ? { ...holderOf(reserved, worktrees, pathExists), since: device.reservation.createdAt ?? null }
      : null
    const lease = device.lease
    const leased = lease?.worktreeId
    // A lease of the older shape names no worktree; it still occupies the device.
    const leaseRow = lease !== null && typeof lease === 'object'
      ? {
          ...(typeof leased === 'string'
            ? holderOf(leased, worktrees, pathExists)
            : { worktreeId: null, project: '?', path: null, gone: true }),
          live: isLeaseLive(lease),
          app: typeof lease.app === 'string' ? lease.app : null,
          agentSession: typeof lease.session === 'string' ? lease.session : null,
          since: lease.acquiredAt ?? null,
        }
      : null
    return {
      alias: String(device.alias ?? device.name ?? '?'),
      platform: device.platform === 'ios' || device.platform === 'android' ? device.platform : 'other',
      virtual: device.kind === 'simulator' || device.kind === 'emulator',
      details: detailsOf(device),
      connected: device.connected !== false,
      overWifi: device.overWifi === true,
      state: leaseRow?.live ? 'busy' : reservation !== null ? 'reserved' : 'free',
      reservation,
      lease: leaseRow,
    }
  })
}

/** Device actions the panel offers. */
export const ACTIONS = ['reserve', 'unreserve', 'unlease']

/** A refused action request, reported to the panel as is. */
export class ActionError extends Error {
  /**
   * @param {string} code - machine-readable refusal.
   * @param {string} message - human-readable reason.
   */
  constructor(code, message) {
    super(message)
    this.name = 'ActionError'
    this.code = code
  }
}

/**
 * The tooling command performing one action, run from the worktree it acts for.
 * `reserve` reserves for `worktreeId`; taking a device another project reserved or runs on needs
 * `force` (the tooling then stops that run). `unreserve` and `unlease` run from the holder's own
 * worktree; a holder whose checkout is gone is overridden with `--force` from any usable worktree.
 * @param {{action: string, alias: string, worktreeId?: string, force?: boolean}} request - panel request.
 * @param {Array<Record<string, any>>} rows - current rows from {@link deviceRows}.
 * @param {Array<{id: string, path: string, usable: boolean}>} worktrees - registered worktrees.
 * @returns {{cwd: string, args: string[]}} worktree path and tooling arguments.
 */
export function planAction(request, rows, worktrees) {
  if (!ACTIONS.includes(request.action)) throw new ActionError('invalid', `unknown action ${request.action}`)
  const row = rows.find(item => item.alias === request.alias)
  if (row === undefined) throw new ActionError('unknown-device', `no device ${request.alias} in the ledger`)
  const alias = row.alias
  const usable = id => worktrees.find(item => item.id === id && item.usable)
  const anyUsable = () => {
    const found = worktrees.find(item => item.usable)
    if (found === undefined) throw new ActionError('no-tooling', 'no registered worktree has the rn-looky tooling')
    return found
  }
  const forced = ['--force', '--confirmation', alias]
  if (request.action === 'reserve') {
    const target = usable(request.worktreeId)
    if (target === undefined) throw new ActionError('unknown-worktree', 'the target project is not a usable registered worktree')
    if (row.reservation?.worktreeId === target.id) throw new ActionError('unchanged', `${alias} is already reserved there`)
    const takeover = (row.reservation !== null && row.reservation.worktreeId !== target.id)
      || (row.lease?.live === true && row.lease.worktreeId !== target.id)
    if (takeover && request.force !== true) throw new ActionError('takeover-needed', `${alias} is held by another project`)
    return { cwd: target.path, args: ['device', 'reserve', '--alias', alias, ...(takeover ? forced : [])] }
  }
  const claim = request.action === 'unreserve' ? row.reservation : row.lease
  if (claim === null) {
    throw new ActionError('unchanged', `${alias} has no ${request.action === 'unreserve' ? 'reservation' : 'lease'}`)
  }
  const holder = claim.worktreeId === null ? undefined : usable(claim.worktreeId)
  return holder !== undefined
    ? { cwd: holder.path, args: ['device', request.action, '--alias', alias] }
    : { cwd: anyUsable().path, args: ['device', request.action, '--alias', alias, ...forced] }
}
