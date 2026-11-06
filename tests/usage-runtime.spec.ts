import { describe, expect, it, vi } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import { classifyToolCall } from '../src/usage/usage-classifier.ts'
import {
  createUsageCollectorState,
  ingestUsageSessionEvent,
} from '../src/usage/usage-collector.ts'
import { buildUsageReport } from '../src/usage/usage-core.ts'
import { installUsageRuntime, type UsageRuntimeScheduler } from '../src/usage/usage-runtime.ts'
import * as usageRuntimeModule from '../src/usage/usage-runtime.ts'

const TIME = Date.UTC(2026, 10, 4, 12, 0, 0)

function toolCall(seq: number, options: { callId?: string; name?: string } = {}): SessionEvent {
  return {
    type: 'tool/call',
    seq,
    time: TIME + seq,
    data: {
      turn: 1,
      step: 1,
      callId: options.callId ?? `call-${seq}`,
      name: options.name ?? 'bash',
      arguments: '{"secret":"SECRET-ARGUMENT"}',
      meta: { secret: 'SECRET-META' },
    },
  } as unknown as SessionEvent
}

function toolResult(
  seq: number,
  options: { callId?: string; isError?: boolean; code?: string } = {},
): SessionEvent {
  const data: Record<string, unknown> = {
    turn: 1,
    step: 1,
    message: {
      role: 'tool',
      toolCallId: options.callId ?? `call-${seq - 1}`,
      ...(options.isError === undefined ? {} : { isError: options.isError }),
      content: [{ type: 'text', text: 'SECRET-TOOL-OUTPUT' }],
    },
  }
  if (options.code !== undefined) {
    data.error = { code: options.code, name: 'SecretErrorName', reason: 'SECRET-REASON' }
  }
  return { type: 'tool/result', seq, time: TIME + seq, data } as unknown as SessionEvent
}

function controlEvent(seq: number): SessionEvent {
  return { type: 'turn/start', seq, time: TIME + seq, data: { turn: 1 } } as unknown as SessionEvent
}

function createManualScheduler() {
  let callbacks: Array<() => void> = []
  const scheduler: UsageRuntimeScheduler = (flush) => {
    callbacks.push(flush)
    return () => {
      callbacks = callbacks.filter(callback => callback !== flush)
    }
  }
  return {
    scheduler,
    pending: (): number => callbacks.length,
    runOne(): void {
      const callback = callbacks.shift()
      callback?.()
    },
    runAll(): void {
      const batch = callbacks
      callbacks = []
      for (const callback of batch) callback()
    },
  }
}

interface FakeHostOptions {
  readonly services?: Readonly<Record<string, unknown>>
  readonly logger?: { readonly warn?: (...args: unknown[]) => void }
  readonly getThrows?: ReadonlySet<string>
  readonly onThrows?: boolean
  readonly effectThrows?: boolean
}

function createFakeHost(options: FakeHostOptions = {}) {
  const handlers = new Map<string, (session: unknown, event: unknown) => void>()
  const subscribeNames: string[] = []
  const listenerDisposers: Array<ReturnType<typeof vi.fn>> = []
  const warn = vi.fn()
  let effectCleanup: (() => void) | undefined
  const ctx = {
    logger: options.logger ?? { warn },
    on: (name: string, listener: (session: unknown, event: unknown) => void) => {
      if (options.onThrows === true) throw new Error('subscribe failed')
      subscribeNames.push(name)
      handlers.set(name, listener)
      const dispose = vi.fn()
      listenerDisposers.push(dispose)
      return dispose
    },
    effect: (factory: () => () => void) => {
      if (options.effectThrows === true) throw new Error('effect registration failed')
      effectCleanup = factory()
    },
    get: (name: string) => {
      if (options.getThrows?.has(name) === true) throw new Error(`lookup failed: ${name}`)
      return options.services?.[name]
    },
  }
  return {
    ctx: ctx as unknown as Context,
    handlers,
    subscribeNames,
    listenerDisposers,
    warn,
    emit(sessionId: string, event: SessionEvent): void {
      handlers.get('session/event')?.({ id: sessionId }, event)
    },
    cleanupEffect(): void {
      effectCleanup?.()
    },
    hasEffect(): boolean {
      return effectCleanup !== undefined
    },
  }
}

function aggregate(report: ReturnType<ReturnType<typeof installUsageRuntime>['report']>, capabilityId: string) {
  return report.aggregates.find(row => row.capabilityId === capabilityId)
}

describe('usage runtime host adapter', () => {
  it('subscribes only to session/event and coalesces a burst into one tick', () => {
    const host = createFakeHost()
    const manual = createManualScheduler()
    const runtime = installUsageRuntime(host.ctx, { schedule: manual.scheduler })

    host.emit('session-a', toolCall(1))
    host.emit('session-a', toolResult(2))
    host.emit('session-a', controlEvent(3))

    expect(host.subscribeNames).toEqual(['session/event'])
    expect(runtime.pending()).toBe(3)
    expect(manual.pending()).toBe(1)
    expect(runtime.report().calls).toBe(0)

    manual.runOne()

    expect(runtime.pending()).toBe(0)
    expect(runtime.report()).toMatchObject({ calls: 1, succeeded: 1, failed: 0 })
    expect(runtime.stats()).toMatchObject({
      received: 3,
      delivered: 3,
      accepted: 3,
      duplicates: 0,
      invalid: 0,
      batches: 1,
    })
    expect(runtime.stats().reasons).toMatchObject({ 'counted-event': 2, 'observed-event': 1 })
  })

  it('disposes immediately when lifecycle cleanup registration fails', () => {
    const host = createFakeHost({ effectThrows: true })
    const runtime = installUsageRuntime(host.ctx)

    expect(host.listenerDisposers[0]).toHaveBeenCalledTimes(1)
    host.emit('session-a', toolCall(1))
    expect(runtime.stats().received).toBe(0)
    expect(runtime.pending()).toBe(0)
  })

  it('flushes on the default next-tick scheduler', async () => {
    const host = createFakeHost()
    const runtime = installUsageRuntime(host.ctx)

    host.emit('session-a', toolCall(1))
    host.emit('session-a', toolResult(2))
    expect(runtime.pending()).toBe(2)
    expect(runtime.report().calls).toBe(0)

    await new Promise(resolve => setTimeout(resolve, 5))

    expect(runtime.pending()).toBe(0)
    expect(runtime.report()).toMatchObject({ calls: 1, succeeded: 1 })
    runtime.dispose()
  })

  it('delivers a batch in per-session seq order even when the result arrives first', () => {
    const host = createFakeHost()
    const manual = createManualScheduler()
    const runtime = installUsageRuntime(host.ctx, { schedule: manual.scheduler })

    host.emit('session-a', toolResult(2, { callId: 'call-1' }))
    host.emit('session-a', toolCall(1, { callId: 'call-1' }))
    manual.runOne()

    expect(runtime.report()).toMatchObject({ calls: 1, succeeded: 1, unresolved: 0, orphanResults: 0 })
  })

  it('orders events across interleaved sessions without losing the call/result pairing', () => {
    const host = createFakeHost()
    const manual = createManualScheduler()
    const runtime = installUsageRuntime(host.ctx, { schedule: manual.scheduler })

    host.emit('session-b', toolCall(1, { callId: 'b-call' }))
    host.emit('session-a', toolResult(2, { callId: 'a-call' }))
    host.emit('session-a', toolCall(1, { callId: 'a-call' }))
    host.emit('session-b', toolResult(2, { callId: 'b-call' }))
    manual.runOne()

    expect(runtime.report()).toMatchObject({ calls: 2, succeeded: 2, unresolved: 0, orphanResults: 0 })
  })

  it('merges a bounded history snapshot before queued live events', async () => {
    const historical = [toolCall(0), toolResult(1)]
    let resolveRead!: (value: { eventState: string; events: SessionEvent[] }) => void
    let markReadStarted!: () => void
    const readStarted = new Promise<void>((resolve) => { markReadStarted = resolve })
    const readResult = new Promise<{ eventState: string; events: SessionEvent[] }>((resolve) => { resolveRead = resolve })
    const persistence = {
      list: async () => [{ header: { id: 'session-a' }, revision: 'r1', eventCount: historical.length }],
      open: async (sessionId: string, access: string) => ({
        id: sessionId,
        header: { id: sessionId },
        inheritedEventCount: 0,
        access,
        read: async (offset = 0, length = historical.length) => {
          markReadStarted()
          const page = await readResult
          return { ...page, events: page.events.slice(offset, offset + length) }
        },
        close: async () => {},
      }),
    }
    const host = createFakeHost({ services: { profileContext: { name: 'desktop' }, sessionPersistence: persistence } })
    const manual = createManualScheduler()
    const runtime = installUsageRuntime(host.ctx, { schedule: manual.scheduler })

    await readStarted
    host.emit('session-a', toolCall(2))
    host.emit('session-a', toolResult(3))
    expect(runtime.pending()).toBe(2)
    expect(runtime.report().calls).toBe(0)

    resolveRead({ eventState: 'owned', events: historical })
    const result = await runtime.historyBackfill()
    expect(result?.coverageStatus, JSON.stringify(result?.stats)).toBe('complete')
    expect(runtime.report().calls).toBe(1)
    expect(runtime.pending()).toBe(2)
    manual.runAll()

    expect(runtime.report()).toMatchObject({ calls: 2, succeeded: 2, failed: 0, orphanResults: 0 })
    expect(runtime.state().sessions.get('session-a')?.observedSeq).toBe(3)
  })

  it('cancels history when live queue pressure arrives and discards the stale snapshot', async () => {
    const historical = [toolCall(0), toolResult(1)]
    let resolveRead!: (value: { eventState: string; events: SessionEvent[] }) => void
    let markReadStarted!: () => void
    const readStarted = new Promise<void>((resolve) => { markReadStarted = resolve })
    const readResult = new Promise<{ eventState: string; events: SessionEvent[] }>((resolve) => { resolveRead = resolve })
    const persistence = {
      list: async () => [{ header: { id: 'session-a' }, revision: 'r1', eventCount: historical.length }],
      open: async (sessionId: string, access: string) => ({
        id: sessionId,
        header: { id: sessionId },
        inheritedEventCount: 0,
        access,
        read: async (offset = 0, length = historical.length) => {
          markReadStarted()
          const page = await readResult
          return { ...page, events: page.events.slice(offset, offset + length) }
        },
        close: async () => {},
      }),
    }
    const host = createFakeHost({ services: { profileContext: { name: 'desktop' }, sessionPersistence: persistence } })
    const manual = createManualScheduler()
    const runtime = installUsageRuntime(host.ctx, { schedule: manual.scheduler, maxQueue: 1 })
    await readStarted
    const pendingBackfill = runtime.historyBackfill()
    expect(runtime.historyBackfill()).toBe(pendingBackfill)

    host.emit('session-a', toolCall(5))
    host.emit('session-a', toolResult(6))
    expect(runtime.stats().backfillReasons['backfill-cancelled-live-pressure']).toBe(1)
    expect(runtime.stats().reasons['backfill-cancelled-live-pressure']).toBeUndefined()
    expect(runtime.historyBackfill()).toBe(pendingBackfill)
    manual.runAll()
    expect(runtime.report()).toMatchObject({ calls: 1, succeeded: 1, orphanResults: 0 })

    resolveRead({ eventState: 'owned', events: historical })
    expect(await pendingBackfill).toBeUndefined()
    expect(runtime.report()).toMatchObject({ calls: 1, succeeded: 1, orphanResults: 0 })
    expect(runtime.state().sessions.get('session-a')?.observedSeq).toBe(6)
  })

  it('discards an in-flight history result on dispose', async () => {
    let resolveRead!: (value: { eventState: string; events: SessionEvent[] }) => void
    let markReadStarted!: () => void
    const readStarted = new Promise<void>((resolve) => { markReadStarted = resolve })
    const readResult = new Promise<{ eventState: string; events: SessionEvent[] }>((resolve) => { resolveRead = resolve })
    const persistence = {
      list: async () => [{ header: { id: 'session-a' }, revision: 'r1', eventCount: 1 }],
      open: async (sessionId: string, access: string) => ({
        id: sessionId,
        header: { id: sessionId },
        inheritedEventCount: 0,
        access,
        read: async () => { markReadStarted(); return readResult },
        close: async () => {},
      }),
    }
    const host = createFakeHost({ services: { profileContext: { name: 'desktop' }, sessionPersistence: persistence } })
    const runtime = installUsageRuntime(host.ctx)
    await readStarted
    const pendingBackfill = runtime.historyBackfill()

    runtime.dispose()
    resolveRead({ eventState: 'owned', events: [toolCall(0)] })

    expect(await pendingBackfill).toBeUndefined()
    expect(runtime.report().calls).toBe(0)
    expect(host.listenerDisposers[0]).toHaveBeenCalledTimes(1)
  })

  it('keeps the collector duplicate gate when the same seq is replayed', () => {
    const host = createFakeHost()
    const manual = createManualScheduler()
    const runtime = installUsageRuntime(host.ctx, { schedule: manual.scheduler })

    host.emit('session-a', toolCall(1))
    manual.runOne()
    host.emit('session-a', toolCall(1))
    manual.runOne()

    expect(runtime.report().calls).toBe(1)
    expect(runtime.stats()).toMatchObject({ delivered: 2, duplicates: 1 })
  })

  it('matches the sequential collector transition for the same event page', () => {
    const page: Array<{ sessionId: string; event: SessionEvent }> = [
      { sessionId: 'session-a', event: controlEvent(1) },
      { sessionId: 'session-a', event: toolCall(2, { callId: 'a-call' }) },
      { sessionId: 'session-b', event: toolCall(1, { callId: 'b-call' }) },
      { sessionId: 'session-a', event: toolResult(3, { callId: 'a-call', isError: true, code: 'E_X' }) },
      { sessionId: 'session-b', event: toolResult(2, { callId: 'b-call' }) },
      { sessionId: 'session-a', event: controlEvent(5) },
    ]
    const classify = (toolName: string) => classifyToolCall({ toolId: toolName }, {})

    const host = createFakeHost()
    const manual = createManualScheduler()
    const runtime = installUsageRuntime(host.ctx, { schedule: manual.scheduler })
    for (const entry of page) host.emit(entry.sessionId, entry.event)
    manual.runOne()

    let sequential = createUsageCollectorState()
    for (const entry of page) {
      sequential = ingestUsageSessionEvent(sequential, {
        sessionId: entry.sessionId,
        event: entry.event,
        workspace: { attribution: 'unknown' },
        classify,
        origin: 'live',
      }).state
    }

    expect(runtime.report()).toEqual(buildUsageReport(sequential.usage))
    expect(runtime.state().sessions).toEqual(sequential.sessions)
  })

  it('resolves workspace attribution from the optional registry through ctx.get', () => {
    const list = vi.fn(() => [{ id: 'ws-1', sessionIds: ['session-a'] }])
    const host = createFakeHost({ services: { workspaceRegistry: { list } } })
    const manual = createManualScheduler()
    const runtime = installUsageRuntime(host.ctx, { schedule: manual.scheduler })

    expect(runtime.metadata.workspaceRegistry).toBe(true)
    host.emit('session-a', toolCall(1))
    host.emit('session-a', toolResult(2))
    manual.runOne()

    expect(list).toHaveBeenCalledTimes(1)
    expect(aggregate(runtime.report(), 'bash')).toMatchObject({
      workspaceId: 'ws-1',
      workspaceAttribution: 'current-mapping',
    })
    expect(runtime.report().coverage['session-a']?.reasons).toContain('workspace-current-mapping')
  })

  it('runs memory-only with profile unknown when optional services are missing', () => {
    const host = createFakeHost()
    const manual = createManualScheduler()
    const runtime = installUsageRuntime(host.ctx, { schedule: manual.scheduler })

    expect(runtime.metadata.mode).toBe('memory')
    expect(runtime.metadata.profile).toEqual({
      status: 'unknown',
      label: 'profile unknown',
      reason: 'profile-context-missing',
    })
    expect(runtime.metadata.workspaceRegistry).toBe(false)
    expect(runtime.metadata.capability).toBe(false)
    expect(runtime.metadata.feed).toBe('session/event')
    expect(Object.isFrozen(runtime.metadata)).toBe(true)

    host.emit('session-a', toolCall(1))
    host.emit('session-a', toolResult(2))
    manual.runOne()

    expect(aggregate(runtime.report(), 'bash')).toMatchObject({ workspaceAttribution: 'unknown' })
    const coverage = runtime.report().coverage['session-a']
    expect(coverage?.reasons).toContain('workspace-attribution-unknown')
    expect(coverage?.reasons).toContain('unknown-tool-owner')
  })

  it('records a resolved profile name without leaving memory mode', () => {
    const host = createFakeHost({ services: { profileContext: { name: 'desktop' } } })
    const runtime = installUsageRuntime(host.ctx, { schedule: createManualScheduler().scheduler })

    expect(runtime.metadata.mode).toBe('memory')
    expect(runtime.metadata.profile).toEqual({ status: 'known', name: 'desktop' })
  })

  it('degrades to profile unknown when the profile service throws', () => {
    const host = createFakeHost({ getThrows: new Set(['profileContext']) })
    const runtime = installUsageRuntime(host.ctx, { schedule: createManualScheduler().scheduler })

    expect(runtime.metadata.profile).toMatchObject({
      status: 'unknown',
      label: 'profile unknown',
      reason: 'context-unavailable',
    })
  })

  it('uses capability records as trusted MCP evidence and never guesses from the tool name', () => {
    const records = new Map<string, unknown>([
      ['mcp__files__read', { origin: { serverName: 'files', provider: 'files' } }],
      ['bash', { origin: { serverName: 'built-in', provider: 'built-in' } }],
    ])
    const get = vi.fn((id: string, _kind?: string) => records.get(id))
    const host = createFakeHost({ services: { capability: { get } } })
    const manual = createManualScheduler()
    const runtime = installUsageRuntime(host.ctx, { schedule: manual.scheduler })

    expect(runtime.metadata.capability).toBe(true)
    host.emit('session-a', toolCall(1, { name: 'mcp__files__read' }))
    host.emit('session-a', toolResult(2, { callId: 'call-1' }))
    host.emit('session-a', toolCall(3, { name: 'bash' }))
    host.emit('session-a', toolResult(4, { callId: 'call-3' }))
    // A name that looks like MCP but has no trusted record must stay unknown.
    host.emit('session-a', toolCall(5, { name: 'mcp__guessed__tool' }))
    host.emit('session-a', toolResult(6, { callId: 'call-5' }))
    manual.runOne()

    expect(get).toHaveBeenCalledWith('mcp__files__read', 'tool')
    expect(aggregate(runtime.report(), 'mcp__files__read')).toMatchObject({
      capabilityKind: 'mcp',
      providerId: 'files',
    })
    // A record under the reserved `built-in` pseudo-server IS trusted evidence
    // that the tool is harness-native. Leaving it unknown made the whole page
    // report an unknown source even though the catalog knew the answer.
    expect(aggregate(runtime.report(), 'bash')).toMatchObject({ capabilityKind: 'native' })
    expect(aggregate(runtime.report(), 'mcp__guessed__tool')).toMatchObject({ capabilityKind: 'unknown' })
  })

  it('attributes several native tools to native without any prefix guessing', () => {
    // Regression guard for the classification gap: every harness-native tool is
    // cataloged under the reserved `built-in` pseudo-server, and that record is
    // the only evidence needed. A name-based guess is deliberately not used.
    const records = new Map<string, unknown>([
      ['bash', { origin: { serverName: 'built-in', provider: 'built-in' } }],
      ['read', { origin: { serverName: 'built-in', provider: 'built-in' } }],
      ['mcp__github__create_issue', { origin: { serverName: 'github', provider: 'github' } }],
    ])
    const host = createFakeHost({
      services: { capability: { get: (id: string) => records.get(id) } },
    })
    const manual = createManualScheduler()
    const runtime = installUsageRuntime(host.ctx, { schedule: manual.scheduler })

    host.emit('session-a', toolCall(1, { name: 'bash' }))
    host.emit('session-a', toolResult(2, { callId: 'call-1' }))
    host.emit('session-a', toolCall(3, { name: 'read' }))
    host.emit('session-a', toolResult(4, { callId: 'call-3' }))
    host.emit('session-a', toolCall(5, { name: 'mcp__github__create_issue' }))
    host.emit('session-a', toolResult(6, { callId: 'call-5' }))
    manual.runOne()

    const report = runtime.report()
    expect(aggregate(report, 'bash')).toMatchObject({ capabilityKind: 'native' })
    expect(aggregate(report, 'read')).toMatchObject({ capabilityKind: 'native' })
    expect(aggregate(report, 'mcp__github__create_issue')).toMatchObject({
      capabilityKind: 'mcp',
      providerId: 'github',
    })
  })

  it('accepts explicit trusted evidence from options without consulting the name', () => {
    const host = createFakeHost()
    const manual = createManualScheduler()
    const runtime = installUsageRuntime(host.ctx, {
      schedule: manual.scheduler,
      nativeToolIds: ['bash'],
      pluginToolOwners: new Map([['custom_tool', 'owner-x']]),
    })

    host.emit('session-a', toolCall(1, { name: 'bash' }))
    host.emit('session-a', toolResult(2, { callId: 'call-1' }))
    host.emit('session-a', toolCall(3, { name: 'custom_tool' }))
    host.emit('session-a', toolResult(4, { callId: 'call-3' }))
    manual.runOne()

    expect(aggregate(runtime.report(), 'bash')).toMatchObject({ capabilityKind: 'native' })
    expect(aggregate(runtime.report(), 'custom_tool')).toMatchObject({
      capabilityKind: 'plugin-tool',
      providerId: 'owner-x',
    })
  })

  it('keeps raw arguments, output, meta, error name and reason out of all retained state', () => {
    const host = createFakeHost()
    const manual = createManualScheduler()
    const runtime = installUsageRuntime(host.ctx, { schedule: manual.scheduler })

    host.emit('session-a', toolCall(1))
    host.emit('session-a', toolResult(2, { isError: true, code: 'E_FAIL' }))
    manual.runOne()

    const serialized = JSON.stringify({
      report: runtime.report(),
      stats: runtime.stats(),
      metadata: runtime.metadata,
    })
    expect(serialized).not.toContain('SECRET-ARGUMENT')
    expect(serialized).not.toContain('SECRET-META')
    expect(serialized).not.toContain('SECRET-TOOL-OUTPUT')
    expect(serialized).not.toContain('SecretErrorName')
    expect(serialized).not.toContain('SECRET-REASON')
    expect(runtime.report().aggregates[0]?.errors).toEqual({ E_FAIL: 1 })
  })

  it('records adjacent sequence holes with the exact skipped count', () => {
    const host = createFakeHost()
    const manual = createManualScheduler()
    const runtime = installUsageRuntime(host.ctx, { schedule: manual.scheduler })

    host.emit('session-a', controlEvent(1))
    host.emit('session-a', controlEvent(4))
    host.emit('session-a', toolCall(5))
    host.emit('session-a', toolResult(6))
    manual.runOne()

    const coverage = runtime.report().coverage['session-a']
    expect(coverage?.reasons).toContain('sequence-gap')
    expect(coverage?.skippedEvents).toBe(2)
    expect(runtime.report()).toMatchObject({ calls: 1, succeeded: 1 })
  })

  it('flushes one bounded micro-batch per tick and reschedules the remainder', () => {
    const host = createFakeHost()
    const manual = createManualScheduler()
    const runtime = installUsageRuntime(host.ctx, { schedule: manual.scheduler, maxBatch: 1 })

    host.emit('session-a', toolCall(1, { callId: 'call-1' }))
    host.emit('session-a', toolCall(2, { callId: 'call-2' }))
    host.emit('session-a', toolCall(3, { callId: 'call-3' }))

    expect(manual.pending()).toBe(1)
    manual.runOne()
    expect(runtime.report().calls).toBe(1)
    expect(runtime.pending()).toBe(2)
    expect(manual.pending()).toBe(1)
    expect(runtime.stats().batches).toBe(1)

    manual.runOne()
    expect(runtime.report().calls).toBe(2)
    manual.runOne()
    expect(runtime.report().calls).toBe(3)
    expect(runtime.pending()).toBe(0)
    expect(runtime.stats().batches).toBe(3)
  })

  it('bounds the queue by draining early instead of dropping the burst', () => {
    const host = createFakeHost()
    const manual = createManualScheduler()
    const runtime = installUsageRuntime(host.ctx, { schedule: manual.scheduler, maxQueue: 2 })

    host.emit('session-a', toolCall(1, { callId: 'call-1' }))
    host.emit('session-a', toolCall(2, { callId: 'call-2' }))
    expect(runtime.pending()).toBe(2)
    expect(manual.pending()).toBe(1)

    host.emit('session-a', toolCall(3, { callId: 'call-3' }))
    expect(runtime.report().calls).toBe(2)
    expect(runtime.pending()).toBe(1)

    manual.runOne()
    expect(runtime.report().calls).toBe(3)
  })

  it('disposes the listener and flushes queued events without a tick', () => {
    const host = createFakeHost()
    const manual = createManualScheduler()
    const runtime = installUsageRuntime(host.ctx, { schedule: manual.scheduler })

    host.emit('session-a', toolCall(1))
    host.emit('session-a', toolResult(2))
    expect(runtime.pending()).toBe(2)

    runtime.dispose()

    expect(host.listenerDisposers[0]).toHaveBeenCalledTimes(1)
    expect(manual.pending()).toBe(0)
    expect(runtime.pending()).toBe(0)
    expect(runtime.report()).toMatchObject({ calls: 1, succeeded: 1 })

    const receivedAfterDispose = runtime.stats().received
    host.emit('session-a', toolCall(3))
    expect(runtime.stats().received).toBe(receivedAfterDispose)
    expect(runtime.report().calls).toBe(1)

    runtime.dispose()
    expect(host.listenerDisposers[0]).toHaveBeenCalledTimes(1)
  })

  it('disposes and flushes through the fiber effect cleanup when available', () => {
    const host = createFakeHost()
    const manual = createManualScheduler()
    const runtime = installUsageRuntime(host.ctx, { schedule: manual.scheduler })

    expect(host.hasEffect()).toBe(true)
    host.emit('session-a', toolCall(1))
    host.emit('session-a', toolResult(2))
    host.cleanupEffect()

    expect(host.listenerDisposers[0]).toHaveBeenCalledTimes(1)
    expect(runtime.pending()).toBe(0)
    expect(runtime.report()).toMatchObject({ calls: 1, succeeded: 1 })
  })

  it('contains optional-service failures and reports them only through logger.warn', () => {
    const list = vi.fn(() => {
      throw new Error('workspace registry unavailable')
    })
    const capability = {
      get: vi.fn(() => {
        throw new Error('capability registry unavailable')
      }),
    }
    const host = createFakeHost({ services: { workspaceRegistry: { list }, capability } })
    const manual = createManualScheduler()
    const runtime = installUsageRuntime(host.ctx, { schedule: manual.scheduler })

    host.emit('session-a', toolCall(1))
    host.emit('session-a', toolResult(2))
    manual.runOne()

    expect(runtime.report()).toMatchObject({ calls: 1, succeeded: 1 })
    expect(aggregate(runtime.report(), 'bash')).toMatchObject({ workspaceAttribution: 'unknown' })
    const messages = host.warn.mock.calls.map(call => String(call[0]))
    expect(messages).toContain('agent-efficiency-guard usage-runtime: workspace-list (workspace registry unavailable)')
    expect(messages).toContain('agent-efficiency-guard usage-runtime: capability-lookup (capability registry unavailable)')
  })

  it('returns a frozen metadata-only snapshot without event payloads', () => {
    const host = createFakeHost()
    const manual = createManualScheduler()
    const runtime = installUsageRuntime(host.ctx, { schedule: manual.scheduler })

    host.emit('session-a', toolCall(1))
    host.emit('session-a', toolResult(2, { isError: true, code: 'PRIVATE DETAIL WITH SPACES' }))
    manual.runOne()

    const snapshot = runtime.snapshot()
    const serialized = JSON.stringify(snapshot)
    expect(snapshot).toMatchObject({
      metadata: { mode: 'memory', feed: 'session/event' },
      stats: { received: 2, delivered: 2, accepted: 2 },
      report: { calls: 1, failed: 1 },
    })
    expect(Object.isFrozen(snapshot)).toBe(true)
    expect(Object.isFrozen(snapshot.stats)).toBe(true)
    expect(serialized).not.toContain('SECRET-ARGUMENT')
    expect(serialized).not.toContain('SECRET-META')
    expect(serialized).not.toContain('SECRET-TOOL-OUTPUT')
    expect(serialized).not.toContain('SECRET-REASON')
    expect(serialized).not.toContain('PRIVATE DETAIL WITH SPACES')
  })

  it('does not let a throwing logger or a throwing scheduler escape', () => {
    const host = createFakeHost({ logger: { warn: () => { throw new Error('logger broken') } } })
    const schedule: UsageRuntimeScheduler = () => {
      throw new Error('scheduler broken')
    }
    const runtime = installUsageRuntime(host.ctx, { schedule })

    expect(() => host.emit('session-a', toolCall(1))).not.toThrow()
    expect(runtime.report().calls).toBe(1)
  })

  it('drops unusable events without throwing or touching raw payloads', () => {
    const host = createFakeHost()
    const manual = createManualScheduler()
    const runtime = installUsageRuntime(host.ctx, { schedule: manual.scheduler })
    const handler = host.handlers.get('session/event')
    expect(handler).toBeDefined()

    expect(() => handler?.({ id: 'session-a' }, null)).not.toThrow()
    expect(() => handler?.({ id: 'session-a' }, { type: 'tool/call', seq: -1, data: {} })).not.toThrow()
    expect(() => handler?.({ id: '' }, toolCall(1))).not.toThrow()
    manual.runOne()

    expect(runtime.stats()).toMatchObject({ received: 3, invalid: 3 })
    expect(runtime.report().calls).toBe(0)
  })

  it('honors historyBackfill false and reports profile/service disable reasons', () => {
    const list = vi.fn(async () => [])
    const disabledHost = createFakeHost({
      services: {
        profileContext: { name: 'desktop' },
        sessionPersistence: { list, open: vi.fn() },
      },
    })
    const disabled = installUsageRuntime(disabledHost.ctx, { historyBackfill: false })
    expect(list).not.toHaveBeenCalled()
    disabled.dispose()

    const unknownProfile = installUsageRuntime(createFakeHost({
      services: { sessionPersistence: { list, open: vi.fn() } },
    }).ctx)
    expect(unknownProfile.stats().backfillReasons['backfill-disabled-profile-unknown']).toBe(1)
    expect(unknownProfile.stats().reasons['backfill-disabled-profile-unknown']).toBeUndefined()
    unknownProfile.dispose()

    const missingService = installUsageRuntime(createFakeHost({
      services: { profileContext: { name: 'desktop' } },
    }).ctx)
    expect(missingService.stats().backfillReasons['backfill-disabled-service-unavailable']).toBe(1)
    missingService.dispose()
  })

  it('keeps repeated backfill failure reasons out of live collector diagnostics', async () => {
    const persistence = {
      list: async () => [{ header: { id: 'session-a' }, revision: 'r1', eventCount: 1 }],
      open: async () => { throw new Error('read-only open unavailable') },
    }
    const host = createFakeHost({
      services: { profileContext: { name: 'desktop' }, sessionPersistence: persistence },
    })
    const runtime = installUsageRuntime(host.ctx)

    await runtime.historyBackfill()
    await runtime.historyBackfill()

    expect(runtime.stats().backfillReasons['backfill-open-failed']).toBe(2)
    expect(runtime.stats().reasons['backfill-open-failed']).toBeUndefined()
  })

  it('declares no static inject and delegates history reads to the bounded backfill module', async () => {
    expect((usageRuntimeModule as { inject?: unknown }).inject).toBeUndefined()

    const host = createFakeHost()
    const scheduler = createManualScheduler()
    const runtime = installUsageRuntime(host.ctx, { schedule: scheduler.scheduler })
    expect(host.subscribeNames).toEqual(['session/event'])
    expect(host.subscribeNames).not.toContain('session/flush')

    const { readFile } = await import('node:fs/promises')
    const source = await readFile(new URL('../src/usage/usage-runtime.ts', import.meta.url), 'utf8')
    expect(source).toContain('sessionPersistence')
    expect(source).toContain('runUsageBackfill')
    expect(source).not.toContain('ctx.sessions')
    expect(source).not.toContain("from 'node:fs")
    runtime.dispose()
  })
})
