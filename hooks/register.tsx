import { atom, read, update } from 'claude-code'
import type { Register } from 'claude-code'

import type { Agent, Budget, Decision, Flightwake, Mission, Plan, Progress, Risk, Route, Spawned, Worker, Workflow } from '../types'

const P = 'mission-control'

const workers = atom({ plugin: 'mission-control', key: 'workers' } as const, [])
const agents = atom({ plugin: 'mission-control', key: 'agents' } as const, [])
const costUsd = atom({ plugin: 'mission-control', key: 'costUsd' } as const, 0)
const mission = atom({ plugin: 'mission-control', key: 'mission' } as const, { risk: 'NORMAL' })
const decision = atom({ plugin: 'mission-control', key: 'decision' } as const, null)
const minute = atom({ plugin: 'mission-control', key: 'minute' } as const, 0)
const budget = atom({ plugin: 'mission-control', key: 'budget' } as const, null)
const workflows = atom({ plugin: 'mission-control', key: 'workflows' } as const, [])
const fw = atom({ plugin: 'mission-control', key: 'fw' } as const, null)
const progress = atom({ plugin: 'mission-control', key: 'progress' } as const, {})
const spawned = atom({ plugin: 'mission-control', key: 'spawned' } as const, {})
const isExpanded = atom({ plugin: 'mission-control', key: 'isExpanded' } as const, true)

const RISK_MARK: Record<Risk, string> = { NORMAL: '●', WATCH: '▲', NEEDS_DECISION: '◆', BLOCKED: '■' }
const PLAN_SCHEMA = {
  type: 'object',
  properties: {
    minutes: { type: 'array', items: { type: 'number', minimum: 0 }, minItems: 2, maxItems: 2 },
    usd: { type: 'array', items: { type: 'number', minimum: 0 }, minItems: 2, maxItems: 2 },
  },
  required: ['minutes', 'usd'],
}
const DEFAULT_OPTIONS = ['繼續', '先問我', '停止']

const TOOL_DESCRIPTION = `Mission Control: update the status band the person sees, and raise a decision card.
Call it only at stage transitions (planning → executing → reviewing → deciding → done) or when the person must decide; never for routine progress.
Fields: task (short id, e.g. WM-081), stage (PLANNING|EXECUTING|REVIEWING|DECIDING|WAITING_USER|DONE|FAILED), risk (NORMAL|WATCH|NEEDS_DECISION|BLOCKED), note (current biggest risk/progress, one line), next (what happens next), decision ({title, body, recommendation, estimate, options[]}) — shows buttons; the person's choice arrives as a new prompt. Pass decision: null to clear.
expansion ({adding: ["+3 Sol executor", "+1 Astra reviewer"], purpose, estimate, options?: [{label, cap}]}) — call it BEFORE any fan-out that adds 2+ agents/workers, then end your turn. While it waits, every Agent call, Workflow call and \`codex exec\` is refused; once the person answers you get a hard budget of new agents/workers (the choice and its cap arrive as a new prompt) and calls beyond it are refused until you raise a new expansion. Each agent a Workflow starts uses one from the budget; past it, that agent's tool calls are refused.
plan ({minutes: [lo, hi], usd: [lo, hi]}) — your estimate for the work starting now (also accepted inside expansion, starting when the person approves); the band then shows remaining time and projected cost and turns WATCH if the work runs past it. route ({model, source, reason}) — set it when you assign a model to the task: model (e.g. Astra), source (who chose it, e.g. "Opus 明確指定" / "使用者指定" / "預設"), reason (one line why). The band shows it beside the model the latest codex worker or subagent actually ran, and flags a mismatch.
progress ({done, total}) — only when you know a real count (files, parts, tests); it sharpens the remaining-time estimate.
To make a Codex worker visible in the tree, run it through the wrapper: \`dispatch-codex --task WM-081 --role executor --name Sol -- codex exec ...\` (model/effort are read from codex's -m and model_reasoning_effort flags).`

// Fold the wrapper's JSONL into one Worker per id; lines from other sessions never reach this file.
export function reduceEvents(text: string): Worker[] {
  const byId = new Map<string, Worker>()
  for (const line of text.split('\n')) {
    if (!line.trim()) continue
    let ev: any
    try {
      ev = JSON.parse(line)
    } catch {
      continue
    }
    if (ev.event === 'worker.started') {
      byId.set(ev.id, {
        id: ev.id, name: ev.name || ev.role, role: ev.role, model: ev.model, effort: ev.effort,
        task: ev.task, status: 'running', startedAt: ev.ts,
      })
    } else if (ev.event === 'worker.rollout' && byId.has(ev.id)) {
      byId.set(ev.id, { ...byId.get(ev.id)!, rollout: ev.path })
    } else if (ev.event === 'worker.completed' && byId.has(ev.id)) {
      const w = byId.get(ev.id)!
      byId.set(ev.id, { ...w, status: ev.exit === 0 ? 'completed' : 'failed', endedAt: ev.ts, exit: ev.exit })
    }
  }
  return [...byId.values()]
}

// USD per 1M tokens: OpenAI API price cards (openai.com GPT-6.1 Sol launch post, checked 2026-10-05). Edit here when they change.
const PRICES: Record<string, { input: number; cached: number; output: number }> = {
  'gpt-6.1-sol': { input: 2, cached: 0.1, output: 10 },
  'gpt-6-sol': { input: 2, cached: 0.2, output: 10 },
  'gpt-6-astra': { input: 10, cached: 1, output: 50 },
  'gpt-6-luna': { input: 0.1, cached: 0.01, output: 0.5 },
}

// bin/codex-progress output: last token_count line, model/effort, command count, edit count, last agent message
export function parseProgress(stdout: string, isFinal: boolean): Progress {
  const [tokenLine = '', modelLine = '', cmds = '0', edits = '0', msgLine = ''] = stdout.split('\n')
  let usage: any = {}
  try {
    usage = JSON.parse(tokenLine).payload?.info?.total_token_usage ?? {}
  } catch {}
  const model = /"model":"([^"]*)"/.exec(modelLine)?.[1] ?? ''
  const effort = /"reasoning_effort":"([^"]*)"/.exec(modelLine)?.[1] ?? ''
  let lastMessage = ''
  try {
    lastMessage = (JSON.parse(msgLine).payload?.item?.content ?? []).map((c: any) => c.text ?? '').join(' ')
  } catch {}
  const input = usage.input_tokens ?? 0
  const cached = usage.cached_input_tokens ?? 0
  const output = usage.output_tokens ?? 0
  const price = PRICES[model]
  const usd = price ? ((input - cached) * price.input + cached * price.cached + output * price.output) / 1e6 : null
  return {
    model, effort, input, cached, output, usd, isFinal,
    commands: Number(cmds) || 0, edits: Number(edits) || 0, lastMessage: lastMessage.replace(/\s+/g, ' ').trim(),
  }
}

export const tokens = (n: number) => (n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `${Math.round(n / 1e3)}k` : `${n}`)
export const codexUsd = (ps: Record<string, Progress>) => Object.values(ps).reduce((n, p) => n + (p.usd ?? 0), 0)

const mins = (from: number, to: number) => `${Math.max(0, Math.round((to - from) / 60000))}m`
const usd = (n: number) => `$${n.toFixed(2)}`
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b)

export function stageOf(m: Mission, ws: Worker[], d: Decision | null): string {
  if (d) return 'WAITING_USER'
  if (m.stage) return m.stage
  const running = ws.filter(w => w.status === 'running')
  return running.length ? running[running.length - 1]!.role.toUpperCase() : ''
}

// "+3 Sol executor" → 3; a line without a number counts as 1
export const totalOf = (adding: string[]) => adding.reduce((n, a) => n + Number(/\d+/.exec(a)?.[0] ?? 1), 0)

export function expansionCard(x: any): Decision {
  const total = totalOf(x.adding ?? [])
  const opts: { label: string; cap: number }[] = x.options?.length
    ? x.options
    : [
        { label: '允許', cap: total },
        ...(total > 2 ? [{ label: '只允許 2 個', cap: 2 }] : []),
        { label: '先問我', cap: 0 },
        { label: '停止', cap: 0 },
      ]
  return {
    kind: 'expansion', title: 'Expansion preview', body: x.purpose ?? '', estimate: x.estimate,
    adding: x.adding ?? [], options: opts.map(o => o.label), caps: opts.map(o => o.cap), plan: planOf(x.plan),
  }
}

// tool input {minutes: [lo, hi], usd: [lo, hi]} → the planned ranges, or undefined when malformed
export function planOf(x: any): Pick<Plan, 'minutes' | 'usd'> | undefined {
  const pair = (v: any) => (Array.isArray(v) && v.length === 2 && v.every(n => typeof n === 'number' && n >= 0) ? [Math.min(...v), Math.max(...v)] as [number, number] : undefined)
  const minutes = pair(x?.minutes)
  const usd = pair(x?.usd)
  return minutes && usd ? { minutes, usd } : undefined
}

export type Estimate = { elapsedMin: number; spent: number; remainMin: [number, number]; projUsd: [number, number]; isOver: boolean; why?: string }

// No fake precision: remaining time is the plan's range less elapsed, or elapsed × left/done when real progress is known;
// remaining cost is the burn rate so far times that. Over = past the time range, or projected cost > 1.4 × the plan's high.
export function estimate(plan: Plan, nowMs: number, nowUsd: number, prog?: { done: number; total: number }): Estimate {
  const elapsedMin = Math.max(0, (nowMs - plan.startedAt) / 60000)
  const spent = Math.max(0, nowUsd - plan.baseUsd)
  const rate = elapsedMin >= 1 ? spent / elapsedMin : 0
  let remainMin: [number, number]
  if (prog && prog.done > 0 && prog.total >= prog.done) {
    const r = (elapsedMin * (prog.total - prog.done)) / prog.done
    remainMin = [r, r]
  } else {
    remainMin = [Math.max(0, plan.minutes[0] - elapsedMin), Math.max(0, plan.minutes[1] - elapsedMin)]
  }
  const projUsd: [number, number] = [spent + rate * remainMin[0], spent + rate * remainMin[1]]
  const isLate = elapsedMin > plan.minutes[1]
  const isCostly = projUsd[1] > plan.usd[1] * 1.4
  const why = isLate
    ? `已超出預估時間 ${Math.round(elapsedMin - plan.minutes[1])} 分`
    : isCostly
      ? `預測成本 $${projUsd[1].toFixed(2)} 超過預估上限 $${plan.usd[1].toFixed(2)} 的 140%`
      : undefined
  return { elapsedMin, spent, remainMin, projUsd, isOver: isLate || isCostly, why }
}

// What this task actually runs on: the latest-started of its codex workers (tagged with the task, or running)
// and the subagents spawned since the route was set.
export type RouteView = Route & { actual: string; isMismatch: boolean }
export function routeOf(m: Mission, ws: Worker[], ps: Record<string, Progress>, sp: Spawned = {}): RouteView | null {
  const r: Route | undefined = m.route
  if (!r) return null
  const runs = [
    ...ws.filter(w => (m.task && w.task === m.task) || w.status === 'running').map(w => ({ at: w.startedAt, model: ps[w.id]?.model || w.model })),
    ...Object.values(sp).filter(a => a.at >= (r.at ?? 0)),
  ].filter(x => x.model)
  const actual = runs.reduce<{ at: number; model: string } | undefined>((a, x) => (!a || x.at >= a.at ? x : a), undefined)?.model ?? ''
  return { ...r, actual, isMismatch: Boolean(actual) && !actual.toLowerCase().includes(r.model.toLowerCase()) }
}

const range = (r: [number, number], f: (n: number) => string) => (f(r[0]) === f(r[1]) ? f(r[0]) : `${f(r[0])}–${f(r[1])}`)
// no burn rate in the first minute: the projection would just repeat what is spent, so leave it out
export const etaText = (est: Estimate) =>
  `剩 ~${range(est.remainMin, n => `${Math.round(n)}m`)}${est.elapsedMin >= 1 ? ` · 預測 ${range(est.projUsd, n => `$${n.toFixed(2)}`)}` : ''}`

async function totalUsd($: any): Promise<number> {
  return (await read($, costUsd)) + codexUsd(await read($, progress))
}

// Hard cap: refuse spawns while an expansion waits, and past the budget its answer granted.
async function gate($: any, n: number): Promise<string | undefined> {
  if ((await read($, decision))?.kind === 'expansion') {
    return 'Mission Control: an expansion preview is waiting for the person; spawn nothing until they answer.'
  }
  let ok = false
  let seen: Budget = null
  await update($, budget, b => {
    seen = b
    ok = b === null || b.left >= n
    return b !== null && ok ? { ...b, left: b.left - n } : b
  })
  if (ok) return undefined
  const b = seen as Budget
  return `Mission Control: expansion budget used up (${b ? b.total - b.left : 0}/${b?.total ?? 0}). Raise a new expansion preview with the mission tool to add more.`
}

type Paths = { events: string; sessionDir: string; cwd: string }

async function bindPaths($: any): Promise<Paths> {
  const home = (await $.env.get('HOME')) ?? '/tmp'
  const id = await $.session.id()
  const cwd = await $.session.cwd()
  const events = `${home}/.claude/mission-control/${id}.jsonl`
  await $.env.set('MC_EVENTS', events)
  // where the engine keeps this session's workflow runs (the transcript folder)
  return { events, cwd, sessionDir: `${home}/.claude/projects/${cwd.replace(/[^A-Za-z0-9]/g, '-')}/${id}` }
}

// One Workflow per run: journal.jsonl's started/result lines give progress; workflows/<run>.json appears when it ends.
export function reduceJournal(id: string, text: string): Pick<Workflow, 'done' | 'total' | 'phase' | 'running'> {
  const started = new Map<string, { label: string; phase?: string }>()
  const done = new Set<string>()
  for (const line of text.split('\n')) {
    let ev: any
    try {
      ev = JSON.parse(line)
    } catch {
      continue
    }
    if (ev.type === 'started') started.set(ev.agentId, { label: ev.label, phase: ev.phase })
    if (ev.type === 'result') done.add(ev.agentId)
  }
  const running = [...started].filter(([a]) => !done.has(a)).map(([, v]) => v)
  return { done: done.size, total: started.size, phase: running.at(-1)?.phase ?? [...started.values()].at(-1)?.phase, running: running.map(r => r.label) }
}

async function readWorkflows($: any, sessionDir: string, before: Workflow[]): Promise<Workflow[]> {
  const runs = await $.fs.list(`${sessionDir}/subagents/workflows`).catch(() => [])
  const scripts = await $.fs.list(`${sessionDir}/workflows/scripts`).catch(() => [])
  const out: Workflow[] = []
  for (const r of runs.filter((x: any) => x.kind === 'dir' && x.name.startsWith('wf_'))) {
    const old = before.find(w => w.id === r.name)
    if (old && old.status !== 'running') {
      out.push(old)
      continue
    }
    const summary = await $.fs.read(`${sessionDir}/workflows/${r.name}.json`).then(JSON.parse).catch(() => null)
    const journal = await $.fs.read(`${sessionDir}/subagents/workflows/${r.name}/journal.jsonl`).catch(() => '')
    const script = scripts.find((f: any) => f.name.endsWith(`-${r.name}.js`))?.name
    out.push({
      id: r.name,
      name: summary?.workflowName ?? script?.slice(0, -(r.name.length + 4)) ?? r.name,
      status: summary?.status ?? 'running',
      ...reduceJournal(r.name, journal),
    })
  }
  return out.slice(-6)
}

// STATE.md frontmatter + commits since STATE last changed
async function readFw($: any, cwd: string): Promise<Flightwake | null> {
  const text = await $.fs.read(`${cwd}/.flightwake/STATE.md`).catch(() => null)
  if (text === null) return null
  const field = (k: string) => new RegExp(`^${k}:\\s*([^#\\n]*)`, 'm').exec(text)?.[1]?.trim() ?? '?'
  let behind: number | null = null
  const last = await $.process.run(['git', 'log', '-1', '--format=%H', '--', '.flightwake/STATE.md'], { cwd }).catch(() => null)
  const sha = last?.exitCode === 0 ? last.stdout.trim() : ''
  if (sha) {
    const n = await $.process.run(['git', 'rev-list', '--count', `${sha}..HEAD`], { cwd }).catch(() => null)
    if (n?.exitCode === 0) behind = Number(n.stdout.trim())
  }
  return { updated: field('updated'), by: field('updated_by'), health: field('health'), latest: field('latest_record'), behind }
}

// Every dispatch shows on the band: a spawn fills the route (and the task, when none is set) unless the
// mission tool set one for a task still under way.
async function autoRoute($: any, route: Omit<Route, 'at' | 'auto'>, task: string) {
  const at = await $.clock.now()
  await update($, mission, m => {
    const isOpen = m.stage !== 'DONE' && m.stage !== 'FAILED'
    if (m.route && !m.route.auto && isOpen) return m
    const fresh = !isOpen || !m.task
    return {
      ...m,
      ...(fresh ? { task, stage: 'EXECUTING', next: undefined, plan: undefined, progress: undefined, risk: 'NORMAL' as Risk, note: undefined } : {}),
      route: { ...route, at, auto: true },
    }
  })
}

// "claude-opus-5-5" → "Opus"; anything else as given
const modelName = (id = '') => /claude-([a-z]+)/.exec(id)?.[1]?.replace(/^./, c => c.toUpperCase()) ?? id

async function choose($: any, d: Decision, i: number) {
  await update($, decision, () => null)
  const opt = d.options[i]
  let suffix = ''
  if (d.kind === 'expansion') {
    const cap = d.caps?.[i] ?? 0
    await update($, budget, () => ({ left: cap, total: cap }))
    suffix = `（上限 ${cap} 個新 agent/worker）`
    if (cap > 0 && d.plan) {
      const plan: Plan = { ...d.plan, startedAt: await $.clock.now(), baseUsd: await totalUsd($) }
      await update($, mission, m => ({ ...m, plan, progress: undefined, isOverWarned: false }))
    }
  }
  void $.prompt.submit({ text: `[Mission Control] ${d.title} → 使用者選擇：${opt}${suffix}`, asUser: true })
}

// Is this loop id one of this session's workflow agents? Their ids show up only in the run journals.
async function isWorkflowAgent($: any, sessionDir: string, id: string): Promise<boolean> {
  const runs = await $.fs.list(`${sessionDir}/subagents/workflows`).catch(() => [])
  for (const r of runs.filter((x: any) => x.kind === 'dir' && x.name.startsWith('wf_'))) {
    const journal = await $.fs.read(`${sessionDir}/subagents/workflows/${r.name}/journal.jsonl`).catch(() => '')
    if (journal.includes(`"agentId":"${id}"`)) return true
  }
  return false
}

async function poll($: any, paths: Paths, tick: number) {
  const text = await $.fs.read(paths.events).catch(() => '')
  const nextWorkers = reduceEvents(text)
  const before = await read($, workers)
  if (!same(before, nextWorkers)) {
    for (const w of nextWorkers) {
      const old = before.find(o => o.id === w.id)
      if (w.status === 'failed' && old?.status !== 'failed') $.ui.toast(`✗ ${w.name} failed (exit ${w.exit})`)
      if (!old && w.status === 'running') {
        await autoRoute($, { model: w.model || '（codex 預設）', source: w.model ? 'dispatch-codex -m 指定' : 'codex 預設', reason: `${w.role} ${w.name}` }, w.task && w.task !== '-' ? w.task : w.name)
      }
    }
    await update($, workers, () => nextWorkers)
  }
  const list: Agent[] = (await $.agent.list()).map((a: any) => ({
    id: a.id, description: a.description, type: a.type, status: a.status, parentId: a.parentId,
  }))
  if (!same(await read($, agents), list)) await update($, agents, () => list)
  const cost = (await $.session.usage()).cost?.usd ?? 0
  if (Math.abs((await read($, costUsd)) - cost) >= 0.01) await update($, costUsd, () => cost)
  const m = Math.floor((await $.clock.now()) / 60000)
  if ((await read($, minute)) !== m) await update($, minute, () => m)
  // codex progress: running workers every other tick, finished ones once more for the final count
  const ps = await read($, progress)
  const todo = nextWorkers.filter(w => w.rollout && (w.status === 'running' ? tick % 2 === 0 : !ps[w.id]?.isFinal))
  if (todo.length) {
    const fresh: Record<string, Progress> = { ...ps }
    for (const w of todo) {
      const r = await $.process.run([`${$.plugin.root}/bin/codex-progress`, w.rollout], { timeoutMs: 10000 }).catch(() => null)
      if (r?.exitCode === 0 || r?.stdout) fresh[w.id] = parseProgress(r.stdout, w.status !== 'running')
    }
    if (!same(ps, fresh)) await update($, progress, () => fresh)
  }
  const mm = await read($, mission)
  if (mm.plan && !mm.isOverWarned && mm.stage !== 'DONE' && mm.stage !== 'FAILED') {
    const est = estimate(mm.plan, await $.clock.now(), await totalUsd($), mm.progress)
    if (est.isOver) {
      $.ui.toast(`▲ ${mm.task ?? 'Mission'}：${est.why}`)
      await update($, mission, m => ({ ...m, isOverWarned: true, risk: m.risk === 'NORMAL' ? 'WATCH' : m.risk, note: m.note ?? est.why }))
    }
  }
  const wfBefore = await read($, workflows)
  const wf = await readWorkflows($, paths.sessionDir, wfBefore)
  if (!same(wfBefore, wf)) await update($, workflows, () => wf)
  // ponytail: flightwake (git) every 30s; it changes on records, not per second
  if (tick % 10 === 0) {
    const f = await readFw($, paths.cwd)
    if (!same(await read($, fw), f)) await update($, fw, () => f)
  }
}

const WIDE = /[\u1100-\u115f\u2e80-\ua4cf\uac00-\ud7a3\uf900-\ufaff\ufe30-\ufe4f\uff00-\uff60\uffe0-\uffe6]/

// Cut to a terminal width, counting CJK and other wide glyphs as 2 cells.
export function fit(text: string, cols: number): string {
  let w = 0
  let out = ''
  for (const ch of text) {
    const cw = WIDE.test(ch) ? 2 : 1
    if (w + cw > cols - 1) return out + '…'
    w += cw
    out += ch
  }
  return out
}

// three colors only: green = fine, yellow = look, red = stuck; everything else is plain or dim
const STAGE_COLOR: Record<string, string> = { DECIDING: 'yellow', WAITING_USER: 'yellow', DONE: 'green', FAILED: 'red' }
const RISK_COLOR: Record<Risk, string> = { NORMAL: 'green', WATCH: 'yellow', NEEDS_DECISION: 'yellow', BLOCKED: 'red' }
const MARK_COLOR: Record<string, string> = { completed: 'green', failed: 'red', killed: 'red' }
const mark = (st: string) => (st === 'running' ? '●' : st === 'completed' ? '✓' : st === 'failed' || st === 'killed' ? '✗' : '○')

// Terminal cells of a string, CJK and other wide glyphs counting 2.
export const cells = (text: string) => [...text].reduce((n, ch) => n + (WIDE.test(ch) ? 2 : 1), 0)

// The expanded view: a rounded card, 3–6 rows. Header (task, stage, → next | $, ETA), then labelled rows that
// show only when they say something: 風險 · 派工 model ← source ✓ actual · 原因 · 執行 agents/workers · 流程 workflow / fw behind
type FlowData = {
  m: Mission; ws: Worker[]; as: Agent[]; cost: number; d: Decision | null; now: number; b: Budget
  wfs: Workflow[]; f: Flightwake | null; ps: Record<string, Progress>; cols: number; sp?: Spawned
}
type Seg = [text: string, style?: Record<string, unknown>]
export function renderFlow({ Box, Text }: any, { m, ws, as, cost, d, now, b, wfs, f, ps, cols, sp }: FlowData) {
  const nowMs = now * 60000
  const isOver = m.stage === 'DONE' || m.stage === 'FAILED'
  const est = m.plan && !isOver ? estimate(m.plan, nowMs, cost + codexUsd(ps), m.progress) : null
  const mine = ws.filter(w => w.status === 'running' || (m.task && w.task === m.task)).slice(-3)
  const liveAgents = as.filter(a => a.status === 'running')
  const wf = wfs.find(w => w.status === 'running') ?? wfs.at(-1)
  const route = routeOf(m, ws, ps, sp)
  const stage = stageOf(m, ws, d) || 'IDLE'
  const inner = Math.max(20, cols - 4)
  const LABEL = 6

  // one row: dim label, then segments cut to what is left of the width
  const row = (label: string, segs: Seg[], key: string) => {
    let room = inner - LABEL
    const kept: Seg[] = []
    for (const [t, st] of segs) {
      if (room <= 1) break
      const shown = cells(t) <= room ? t : fit(t, room)
      kept.push([shown, st])
      room -= cells(shown)
    }
    return (
      <Box key={key}>
        <Box width={LABEL} flexShrink={0}><Text dimColor>{label}</Text></Box>
        {kept.map(([t, st], i) => <Text key={`${key}-${i}`} {...(st ?? {})}>{t}</Text>)}
      </Box>
    )
  }
  const gap: Seg = ['   ']

  const right = [usd(cost + codexUsd(ps)), b ? `名額 ${b.left}/${b.total}` : null, est && !est.why ? etaText(est) : null]
    .filter(Boolean).join('  ')
  const left = `${m.task ?? 'Mission'}  ${stage}${m.next ? `  → ${m.next}` : ''}`
  const leftRoom = Math.max(8, inner - cells(right) - 2)
  const shownLeft = fit(left, leftRoom)
  const head = [m.task ?? 'Mission', `  ${stage}`, m.next ? `  → ${m.next}` : '']
  // cut the header's three parts to what fit() kept
  let keep = cells(shownLeft)
  const headParts = head.map(t => {
    const part = cells(t) <= keep ? t : keep > 1 ? fit(t, keep) : ''
    keep -= cells(part)
    return part
  })

  const work: Seg[] = [
    ...liveAgents.map(a => [`● ${a.type}`] as Seg),
    ...mine.map(w => {
      const p = ps[w.id]
      const t = w.status === 'running' ? mins(w.startedAt, nowMs) : mins(w.startedAt, w.endedAt ?? w.startedAt)
      return [`${mark(w.status)} ${w.name} ${t}${p?.usd != null ? ` ≈${usd(p.usd)}` : ''}${p ? ` ${p.commands}指令` : ''}`, { color: MARK_COLOR[w.status] }] as Seg
    }),
  ].flatMap((x, i) => (i ? [gap, x] : [x]))
  const isFwBehind = Boolean(f?.behind && f.behind >= 3)
  const flow: Seg[] = [
    ...(wf ? [[`${mark(wf.status)} ${wf.name} ${wf.done}/${wf.total}${wf.phase ? ` ${wf.phase}` : ''}`, { color: MARK_COLOR[wf.status] }] as Seg] : []),
    ...(wf && isFwBehind ? [gap] : []),
    ...(isFwBehind ? [[`flightwake 落後 ${f!.behind} commits`, { color: 'yellow' }] as Seg] : []),
  ]
  const risk = [m.risk !== 'NORMAL' ? `${RISK_MARK[m.risk]} ${m.note ?? m.risk}` : null, est?.why ? `▲ ${est.why}` : null].filter(Boolean).join('   ')

  const isWarn = Boolean(est?.isOver) || m.risk !== 'NORMAL' || Boolean(route?.isMismatch)
  return (
    <Box flexDirection="column" borderStyle="round" borderColor={m.risk === 'BLOCKED' ? 'red' : isWarn ? 'yellow' : 'gray'} paddingX={1}>
      <Box justifyContent="space-between">
        <Box>
          <Text bold>{headParts[0]}</Text>
          <Text bold color={STAGE_COLOR[stage]}>{headParts[1]}</Text>
          <Text>{headParts[2]}</Text>
        </Box>
        <Text dimColor>{right}</Text>
      </Box>
      {risk && row('風險', [[risk, { color: m.risk === 'BLOCKED' ? 'red' : 'yellow' }]], 'risk')}
      {route && row('派工', [
        [route.model, { bold: true }],
        [` ← ${route.source}`, { dimColor: true }],
        gap,
        ...(route.actual
          ? [route.isMismatch ? [`▲ 實際 ${route.actual}`, { color: 'yellow' }] as Seg : [`✓ ${route.actual}`, { color: 'green' }] as Seg]
          : [['尚未派工', { dimColor: true }] as Seg]),
      ], 'route')}
      {route?.reason && row('原因', [[route.reason, { dimColor: true }]], 'reason')}
      {row('執行', work.length ? work : [['沒有工作中的 agent／worker', { dimColor: true }]], 'work')}
      {flow.length > 0 && row('流程', flow, 'flow')}
    </Box>
  )
}

export const register: Register = on => {
  let paths: Paths | null = null
  let tick = 0

  on('session.start', async ($, e, next) => {
    paths = await bindPaths($)
    const path = (await $.env.get('PATH')) ?? ''
    const bin = `${$.plugin.root}/bin`
    if (!path.split(':').includes(bin)) await $.env.set('PATH', `${bin}:${path}`)

    await $.command.register({ name: 'flow', description: 'Mission Control: show the agent / worker tree' })
    await $.tool.register({
      name: 'mission',
      description: TOOL_DESCRIPTION,
      inputSchema: {
        type: 'object',
        properties: {
          task: { type: 'string' },
          stage: { type: 'string' },
          risk: { type: 'string', enum: ['NORMAL', 'WATCH', 'NEEDS_DECISION', 'BLOCKED'] },
          note: { type: 'string' },
          next: { type: 'string' },
          route: {
            type: 'object',
            properties: { model: { type: 'string' }, source: { type: 'string' }, reason: { type: 'string' } },
            required: ['model', 'source'],
          },
          plan: PLAN_SCHEMA,
          progress: {
            type: 'object',
            properties: { done: { type: 'integer', minimum: 0 }, total: { type: 'integer', minimum: 1 } },
            required: ['done', 'total'],
          },
          expansion: {
            type: ['object', 'null'],
            properties: {
              plan: PLAN_SCHEMA,
              adding: { type: 'array', items: { type: 'string' } },
              purpose: { type: 'string' },
              estimate: { type: 'string' },
              options: {
                type: 'array', maxItems: 9,
                items: { type: 'object', properties: { label: { type: 'string' }, cap: { type: 'integer', minimum: 0 } }, required: ['label', 'cap'] },
              },
            },
            required: ['adding'],
          },
          decision: {
            type: ['object', 'null'],
            properties: {
              title: { type: 'string' },
              body: { type: 'string' },
              recommendation: { type: 'string' },
              estimate: { type: 'string' },
              options: { type: 'array', maxItems: 9, items: { type: 'string' } },
            },
            required: ['title', 'body'],
          },
        },
      },
    })
    // ponytail: 3s poll of a small JSONL + agent list; switch to a file watch if one lands in $.fs
    $.clock.every(3000, () =>
      void (paths ? Promise.resolve(paths) : bindPaths($))
        .then(p => poll($, (paths = p), tick++))
        .catch(() => undefined),
    )
    return next(e)
  })

  // /clear: new session id, no session.start — reset and rebind on the next poll
  on('session.end', async ($, e, next) => {
    if (e.reason === 'clear') {
      paths = null
      tick = 0
      wfAgents.clear()
      await update($, workflows, () => [])
      await update($, progress, () => ({}))
      await update($, mission, () => ({ risk: 'NORMAL' }))
      await update($, decision, () => null)
      await update($, workers, () => [])
      await update($, budget, () => null)
      await update($, spawned, () => ({}))
    }
    return next(e)
  })

  // the person answered in words instead of a button: drop the card; an unanswered expansion grants nothing
  on('prompt.submit', async ($, e, next) => {
    const d = await read($, decision)
    if (d && !e.text.startsWith('[Mission Control]')) {
      await update($, decision, () => null)
      if (d.kind === 'expansion') await update($, budget, () => ({ left: 0, total: 0 }))
    }
    return next(e)
  })

  // the model each subagent really started on, for the route's 實際執行
  on('agent.spawn', async ($, e, next) => {
    const r = await next(e)
    if (r.agentId && r.model) {
      // fill the route first so this spawn counts as its 實際 (spawned.at >= route.at)
      const parent = modelName(e.parentModel)
      await autoRoute($, {
        model: modelName(e.model ?? r.model),
        source: e.fork ? `fork（繼承 ${parent}）` : e.model ? `${parent} 明確指定` : `預設（${e.subagentType}）`,
        reason: e.description,
      }, e.description || e.subagentType)
      const at = await $.clock.now()
      await update($, spawned, s => ({ ...s, [r.agentId!]: { model: r.model!, at } }))
    }
    return r
  })

  on('tool.call', { tool: 'Agent' }, async ($, e, next) => {
    const deny = await gate($, 1)
    return deny ? { deny } : next(e)
  })

  // A Workflow is gated as a whole only while an expansion waits or the budget is empty;
  // its agents are charged one by one below, as each makes its first tool call.
  on('tool.call', { tool: 'Workflow' }, async ($, e, next) => {
    const deny = await gate($, 0)
    if (deny) return { deny }
    const b = await read($, budget)
    return b && b.left === 0 ? { deny: 'Mission Control: expansion budget is 0; raise an expansion preview before starting a workflow.' } : next(e)
  })

  // ponytail: per-process memo of workflow agents seen; a reload forgets it and re-charges on their next call
  const wfAgents = new Map<string, boolean>()
  on('tool.call', async ($, e, next) => {
    const id = e.agentId
    if (!id || !paths) return next(e)
    if (!wfAgents.has(id)) {
      // Agent-tool subagents are listed (and already charged at spawn); only unlisted ids need the journals
      if ((await read($, agents)).some(a => a.id === id)) return next(e)
      if (!(await isWorkflowAgent($, paths.sessionDir, id))) return next(e)
      wfAgents.set(id, (await gate($, 1)) === undefined)
    }
    return wfAgents.get(id)
      ? next(e)
      : { deny: 'Mission Control: this workflow agent is past the approved expansion cap. Stop now and return what you have without further tool calls.' }
  })

  on('tool.call', { tool: 'Bash' }, async ($, e, next) => {
    const n = (e.command.match(/\bcodex\s+exec\b/g) ?? []).length
    const deny = n ? await gate($, n) : undefined
    return deny ? { deny } : next(e)
  })

  // The band starts expanded; /flow folds it to one line, again (or /flow on) expands it back
  on('command.run', { command: 'flow' }, async ($, e) => {
    const arg = e.args.trim()
    let next = false
    await update($, isExpanded, v => (next = arg === 'on' ? true : arg === 'off' ? false : !v))
    return { text: next ? 'Mission Control 已展開（再打 /flow 收起）。' : 'Mission Control 已收起。' }
  })

  on('tool.call', { tool: 'mcp__mission-control__mission' }, async ($, e: any) => {
    const input = e.input ?? e
    const { decision: d0, expansion: x, ...fields } = input
    const d = x ? expansionCard(x) : x === null ? null : d0
    const plan = planOf(fields.plan)
    const now = plan || fields.route ? await $.clock.now() : 0
    const base = plan ? { startedAt: now, baseUsd: await totalUsd($) } : null
    await update($, mission, m => {
      const merged: Mission = { ...m }
      for (const k of ['task', 'stage', 'risk', 'note', 'next'] as const) if (fields[k] !== undefined) (merged as any)[k] = fields[k]
      if (fields.route) merged.route = { ...fields.route, at: now }
      if (plan && base) Object.assign(merged, { plan: { ...plan, ...base }, progress: undefined, isOverWarned: false })
      const pr = fields.progress
      if (pr && typeof pr.done === 'number' && typeof pr.total === 'number' && pr.total > 0) merged.progress = { done: pr.done, total: pr.total }
      return merged
    })
    if (d !== undefined) {
      await update($, decision, () => (d ? { ...d, options: d.options?.length ? d.options : DEFAULT_OPTIONS } : null))
      if (d) $.ui.toast(d.kind === 'expansion' ? `◆ Expansion preview: ${d.adding?.join(', ')}` : `◆ Decision needed: ${d.title}`)
    }
    if (fields.stage === 'DONE' || fields.stage === 'FAILED') await update($, budget, () => null)
    return { result: d ? 'Card shown; the person\'s choice will arrive as a new prompt. End your turn now.' : 'ok' }
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (e.props.hasSurvey) return next(e)
    const [m, ws, as, cost, d, now, b, wfs, ps, f, isOpen, sp] = await Promise.all([
      read($, mission), read($, workers), read($, agents), read($, costUsd), read($, decision), read($, minute), read($, budget),
      read($, workflows), read($, progress), read($, fw), read($, isExpanded), read($, spawned),
    ])
    const els = $.ui.resolve(e)
    const { Box, Text, Button } = els
    const wfRun = wfs.filter(w => w.status === 'running')
    const running = ws.filter(w => w.status === 'running')
    const live = as.filter(a => a.status === 'running')

    const card = d && (
        <Box flexDirection="column" borderStyle="round" borderColor="yellow" paddingX={1}>
          <Box>
            <Text bold color="yellow">◆ </Text>
            <Text bold>{m.task ? `${m.task}  ` : ''}</Text>
            <Text bold color="yellow">{d.title}</Text>
          </Box>
          {d.kind === 'expansion' && (
            <Text><Text dimColor>目前  </Text>main + {running.length + live.length} running</Text>
          )}
          {d.kind === 'expansion' && <Text><Text dimColor>準備  </Text>{d.adding?.join('、')}</Text>}
          {d.body && <Text>{d.kind === 'expansion' ? <Text dimColor>目的  </Text> : ''}{d.body}</Text>}
          {d.recommendation && <Text><Text color="green">建議  </Text>{d.recommendation}</Text>}
          {d.estimate && <Text dimColor>預估  {d.estimate}</Text>}
          {d.plan && (
            <Text dimColor>
              計畫  {range(d.plan.minutes, n => `${n}m`)} · ${d.plan.usd[0].toFixed(2)}–${d.plan.usd[1].toFixed(2)}（核准後開始計時）
            </Text>
          )}
          <Box marginTop={1} columnGap={1}>
            {d.options.map((opt, i) => (
              <Button
                key={`opt-${i}`}
                label={opt}
                hotkey={i < 9 ? String(i + 1) : undefined}
                variant={i === 0 ? 'primary' : undefined}
                onPress={() => choose($, d, i)}
              />
            ))}
          </Box>
        </Box>
    )
    const isActive = running.length > 0 || live.length > 0 || wfRun.length > 0
    const isOver = m.stage === 'DONE' || m.stage === 'FAILED'
    // nothing going on: stay silent even when expanded
    if (!card && !isActive && (!m.task || isOver)) return next(e)
    if (isOpen) {
      return (
        <Box flexDirection="column">
          {card}
          {renderFlow(els, { m, ws, as, cost, d, now, b, wfs, f, ps, sp, cols: e.props.bodyColumns })}
        </Box>
      )
    }
    if (card) return card

    // folded: one line — task, stage, then the rest dim, warnings in yellow
    const nowMs = now * 60000
    const lead = running[running.length - 1]
    const est = m.plan && !isOver ? estimate(m.plan, nowMs, cost + codexUsd(ps), m.progress) : null
    const route = routeOf(m, ws, ps, sp)
    const stage = stageOf(m, ws, d) || (e.props.isWorking || live.length ? 'WORKING' : 'IDLE')
    const warn = [
      m.risk !== 'NORMAL' ? `${RISK_MARK[m.risk]} ${m.note ?? m.risk}` : null,
      est?.why ? `▲ ${est.why}` : null,
    ].filter(Boolean).join('  ')
    const model = route ? (route.isMismatch ? `${route.model} ▲ 實際 ${route.actual}` : `${route.model}${route.actual ? ' ✓' : ''}`) : ''
    const rest = [
      lead ? `${lead.name} ${mins(lead.startedAt, nowMs)}` : null,
      running.length + live.length > 1 ? `${running.length + live.length} workers` : null,
      ...wfRun.map(w => `${w.name} ${w.done}/${w.total}`),
      usd(cost + codexUsd(ps)),
    ].filter(Boolean).join('  ')
    const nextText = m.next ? `  → ${m.next}` : ''
    const head = `${m.task ?? '—'}  `
    const used = 2 + cells(head) + cells(stage) + (model ? cells(model) + 2 : 0) + (warn ? cells(warn) + 2 : 0)
    // → next outranks the dim tail: it is cut last
    const nextShown = fit(nextText, Math.max(4, e.props.bodyColumns - used))
    const room = Math.max(0, e.props.bodyColumns - used - cells(nextShown) - 2)
    return (
      <Box>
        <Text color={RISK_COLOR[m.risk]}>{RISK_MARK[m.risk]} </Text>
        <Text bold>{head}</Text>
        <Text bold color={STAGE_COLOR[stage]}>{stage}</Text>
        {model && <Text color={route?.isMismatch ? 'yellow' : undefined}>  {model}</Text>}
        {warn && <Text color="yellow">  {warn}</Text>}
        <Text>{nextShown}</Text>
        {room > 4 && <Text dimColor>  {fit(rest, room)}</Text>}
      </Box>
    )
  })

}
