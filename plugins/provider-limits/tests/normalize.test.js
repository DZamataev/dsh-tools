import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { codexPayload, opencodeGoApiBase, opencodeGoPayload, statusPayload, teamclaudePayload } from '../normalize.js'
import { Config, kindOf } from '../index.js'

const fixture = name => JSON.parse(readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8'))

test('teamclaude keeps every aggregate bucket as remaining percent', () => {
  const out = teamclaudePayload(fixture('teamclaude-quota.json'))
  assert.deepEqual(out.buckets.map(b => [b.key, b.window, b.qualifier]), [
    ['fiveHour', '5h', ''], ['weeklyShared', '7d', ''], ['weeklySonnet', '7d', 'Sonnet'], ['weeklyFable', '7d', 'Fable'],
  ].filter(([key]) => out.buckets.some(b => b.key === key)))
  assert.ok(out.accounts.length >= 2)
  assert.equal(out.accounts[0].buckets[0].remainingPct, 42)
  assert.equal(out.accounts[1].disabled, true)
})

test('codex-lb keeps the tighter of key and pool per window and resource', () => {
  const out = codexPayload(fixture('codexlb-v1-usage.json'))
  const five = out.buckets.find(b => b.window === '5h')
  assert.equal(five.remainingPct, Math.round((443 / 450) * 1000) / 10)
  assert.deepEqual(out.poolWindows.map(w => w.remainingPct), [98.5, 95.5])
})

test('codex-lb labels two resources in one window by their limit type', () => {
  const out = codexPayload({
    limits: [
      { limit_type: 'cost_usd', limit_window: 'weekly', max_value: 100, remaining_value: 99 },
      { limit_type: 'credits', limit_window: '7d', max_value: 100, remaining_value: 56 },
    ],
  })
  assert.deepEqual(out.buckets.map(b => [b.window, b.qualifier, b.remainingPct]), [['7d', 'cost_usd', 99], ['7d', 'credits', 56]])
})

test('codex-lb zero ceiling reads as exhausted', () => {
  const out = codexPayload({ limits: [{ limit_type: 'credits', limit_window: '5h', max_value: 0, remaining_value: 0 }] })
  assert.equal(out.buckets[0].remainingPct, 0)
})

test('opencode go percent is used share and non-ok status is exhausted', () => {
  const out = opencodeGoPayload({
    usage: { rolling: { status: 'ok', percent: 30 }, weekly: { status: 'rate-limited', percent: 50 }, monthly: { percent: Number.NaN } },
  })
  assert.deepEqual(out.buckets.map(b => [b.window, b.remainingPct]), [['5h', 70], ['7d', 0]])
  assert.equal(opencodeGoPayload(fixture('opencode-go-usage.json')).buckets.length, 3)
})

test('opencode go base gains /v1 only on opencode.ai', () => {
  assert.equal(opencodeGoApiBase('https://opencode.ai/zen/go'), 'https://opencode.ai/zen/go/v1')
  assert.equal(opencodeGoApiBase('https://opencode.ai/zen/go/v1/'), 'https://opencode.ai/zen/go/v1')
  assert.equal(opencodeGoApiBase('https://proxy.example/zen/go'), 'https://proxy.example/zen/go')
})

test('statuspage: unknown component does not vote; unknown indicator is trouble', () => {
  const page = { id: 'a', label: 'A', component: 'API' }
  assert.equal(statusPayload(page, { status: { indicator: 'none' }, components: [] }).ok, true)
  assert.equal(statusPayload(page, { status: { indicator: 'none' }, components: [{ name: 'API', status: 'major_outage' }] }).ok, false)
  assert.equal(statusPayload(page, { status: { indicator: 'brand-new' } }).ok, false)
})

test('route kinds follow the configured routes', () => {
  assert.equal(kindOf('anthropic', { baseURL: 'https://teamclaude.example:3443' }, {}), 'teamclaude')
  assert.equal(kindOf('anthropic', {}, {}), null)
  assert.equal(kindOf('codex-lb', { api: 'openai-responses', baseURL: 'https://lb.example/backend-api/codex' }, {}), 'codex-lb')
  assert.equal(kindOf('opencode-go', {}, {}), 'opencode-go')
  assert.equal(kindOf('openai', { baseURL: 'https://api.openai.com/v1' }, {}), null)
  assert.equal(kindOf('anthropic', { baseURL: 'https://teamclaude.example' }, { anthropic: 'none' }), null)
})

test('config applies defaults and rejects invalid values', () => {
  const ok = Config['~standard'].validate({})
  assert.equal(ok.value.cacheTtlMs, 60_000)
  assert.equal(ok.value.statusPages.length, 2)
  assert.ok(Config['~standard'].validate({ routes: { x: 'bogus' } }).issues.length > 0)
  assert.ok(Config['~standard'].validate({ pollMs: 5 }).issues.length > 0)
})
