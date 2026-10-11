export type WorkerStatus = 'running' | 'completed' | 'failed'
export type Worker = {
  id: string
  name: string
  role: string
  model: string
  effort: string
  task: string
  status: WorkerStatus
  startedAt: number
  endedAt?: number
  exit?: number
  rollout?: string
}
// read from the codex rollout; usd is the API-price equivalent (a ChatGPT login pays no per-token price)
export type Progress = {
  model: string
  effort: string
  input: number
  cached: number
  output: number
  usd: number | null
  commands: number
  edits: number
  lastMessage: string
  isFinal: boolean
}
export type Agent = { id: string; description: string; type: string; status: string; parentId?: string }
export type Risk = 'NORMAL' | 'WATCH' | 'NEEDS_DECISION' | 'BLOCKED'
// the estimate Opus committed to, started when the plan (or an approved expansion carrying it) begins
export type Plan = { startedAt: number; baseUsd: number; minutes: [number, number]; usd: [number, number] }
export type Mission = {
  task?: string
  stage?: string
  risk: Risk
  note?: string
  next?: string
  plan?: Plan
  progress?: { done: number; total: number }
  isOverWarned?: boolean
  // who picks the model for this task and why; the actual model is read from the worker, never from here
  route?: Route
  // the weekly limit's percentUsed when this task started
  weekBase?: number
}
// at: when the mission tool set it; spawns before it are not this route's
// auto: filled in from a spawn, not by the mission tool; the next spawn may replace it
export type Route = { model: string; source: string; reason?: string; at?: number; auto?: boolean }
// the model each subagent was started on, from agent.spawn's result
export type Spawned = Record<string, { model: string; at: number }>
export type Decision = {
  title: string
  body: string
  recommendation?: string
  estimate?: string
  options: string[]
  // expansion preview only: what is being added, and the spawn budget each option grants
  kind?: 'expansion'
  adding?: string[]
  caps?: number[]
  plan?: Pick<Plan, 'minutes' | 'usd'>
}
// the seven-day rate-limit window, from session.measure; null off a subscription
export type Week = { pct: number; resetsAt?: string }
// null = no cap; set once an expansion is answered
export type Budget = { left: number; total: number } | null

export type Workflow = { id: string; name: string; status: string; done: number; total: number; phase?: string; running: string[] }
export type Flightwake = { updated: string; by: string; health: string; latest: string; behind: number | null }

declare module 'claude-code' {
  interface PluginState {
    'mission-control': {
      workers: Worker[]
      agents: Agent[]
      costUsd: number
      mission: Mission
      decision: Decision | null
      minute: number
      isExpanded: boolean
      budget: Budget
      workflows: Workflow[]
      fw: Flightwake | null
      progress: Record<string, Progress>
      spawned: Spawned
      week: Week | null
    }
  }
}
