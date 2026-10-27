/**
 * Pure parsers for the git output the Host half reads. No process or
 * filesystem access, so the tests feed them literal output.
 */

/**
 * Parse `git status --porcelain=v2 --branch -z` output.
 * @param {string} stdout - NUL-separated records.
 * @param {number} maxLines - most short-status lines to keep.
 * @returns {{
 *   branch: string | null, detached: boolean, oid: string | null, upstream: string | null,
 *   ahead: number | null, behind: number | null,
 *   staged: number, unstaged: number, untracked: number, conflicted: number, total: number,
 *   lines: { xy: string, path: string, orig: string | null }[], truncated: boolean,
 * }} branch facts, change counts, and `git status --short`-style lines.
 */
export function parseStatusV2(stdout, maxLines) {
  const result = {
    branch: null, detached: false, oid: null, upstream: null, ahead: null, behind: null,
    staged: 0, unstaged: 0, untracked: 0, conflicted: 0, total: 0, lines: [], truncated: false,
  }
  const records = stdout.split('\0')
  const push = (xy, path, orig) => {
    result.total += 1
    if (result.lines.length < maxLines) result.lines.push({ xy, path, orig })
    else result.truncated = true
  }
  for (let index = 0; index < records.length; index += 1) {
    const record = records[index]
    if (record === '') continue
    if (record.startsWith('# ')) {
      const [key, ...rest] = record.slice(2).split(' ')
      const value = rest.join(' ')
      if (key === 'branch.oid') result.oid = value === '(initial)' ? null : value
      else if (key === 'branch.head') {
        result.detached = value === '(detached)'
        result.branch = result.detached ? null : value
      } else if (key === 'branch.upstream') result.upstream = value
      else if (key === 'branch.ab') {
        const match = /^\+(\d+) -(\d+)$/.exec(value)
        if (match !== null) {
          result.ahead = Number(match[1])
          result.behind = Number(match[2])
        }
      }
      continue
    }
    const kind = record[0]
    if (kind === '?') {
      result.untracked += 1
      push('??', record.slice(2), null)
    } else if (kind === '1' || kind === '2' || kind === 'u') {
      // Fixed fields precede the path, which itself may contain spaces.
      const fixed = kind === '1' ? 8 : kind === '2' ? 9 : 10
      const parts = record.split(' ')
      const xy = parts[1] ?? '..'
      const path = parts.slice(fixed).join(' ')
      let orig = null
      if (kind === '2') {
        orig = records[index + 1] ?? null
        index += 1
      }
      if (kind === 'u') result.conflicted += 1
      else {
        if (xy[0] !== '.') result.staged += 1
        if (xy[1] !== '.') result.unstaged += 1
      }
      push(xy.replaceAll('.', ' '), path, orig)
    }
    // '!' (ignored) records are not requested.
  }
  return result
}

/**
 * Parse `git log -1 --format=%h%x1f%s%x1f%ct%x1f%an%x1f%ae` output.
 * @param {string} stdout - one unit-separated record.
 * @returns {{ sha: string, subject: string, time: number, author: string, email: string } | null} last commit, or null when absent.
 */
export function parseLastCommit(stdout) {
  const [sha, subject, seconds, author, email] = stdout.replace(/\n$/, '').split('\x1f')
  if (sha === undefined || sha === '' || subject === undefined) return null
  const time = Number(seconds) * 1000
  return { sha, subject, time: Number.isFinite(time) ? time : 0, author: author ?? '', email: email ?? '' }
}

/**
 * Parse `du -sk <dir>` output.
 * @param {string} stdout - du output.
 * @returns {number | null} size in bytes, or null when unparseable.
 */
export function parseDuKilobytes(stdout) {
  const match = /^(\d+)\s/.exec(stdout.trim() + ' ')
  return match === null ? null : Number(match[1]) * 1024
}

/**
 * Whether failed git output means the directory is outside any repository.
 * @param {string} stderr - git stderr.
 * @returns {boolean} true for "not a git repository".
 */
export function isNotRepository(stderr) {
  return /not a git repository/i.test(stderr)
}
