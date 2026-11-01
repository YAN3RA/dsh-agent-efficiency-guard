import { createHash } from 'node:crypto'

export type GuardProfileName = 'quick' | 'normal' | 'deep'

export interface GuardProfile {
  readonly softSteps: number
  readonly hardSteps: number
  readonly softToolCalls: number
  readonly hardToolCalls: number
  readonly softDurationMs: number
  readonly hardDurationMs: number
}

export interface HostIntegrationConfig {
  readonly enabled: boolean
  readonly provider: 'pi-desktop' | string
  readonly preferHostTokenSaver: boolean
  readonly preferHostPromptCache: boolean
  readonly maxConvergenceSteersPerTurn: number
  readonly maxNoProgressCycles: number
  readonly loopBreakMode: 'stop-next-step'
}

export interface GuardConfig {
  readonly enabled: boolean
  readonly profile: GuardProfileName
  readonly duplicateDetection: boolean
  readonly duplicateWarnAfter: number
  readonly duplicateHardBlock: boolean
  readonly profiles: Readonly<Record<GuardProfileName, GuardProfile>>
  readonly hostIntegration: HostIntegrationConfig
}

export interface ToolCallObservation {
  readonly name: string
  readonly arguments: unknown
  readonly controlPlane?: boolean
  readonly progress?: boolean
  readonly resultFingerprint?: string
}

export interface RepeatRecord {
  readonly count: number
  readonly lastAt: number
}

export interface TurnState {
  readonly turn: number
  readonly startedAt: number
  readonly repeatedSignatures: Map<string, RepeatRecord>
  modelSteps: number
  businessToolCalls: number
  softWarningSent: boolean
  finalizationHintSent: boolean
  convergenceSteers: number
  noProgressCycles: number
  duplicateWarningSent: boolean
  progressSinceStop: boolean
  hardStopped: boolean
  lastActivityAt: number
  lastProgressFingerprint?: string
}

export type GuardDecision =
  | { readonly kind: 'allow' }
  | { readonly kind: 'deny'; readonly reason: string; readonly code: 'step-budget' | 'tool-budget' | 'time-budget' | 'no-progress-loop' }

export interface ObservationResult {
  readonly decision: GuardDecision
  readonly duplicateCount: number
  readonly shouldWarn: boolean
  readonly shouldConverge: boolean
}

export const DEFAULT_GUARD_PROFILES: Readonly<Record<GuardProfileName, GuardProfile>> = {
  quick: {
    softSteps: 3,
    hardSteps: 5,
    softToolCalls: 6,
    hardToolCalls: 8,
    softDurationMs: 120_000,
    hardDurationMs: 240_000,
  },
  normal: {
    softSteps: 5,
    hardSteps: 8,
    softToolCalls: 9,
    hardToolCalls: 12,
    softDurationMs: 300_000,
    hardDurationMs: 480_000,
  },
  deep: {
    softSteps: 10,
    hardSteps: 14,
    softToolCalls: 18,
    hardToolCalls: 25,
    softDurationMs: 720_000,
    hardDurationMs: 1_200_000,
  },
}

export const DEFAULT_HOST_INTEGRATION: HostIntegrationConfig = {
  enabled: true,
  provider: 'pi-desktop',
  preferHostTokenSaver: true,
  preferHostPromptCache: true,
  maxConvergenceSteersPerTurn: 1,
  maxNoProgressCycles: 2,
  loopBreakMode: 'stop-next-step',
}

export const DEFAULT_GUARD_CONFIG: GuardConfig = {
  enabled: true,
  profile: 'normal',
  duplicateDetection: true,
  duplicateWarnAfter: 2,
  duplicateHardBlock: false,
  profiles: DEFAULT_GUARD_PROFILES,
  hostIntegration: DEFAULT_HOST_INTEGRATION,
}

function assertPositiveInteger(name: string, value: unknown): asserts value is number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${name} must be a positive safe integer`)
  }
}

function validateProfile(name: string, profile: GuardProfile): GuardProfile {
  assertPositiveInteger(`${name}.softSteps`, profile.softSteps)
  assertPositiveInteger(`${name}.hardSteps`, profile.hardSteps)
  assertPositiveInteger(`${name}.softToolCalls`, profile.softToolCalls)
  assertPositiveInteger(`${name}.hardToolCalls`, profile.hardToolCalls)
  assertPositiveInteger(`${name}.softDurationMs`, profile.softDurationMs)
  assertPositiveInteger(`${name}.hardDurationMs`, profile.hardDurationMs)
  if (profile.softSteps >= profile.hardSteps) throw new Error(`${name}.softSteps must be less than hardSteps`)
  if (profile.softToolCalls >= profile.hardToolCalls) throw new Error(`${name}.softToolCalls must be less than hardToolCalls`)
  if (profile.softDurationMs >= profile.hardDurationMs) throw new Error(`${name}.softDurationMs must be less than hardDurationMs`)
  return profile
}

export function validateGuardConfig(input: Partial<GuardConfig> = {}): GuardConfig {
  const profiles = { ...DEFAULT_GUARD_PROFILES, ...(input.profiles ?? {}) }
  for (const name of ['quick', 'normal', 'deep'] as const) validateProfile(`profiles.${name}`, profiles[name])
  if (input.profile !== undefined && !['quick', 'normal', 'deep'].includes(input.profile)) {
    throw new Error(`profile must be quick, normal, or deep`)
  }
  const duplicateWarnAfter = input.duplicateWarnAfter ?? DEFAULT_GUARD_CONFIG.duplicateWarnAfter
  assertPositiveInteger('duplicateWarnAfter', duplicateWarnAfter)
  if (input.duplicateHardBlock === true && input.duplicateDetection === false) {
    throw new Error('duplicateHardBlock requires duplicateDetection')
  }
  const host = { ...DEFAULT_HOST_INTEGRATION, ...(input.hostIntegration ?? {}) }
  assertPositiveInteger('hostIntegration.maxConvergenceSteersPerTurn', host.maxConvergenceSteersPerTurn)
  assertPositiveInteger('hostIntegration.maxNoProgressCycles', host.maxNoProgressCycles)
  if (host.loopBreakMode !== 'stop-next-step') throw new Error('hostIntegration.loopBreakMode must be stop-next-step')
  return {
    ...DEFAULT_GUARD_CONFIG,
    ...input,
    profiles,
    duplicateWarnAfter,
    hostIntegration: host,
  }
}

export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'undefined'
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`
  const object = value as Record<string, unknown>
  return `{${Object.keys(object).sort().map(key => `${JSON.stringify(key)}:${canonicalJson(object[key])}`).join(',')}}`
}

export function toolSignature(name: string, argumentsValue: unknown): string {
  return createHash('sha256').update(name).update('\0').update(canonicalJson(argumentsValue)).digest('hex')
}

export class GuardStateStore {
  private readonly states = new WeakMap<object, TurnState>()

  beginTurn(agent: object, turn: number, now = Date.now()): TurnState {
    const state: TurnState = {
      turn,
      startedAt: now,
      repeatedSignatures: new Map(),
      modelSteps: 0,
      businessToolCalls: 0,
      softWarningSent: false,
      finalizationHintSent: false,
      convergenceSteers: 0,
      noProgressCycles: 0,
      duplicateWarningSent: false,
      progressSinceStop: false,
      hardStopped: false,
      lastActivityAt: now,
    }
    this.states.set(agent, state)
    return state
  }

  get(agent: object): TurnState | undefined {
    return this.states.get(agent)
  }

  getOrBegin(agent: object, turn: number, now = Date.now()): TurnState {
    const current = this.states.get(agent)
    return current?.turn === turn ? current : this.beginTurn(agent, turn, now)
  }

  clear(agent: object): void {
    this.states.delete(agent)
  }

  clearIfTurn(agent: object, turn: number): void {
    if (this.states.get(agent)?.turn === turn) this.states.delete(agent)
  }
}

export class EfficiencyGuard {
  readonly config: GuardConfig
  readonly states: GuardStateStore

  constructor(config: Partial<GuardConfig> = {}, states = new GuardStateStore()) {
    this.config = validateGuardConfig(config)
    this.states = states
  }

  profile(): GuardProfile {
    return this.config.profiles[this.config.profile]
  }

  admitStep(agent: object, turn: number, now = Date.now()): GuardDecision {
    if (!this.config.enabled) return { kind: 'allow' }
    const state = this.states.getOrBegin(agent, turn, now)
    const profile = this.profile()
    if (state.hardStopped) return { kind: 'deny', code: 'no-progress-loop', reason: 'No-progress loop stopped this turn. Start a new turn to continue.' }
    if (state.modelSteps >= profile.hardSteps) {
      state.hardStopped = true
      return { kind: 'deny', code: 'step-budget', reason: 'Step budget reached. The current task may be incomplete.' }
    }
    if (now - state.startedAt >= profile.hardDurationMs) {
      state.hardStopped = true
      return { kind: 'deny', code: 'time-budget', reason: 'Time budget reached. The current task may be incomplete.' }
    }
    state.modelSteps += 1
    state.lastActivityAt = now
    return { kind: 'allow' }
  }
  admitTool(agent: object, turn: number, now = Date.now()): GuardDecision {
    if (!this.config.enabled) return { kind: 'allow' }
    const state = this.states.get(agent)
    if (state?.turn !== turn) return { kind: 'allow' }
    const profile = this.profile()
    if (state.hardStopped) return { kind: 'deny', code: 'no-progress-loop', reason: 'No-progress loop stopped this turn. Start a new turn to continue.' }
    if (state.businessToolCalls >= profile.hardToolCalls) {
      state.hardStopped = true
      return { kind: 'deny', code: 'tool-budget', reason: 'Tool budget reached for this turn. Use existing results and summarize.' }
    }
    if (now - state.startedAt >= profile.hardDurationMs) {
      state.hardStopped = true
      return { kind: 'deny', code: 'time-budget', reason: 'Time budget reached. The current task may be incomplete.' }
    }
    return { kind: 'allow' }
  }


  observeTool(agent: object, turn: number, observation: ToolCallObservation, now = Date.now()): ObservationResult {
    const state = this.states.getOrBegin(agent, turn, now)
    const profile = this.profile()
    if (observation.controlPlane) return { decision: { kind: 'allow' }, duplicateCount: 0, shouldWarn: false, shouldConverge: false }
    if (state.hardStopped) {
      return { decision: { kind: 'deny', code: 'no-progress-loop', reason: 'No-progress loop stopped this turn. Start a new turn to continue.' }, duplicateCount: 0, shouldWarn: false, shouldConverge: false }
    }
    if (now - state.startedAt >= profile.hardDurationMs) {
      state.hardStopped = true
      return { decision: { kind: 'deny', code: 'time-budget', reason: 'Time budget reached. The current task may be incomplete.' }, duplicateCount: 0, shouldWarn: false, shouldConverge: false }
    }
    if (state.businessToolCalls >= profile.hardToolCalls) {
      state.hardStopped = true
      return { decision: { kind: 'deny', code: 'tool-budget', reason: 'Tool budget reached for this turn. Use existing results and summarize.' }, duplicateCount: 0, shouldWarn: false, shouldConverge: false }
    }
    const signature = toolSignature(observation.name, observation.arguments)
    const previous = state.repeatedSignatures.get(signature)
    const duplicateCount = (previous?.count ?? 0) + 1
    state.repeatedSignatures.set(signature, { count: duplicateCount, lastAt: now })
    state.businessToolCalls += 1
    state.lastActivityAt = now
    if (observation.progress === true || observation.resultFingerprint !== undefined) {
      const fingerprint = observation.resultFingerprint ?? `${observation.name}:${state.businessToolCalls}`
      if (state.lastProgressFingerprint !== fingerprint) {
        state.noProgressCycles = 0
        state.lastProgressFingerprint = fingerprint
      }
    }
    const shouldWarn = this.config.duplicateDetection && duplicateCount >= this.config.duplicateWarnAfter
    const shouldConverge = state.businessToolCalls >= profile.softToolCalls || now - state.startedAt >= profile.softDurationMs
    return { decision: { kind: 'allow' }, duplicateCount, shouldWarn, shouldConverge }
  }

  noteToolResult(agent: object, turn: number, name: string, result: unknown, now = Date.now()): void {
    const state = this.states.get(agent)
    if (state?.turn !== turn) return
    const fingerprint = toolSignature(name, result)
    if (state.lastProgressFingerprint === fingerprint) return
    state.lastProgressFingerprint = fingerprint
    state.progressSinceStop = true
    state.lastActivityAt = now
  }

  needsConvergence(agent: object, turn: number, now = Date.now()): boolean {
    const state = this.states.get(agent)
    if (state?.turn !== turn) return false
    const profile = this.profile()
    return state.modelSteps >= profile.softSteps || state.businessToolCalls >= profile.softToolCalls || now - state.startedAt >= profile.softDurationMs
  }

  noteTurnStopping(agent: object, turn: number, progressed: boolean, convergenceRequested = false, now = Date.now()): { shouldSteer: boolean; shouldStop: boolean } {
    const state = this.states.getOrBegin(agent, turn, now)
    const hadProgress = progressed || state.progressSinceStop
    if (hadProgress) state.noProgressCycles = 0
    else state.noProgressCycles += 1
    state.progressSinceStop = false
    const shouldStop = convergenceRequested && state.convergenceSteers >= this.config.hostIntegration.maxConvergenceSteersPerTurn &&
      state.noProgressCycles >= this.config.hostIntegration.maxNoProgressCycles
    if (shouldStop) {
      state.hardStopped = true
      return { shouldSteer: false, shouldStop: true }
    }
    const shouldSteer = convergenceRequested && !state.finalizationHintSent && state.convergenceSteers < this.config.hostIntegration.maxConvergenceSteersPerTurn
    if (shouldSteer) {
      state.finalizationHintSent = true
      state.softWarningSent = true
      state.convergenceSteers += 1
    }
    return { shouldSteer, shouldStop: false }
  }

  markSoftWarningSent(agent: object, turn: number): void {
    const state = this.states.get(agent)
    if (state?.turn === turn) state.softWarningSent = true
  }
}

export const CONVERGENCE_MESSAGE = '本轮执行预算即将用尽。请停止扩展搜索范围，优先使用已有证据完成当前目标；必要的最后一次验证之后请直接总结。未完成或未经验证的部分必须明确说明。'
