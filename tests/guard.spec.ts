import type { Context } from '@deepseek-ai/cordis'
import { TOOL_ABORTED } from '@deepseek-ai/dsh-tools'
import { describe, expect, it, vi } from 'vitest'
import { apply, Config } from '../src/guard.ts'

type Execution = { callId: string; agent: { inject: ReturnType<typeof vi.fn> }; name: string; arguments: unknown }
type Result = { isError: boolean; value?: unknown; error?: { message: string; info?: { name: string; code: string } }; content: Array<{ type: string; text?: string }> }

function injectedText(agent: Execution['agent']): string {
  return agent.inject.mock.calls.flat().map((message) => {
    const value = message as { content?: Array<{ type?: string; text?: string }> }
    return value.content?.filter(block => block.type === 'text').map(block => block.text ?? '').join('') ?? ''
  }).join('\n')
}

function setup(config: Parameters<typeof apply>[1] = {}) {
  const hooks = new Map<string, (...args: any[]) => any>()
  const warn = vi.fn(), info = vi.fn(), toolGuard = vi.fn(), toolBodies = vi.fn()
  let registeredGuard: ((execution: any) => string | undefined) | undefined
  const disposers: Array<ReturnType<typeof vi.fn>> = []
  const capabilityPolicy = { metaTools: vi.fn(() => ['meta_search', 'meta_invoke']) }
  let cleanup: (() => void) | undefined
  const ctx = {
    logger: { warn, info }, capabilityPolicy,
    // The Guard reads live switches through `ctx.get('capabilityPolicy')`; a
    // host without that service falls back to the patch config, which is what
    // `undefined` models here.
    get: (key: string) => (key === 'capabilityPolicy' ? undefined : undefined),
    tools: { guard: (callback: (execution: any) => string | undefined) => {
      toolGuard(callback)
      registeredGuard = callback
      const dispose = vi.fn()
      disposers.push(dispose)
      return dispose
    } },
    on: (name: string, handler: (...args: any[]) => any) => {
      hooks.set(name, handler)
      const dispose = vi.fn()
      disposers.push(dispose)
      return dispose
    },
    effect: (factory: () => () => void) => { cleanup = factory() },
  }
  apply(ctx as unknown as Context, config)
  return { hooks, warn, info, toolGuard, toolBodies, capabilityPolicy, registeredGuard: () => registeredGuard, disposers, cleanup: () => cleanup?.() }
}

type TestHost = ReturnType<typeof setup>

function execution(agent: Execution['agent'], name: string, args: unknown, callId: string): Execution {
  return { agent, name, arguments: args, callId }
}

function success(value: unknown, text = JSON.stringify(value)): Result {
  return { isError: false, value, content: [{ type: 'text', text }] }
}

async function prepareTurn(host: TestHost, agent: Execution['agent']): Promise<void> {
  const next = vi.fn(async () => ({ kind: 'continue' }))
  await host.hooks.get('agent/pre-step')!({ agent, turn: 1 }, next)
}

async function executeOnly(host: TestHost, call: Execution, result: Result = success({ ok: true }), prepared = false): Promise<void> {
  if (!prepared) await prepareTurn(host, call.agent)
  const execute = host.hooks.get('tools/execute')!
  const next = vi.fn(async () => result)
  await execute(call, next)
  if (next.mock.calls.length > 0) host.toolBodies(call)
}

function resultOnly(host: TestHost, call: Execution, result: Result): void {
  host.hooks.get('tools/result')!(call, result)
}

async function runTool(host: TestHost, call: Execution, result: Result): Promise<string | undefined> {
  await prepareTurn(host, call.agent)
  const denial = host.registeredGuard()!(call)
  if (denial !== undefined) {
    resultOnly(host, call, { isError: true, error: { message: denial }, content: [{ type: 'text', text: denial }] })
    return denial
  }
  await executeOnly(host, call, result, true)
  resultOnly(host, call, result)
  return undefined
}

describe('Guard Host hooks', () => {
  it('reports disabled state and does not inject reminders', async () => {
    const host = setup({ enabled: false })
    expect(host.info.mock.calls.flat().join(' ')).toContain('thinking-guard: disabled;')
    const agent = { inject: vi.fn() }
    const next = vi.fn(async () => ({ kind: 'continue' }))
    expect(await host.hooks.get('agent/pre-step')!({ agent, turn: 1 }, next)).toEqual({ kind: 'continue' })
    expect(await host.hooks.get('tools/execute')!(execution(agent, 'write', {}, 'd1'), next)).toEqual({ kind: 'continue' })
    expect(agent.inject).not.toHaveBeenCalled()
  })

  it('accepts legacy schema switches and keeps steps running without convergence prompts', async () => {
    const parsed = Config({ stepLimitMode: 'hard-stop', duplicateHardBlock: true })
    const host = setup(parsed)
    expect(host.warn).toHaveBeenCalledTimes(2)
    expect(host.warn.mock.calls.flat().join(' ')).toMatch(/stepLimitMode=hard-stop/)
    expect(host.warn.mock.calls.flat().join(' ')).toMatch(/duplicateHardBlock/)
    expect(host.toolGuard).toHaveBeenCalledOnce()
    expect(host.registeredGuard()).toBeTypeOf('function')
    expect(host.hooks.has('agent/turn-stopping')).toBe(false)
    const agent = { inject: vi.fn() }, messages: unknown[] = []
    const next = vi.fn(async () => ({ kind: 'continue' }))
    for (let i = 0; i < 30; i++) {
      expect(await host.hooks.get('agent/pre-step')!({ agent, turn: 1, messages }, next)).toEqual({ kind: 'continue' })
    }
    expect(next).toHaveBeenCalledTimes(30)
    expect(agent.inject).not.toHaveBeenCalled()
    expect(messages).toEqual([])
  })

  it('warns at repeat thresholds and only locally denies after unchanged evidence', async () => {
    const host = setup()
    const agent = { inject: vi.fn() }
    const callFor = (index: number) => execution(agent, 'write', { path: 'same' }, `w-${index}`)
    const same = success({ rows: [1] })
    for (let i = 1; i <= 8; i++) {
      expect(await runTool(host, callFor(i), same)).toBeUndefined()
      if ([3, 5, 8].includes(i)) expect(injectedText(agent)).toContain(`第 ${i} 次`)
    }
    expect(await runTool(host, callFor(9), same)).toContain('局部拒绝')
    expect(await runTool(host, callFor(10), same)).toBeUndefined()
    expect(await runTool(host, callFor(11), same)).toBeUndefined()
  })

  it('does not locally block common read-only tools even when their result is unchanged', async () => {
    const host = setup()
    const agent = { inject: vi.fn() }
    const same = success({ rows: ['same'] })
    for (let i = 1; i <= 10; i++) {
      expect(await runTool(host, execution(agent, 'read', { path: 'a' }, `r-${i}`), same)).toBeUndefined()
    }
    expect(injectedText(agent)).toContain('第 3 次')
    expect(injectedText(agent)).toContain('第 5 次')
    expect(injectedText(agent)).toContain('第 8 次')
  })

  it('excludes configured polling tools and default image/job status polling', async () => {
    const host = setup({ excludedTools: ['custom_poll'], pollingTools: ['custom_wait'] })
    const agent = { inject: vi.fn() }
    for (const name of ['get_image_generation_task', 'job_output', 'custom_poll', 'custom_wait']) {
      for (let i = 0; i < 10; i++) {
        expect(await runTool(host, execution(agent, name, { id: 'job-1' }, `${name}-${i}`), success({ status: 'running' }))).toBeUndefined()
      }
    }
    expect(injectedText(agent)).toBe('')
    expect(host.registeredGuard()!(execution(agent, 'job_output', { id: 'job-1' }, 'poll-next'))).toBeUndefined()
  })

  it('uses live policy metaTools and excludes the reserved run_code transport', async () => {
    const host = setup()
    host.capabilityPolicy.metaTools.mockReturnValue(['meta_find'])
    const agent = { inject: vi.fn() }
    for (const name of ['meta_find', 'run_code']) {
      for (let i = 0; i < 10; i++) {
        await runTool(host, execution(agent, name, { query: 'x' }, `${name}-${i}`), success({ ok: true }))
      }
    }
    expect(injectedText(agent)).toBe('')
  })

  it('orders parallel results by callId dispatch sequence instead of completion order', async () => {
    const host = setup()
    const agent = { inject: vi.fn() }
    const calls = [
      execution(agent, 'tool-a', { id: 'a1' }, 'a1'),
      execution(agent, 'tool-a', { id: 'a2' }, 'a2'),
      execution(agent, 'tool-b', { id: 'b1' }, 'b1'),
      execution(agent, 'tool-b', { id: 'b2' }, 'b2'),
    ]
    for (const call of calls) await executeOnly(host, call)
    const unchanged = success({ stable: true })
    for (const index of [0, 2, 1, 3]) resultOnly(host, calls[index], unchanged)
    expect(injectedText(agent)).not.toContain('交替工具调用序列')
    expect(host.registeredGuard()!(execution(agent, 'tool-a', { id: 'a3' }, 'a3'))).toBeUndefined()
  })

  it('fails open when an earlier dispatch result is unresolved beyond the bounded queue', async () => {
    const host = setup()
    const agent = { inject: vi.fn() }
    for (let i = 0; i < 65; i++) await executeOnly(host, execution(agent, 'write', { i }, `gap-${i}`))
    for (let i = 0; i < 65; i++) resultOnly(host, execution(agent, 'write', { i }, `gap-${i}`), success({ stable: true }))
    expect(host.registeredGuard()!(execution(agent, 'write', { i: 99 }, 'after-overflow'))).toBeUndefined()
  })

  it('does not count a Guard denial or feed its result back into loop evidence', async () => {
    const host = setup()
    const agent = { inject: vi.fn() }
    const call = (i: number) => execution(agent, 'write', { path: 'same' }, `deny-${i}`)
    const same = success({ stable: true })
    for (let i = 1; i <= 8; i++) await runTool(host, call(i), same)
    expect(await runTool(host, call(9), same)).toContain('局部拒绝')
    expect(host.toolBodies).toHaveBeenCalledTimes(8)
    expect(await runTool(host, call(10), same)).toBeUndefined()
    expect(host.toolBodies).toHaveBeenCalledTimes(9)
  })

  it('resets loop evidence on real user input but ignores synthetic Guard reminders', async () => {
    const host = setup()
    const agent = { inject: vi.fn() }
    const makeCall = (i: number) => execution(agent, 'write', { path: 'same' }, `steer-${i}`)
    const same = success({ stable: true })
    for (let i = 1; i <= 8; i++) await runTool(host, makeCall(i), same)
    const reminder = agent.inject.mock.calls[0]?.[0] as { id: string; source: { kind: string } }
    expect(reminder?.source.kind).toBe('thinking-guard')
    host.hooks.get('agent/inbox/inserted')!({ agent, message: reminder })
    expect(await runTool(host, makeCall(9), same)).toContain('局部拒绝')
    host.hooks.get('agent/inbox/inserted')!({ agent, message: { id: 'user-1', source: { kind: 'user' } } })
    for (let i = 10; i <= 17; i++) expect(await runTool(host, makeCall(i), same)).toBeUndefined()
    expect(await runTool(host, makeCall(18), same)).toContain('局部拒绝')
  })

  it('uses error and cancellation fingerprints and resets the chain on a user steer', async () => {
    const host = setup()
    const agent = { inject: vi.fn() }
    const call = (i: number) => execution(agent, 'fetch', { url: 'https://example.invalid' }, `err-${i}`)
    const failed: Result = { isError: true, error: { message: 'network failure', info: { name: 'Error', code: 'NETWORK' } }, content: [] }
    for (let i = 1; i <= 8; i++) await runTool(host, call(i), failed)
    expect(injectedText(agent)).toContain('连续重复')
    expect(await runTool(host, call(9), failed)).toContain('局部拒绝')
    const cancelledCall = (i: number) => execution(agent, 'fetch-cancelled', { url: 'https://example.invalid' }, `cancel-${i}`)
    const cancelled: Result = { isError: true, error: { message: 'cancelled', info: { name: 'AbortError', code: TOOL_ABORTED } }, content: [] }
    for (let i = 10; i <= 17; i++) await runTool(host, cancelledCall(i), cancelled)
    expect(await runTool(host, cancelledCall(18), cancelled)).toContain('局部拒绝')
  })

  it('does not treat content changes as unchanged when canonical values are equal', async () => {
    const host = setup()
    const agent = { inject: vi.fn() }
    for (let i = 1; i <= 8; i++) {
      expect(await runTool(host, execution(agent, 'write', { id: 1 }, `content-${i}`), success({ stable: true }, `content-${i}`))).toBeUndefined()
    }
    expect(host.registeredGuard()!(execution(agent, 'write', { id: 1 }, 'content-next'))).toBeUndefined()
  })

  it('keeps the disabled switch silent and disposes every registered hook', async () => {
    const disabled = setup({ duplicateDetection: false })
    const agent = { inject: vi.fn() }
    for (let i = 1; i <= 10; i++) await runTool(disabled, execution(agent, 'write', { id: 1 }, `disabled-${i}`), success({ stable: true }))
    expect(injectedText(agent)).toBe('')
    expect(disabled.registeredGuard()!(execution(agent, 'write', { id: 1 }, 'disabled-next'))).toBeUndefined()

    const host = setup()
    const cleanAgent = { inject: vi.fn() }
    await runTool(host, execution(cleanAgent, 'meta_invoke', {}, 'meta-1'), success({}))
    expect(cleanAgent.inject).not.toHaveBeenCalled()
    host.hooks.get('agent/disposed')!({ agent: cleanAgent })
    host.cleanup()
    for (const dispose of host.disposers) expect(dispose).toHaveBeenCalledOnce()
  })
})

describe('Guard live switches from the settings page', () => {
  /**
   * The settings page writes through the policy service. These tests install a
   * fake policy that returns those switches, so they fail if the Guard ever
   * reads a stale copy: the whole point is that a toggle applies without a reload.
   */
  function setupWithSwitches(initial: {
    enabled: boolean; duplicateDetection: boolean
    alternatingCycleDetection: boolean; noProgressProtection: boolean
  }) {
    const switches = { ...initial }
    const hooks = new Map<string, (...args: any[]) => any>()
    const info = vi.fn()
    let registeredGuard: ((execution: any) => string | undefined) | undefined
    const ctx = {
      logger: { warn: vi.fn(), info },
      capabilityPolicy: { metaTools: () => ['meta_search', 'meta_invoke'], getGuard: () => switches },
      get: (key: string) => (key === 'capabilityPolicy' ? { getGuard: () => switches } : undefined),
      tools: {
        guard: (callback: (execution: any) => string | undefined) => {
          registeredGuard = callback
          return vi.fn()
        },
      },
      on: (name: string, handler: (...args: any[]) => any) => {
        hooks.set(name, handler)
        return vi.fn()
      },
      effect: () => undefined,
    }
    apply(ctx as unknown as Context, {})
    return {
      hooks,
      switches,
      guard: () => registeredGuard!,
      toggle: (patch: Partial<typeof switches>) => Object.assign(switches, patch),
    }
  }

  /** Drive N identical calls that all share one result fingerprint. */
  async function repeatIdentical(
    host: ReturnType<typeof setupWithSwitches>,
    agent: { inject: ReturnType<typeof vi.fn> },
    times: number,
  ): Promise<string[]> {
    const denials: string[] = []
    const next = vi.fn(async () => ({ kind: 'continue' }))
    await host.hooks.get('agent/pre-step')!({ agent, turn: 1 }, next)
    for (let i = 0; i < times; i += 1) {
      const call = execution(agent, 'write', { same: true }, `same-${i}`)
      const denial = host.guard()(call)
      if (denial !== undefined) {
        denials.push(denial)
        host.hooks.get('tools/result')!(call, {
          isError: true, error: { message: denial }, content: [{ type: 'text', text: denial }],
        })
        continue
      }
      await host.hooks.get('tools/execute')!(call, vi.fn(async () => success({ ok: true })))
      host.hooks.get('tools/result')!(call, success({ ok: true }))
    }
    return denials
  }

  it('produces no reminders and no denials while the master switch is off', async () => {
    const host = setupWithSwitches({
      enabled: false, duplicateDetection: true, alternatingCycleDetection: true, noProgressProtection: true,
    })
    const agent = { inject: vi.fn() }
    const denials = await repeatIdentical(host, agent, 9)
    expect(denials).toEqual([])
    expect(agent.inject).not.toHaveBeenCalled()
  })

  it('reminds but never denies once no-progress protection is turned off', async () => {
    const host = setupWithSwitches({
      enabled: true, duplicateDetection: true, alternatingCycleDetection: true, noProgressProtection: false,
    })
    const agent = { inject: vi.fn() }
    const denials = await repeatIdentical(host, agent, 9)
    // Reminders still land…
    expect(agent.inject).toHaveBeenCalled()
    // …but the local denial never fires.
    expect(denials).toEqual([])
  })

  it('starts denying the repeated call when no-progress protection is on', async () => {
    const host = setupWithSwitches({
      enabled: true, duplicateDetection: true, alternatingCycleDetection: true, noProgressProtection: true,
    })
    const agent = { inject: vi.fn() }
    const denials = await repeatIdentical(host, agent, 9)
    expect(denials.length).toBeGreaterThan(0)
  })

  it('applies a flipped switch immediately, without re-applying the plugin', async () => {
    const host = setupWithSwitches({
      enabled: true, duplicateDetection: true, alternatingCycleDetection: true, noProgressProtection: true,
    })
    const agent = { inject: vi.fn() }
    host.toggle({ enabled: false })
    const denials = await repeatIdentical(host, agent, 9)
    expect(denials).toEqual([])
  })
})
