import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { createUserMessage, type UserMessage } from '@deepseek-ai/dsh-llm'
import type { ToolExecution, ToolExecutionResult } from '@deepseek-ai/dsh-tools'
import {
  CONVERGENCE_MESSAGE,
  DEFAULT_GUARD_PROFILES,
  DEFAULT_HOST_INTEGRATION,
  EfficiencyGuard,
  toolSignature,
  type GuardConfig,
  type GuardProfile,
  type HostIntegrationConfig,
} from './guard-core.ts'
export const name = 'agent-efficiency-guard'
export const inject = ['tools']
export interface Config {
  enabled?: boolean
  profile?: 'quick' | 'normal' | 'deep'
  duplicateDetection?: boolean
  duplicateWarnAfter?: number
  duplicateHardBlock?: boolean
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
  duplicateDetection: z.boolean().default(true),
  duplicateWarnAfter: z.number().default(2),
  duplicateHardBlock: z.boolean().default(false),
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

const CONTROL_PLANE_TOOLS = new Set(['meta_search', 'meta_invoke'])

function shortMessage(text: string): UserMessage {
  return createUserMessage({
    content: [{ type: 'text', text }],
    source: { kind: 'user' },
  })
}

function toGuardConfig(config: Config): Partial<GuardConfig> {
  return {
    enabled: config.enabled,
    profile: config.profile,
    duplicateDetection: config.duplicateDetection,
    duplicateWarnAfter: config.duplicateWarnAfter,
    duplicateHardBlock: config.duplicateHardBlock,
    profiles: config.profiles === undefined ? undefined : { ...DEFAULT_GUARD_PROFILES, ...config.profiles },
    hostIntegration: config.hostIntegration === undefined ? undefined : { ...DEFAULT_HOST_INTEGRATION, ...config.hostIntegration },
  }
}

function resultFingerprint(result: Readonly<ToolExecutionResult>): unknown {
  if (result.isError) return { isError: true, error: result.error.message }
  return { isError: false, content: result.content }
}

/**
 * DSH-facing efficiency guard. All state is keyed by the live Agent object and
 * the current turn number; no conversation text or raw tool arguments are
 * persisted. Only a SHA-256 signature and bounded counters remain in memory.
 */
export function apply(ctx: Context, config: Config = {}): void {
  const guard = new EfficiencyGuard(toGuardConfig(config))
  const disposers: Array<() => void> = []

  const toolGuard = ctx.tools.guard((execution) => {
    const agent = execution.agent
    if (agent === undefined || CONTROL_PLANE_TOOLS.has(execution.name)) return undefined
    const state = guard.states.get(agent)
    if (state === undefined) return undefined

    const admission = guard.admitTool(agent, state.turn)
    if (admission.kind === 'deny') return admission.reason

    return undefined
  })
  disposers.push(toolGuard)

  disposers.push(ctx.on('agent/pre-step', async (payload, next) => {
    const admission = guard.admitStep(payload.agent, payload.turn)
    if (admission.kind === 'deny') {
      ctx.logger.warn(`agent-efficiency-guard: ${admission.reason}`)
      return { kind: 'reject' }
    }

    const decision = await next()
    if (decision.kind !== 'enter') return decision
    const state = guard.states.get(payload.agent)
    if (state === undefined || state.softWarningSent || !guard.needsConvergence(payload.agent, payload.turn)) {
      return decision
    }
    guard.markSoftWarningSent(payload.agent, payload.turn)
    return {
      ...decision,
      messages: [...decision.messages, shortMessage(CONVERGENCE_MESSAGE)],
    }
  }))

  disposers.push(ctx.on('agent/turn-stopping', (payload) => {
    const state = guard.states.get(payload.agent)
    if (state === undefined) return
    const convergenceRequested = guard.needsConvergence(payload.agent, payload.turn)
    const action = guard.noteTurnStopping(payload.agent, payload.turn, state.progressSinceStop, convergenceRequested)
    if (action.shouldStop) {
      ctx.logger.warn('agent-efficiency-guard: no-progress loop stopped; the current task may be incomplete')
      return
    }
    if (action.shouldSteer) {
      payload.agent.steer(shortMessage(CONVERGENCE_MESSAGE))
    }
  }))

  disposers.push(ctx.on('tools/result', (execution: Readonly<ToolExecution>, result: Readonly<ToolExecutionResult>) => {
    const agent = execution.agent
    const state = agent === undefined ? undefined : guard.states.get(agent)
    if (agent === undefined || state === undefined) return
    const observed = guard.observeTool(agent, state.turn, {
      name: execution.name,
      arguments: execution.arguments,
      controlPlane: CONTROL_PLANE_TOOLS.has(execution.name),
      resultFingerprint: toolSignature(execution.name, resultFingerprint(result)),
    })
    if (observed.decision.kind === 'deny') return
    const current = guard.states.get(agent)
    if (observed.shouldWarn && current !== undefined && !current.duplicateWarningSent) {
      current.duplicateWarningSent = true
      agent.inject(shortMessage('该调用与本轮之前的调用完全相同，请检查已有结果，不要无意义重复。'))
    }
    if (observed.shouldConverge && current !== undefined && !current.softWarningSent) {
      guard.markSoftWarningSent(agent, state.turn)
      agent.inject(shortMessage(CONVERGENCE_MESSAGE))
    }
  }))

  disposers.push(ctx.on('agent/disposed', ({ agent }) => guard.states.clear(agent)))

  ctx.logger.info('agent-efficiency-guard: enabled; host Token Saver/Prompt Cache remain owned by the host and existing Save Token plugin')
  ctx.effect(() => () => {
    for (const dispose of disposers.splice(0)) dispose()
  }, 'agent-efficiency-guard: cleanup')
}
