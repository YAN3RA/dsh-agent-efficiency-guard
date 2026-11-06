import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { createUserMessage, type UserMessage } from '@deepseek-ai/dsh-llm'
import { TOOL_ABORTED, TOOL_ABORTED_BEFORE_DISPATCH, type ToolExecution, type ToolExecutionResult } from '@deepseek-ai/dsh-tools'
import type { CapabilityPolicyService } from './policy.ts'
import {
  DEFAULT_REPEAT_THRESHOLDS,
  LOOP_HISTORY_LIMIT,
  createGuardLoopState,
  guardResultFingerprint,
  guardToolSignature,
  observeGuardLoop,
  type GuardLoopOptions,
  type GuardToolOutcome,
} from './guard-loop-core.ts'
import {
  DEFAULT_GUARD_PROFILES,
  DEFAULT_HOST_INTEGRATION,
  EfficiencyGuard,
  type GuardConfig,
  type GuardProfile,
  type HostIntegrationConfig,
  type PendingLoopObservation,
  type TurnState,
} from './guard-core.ts'
export const name = 'thinking-guard'
export const inject = ['tools', 'capabilityPolicy']

declare module '@deepseek-ai/dsh-llm' {
  interface MessageSourceMap {
    'thinking-guard': { kind: 'thinking-guard' }
  }
}

const DEFAULT_POLLING_TOOLS = [
  'get_image_generation_task', 'job_output', 'job_status', 'wait', 'wait_status', 'wait_for_job', 'poll_job', 'get_status',
] as const
const DEFAULT_WARN_ONLY_TOOLS = [
  'read', 'read_file', 'read_text_file', 'cat', 'ls', 'list_files', 'glob', 'grep', 'search', 'find', 'stat',
] as const
export interface Config {
  enabled?: boolean
  profile?: 'quick' | 'normal' | 'deep'
  /** @deprecated Accepted for migration only; hard steps never stop a turn. */
  stepLimitMode?: 'warn-only' | 'hard-stop'
  duplicateDetection?: boolean
  /** Alternating-cycle detection (A -> B -> A -> B). Defaults to on. */
  alternatingCycleDetection?: boolean
  /** No-progress protection: may locally deny a repeated call. Defaults to on. */
  noProgressProtection?: boolean
  /** @deprecated Accepted for config migration only; N7 uses fixed 3/5/8 thresholds. */
  duplicateWarnAfter?: number
  duplicateHardBlock?: boolean
  /** Exact names excluded from duplicate and cycle detection. */
  excludedTools?: string[]
  /** Exact polling/status tools; warn/block detection is skipped, counters remain. */
  pollingTools?: string[]
  /** Exact tools may warn but never be locally denied based on identical results. */
  warnOnlyTools?: string[]
  profiles?: Partial<Record<'quick' | 'normal' | 'deep', GuardProfile>>
  hostIntegration?: Partial<HostIntegrationConfig>
}

const profileSchema = z.object({
  softSteps: z.number(),
  hardSteps: z.number(),
  softToolCalls: z.number(),
  hardToolCalls: z.number(),
  softDurationMs: z.number(),
  hardDurationMs: z.number(),
})

export const Config: z<Config> = z.object({
  enabled: z.boolean().default(true),
  profile: z.union(['quick', 'normal', 'deep']).default('normal'),
  stepLimitMode: z.union(['warn-only', 'hard-stop']).default('warn-only'),
  duplicateDetection: z.boolean().default(true),
  alternatingCycleDetection: z.boolean().default(true),
  noProgressProtection: z.boolean().default(true),
  duplicateWarnAfter: z.number().default(2),
  duplicateHardBlock: z.boolean().default(false),
  excludedTools: z.array(z.string()).default([]),
  pollingTools: z.array(z.string()).default([...DEFAULT_POLLING_TOOLS]),
  warnOnlyTools: z.array(z.string()).default([...DEFAULT_WARN_ONLY_TOOLS]),
  profiles: z.object({
    quick: profileSchema.default(DEFAULT_GUARD_PROFILES.quick),
    normal: profileSchema.default(DEFAULT_GUARD_PROFILES.normal),
    deep: profileSchema.default(DEFAULT_GUARD_PROFILES.deep),
  }),
  hostIntegration: z.object({
    enabled: z.boolean().default(DEFAULT_HOST_INTEGRATION.enabled),
    provider: z.string().default(DEFAULT_HOST_INTEGRATION.provider),
    preferHostTokenSaver: z.boolean().default(DEFAULT_HOST_INTEGRATION.preferHostTokenSaver),
    preferHostPromptCache: z.boolean().default(DEFAULT_HOST_INTEGRATION.preferHostPromptCache),
    maxConvergenceSteersPerTurn: z.number().default(DEFAULT_HOST_INTEGRATION.maxConvergenceSteersPerTurn),
    maxNoProgressCycles: z.number().default(DEFAULT_HOST_INTEGRATION.maxNoProgressCycles),
    loopBreakMode: z.union(['stop-next-step']).default(DEFAULT_HOST_INTEGRATION.loopBreakMode),
  }),
})

const RESERVED_TRANSPORT_TOOLS = new Set(['run_code'])
const MAX_PENDING_DISPATCHES = 64
const MAX_LOCAL_LOOP_DENIALS = 16
const LOOP_WARNING_LIMIT = 32

function isControlPlaneTool(policy: CapabilityPolicyService, name: string): boolean {
  return RESERVED_TRANSPORT_TOOLS.has(name) || policy.metaTools().includes(name)
}

function rememberDeniedCall(state: { deniedCallIds: Set<string> }, callId: string): void {
  if (state.deniedCallIds.has(callId)) return
  if (state.deniedCallIds.size >= MAX_LOCAL_LOOP_DENIALS) {
    const oldest = state.deniedCallIds.values().next().value
    if (oldest !== undefined) state.deniedCallIds.delete(oldest)
  }
  state.deniedCallIds.add(callId)
}

function rememberUserMessage(state: { userMessageIds: Set<string> }, messageId: string): boolean {
  if (state.userMessageIds.has(messageId)) return false
  if (state.userMessageIds.size >= LOOP_WARNING_LIMIT) {
    const oldest = state.userMessageIds.values().next().value
    if (oldest !== undefined) state.userMessageIds.delete(oldest)
  }
  state.userMessageIds.add(messageId)
  return true
}

function failOpenLoopDetection(state: TurnState): void {
  state.loopDetectionDisabled = true
  state.dispatchRecords.clear()
  state.pendingLoopObservations.clear()
  state.pendingBlockSignatures.clear()
  state.loopState = createGuardLoopState(state.turn)
  state.nextLoopSequence = state.nextDispatchSequence
}

function rememberLoopWarning(state: { loopWarnings: Set<string> }, key: string): boolean {
  if (state.loopWarnings.has(key)) return false
  if (state.loopWarnings.size >= LOOP_WARNING_LIMIT) {
    const oldest = state.loopWarnings.values().next().value
    if (oldest !== undefined) state.loopWarnings.delete(oldest)
  }
  state.loopWarnings.add(key)
  return true
}

function rememberBlockCandidate(state: { pendingBlockSignatures: Set<string> }, signature: string): void {
  if (state.pendingBlockSignatures.has(signature)) return
  if (state.pendingBlockSignatures.size >= LOOP_HISTORY_LIMIT) {
    const oldest = state.pendingBlockSignatures.values().next().value
    if (oldest !== undefined) state.pendingBlockSignatures.delete(oldest)
  }
  state.pendingBlockSignatures.add(signature)
}

function rememberBlockedSignature(state: { blockedLoopSignatures: Set<string> }, signature: string): void {
  if (state.blockedLoopSignatures.has(signature)) return
  if (state.blockedLoopSignatures.size >= MAX_LOCAL_LOOP_DENIALS) {
    const oldest = state.blockedLoopSignatures.values().next().value
    if (oldest !== undefined) state.blockedLoopSignatures.delete(oldest)
  }
  state.blockedLoopSignatures.add(signature)
}

function outcomeFor(result: Readonly<ToolExecutionResult>): GuardToolOutcome {
  if (!result.isError) return 'success'
  if (result.error.info?.code === TOOL_ABORTED || result.error.info?.code === TOOL_ABORTED_BEFORE_DISPATCH) return 'cancelled'
  return 'error'
}

function shortMessage(text: string): UserMessage {
  return createUserMessage({
    content: [{ type: 'text', text }],
    source: { kind: 'thinking-guard' },
  })
}

function handleLoopObservation(
  state: TurnState,
  agent: ToolExecution['agent'],
  observation: PendingLoopObservation,
  options: GuardLoopOptions,
): void {
  if (agent === undefined || state.loopDetectionDisabled) return
  const loopObserved = observeGuardLoop(state.loopState, state.turn, {
    name: observation.name,
    signature: observation.signature,
    callId: observation.callId,
    dispatchSequence: observation.dispatchSequence,
    outcome: observation.outcome,
    resultFingerprint: observation.resultFingerprint,
  }, options)
  state.loopState = loopObserved.state
  const decision = loopObserved.decision
  const signature = decision.signature
  // No-progress protection is the evidence gate for the LOCAL denial. With it off
  // the call is still reminded about (below), but never becomes blockable, so the
  // switch in the settings page changes behaviour instead of being cosmetic.
  if (signature !== undefined && decision.blockCandidate && options.noProgressProtection !== false) {
    rememberBlockCandidate(state, signature)
  }
  if (signature === undefined || decision.warning === 'none') return

  const warningKey = `${signature}:${decision.warning}:${decision.repeatThreshold ?? LOOP_HISTORY_LIMIT}`
  if (!rememberLoopWarning(state, warningKey)) return
  const message = decision.warning === 'alternating-cycle'
    ? decision.noProgressEvidence === 'none'
      ? '检测到交替工具调用序列，但结果仍变化或证据不足；暂不拒绝任何调用。'
      : '检测到交替工具调用循环且结果/错误指纹未变化；后续相同循环调用可能被局部拒绝，当前 Turn 会继续。'
    : `检测到工具调用连续重复（第 ${decision.repeatThreshold ?? decision.repeatCount} 次）；请检查已有结果，避免无意义重复。`
  agent.inject(shortMessage(message))
}
function createLoopOptions(
  ctx: Context,
  excludedTools: ReadonlySet<string>,
  pollingTools: ReadonlySet<string>,
  warnOnlyTools: ReadonlySet<string>,
  alternatingCycleEnabled: boolean,
): GuardLoopOptions {
  return {
    repeatThresholds: DEFAULT_REPEAT_THRESHOLDS,
    excludedTools: new Set([...excludedTools, ...ctx.capabilityPolicy.metaTools(), ...RESERVED_TRANSPORT_TOOLS]),
    pollingTools,
    warnOnlyTools,
    alternatingCycleEnabled,
  }
}
function toGuardConfig(config: Config): Partial<GuardConfig> {
  return {
    enabled: config.enabled,
    profile: config.profile,
    stepLimitMode: config.stepLimitMode,
    duplicateDetection: config.duplicateDetection,
    alternatingCycleDetection: config.alternatingCycleDetection,
    noProgressProtection: config.noProgressProtection,
    duplicateWarnAfter: config.duplicateWarnAfter,
    duplicateHardBlock: config.duplicateHardBlock,
    profiles: config.profiles === undefined ? undefined : { ...DEFAULT_GUARD_PROFILES, ...config.profiles },
    hostIntegration: config.hostIntegration === undefined ? undefined : { ...DEFAULT_HOST_INTEGRATION, ...config.hostIntegration },
  }
}

/**
 * Live Guard switches, with the settings page taking precedence.
 *
 * The page writes through `ctx.capabilityPolicy.updateGuard`, which persists and
 * updates the service immediately, so a toggle takes effect on the next tool call
 * without reloading the plugin. The patch-file config stays the base for a
 * deployment that never opens the page.
 */
function readSwitches(ctx: Context, config: Config): Required<Pick<Config,
  'enabled' | 'duplicateDetection' | 'alternatingCycleDetection' | 'noProgressProtection'>> {
  const live = ctx.get('capabilityPolicy')?.getGuard()
  return {
    enabled: live?.enabled ?? config.enabled ?? true,
    duplicateDetection: live?.duplicateDetection ?? config.duplicateDetection ?? true,
    alternatingCycleDetection:
      live?.alternatingCycleDetection ?? config.alternatingCycleDetection ?? true,
    noProgressProtection: live?.noProgressProtection ?? config.noProgressProtection ?? true,
  }
}

/**
 * DSH-facing efficiency guard. All state is keyed by the live Agent object and
 * the current turn number; no conversation text or raw tool arguments are
 * persisted. Only a SHA-256 signature and bounded counters remain in memory.
 */
export function apply(ctx: Context, config: Config = {}): void {
  if (config.stepLimitMode === 'hard-stop') {
    ctx.logger.warn('thinking-guard: stepLimitMode=hard-stop is deprecated and ignored; normal task steps are never blocked by hardSteps')
  }
  if (config.duplicateHardBlock === true) {
    ctx.logger.warn('thinking-guard: duplicateHardBlock is deprecated and ignored; duplicate calls are advisory until no-progress evidence is confirmed')
  }
  const guard = new EfficiencyGuard(toGuardConfig(config))
  const disposers: Array<() => void> = []
  const excludedTools = new Set(config.excludedTools ?? [])
  const pollingTools = new Set([...DEFAULT_POLLING_TOOLS, ...(config.pollingTools ?? [])])
  const warnOnlyTools = new Set([...DEFAULT_WARN_ONLY_TOOLS, ...(config.warnOnlyTools ?? [])])
  const switches = (): ReturnType<typeof readSwitches> => readSwitches(ctx, config)
  const loopOptions = (): GuardLoopOptions => ({
    ...createLoopOptions(ctx, excludedTools, pollingTools, warnOnlyTools, switches().alternatingCycleDetection),
    noProgressProtection: switches().noProgressProtection,
  })

  const toolGuard = ctx.tools.guard((execution) => {
    const agent = execution.agent
    const sw = switches()
    if (!sw.enabled || !sw.duplicateDetection || agent === undefined
      || isControlPlaneTool(ctx.capabilityPolicy, execution.name)
      || excludedTools.has(execution.name) || pollingTools.has(execution.name) || warnOnlyTools.has(execution.name)) return undefined
    const state = guard.states.get(agent)
    if (state === undefined || state.loopDetectionDisabled) return undefined
    const signature = guardToolSignature(execution.name, execution.arguments)
    if (state.localLoopDenials >= MAX_LOCAL_LOOP_DENIALS
      || !state.pendingBlockSignatures.delete(signature)
      || state.blockedLoopSignatures.has(signature)) return undefined
    rememberBlockedSignature(state, signature)
    rememberDeniedCall(state, String(execution.callId))
    state.localLoopDenials += 1
    return '检测到相同工具调用及相同结果/错误证据；已局部拒绝本次重复调用，当前 Turn 继续运行。'
  })
  disposers.push(toolGuard)

  disposers.push(ctx.on('agent/pre-step', async (payload, next) => {
    guard.admitStep(payload.agent, payload.turn)
    return next()
  }))

  disposers.push(ctx.on('agent/inbox/inserted', ({ agent, message }) => {
    const state = guard.states.get(agent)
    if (state === undefined || message.source.kind !== 'user') return
    if (!rememberUserMessage(state, String(message.id))) return
    guard.resetLoopState(agent)
  }))

  disposers.push(ctx.on('tools/execute', async (execution, next) => {
    const agent = execution.agent
    if (!switches().enabled || !switches().duplicateDetection || agent === undefined) return next()
    const state = guard.states.get(agent)
    if (state === undefined || state.loopDetectionDisabled) return next()

    const callId = String(execution.callId)
    if (state.dispatchRecords.has(callId)
      || state.dispatchRecords.size + state.pendingLoopObservations.size >= MAX_PENDING_DISPATCHES) {
      failOpenLoopDetection(state)
      return next()
    }
    const dispatchSequence = state.nextDispatchSequence++
    const epoch = state.loopEpoch
    const signature = guardToolSignature(execution.name, execution.arguments)
    state.dispatchRecords.set(callId, { sequence: dispatchSequence, epoch, name: execution.name, signature })
    guard.observeTool(agent, state.turn, { controlPlane: isControlPlaneTool(ctx.capabilityPolicy, execution.name) })
    return next()
  }))

  disposers.push(ctx.on('tools/result', (execution: Readonly<ToolExecution>, result: Readonly<ToolExecutionResult>) => {
    const agent = execution.agent
    const state = agent === undefined ? undefined : guard.states.get(agent)
    if (!switches().enabled || agent === undefined || state === undefined) return
    const callId = String(execution.callId)
    if (state.deniedCallIds.delete(callId)) return

    const dispatch = state.dispatchRecords.get(callId)
    if (dispatch === undefined) return
    state.dispatchRecords.delete(callId)
    if (dispatch.epoch !== state.loopEpoch || !switches().duplicateDetection || state.loopDetectionDisabled) return

    const outcome = outcomeFor(result)
    const evidence = result.isError
      ? { code: result.error.info?.code ?? null, message: result.error.message, content: result.content }
      : { value: result.value, content: result.content }
    const pending: PendingLoopObservation = {
      name: dispatch.name,
      callId,
      dispatchSequence: dispatch.sequence,
      epoch: dispatch.epoch,
      signature: dispatch.signature,
      outcome,
      resultFingerprint: guardResultFingerprint(outcome, evidence),
    }
    if (state.pendingLoopObservations.size >= MAX_PENDING_DISPATCHES) {
      failOpenLoopDetection(state)
      return
    }
    state.pendingLoopObservations.set(dispatch.sequence, pending)

    while (state.pendingLoopObservations.has(state.nextLoopSequence)) {
      const observation = state.pendingLoopObservations.get(state.nextLoopSequence)
      state.pendingLoopObservations.delete(state.nextLoopSequence)
      state.nextLoopSequence += 1
      if (observation === null || observation === undefined || observation.epoch !== state.loopEpoch) continue
      handleLoopObservation(state, agent, observation, loopOptions())
    }
  }))

  disposers.push(ctx.on('agent/disposed', ({ agent }) => guard.states.clear(agent)))

  ctx.logger.info(`thinking-guard: ${guard.config.enabled ? 'enabled' : 'disabled'}; host Token Saver/Prompt Cache remain owned by the host and existing Save Token plugin`)
  ctx.effect(() => () => {
    for (const dispose of disposers.splice(0)) dispose()
  }, 'thinking-guard: cleanup')
}
