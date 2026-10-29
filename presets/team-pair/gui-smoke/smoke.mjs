#!/usr/bin/env node
// Playwright smoke: drive the DSH Desktop TEST instance (DSH_HOME=~/.dsh-dev) through its Web UI
// and prove Agent Teams with per-teammate models works.
//
// Env: ROLE (opus-reviewer) LEAD_MODEL ("Claude Sonnet 5.5") TIMEOUT_MIN (20)
//      FIXTURE (/tmp/team-pair-gui-fixture) WORKSPACE (rn-looky3: sidebar workspace used as the session cwd)
//      ACCESS_MODE ("Workspace Write" = UI default; the /tmp fixture is outside the workspace so approval cards are expected and auto-approved)
//      PRESET (hero Agent Preset picker label substring, e.g. "Standard", "Pair: Claude + GPT"; default: leave the picker as is)
//      PROMPT (override the team-pair prompt; the Agent Team trigger/spawn expectations then do not apply)
//      URL (auto-read from ~/.dsh-dev/instance.log) OUT (default ./out-<ROLE>) HEADED=1
// Run: node smoke.mjs   (playwright resolved from the DSH checkout in DSH_SRC, default ~/dev/deepseek-harness)
import { readFileSync, mkdirSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const WT = process.env.DSH_SRC ?? join(homedir(), 'dev', 'deepseek-harness')
const { chromium } = await import(`${WT}/node_modules/.pnpm/playwright@1.61.1/node_modules/playwright/index.mjs`)

const HERE = dirname(fileURLToPath(import.meta.url))
const ROLE = process.env.ROLE ?? 'opus-reviewer'
const LEAD_MODEL = process.env.LEAD_MODEL ?? 'Claude Sonnet 5.5'
const TIMEOUT_MIN = Number(process.env.TIMEOUT_MIN ?? 20)
const FIXTURE = process.env.FIXTURE ?? '/tmp/team-pair-gui-fixture'
const WORKSPACE = process.env.WORKSPACE ?? 'rn-looky3'
const ACCESS_MODE = process.env.ACCESS_MODE ?? 'Workspace Write'
const PRESET = process.env.PRESET
const OUT = process.env.OUT ?? join(HERE, `out-${ROLE}`)
mkdirSync(OUT, { recursive: true })

const log = (...a) => {
  const line = `[${new Date().toISOString()}] ${a.join(' ')}`
  console.log(line)
  try { writeFileSync(join(OUT, 'run.log'), line + '\n', { flag: 'a' }) } catch {}
}

function instanceUrl() {
  if (process.env.URL) return process.env.URL
  const text = readFileSync(join(homedir(), '.dsh-dev', 'instance.log'), 'utf8')
  const hits = [...text.matchAll(/dsh web: (http:\/\/127\.0\.0\.1:\d+\/\?token=\S+)/g)]
  if (hits.length === 0) throw new Error('no "dsh web:" URL in ~/.dsh-dev/instance.log')
  return hits[hits.length - 1][1]
}

const PROMPT = process.env.PROMPT ?? `Use the team-pair skill: spawn the ${ROLE} teammate (spawn_teammate with role ${ROLE}), fix the failing tests in ${FIXTURE} yourself, then send ${ROLE} a message asking for a review and iterate until it has no findings. Wait for the reviewer before answering. Finally report what the reviewer found and which model each member ran on (use list_agents).`

const shots = []
const t0 = Date.now()
const shot = async (page, name) => {
  const file = join(OUT, `${String(shots.length + 1).padStart(2, '0')}-${name}.png`)
  await page.screenshot({ path: file })
  shots.push(file)
  log('screenshot', file)
}

const chromeDir = join(homedir(), 'Library/Caches/ms-playwright')
const browser = await chromium.launch({
  headless: process.env.HEADED !== '1',
  executablePath: join(chromeDir, 'chromium_headless_shell-1234/chrome-headless-shell-mac-arm64/chrome-headless-shell'),
})
const page = await (await browser.newContext({ viewport: { width: 1500, height: 950 }, locale: 'en-US' })).newPage()
const result = { role: ROLE, preset: PRESET ?? null, requestedLeadModel: LEAD_MODEL, fixture: FIXTURE, workspace: WORKSPACE, accessMode: ACCESS_MODE, approvals: [], status: 'unknown' }
page.on('pageerror', e => log('PAGEERROR', e.message))

const stopBtn = () => page.getByRole('button', { name: 'Stop generating' })
const composer = () => page.locator('[data-composer-input]')

async function approvePending() {
  const allow = page.getByRole('button', { name: 'Allow once' })
  let n = 0
  while (await allow.count() > 0) {
    const card = await page.getByLabel(/./).filter({ has: allow.first() }).first().innerText().catch(() => '')
    await allow.first().click({ timeout: 3000 }).catch(() => {})
    result.approvals.push(card.replace(/\s+/g, ' ').slice(0, 200))
    log('APPROVED', card.replace(/\s+/g, ' ').slice(0, 160))
    await page.waitForTimeout(500)
    if (++n > 20) break
  }
}

try {
  await page.goto(instanceUrl(), { waitUntil: 'load' })
  await page.getByRole('button', { name: 'Continue' }).click({ timeout: 8000 }).catch(() => log('no preview notice'))
  await page.getByRole('button', { name: 'Choose workspace' }).waitFor({ timeout: 30_000 })

  // New blank session in the chosen workspace.
  await page.getByRole('button', { name: 'Choose workspace' }).click()
  await page.getByRole('menuitem', { name: WORKSPACE, exact: true }).click()
  await page.waitForTimeout(800)
  // A workspace without sessions opens a blank session directly; only otherwise ask for a new one.
  if (!(await page.getByRole('button', { name: 'Choose workspace' }).innerText()).includes(WORKSPACE)) {
    await page.getByRole('button', { name: 'New session', exact: true }).first().click()
    await page.waitForTimeout(800)
  }
  await page.getByRole('button', { name: 'Choose workspace' }).waitFor()
  log('workspace chip:', await page.getByRole('button', { name: 'Choose workspace' }).innerText())

  // Access mode (Full access needs an extra risk-confirmation dialog; default Workspace Write + approvals is used).
  const accessBtn = page.getByRole('button', { name: /Access mode/ })
  if (!(await accessBtn.getAttribute('aria-label') ?? '').includes(ACCESS_MODE)) {
    await accessBtn.click()
    await page.getByRole('menuitem', { name: ACCESS_MODE, exact: true }).click()
  }
  log('access mode:', await accessBtn.getAttribute('aria-label'))

  // Agent preset (new-session hero chip; the choice locks after the first turn).
  const presetChip = page.locator('button[aria-haspopup="menu"][title*="agent preset" i]')
  await presetChip.first().waitFor({ timeout: 15_000 })
  result.presetPickerInitial = (await presetChip.first().innerText()).trim()
  log('agent preset picker (initial):', result.presetPickerInitial)
  if (PRESET) {
    await presetChip.first().click()
    const items = page.getByRole('menuitem')
    await items.first().waitFor({ timeout: 8000 })
    result.presetMenuItems = (await items.allInnerTexts()).map(t => t.replace(/\s+/g, ' ').trim())
    log('agent preset menu items:', JSON.stringify(result.presetMenuItems))
    await shot(page, 'preset-menu')
    const item = items.filter({ has: page.locator('span', { hasText: new RegExp(`^${PRESET.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`) }) }).first()
    await item.click()
    await page.waitForTimeout(1200)
  }
  result.presetPickerValue = (await presetChip.first().innerText()).trim()
  log('agent preset picker (current):', result.presetPickerValue)

  // Lead model.
  await page.getByRole('button', { name: /Select model/ }).click()
  await page.getByRole('menuitem', { name: /^Model/ }).click()
  await page.getByRole('menuitemradio', { name: LEAD_MODEL, exact: true }).first().click()
  await page.keyboard.press('Escape')
  await page.waitForTimeout(500)
  const pickerLabel = await page.getByRole('button', { name: /Select model/ }).getAttribute('aria-label')
  result.pickerLabel = pickerLabel
  log('model picker:', pickerLabel)
  if (!pickerLabel?.includes(LEAD_MODEL)) log('WARNING: picker label does not show the requested model; recording it as-is')
  result.presetPickerValueAtSend = (await presetChip.first().innerText().catch(() => '')).trim()
  log('agent preset picker (before send):', result.presetPickerValueAtSend)
  await shot(page, 'configured')

  // Send the prompt with real keystrokes.
  const input = composer()
  await input.waitFor({ state: 'visible' })
  await input.click()
  await page.keyboard.insertText(PROMPT)
  await page.waitForTimeout(300)
  await page.getByRole('button', { name: 'Send message' }).click()
  result.sentAt = new Date().toISOString()
  log('prompt sent')
  await page.waitForTimeout(3000)
  await shot(page, 'after-send')

  const deadline = Date.now() + TIMEOUT_MIN * 60_000
  let spawnShot = false
  let sawRunning = false
  let idleSince = null
  let lastShot = Date.now()
  const teamTrigger = page.locator('[data-team-action]').getByRole('button', { name: /Agent Team/i })

  while (Date.now() < deadline) {
    await approvePending()
    const running = await stopBtn().count() > 0
    if (running) { sawRunning = true; idleSince = null } else if (sawRunning && idleSince === null) idleSince = Date.now()

    const text = await page.locator('main, body').first().innerText().catch(() => '')
    // Tool cards are folded into the turn summary; the header "N subagent(s)" chip appears once a teammate exists.
    if (!spawnShot && /\b[1-9]\d* subagents?\b/i.test(text)) {
      await page.waitForTimeout(2000)
      await shot(page, 'after-spawn')
      spawnShot = true
    }
    if (Date.now() - lastShot > 120_000) { await shot(page, 'progress'); lastShot = Date.now() }
    // Idle for >8s after having run, and not awaiting an approval => turn is complete.
    if (sawRunning && idleSince !== null && Date.now() - idleSince > 8000) break
    // Very fast turns (a few seconds) can finish between polls without "Stop generating" ever being seen:
    // the turn summary "Completed in Ns" plus no stop button is enough, 10 s after sending.
    if (!sawRunning && !running && Date.now() - Date.parse(result.sentAt) > 10_000 && /Completed in/.test(text)) { await page.waitForTimeout(3000); break }
    await page.waitForTimeout(2000)
  }
  if (Date.now() >= deadline) { result.status = 'timeout'; log('TIMEOUT'); await shot(page, 'timeout') }
  else log('turn complete after', Math.round((Date.now() - t0) / 1000), 's')

  // Collect the conversation text.
  const transcript = await page.locator('[data-conversation-scroll]').first().innerText().catch(() => '')
  writeFileSync(join(OUT, 'transcript.txt'), transcript)
  const answers = await page.locator('[data-turn-process-answer]').allInnerTexts().catch(() => [])
  const finalText = (answers.length ? answers[answers.length - 1] : transcript.split('\n').slice(-60).join('\n')).trim()
  writeFileSync(join(OUT, 'final.txt'), finalText + '\n')
  result.finalMentionsReviewer = new RegExp(`review|${ROLE}`, 'i').test(finalText)
  result.finalChars = finalText.length
  log('final text chars:', finalText.length, 'mentions reviewer:', result.finalMentionsReviewer)
  await shot(page, 'final')

  // Expanded turn process (tool calls incl. spawn_teammate / send_message / list_agents), best effort.
  const summary = page.getByRole('button', { name: /^Completed in/ }).last()
  if (await summary.count() > 0) {
    await summary.click().catch(() => {})
    await page.waitForTimeout(1500)
    await shot(page, 'process-expanded')
    writeFileSync(join(OUT, 'transcript-expanded.txt'), await page.locator('[data-conversation-scroll]').first().innerText().catch(() => ''))
    await summary.click().catch(() => {})
  }

  // Team UI.
  const triggers = await teamTrigger.count()
  result.teamTriggerVisible = triggers > 0
  if (triggers > 0) {
    await teamTrigger.first().click()
    const dialog = page.getByRole('dialog', { name: 'Agent Team', exact: true })
    await dialog.waitFor({ timeout: 8000 }).catch(() => log('team dialog did not open'))
    result.teamPanelText = (await dialog.innerText().catch(() => '')).replace(/\n+/g, ' | ')
    writeFileSync(join(OUT, 'team-panel.txt'), result.teamPanelText + '\n')
    log('team panel:', result.teamPanelText.slice(0, 400))
    await shot(page, 'team-panel')
    await page.keyboard.press('Escape')
  } else {
    log('Agent Team trigger NOT visible')
    await shot(page, 'no-team-trigger')
  }
  if (result.status === 'unknown') result.status = result.finalMentionsReviewer ? 'completed' : 'completed-without-reviewer-mention'
} catch (e) {
  result.status = 'error'
  result.error = String(e?.stack ?? e)
  log('ERROR', result.error)
  await shot(page, 'error').catch(() => {})
} finally {
  result.durationSec = Math.round((Date.now() - t0) / 1000)
  result.screenshots = shots
  writeFileSync(join(OUT, 'result.json'), JSON.stringify(result, null, 2) + '\n')
  await browser.close()
}
log('RESULT', JSON.stringify({ status: result.status, durationSec: result.durationSec, approvals: result.approvals.length }))
process.exit(result.status === 'completed' ? 0 : 1)
