import type { RenderElement } from 'claude-code'
import { expect, mock, test } from 'claude-code/testing'

import { agentSegs, elapsedText, fit, modelName, weekColor, weekText, renderFlow, routeOf, parseProgress, planOf, reduceEvents, reduceJournal, tokens, totalOf } from './register.tsx'

const P = 'mission-control'
const TOOL = 'mcp__mission-control__mission'
const SURFACES = ['terminal', 'desktop'] as const
const BAND = {
  component: 'AbovePrompt',
  props: { hasSurvey: false, isWorking: false, maxRows: 10, bodyColumns: 100, scroll: { offset: 0, bodyRows: 9 }, view: {} },
} as const

// what the band shows, one string per row (a Box's Text children joined)
async function shown(ui: { findAll: (q: any) => Promise<any[]> }): Promise<string> {
  const rows = await ui.findAll({ type: 'Box' })
  return rows.map(r => r.children.filter((c: any) => c?.type === 'Text').map((c: any) => textOf(c)).join('')).filter(Boolean).join('\n')
}
const textOf = (c: any): string => (typeof c === 'string' ? c : (c?.children ?? c?.props?.children ?? []).map(textOf).join(''))

test('reduceEvents folds start/completed and skips junk', async () => {
  const lines = [
    '{"event":"worker.started","id":"a","task":"WM-1","role":"executor","name":"Sol","model":"gpt-5","effort":"high","ts":1000}',
    '{"event":"worker.started","id":"b","task":"-","role":"reviewer","name":"","model":"","effort":"","ts":2000}',
    'not json',
    '',
    '{"event":"worker.completed","id":"a","exit":0,"ts":5000}',
    '{"event":"worker.completed","id":"b","exit":1,"ts":6000}',
    '{"event":"worker.completed","id":"ghost","exit":0,"ts":7000}',
    '{"event":"other"}',
  ].join('\n')
  const ws = reduceEvents(lines)
  expect(ws).toHaveLength(2)
  expect(ws[0]).toMatchObject({ id: 'a', name: 'Sol', status: 'completed', exit: 0, endedAt: 5000 })
  expect(ws[1]).toMatchObject({ id: 'b', name: 'reviewer', status: 'failed', exit: 1 })
  expect(reduceEvents('garbage\n{')).toEqual([])
  expect(reduceEvents('{"event":"worker.started","id":"c","role":"x","ts":1}')[0]?.status).toBe('running')
})

test('mission tool sets task/stage and raises a decision', async $ => {
  const r = await $.tool.call({ tool: TOOL, task: 'WM-081', stage: 'EXECUTING', next: 'review' } as any)
  expect((r as any).result).toBe('ok')
  const d = await $.tool.call({ tool: TOOL, decision: { title: 'Ship?', body: 'tests green' } } as any)
  expect(String((d as any).result)).toContain('Card shown')
  const ui = await $.ui.mount({ plugin: P, surface: 'terminal', ...BAND })
  expect(await ui.find({ type: 'Text', text: /Ship\?/ })).toBeDefined()
  await ui.unmount()
  await $.tool.call({ tool: TOOL, decision: null } as any)
  const ui2 = await $.ui.mount({ plugin: P, surface: 'terminal', ...BAND })
  expect(await shown(ui2)).toMatch(/WM-081.*EXECUTING/)
  await ui2.unmount()
})

test('band is silent when idle', async ($, on) => {
  // the engine's own band beneath: the plugin passing to it means it drew nothing
  on('ui.render', { component: 'AbovePrompt' }, (h$, e) => h(h$.ui.resolve(e).Box, { key: 'engine' }) as RenderElement)
  for (const surface of SURFACES) {
    const ui = await $.ui.mount({ plugin: P, surface, ...BAND })
    expect(await ui.find({ key: 'engine' })).toBeDefined()
    expect(await ui.find({ type: 'Text' })).toBeUndefined()
    await ui.unmount()
  }
})

test('band line shows the task after a mission update', async $ => {
  await $.command.run({ command: 'flow', args: 'off' } as any)
  await $.tool.call({ tool: TOOL, task: 'WM-081', stage: 'EXECUTING', next: 'review' } as any)
  for (const surface of SURFACES) {
    const ui = await $.ui.mount({ plugin: P, surface, ...BAND })
    const line = await shown(ui)
    expect(line).toMatch(/WM-081.*EXECUTING/)
    expect(line).toContain('→ review')
    await ui.unmount()
  }
})

test('decision card buttons submit the choice and clear the card', async ($, on) => {
  const submitted: string[] = []
  on('prompt.submit', (_$, e) => {
    submitted.push(e.text)
    return { text: e.text }
  })
  for (const surface of SURFACES) {
    await $.tool.call({ tool: TOOL, task: 'WM-9', decision: { title: 'Ship?', body: 'tests green', options: ['yes', 'no'] } } as any)
    const ui = await $.ui.mount({ plugin: P, surface, ...BAND })
    expect(await ui.findAll({ type: 'Button' })).toHaveLength(2)
    await ui.press({ key: 'opt-1' })
    expect(submitted.at(-1)).toContain('Ship? → 使用者選擇：no')
    expect(await ui.findAll({ type: 'Button' })).toHaveLength(0)
    await ui.unmount()
  }
  expect(submitted).toHaveLength(2)
})

test('expanded /flow view: one line per live item, current task only', async ($, on) => {
  on('ui.render', { component: 'AbovePrompt' }, (h$, e) => h(h$.ui.resolve(e).Box, { key: 'engine' }) as RenderElement)
  const ui = await $.ui.mount({ plugin: P, surface: 'terminal', ...BAND })
  await ui.unmount()
  const els = { Box: 'Box', Text: 'Text' }
  const base = { cost: 1, d: null, now: 0, b: null, wfs: [], f: null, ps: {}, as: [], cols: 200 }
  const ws = [
    { id: 'a', name: 'Sol', role: 'executor', model: '', effort: '', task: 'T1', status: 'completed', startedAt: 0, endedAt: 240000 },
    { id: 'b', name: 'Luna', role: 'executor', model: '', effort: '', task: 'OLD', status: 'completed', startedAt: 0, endedAt: 1 },
  ]
  const text = JSON.stringify(renderFlow(els, { ...base, ws, m: { task: 'T1', stage: 'DONE', risk: 'NORMAL', next: 'ship' } } as any))
  expect(text).toContain('Sol')
  expect(text).not.toContain('Luna')
  expect(text).toContain('ship')
  expect(JSON.stringify(renderFlow(els, { ...base, ws: [], m: { risk: 'NORMAL' } } as any))).toContain('沒有工作中的')
})

test('totalOf and reduceJournal', async () => {
  expect(totalOf(['+3 Sol executor', '+1 Astra reviewer', 'one more'])).toBe(5)
  const j = [
    '{"type":"launched"}',
    '{"type":"started","agentId":"a","label":"test","phase":"Test"}',
    '{"type":"started","agentId":"b","label":"review:api","phase":"Review"}',
    '{"type":"result","agentId":"a","result":"ok"}',
  ].join('\n')
  expect(reduceJournal('wf_x', j)).toEqual({ done: 1, total: 2, phase: 'Review', running: ['review:api'] })
})

test('expansion preview gates spawns, then enforces the chosen cap', async ($, on) => {
  const ran: string[] = []
  on('tool.call', { tool: 'Agent' }, () => (ran.push('agent'), { result: 'spawned' } as any))
  on('tool.call', { tool: 'Bash' }, () => (ran.push('bash'), { result: { stdout: '', stderr: '' } } as any))
  on('prompt.submit', (_$, e) => ({ text: e.text }))
  const agent = () => $.tool.call({ tool: 'Agent', prompt: 'x', description: 'x' } as any) as Promise<any>
  const codex = (cmd: string) => $.tool.call({ tool: 'Bash', command: cmd } as any) as Promise<any>

  // no expansion raised yet: unlimited
  expect((await agent()).deny).toBeUndefined()
  await $.tool.call({ tool: TOOL, expansion: { adding: ['+3 Sol executor', '+1 Astra reviewer'], purpose: 'A/B/C' } } as any)
  expect(String((await agent()).deny)).toContain('waiting for the person')
  expect(String((await codex('dispatch-codex -- codex exec hi')).deny)).toContain('waiting for the person')
  expect((await codex('ls')).deny).toBeUndefined()

  const ui = await $.ui.mount({ plugin: P, surface: 'terminal', ...BAND })
  expect(await shown(ui)).toMatch(/準備  \+3 Sol executor、\+1 Astra reviewer/)
  await ui.press({ key: 'opt-1' }) // 只允許 2 個
  await ui.unmount()

  expect((await codex('codex exec a & codex exec b; wait')).deny).toBeUndefined()
  expect(String((await agent()).deny)).toContain('budget used up (2/2)')
  // mission done lifts the cap
  await $.tool.call({ tool: TOOL, stage: 'DONE' } as any)
  expect((await agent()).deny).toBeUndefined()
  expect(ran).toEqual(['agent', 'bash', 'bash', 'agent'])
})

test('typing instead of pressing drops the card and grants nothing', async ($, on) => {
  on('prompt.submit', (_$, e) => ({ text: e.text }))
  on('tool.call', { tool: 'Agent' }, () => ({ result: 'spawned' } as any))
  await $.tool.call({ tool: TOOL, expansion: { adding: ['+2 Sol'] } } as any)
  await $.prompt.submit({ text: 'wait, explain first' } as any)
  const r: any = await $.tool.call({ tool: 'Agent', prompt: 'x', description: 'x' } as any)
  expect(String(r.deny)).toContain('budget used up (0/0)')
})

test('Workflow is refused while an expansion waits and when the budget is empty', async ($, on) => {
  on('tool.call', { tool: 'Workflow' }, () => ({ result: 'launched' } as any))
  on('prompt.submit', (_$, e) => ({ text: e.text }))
  const wf = () => $.tool.call({ tool: 'Workflow', script: 'x' } as any) as Promise<any>
  expect((await wf()).deny).toBeUndefined()
  await $.tool.call({ tool: TOOL, expansion: { adding: ['+4 reviewers'] } } as any)
  expect(String((await wf()).deny)).toContain('waiting for the person')
  const ui = await $.ui.mount({ plugin: P, surface: 'terminal', ...BAND })
  await ui.press({ key: 'opt-0' }) // 允許 → cap 4
  await ui.unmount()
  expect((await wf()).deny).toBeUndefined()
  await $.tool.call({ tool: TOOL, expansion: { adding: ['+1'] } } as any)
  const ui2 = await $.ui.mount({ plugin: P, surface: 'terminal', ...BAND })
  await ui2.press({ key: 'opt-2' }) // 停止 → cap 0
  await ui2.unmount()
  expect(String((await wf()).deny)).toContain('budget is 0')
})

test('parseProgress reads tokens, model, counts and prices it', async () => {
  const out = [
    '{"type":"event_msg","payload":{"type":"token_count","info":{"total_token_usage":{"input_tokens":1000000,"cached_input_tokens":800000,"output_tokens":50000}}}}',
    '"model":"gpt-6.1-sol" "reasoning_effort":"xhigh" ',
    '42',
    '3',
    '{"type":"event_msg","payload":{"type":"item_completed","item":{"type":"AgentMessage","content":[{"type":"Text","text":"量測  532/532\\n完成"}]}}}',
  ].join('\n')
  const p = parseProgress(out, false)
  expect(p).toMatchObject({ model: 'gpt-6.1-sol', effort: 'xhigh', input: 1000000, cached: 800000, output: 50000, commands: 42, edits: 3, lastMessage: '量測 532/532 完成' })
  // 200k × $2 + 800k × $0.10 + 50k × $10 = 0.4 + 0.08 + 0.5
  expect(Math.abs((p.usd ?? 0) - 0.98) < 1e-9).toBe(true)
  expect(parseProgress('\n"model":"unknown-x"\n0\n0\n', true).usd).toBeNull()
  expect(tokens(1234567)).toBe('1.2M')
})

test('elapsed time and real progress, never a guessed remainder', async () => {
  const plan = { startedAt: 0, baseUsd: 1, minutes: [20, 40] as [number, number], usd: [1, 2] as [number, number] }
  expect(elapsedText(plan, 10 * 60000)).toBe('10m')
    expect(planOf({ minutes: [40, 20], usd: [1, 2] })).toEqual({ minutes: [20, 40], usd: [1, 2] })
  expect(planOf({ minutes: [1], usd: [1, 2] })).toBeUndefined()
})

test('plan on the mission tool shows remaining time in the band', async ($, on) => {
  mock.clock(on, { now: 0 })
  await $.tool.call({ tool: TOOL, task: 'WEB-1', stage: 'EXECUTING', plan: { minutes: [20, 40], usd: [1, 2] } } as any)
  for (const surface of SURFACES) {
    const ui = await $.ui.mount({ plugin: P, surface, ...BAND })
    expect(await shown(ui)).toMatch(/0m/)
    await ui.unmount()
  }
})

test('fit counts CJK as two cells', async () => {
  expect(fit('abc', 10)).toBe('abc')
  expect(fit('使用者決定', 6)).toBe('使用…')
  expect(fit('abcdef', 4)).toBe('abc…')
})

test('route: chosen model beside the one the worker actually ran', async () => {
  const m = { task: 'WM-9', risk: 'NORMAL', route: { model: 'Astra', source: 'Opus 明確指定', reason: '完整性驗收' } } as any
  const w = { id: 'a', name: 'r', role: 'reviewer', model: '', effort: '', task: 'WM-9', status: 'running', startedAt: 0 } as any
  expect(routeOf({ risk: 'NORMAL' } as any, [], {})).toBeNull()
  expect(routeOf(m, [], {})).toMatchObject({ actual: '', isMismatch: false })
  expect(routeOf(m, [{ ...w, model: 'gpt-6-astra' }], {})).toMatchObject({ actual: 'gpt-6-astra', isMismatch: false, reason: '完整性驗收' })
  // the rollout's model wins over the wrapper's flag
  expect(routeOf(m, [{ ...w, model: 'gpt-6-astra' }], { a: { model: 'gpt-6.1-sol' } as any })).toMatchObject({ actual: 'gpt-6.1-sol', isMismatch: true })
})

test('route set via the mission tool shows in the band', async ($, on) => {
  mock.clock(on, { now: 0 })
  await $.command.run({ command: 'flow', args: 'off' } as any)
  await $.tool.call({ tool: TOOL, task: 'WM-9', stage: 'EXECUTING', route: { model: 'Astra', source: 'Opus 明確指定' } } as any)
  const ui = await $.ui.mount({ plugin: P, surface: 'terminal', ...BAND })
  expect(await shown(ui)).toMatch(/WM-9  EXECUTING  Astra/)
  await ui.unmount()
})

test('route: a subagent spawned after the route is what actually ran', async ($, on) => {
  // the engine beneath: starts the agent on the model the call named
  const clock = mock.clock(on, { now: 0 })
  on('agent.spawn', (_$, e) => ({ model: e.model ?? 'claude-opus-5-5', agentId: `ag-${e.model}-${clock.now()}` }))
  await $.agent.spawn({ prompt: 'before', model: 'claude-haiku-5-5' } as any)
  await clock.advance(1000)
  await $.tool.call({ tool: TOOL, task: 'WM-9', stage: 'EXECUTING', route: { model: 'haiku', source: 'Opus 明確指定' } } as any)
  const band = async () => {
    const ui = await $.ui.mount({ plugin: P, surface: 'terminal', ...BAND })
    const t = await shown(ui)
    await ui.unmount()
    return t
  }
  // the spawn before the route does not count
  expect(await band()).toMatch(/尚未派工/)
  await $.agent.spawn({ prompt: 'p', model: 'claude-haiku-5-5' } as any)
  await clock.advance(1000)
  expect(await band()).toMatch(/haiku ← Opus 明確指定\s+✓ Haiku 5.5/)
  await $.agent.spawn({ prompt: 'p', model: 'claude-sonnet-5-5' } as any)
  expect(await band()).toMatch(/▲ 實際 Sonnet 5.5/)
})

test('every dispatch fills the band: a subagent sets task and route; a mission-tool route stays', async ($, on) => {
  const clock = mock.clock(on, { now: 0 })
  on('agent.spawn', (_$, e) => ({ model: e.model ?? 'claude-opus-5-5', agentId: `ag-${clock.now()}` }))
  const band = async () => {
    const ui = await $.ui.mount({ plugin: P, surface: 'terminal', ...BAND })
    const t = await shown(ui)
    await ui.unmount()
    return t
  }
  await $.agent.spawn({ prompt: 'p', description: '查進箱路徑', subagentType: 'Explore', parentModel: 'claude-opus-5-5', model: 'claude-haiku-5-5' } as any)
  expect(await band()).toMatch(/查進箱路徑  EXECUTING/)
  expect(await band()).toMatch(/Haiku 5.5 ← Opus 5.5 明確指定\s+✓ Haiku 5.5/)
  await clock.advance(1000)
  await $.agent.spawn({ prompt: 'p', description: '整理', subagentType: 'general-purpose', parentModel: 'claude-opus-5-5' } as any)
  expect(await band()).toMatch(/Opus 5.5 ← 預設（general-purpose）/)
  // the mission tool's route holds while its task is open
  await $.tool.call({ tool: TOOL, task: 'WM-1', route: { model: 'Astra', source: '使用者指定' } } as any)
  await clock.advance(1000)
  await $.agent.spawn({ prompt: 'p', description: 'x', subagentType: 'Explore', parentModel: 'claude-opus-5-5', model: 'claude-haiku-5-5' } as any)
  expect(await band()).toMatch(/WM-1[\s\S]*Astra ← 使用者指定\s+▲ 實際 Haiku 5.5/)
  // once done, the next spawn starts a new task on the band
  await $.tool.call({ tool: TOOL, stage: 'DONE' } as any)
  await $.agent.spawn({ prompt: 'p', description: '下一件事', subagentType: 'Explore', parentModel: 'claude-opus-5-5' } as any)
  expect(await band()).toMatch(/下一件事  EXECUTING/)
})

test('weekly limit: fill and this task\'s share; same model in two spellings is not a mismatch', async () => {
  expect(weekText(null, { risk: 'NORMAL' })).toBeNull()
  expect(weekText({ pct: 42.4 }, { risk: 'NORMAL', weekBase: 36 })).toBe('週42% +6%')
  expect(weekText({ pct: 36.2 }, { risk: 'NORMAL', weekBase: 36 })).toBe('週36%')
  // reset time only once it matters; local weekday + time
  const at = new Date(2026, 9, 15, 8, 0).toISOString()
  expect(weekText({ pct: 97, resetsAt: at }, { risk: 'NORMAL' })).toBe('週97% ↻四08:00')
  expect(weekText({ pct: 50, resetsAt: at }, { risk: 'NORMAL' })).toBe('週50%')
  expect([weekColor({ pct: 79 }), weekColor({ pct: 80 }), weekColor({ pct: 95 })]).toEqual([undefined, 'yellow', 'red'])
  expect(modelName('claude-opus-5-5')).toBe('Opus 5.5')
  expect(modelName('gpt-6.1')).toBe('gpt-6.1')
  const r = routeOf({ risk: 'NORMAL', route: { model: 'Opus 5.5', source: '使用者指定', at: 0 } }, [], {}, { a: { model: 'claude-opus-5-5', at: 1 } })
  expect(r).toMatchObject({ actual: 'Opus 5.5', isMismatch: false })
})

test('agents: count first, shared leading words dropped, same ones folded', () => {
  const a = (d: string) => ({ id: d, description: d, type: 'general-purpose', status: 'running' })
  const t = (segs: any[]) => segs.map(x => x[0]).join('')
  expect(t(agentSegs([a('R3 scan ads data'), a('R3 scan ads app'), a('R3 scan n8n')]))).toBe('● 3 ads data  ·  ads app  ·  n8n')
  expect(t(agentSegs([a('審查'), a('審查')]))).toBe('● 2 審查 ×2')
  expect(t(agentSegs([a('R3 scan ads data')]))).toBe('● R3 scan ads data')
})
