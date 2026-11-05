import { describe, expect, it } from 'vitest'
import { TOOL_OUTCOME_UNKNOWN, type SessionEvent } from '@deepseek-ai/dsh-session'
import { TOOL_ABORTED } from '@deepseek-ai/dsh-tools'
import { buildUsageReport, type UsageWorkspaceRef } from '../src/usage/usage-core.ts'
import {
  createUsageCollectorState,
  ingestUsageSessionEvent,
  ingestUsageSessionEvents,
  type UsageCollectorState,
  type UsageIngestBatchResult,
  type UsageIngestEventInput,
  type UsageIngestInput,
  type UsageIngestOrigin,
} from '../src/usage/usage-collector.ts'
import type { UsageSourceClassifier } from '../src/usage/usage-event-projector.ts'

const TIME = Date.UTC(2026, 10, 4, 10, 0, 0)
const workspace: UsageWorkspaceRef = { workspaceId: 'ws-1', attribution: 'event-time' }

const classify: UsageSourceClassifier = name => (
  name.startsWith('mcp__')
    ? { kind: 'mcp', providerId: name.split('__')[1] ?? 'server' }
    : { kind: 'unknown', reason: 'unmapped-tool' }
)

function toolCall(
  seq: number,
  options: { callId?: string; name?: string; time?: number } = {},
): SessionEvent {
  return {
    type: 'tool/call',
    seq,
    time: options.time ?? TIME + seq * 1_000,
    data: {
      turn: 1,
      step: 1,
      callId: options.callId ?? `call-${seq}`,
      name: options.name ?? 'mcp__files__read',
      arguments: '{"token":"PRIVATE ARGUMENT"}',
      meta: { secret: 'PRIVATE META' },
    },
  } as unknown as SessionEvent
}

function toolResult(
  seq: number,
  options: { callId?: string; isError?: boolean; code?: string; time?: number } = {},
): SessionEvent {
  const data: Record<string, unknown> = {
    turn: 1,
    step: 1,
    message: {
      role: 'tool',
      toolCallId: options.callId ?? `call-${seq - 1}`,
      ...(options.isError === undefined ? {} : { isError: options.isError }),
      content: [{ type: 'text', text: 'PRIVATE TOOL OUTPUT' }],
    },
  }
  if (options.code !== undefined) {
    data.error = { code: options.code, name: 'PrivateError', reason: 'PRIVATE REASON' }
  }
  return {
    type: 'tool/result',
    seq,
    time: options.time ?? TIME + seq * 1_000,
    data,
  } as unknown as SessionEvent
}

function controlEvent(type: string, seq: number): SessionEvent {
  return { type, seq, time: TIME + seq * 1_000 } as unknown as SessionEvent
}

function malformedCall(seq: number): SessionEvent {
  return {
    type: 'tool/call',
    seq,
    time: TIME + seq * 1_000,
    data: { callId: 'broken-without-name' },
  } as unknown as SessionEvent
}

function live(state: UsageCollectorState, event: SessionEvent, sessionId = 'session-a') {
  return ingestUsageSessionEvent(state, { sessionId, event, workspace, classify, origin: 'live' })
}

function backfill(state: UsageCollectorState, event: SessionEvent, sessionId = 'session-a') {
  return ingestUsageSessionEvent(state, { sessionId, event, workspace, classify, origin: 'backfill' })
}

function complete(
  state: UsageCollectorState,
  sessionId: string,
  fromSeq: number,
  throughSeq: number,
  verified: unknown = true,
) {
  return ingestUsageSessionEvent(state, {
    kind: 'backfill-complete',
    sessionId,
    fromSeq,
    throughSeq,
    verified,
  } as unknown as UsageIngestInput)
}

function report(state: UsageCollectorState) {
  return buildUsageReport(state.usage)
}

function inputOf(
  event: SessionEvent,
  options: {
    sessionId?: string
    origin?: UsageIngestOrigin
    workspace?: UsageWorkspaceRef
    classify?: UsageSourceClassifier
  } = {},
): UsageIngestEventInput {
  return {
    sessionId: options.sessionId ?? 'session-a',
    event,
    workspace: options.workspace ?? workspace,
    classify: options.classify ?? classify,
    origin: options.origin ?? 'live',
  }
}

function ingestSequentially(state: UsageCollectorState, inputs: readonly UsageIngestEventInput[]) {
  const results: Array<{ accepted: boolean; reason: string }> = []
  for (const input of inputs) {
    const result = ingestUsageSessionEvent(state, input)
    results.push({ accepted: result.accepted, reason: result.reason })
    state = result.state
  }
  return { state, results }
}

/** Everything a caller can observe about the fold, including coverage order. */
function collectorSnapshot(state: UsageCollectorState) {
  return {
    report: buildUsageReport(state.usage),
    sessions: [...state.sessions.entries()].sort(([a], [b]) => a.localeCompare(b)),
    totalEvents: state.usage.totalEvents,
    totalCalls: state.usage.totalCalls,
    seenEvents: state.usage.seenEvents.size,
    stoppedByLimit: state.usage.stoppedByLimit,
    orphanResults: state.usage.orphanResults,
    duplicateResults: state.usage.duplicateResults,
  }
}

function expectBatchEqualsSequential(
  inputs: readonly UsageIngestEventInput[],
  initial: UsageCollectorState = createUsageCollectorState(),
) {
  const sequential = ingestSequentially(initial, inputs)
  const batched = ingestUsageSessionEvents(initial, inputs)

  expect(batched.rejectedReason).toBeUndefined()
  expect(batched.results).toEqual(sequential.results)
  expect(batched.accepted).toBe(sequential.results.filter(result => result.accepted).length)
  expect(batched.rejected).toBe(inputs.length - batched.accepted)
  expect(collectorSnapshot(batched.state)).toEqual(collectorSnapshot(sequential.state))
  return batched
}

/** Mixed stream: two Sessions, gaps, malformed records, duplicates, and faults. */
function richPage(): UsageIngestEventInput[] {
  const throwing: UsageSourceClassifier = () => {
    throw new Error('classifier offline')
  }
  return [
    inputOf(toolCall(1)),
    inputOf(toolCall(1, { callId: 'b-call' }), {
      sessionId: 'session-b',
      workspace: { workspaceId: 'workspace-b', attribution: 'current-mapping' },
    }),
    inputOf(toolResult(2)),
    inputOf(toolResult(2, { callId: 'b-call', isError: true, code: TOOL_ABORTED }), { sessionId: 'session-b' }),
    inputOf(controlEvent('user/message', 3), { origin: 'backfill' }),
    inputOf(controlEvent('turn/start', 3), { sessionId: 'session-b', origin: 'backfill' }),
    inputOf(toolCall(5, { name: 'mystery' }), {
      origin: 'backfill',
      workspace: { attribution: 'unknown' },
    }),
    inputOf(toolCall(4, { callId: 'b-call-4', name: 'boom' }), {
      sessionId: 'session-b',
      origin: 'backfill',
      classify: throwing,
    }),
    inputOf(toolResult(6, { callId: 'call-5', isError: true }), { origin: 'backfill' }),
    inputOf(toolResult(5, { callId: 'b-call-4' }), { sessionId: 'session-b', origin: 'backfill' }),
    inputOf(toolResult(8, { callId: 'never-called' })),
    inputOf(controlEvent('assistant/message', 6), { sessionId: 'session-b' }),
    inputOf(malformedCall(9)),
    inputOf(toolCall(11, { callId: 'dup' })),
    inputOf(toolCall(12, { callId: 'dup' })),
    inputOf(toolResult(13, { callId: 'dup' })),
    inputOf(toolResult(14, { callId: 'dup', isError: true })),
    inputOf(toolCall(16, { time: Number.NaN })),
    inputOf(toolCall(17)),
    inputOf(controlEvent('turn/end', 18)),
    inputOf(toolCall(19, { callId: 'dup-seq' })),
    inputOf(toolCall(19, { callId: 'dup-seq' })),
  ]
}

describe('usage collector', () => {
  it('counts one successful call from a live call/result pair', () => {
    let state = createUsageCollectorState()
    const called = live(state, toolCall(1))
    expect(called).toMatchObject({ accepted: true, reason: 'counted-event' })
    state = called.state
    const resulted = live(state, toolResult(2))
    expect(resulted).toMatchObject({ accepted: true, reason: 'counted-event' })
    state = resulted.state

    expect(report(state)).toMatchObject({
      calls: 1,
      succeeded: 1,
      failed: 0,
      denied: 0,
      cancelled: 0,
      unresolved: 0,
      orphanResults: 0,
      duplicateResults: 0,
    })
    const coverage = report(state).coverage['session-a']
    expect(coverage).toMatchObject({ status: 'partial', fromSeq: 1, throughSeq: 2, skippedEvents: 0 })
    expect(coverage?.reasons).toContain('live-only')
    expect(state.sessions.get('session-a')).toEqual({
      firstObservedSeq: 1,
      observedSeq: 2,
      historyComplete: false,
    })
  })

  it('counts failed and cancelled results without adding calls', () => {
    let state = createUsageCollectorState()
    state = live(state, toolCall(1)).state
    state = live(state, toolResult(2, { isError: true, code: 'TOOL_TIMEOUT' })).state
    state = live(state, toolCall(3)).state
    state = live(state, toolResult(4, { isError: true, code: TOOL_ABORTED })).state

    const result = report(state)
    expect(result).toMatchObject({ calls: 2, succeeded: 0, failed: 1, cancelled: 1, unresolved: 0 })
    expect(result.aggregates[0]).toMatchObject({
      calls: 2,
      failed: 1,
      cancelled: 1,
      errors: { TOOL_TIMEOUT: 1 },
    })
    expect(result.coverage['session-a']?.reasons).toContain('denied-not-observable')
    expect(result.coverage['session-a']?.skippedEvents).toBe(0)
  })

  it('maps an unobservable denial to error plus a coverage gap', () => {
    let state = createUsageCollectorState()
    state = live(state, toolCall(1)).state
    state = live(state, toolResult(2, { isError: true })).state

    const result = report(state)
    expect(result).toMatchObject({ calls: 1, failed: 1, denied: 0, unresolved: 0 })
    expect(result.aggregates[0]?.errors).toEqual({})
    expect(result.coverage['session-a']?.reasons).toContain('denied-not-observable')
    expect(result.coverage['session-a']?.skippedEvents).toBe(0)
  })

  it('keeps an interrupted call unresolved and deduplicates the gap', () => {
    let state = createUsageCollectorState()
    state = live(state, toolCall(1)).state
    const unknown = live(state, toolResult(2, { isError: true, code: TOOL_OUTCOME_UNKNOWN }))
    expect(unknown).toMatchObject({ accepted: true, reason: 'coverage-gap' })
    state = unknown.state

    expect(report(state)).toMatchObject({ calls: 1, succeeded: 0, failed: 0, unresolved: 1 })
    expect(report(state).coverage['session-a']).toMatchObject({ status: 'partial', skippedEvents: 1 })
    expect(report(state).coverage['session-a']?.reasons).toContain('outcome-unknown')
    expect(state.sessions.get('session-a')?.observedSeq).toBe(2)

    const duplicate = live(state, toolResult(2, { isError: true, code: TOOL_OUTCOME_UNKNOWN }))
    expect(duplicate).toMatchObject({ accepted: false, reason: 'duplicate-event' })
    expect(duplicate.state).toBe(state)
    expect(report(state).coverage['session-a']?.skippedEvents).toBe(1)
  })

  it('advances the watermark for non-tool events without counting a call', () => {
    let state = createUsageCollectorState()
    const observed = live(state, controlEvent('user/message', 1))
    expect(observed).toMatchObject({ accepted: true, reason: 'observed-event' })
    state = observed.state
    state = live(state, controlEvent('assistant/message', 2)).state

    let result = report(state)
    expect(result.calls).toBe(0)
    expect(result.coverage['session-a']?.status).toBe('partial')
    expect(result.coverage['session-a']?.reasons).toEqual(['live-only'])
    expect(state.sessions.get('session-a')).toMatchObject({ observedSeq: 2, historyComplete: false })

    state = live(state, toolCall(3)).state
    result = report(state)
    expect(result.calls).toBe(1)
    expect(result.coverage['session-a']?.skippedEvents).toBe(0)
    expect(result.coverage['session-a']?.reasons).not.toContain('sequence-gap')
  })

  it('folds historical backfill below the live watermark without double-counting overlap', () => {
    const initial = live(createUsageCollectorState(), toolCall(5)).state
    const history = Array.from({ length: 6 }, (_, seq) => inputOf(toolCall(seq), { origin: 'backfill' }))

    const sequential = ingestSequentially(initial, history)
    const batched = ingestUsageSessionEvents(initial, history)

    expect(batched.rejectedReason).toBeUndefined()
    expect(batched.results).toEqual(sequential.results)
    expect(report(sequential.state).calls).toBe(6)
    expect(report(batched.state).calls).toBe(6)
    expect(batched.state.sessions.get('session-a')).toMatchObject({ observedSeq: 5 })
  })

  it('treats duplicate projections as a no-op', () => {
    let state = live(createUsageCollectorState(), toolCall(1)).state
    state = live(state, toolResult(2)).state
    const snapshot = report(state)

    const duplicateCall = live(state, toolCall(1))
    expect(duplicateCall).toMatchObject({ accepted: false, reason: 'duplicate-event' })
    expect(duplicateCall.state).toBe(state)

    const duplicateResult = live(state, toolResult(2))
    expect(duplicateResult).toMatchObject({ accepted: false, reason: 'duplicate-event' })
    expect(duplicateResult.state).toBe(state)
    expect(report(state)).toEqual(snapshot)
  })

  it('does not double-count a repeated gap-only event', () => {
    let state = live(createUsageCollectorState(), malformedCall(2)).state
    expect(report(state).coverage['session-a']).toMatchObject({ status: 'partial', skippedEvents: 1 })
    expect(report(state).coverage['session-a']?.reasons).toEqual([
      'malformed-tool-call',
      'live-only',
    ])

    const repeated = live(state, malformedCall(2))
    expect(repeated).toMatchObject({ accepted: false, reason: 'duplicate-event' })
    expect(repeated.state).toBe(state)
    expect(report(state).coverage['session-a']?.skippedEvents).toBe(1)
  })

  it('records an adjacent sequence hole with the exact skipped count', () => {
    let state = live(createUsageCollectorState(), toolCall(1)).state
    state = live(state, toolCall(4)).state

    const result = report(state)
    expect(result.calls).toBe(2)
    expect(result.coverage['session-a']).toMatchObject({
      status: 'partial',
      fromSeq: 1,
      throughSeq: 4,
      skippedEvents: 2,
    })
    expect(result.coverage['session-a']?.reasons).toContain('sequence-gap')
  })

  it('never claims complete history from live observation alone', () => {
    let state = createUsageCollectorState()
    for (const event of [toolCall(1), toolResult(2), controlEvent('turn/start', 3), toolCall(4)]) {
      state = live(state, event).state
    }

    const coverage = report(state).coverage['session-a']
    expect(coverage?.status).toBe('partial')
    expect(coverage?.reasons).toContain('live-only')
    expect(state.sessions.get('session-a')?.historyComplete).toBe(false)
  })

  it('restores coverage only through explicit verified backfill completion', () => {
    let state = live(createUsageCollectorState(), toolCall(1)).state
    state = live(state, toolCall(3)).state
    expect(report(state).coverage['session-a']).toMatchObject({
      status: 'partial',
      skippedEvents: 1,
    })
    expect(report(state).coverage['session-a']?.reasons).toEqual(
      expect.arrayContaining(['live-only', 'sequence-gap']),
    )

    const completed = complete(state, 'session-a', 0, 3)
    expect(completed).toMatchObject({ accepted: true, reason: 'backfill-completed' })
    state = completed.state

    const coverage = report(state).coverage['session-a']
    expect(coverage).toMatchObject({
      status: 'complete',
      fromSeq: 0,
      throughSeq: 3,
      skippedEvents: 1,
    })
    expect(coverage?.reasons).not.toContain('live-only')
    expect(coverage?.reasons).not.toContain('sequence-gap')
    expect(state.sessions.get('session-a')).toMatchObject({
      firstObservedSeq: 1,
      observedSeq: 3,
      historyComplete: true,
    })

    const repeated = complete(state, 'session-a', 0, 3)
    expect(repeated.accepted).toBe(true)
    expect(repeated.state).toBe(state)

    const wider = complete(state, 'session-a', 0, 5)
    expect(report(wider.state).coverage['session-a']?.throughSeq).toBe(5)
  })

  it('accepts an explicit completion for a Session with no observed events', () => {
    const completed = complete(createUsageCollectorState(), 'session-z', 0, 10)
    expect(completed.accepted).toBe(true)
    expect(report(completed.state).coverage['session-z']).toMatchObject({
      status: 'complete',
      fromSeq: 0,
      throughSeq: 10,
      skippedEvents: 0,
    })
    expect(completed.state.sessions.get('session-z')).toEqual({ historyComplete: true })
  })

  it('fails closed on unverified or inconsistent backfill completion', () => {
    const state = live(createUsageCollectorState(), toolCall(1)).state
    const cases: unknown[] = [
      { kind: 'backfill-complete', sessionId: 'session-a', fromSeq: 0, throughSeq: 1, verified: false },
      { kind: 'backfill-complete', sessionId: 'session-a', fromSeq: 0, throughSeq: 1 },
      { kind: 'backfill-complete', sessionId: 'session-a', fromSeq: 0, throughSeq: 0, verified: true },
      { kind: 'backfill-complete', sessionId: 'session-a', fromSeq: 2, throughSeq: 2, verified: true },
      { kind: 'backfill-complete', sessionId: 'session-a', fromSeq: 3, throughSeq: 2, verified: true },
      { kind: 'backfill-complete', sessionId: 'session-a', fromSeq: -1, throughSeq: 1, verified: true },
      { kind: 'backfill-complete', sessionId: '   ', fromSeq: 0, throughSeq: 1, verified: true },
      { kind: 'backfill-complete', sessionId: 'session-a', fromSeq: '0', throughSeq: 1, verified: true },
    ]

    for (const raw of cases) {
      const result = ingestUsageSessionEvent(state, raw as UsageIngestInput)
      expect(result).toMatchObject({ accepted: false, reason: 'invalid-backfill-completion' })
      expect(result.state).toBe(state)
    }
    expect(report(state).coverage['session-a']?.status).toBe('partial')
  })

  it('keeps backfill-origin coverage partial until completion', () => {
    let state = backfill(createUsageCollectorState(), toolCall(1)).state
    let coverage = report(state).coverage['session-a']
    expect(coverage?.status).toBe('partial')
    expect(coverage?.reasons).toContain('backfill-incomplete')
    expect(coverage?.reasons).not.toContain('live-only')

    state = complete(state, 'session-a', 0, 1).state
    coverage = report(state).coverage['session-a']
    expect(coverage?.status).toBe('complete')
    expect(coverage?.reasons).not.toContain('backfill-incomplete')
  })

  it('fails closed on missing or malformed input without mutating state', () => {
    const state = createUsageCollectorState()
    const valid = {
      sessionId: 'session-a',
      event: toolCall(1),
      workspace,
      classify,
      origin: 'live' as const,
    }
    const cases: unknown[] = [
      null,
      { ...valid, sessionId: '   ' },
      { ...valid, event: null },
      { ...valid, event: { type: 'tool/call', time: TIME, data: { callId: 'c', name: 'mcp__files__read' } } },
      { ...valid, event: { ...(toolCall(1) as unknown as Record<string, unknown>), seq: -1 } },
      { ...valid, origin: 'both' },
      { ...valid, classify: undefined },
      { ...valid, workspace: undefined },
      { ...valid, workspace: { attribution: 'bogus' } },
      { ...valid, workspace: { attribution: 'event-time' } },
      { ...valid, kind: 'not-a-kind' },
    ]

    for (const raw of cases) {
      const result = ingestUsageSessionEvent(state, raw as UsageIngestInput)
      expect(result).toMatchObject({ accepted: false, reason: 'invalid-input' })
      expect(result.state).toBe(state)
    }
    expect(state.sessions.size).toBe(0)
    expect(report(state)).toMatchObject({ calls: 0 })
  })

  it('fails closed on an event the core rejects and records the skip', () => {
    let state = createUsageCollectorState()
    const rejected = live(state, toolCall(1, { time: Number.NaN }))
    expect(rejected).toMatchObject({ accepted: false, reason: 'invalid-event' })
    state = rejected.state

    let result = report(state)
    expect(result.calls).toBe(0)
    expect(result.coverage['session-a']).toMatchObject({ status: 'partial', skippedEvents: 1 })
    expect(result.coverage['session-a']?.reasons).toEqual(
      expect.arrayContaining(['invalid-event', 'live-only']),
    )
    expect(state.sessions.get('session-a')?.observedSeq).toBe(1)

    state = live(state, toolCall(2)).state
    result = report(state)
    expect(result.calls).toBe(1)
    expect(result.coverage['session-a']?.skippedEvents).toBe(1)
  })

  it('isolates watermarks and call ids per Session', () => {
    let state = createUsageCollectorState()
    state = live(state, toolCall(1, { callId: 'same' }), 'session-a').state
    state = live(state, toolCall(1, { callId: 'same' }), 'session-b').state
    state = live(state, toolResult(2, { callId: 'same' }), 'session-a').state
    state = live(state, toolResult(2, { callId: 'same' }), 'session-b').state

    const result = report(state)
    expect(result).toMatchObject({ calls: 2, succeeded: 2, unresolved: 0 })
    expect(result.coverage['session-a']?.status).toBe('partial')
    expect(result.coverage['session-b']?.status).toBe('partial')
    expect(state.sessions.get('session-a')?.observedSeq).toBe(2)
    expect(state.sessions.get('session-b')?.observedSeq).toBe(2)
  })

  it('counts a call while recording an unavailable classifier as a gap', () => {
    const throwing: UsageSourceClassifier = () => {
      throw new Error('classifier offline')
    }
    const state = ingestUsageSessionEvent(createUsageCollectorState(), {
      sessionId: 'session-a',
      event: toolCall(1),
      workspace,
      classify: throwing,
      origin: 'live',
    }).state

    const result = report(state)
    expect(result.calls).toBe(1)
    expect(result.aggregates[0]).toMatchObject({ capabilityKind: 'unknown' })
    expect(result.coverage['session-a']?.reasons).toEqual(
      expect.arrayContaining(['classifier-failed', 'unknown-tool-owner']),
    )
    expect(result.coverage['session-a']?.skippedEvents).toBe(0)
  })

  it('stores no raw event payload, arguments, output, or message text', () => {
    let state = live(createUsageCollectorState(), toolCall(1)).state
    state = live(state, toolResult(2, { isError: true, code: 'TOOL_TIMEOUT' })).state

    const serialized = JSON.stringify({
      report: report(state),
      sessions: [...state.sessions.entries()],
      aggregates: [...state.usage.aggregates.entries()].map(([key, value]) => [
        key,
        { ...value, errors: [...value.errors] },
      ]),
      calls: [...state.usage.calls.entries()],
    })
    for (const secret of [
      'PRIVATE ARGUMENT',
      'PRIVATE META',
      'PRIVATE TOOL OUTPUT',
      'PRIVATE REASON',
      'PrivateError',
    ]) {
      expect(serialized).not.toContain(secret)
    }
    expect(Object.keys(state.sessions.get('session-a')!).sort()).toEqual([
      'firstObservedSeq',
      'historyComplete',
      'observedSeq',
    ])
  })
})

describe('usage collector batch ingest', () => {
  it('matches the single-event path for a mixed multi-session page', () => {
    const batched = expectBatchEqualsSequential(richPage())
    const result = buildUsageReport(batched.state.usage)

    expect(batched.state.sessions.get('session-a')?.observedSeq).toBe(19)
    expect(batched.state.sessions.get('session-b')?.observedSeq).toBe(6)
    expect(result).toMatchObject({ calls: 7, orphanResults: 1, duplicateResults: 1 })
    expect(result.coverage['session-a']).toMatchObject({
      status: 'partial',
      fromSeq: 1,
      throughSeq: 19,
      skippedEvents: 7,
    })
    expect(result.coverage['session-b']).toMatchObject({
      status: 'partial',
      fromSeq: 1,
      throughSeq: 6,
      skippedEvents: 0,
    })
    for (const reason of [
      'live-only',
      'backfill-incomplete',
      'sequence-gap',
      'unknown-tool-owner',
      'workspace-attribution-unknown',
      'denied-not-observable',
      'unmatched-result',
      'malformed-tool-call',
      'duplicate-call-id',
      'invalid-event',
    ]) {
      expect(result.coverage['session-a']?.reasons).toContain(reason)
    }
  })

  it('matches the single-event path from an incremental state', () => {
    const page = richPage()
    const prefixed = page.slice(0, 8)
    const rest = page.slice(8)
    const initial = ingestSequentially(createUsageCollectorState(), prefixed).state
    const before = collectorSnapshot(initial)

    const sequential = ingestSequentially(initial, rest)
    const batched = ingestUsageSessionEvents(initial, rest)

    // A result in the page pairs with a call observed before the page.
    expect(rest[0]?.event).toMatchObject({ type: 'tool/result' })
    expect(batched.results).toEqual(sequential.results)
    expect(collectorSnapshot(batched.state)).toEqual(collectorSnapshot(sequential.state))
    expect(collectorSnapshot(initial)).toEqual(before)
  })

  it('matches the single-event path after a verified backfill completion', () => {
    const page = richPage()
    const base = ingestSequentially(createUsageCollectorState(), page.slice(0, 8)).state
    const completed = complete(base, 'session-a', 0, 5)
    expect(completed).toMatchObject({ accepted: true, reason: 'backfill-completed' })
    const initial = completed.state
    const rest = page.slice(8)

    const sequential = ingestSequentially(initial, rest)
    const batched = ingestUsageSessionEvents(initial, rest)

    expect(batched.results).toEqual(sequential.results)
    expect(collectorSnapshot(batched.state)).toEqual(collectorSnapshot(sequential.state))
    expect(collectorSnapshot(initial)).toEqual(collectorSnapshot(completed.state))
  })

  it('matches the single-event path through limits and coverage-reason truncation', () => {
    expectBatchEqualsSequential(richPage(), createUsageCollectorState({
      maxEvents: 12,
      maxCalls: 4,
      maxCoverageReasons: 3,
    }))
    const truncated = expectBatchEqualsSequential(richPage(), createUsageCollectorState({
      maxEvents: 40,
      maxCalls: 10,
      maxCoverageReasons: 3,
    }))
    expect(buildUsageReport(truncated.state.usage).coverage['session-a']?.reasonsTruncated).toBe(true)
  })

  it('rejects an out-of-order page without touching state, classifier, or orphan counts', () => {
    let classifierCalls = 0
    const counting: UsageSourceClassifier = name => {
      classifierCalls += 1
      return classify(name)
    }
    const initial = live(createUsageCollectorState(), toolCall(1)).state
    const before = collectorSnapshot(initial)
    const inputs = [
      inputOf(toolResult(5, { callId: 'call-1' }), { classify: counting }),
      inputOf(toolCall(3, { callId: 'late' }), { classify: counting }),
    ]

    const batched = ingestUsageSessionEvents(initial, inputs)
    expect(batched.rejectedReason).toBe('out-of-order-batch')
    expect(batched.state).toBe(initial)
    expect(batched.accepted).toBe(0)
    expect(batched.rejected).toBe(2)
    expect(batched.results).toEqual([
      { accepted: false, reason: 'invalid-input' },
      { accepted: false, reason: 'invalid-input' },
    ])
    expect(collectorSnapshot(initial)).toEqual(before)
    expect(initial.usage.orphanResults).toBe(0)
    // Pre-validation runs before projection, so the classifier is never asked.
    expect(classifierCalls).toBe(0)

    // Ordering is per Session: different Sessions interleave freely.
    const interleaved = ingestUsageSessionEvents(createUsageCollectorState(), [
      inputOf(toolCall(3), { sessionId: 'session-b' }),
      inputOf(toolCall(1), { sessionId: 'session-a' }),
    ])
    expect(interleaved.rejectedReason).toBeUndefined()
    expect(interleaved.accepted).toBe(2)
  })

  it('keeps duplicate watermark semantics inside a page', () => {
    const inputs = [
      inputOf(toolCall(1)),
      inputOf(toolCall(1)),
      inputOf(toolResult(2)),
      inputOf(toolResult(2)),
    ]
    const batched = ingestUsageSessionEvents(createUsageCollectorState(), inputs)

    expect(batched.results.map(result => result.reason)).toEqual([
      'counted-event',
      'duplicate-event',
      'counted-event',
      'duplicate-event',
    ])
    expect(buildUsageReport(batched.state.usage)).toMatchObject({ calls: 1, succeeded: 1 })
    expect(batched.state.sessions.get('session-a')).toEqual({
      firstObservedSeq: 1,
      observedSeq: 2,
      historyComplete: false,
    })
    expect(collectorSnapshot(batched.state)).toEqual(
      collectorSnapshot(ingestSequentially(createUsageCollectorState(), inputs).state),
    )
  })

  it('skips a malformed element without abandoning later events in the page', () => {
    const malformed = {
      ...inputOf(toolResult(2)),
      classify: undefined,
    } as unknown as UsageIngestEventInput
    const inputs = [inputOf(toolCall(1)), malformed, inputOf(toolResult(2))]

    const sequential = ingestSequentially(createUsageCollectorState(), inputs)
    const batched = ingestUsageSessionEvents(createUsageCollectorState(), inputs)

    expect(batched.results).toEqual(sequential.results)
    expect(batched.results[1]).toEqual({ accepted: false, reason: 'invalid-input' })
    expect(batched.accepted).toBe(2)
    expect(batched.rejected).toBe(1)
    expect(collectorSnapshot(batched.state)).toEqual(collectorSnapshot(sequential.state))
  })

  it('replays a mixed live/backfill page without double counting or changing state', () => {
    const page = richPage()
    const first = ingestUsageSessionEvents(createUsageCollectorState(), page)
    const before = collectorSnapshot(first.state)

    const replay = ingestUsageSessionEvents(first.state, page)
    expect(replay.rejectedReason).toBeUndefined()
    expect(collectorSnapshot(replay.state)).toEqual(before)
  })

  it('returns the input state for empty or wholly invalid pages', () => {
    const state = live(createUsageCollectorState(), toolCall(1)).state
    expect(ingestUsageSessionEvents(state, [])).toEqual({
      state,
      results: [],
      accepted: 0,
      rejected: 0,
    })

    const invalid = [
      { ...inputOf(toolCall(2)), origin: 'nope' },
      null,
    ] as unknown as UsageIngestEventInput[]
    const batched = ingestUsageSessionEvents(state, invalid)
    expect(batched.state).toBe(state)
    expect(batched.accepted).toBe(0)
    expect(batched.rejected).toBe(2)
    expect(batched.results).toEqual([
      { accepted: false, reason: 'invalid-input' },
      { accepted: false, reason: 'invalid-input' },
    ])
  })

  it('folds 20k real collector events in one ordered page within a loose budget', () => {
    const inputs: UsageIngestEventInput[] = []
    for (let index = 0; index < 10_000; index += 1) {
      const seq = index * 2 + 1
      inputs.push(inputOf(toolCall(seq, { callId: `perf-${index}`, time: TIME + index })))
      inputs.push(inputOf(toolResult(seq + 1, { callId: `perf-${index}`, time: TIME + index + 1 })))
    }

    const started = performance.now()
    const batched: UsageIngestBatchResult = ingestUsageSessionEvents(createUsageCollectorState(), inputs)
    const elapsed = performance.now() - started

    expect(batched.rejectedReason).toBeUndefined()
    expect(batched.accepted).toBe(20_000)
    expect(batched.rejected).toBe(0)
    const result = buildUsageReport(batched.state.usage)
    expect(result).toMatchObject({
      calls: 10_000,
      succeeded: 10_000,
      failed: 0,
      unresolved: 0,
      orphanResults: 0,
      duplicateResults: 0,
      limitsReached: false,
    })
    expect(result.coverage['session-a']).toMatchObject({
      status: 'partial',
      fromSeq: 1,
      throughSeq: 20_000,
      skippedEvents: 0,
    })
    expect(result.coverage['session-a']?.reasons).toEqual(['live-only'])
    // Loose catastrophic-regression guard: folding one applyUsageEvent per event
    // copied the growing state each time; a single page keeps the fold linear.
    // The gap is wide (linear here vs. seconds for the old fold), so this is not
    // a tight benchmark and tolerates a busy machine.
    expect(elapsed).toBeLessThan(5_000)
  }, 30_000)
})
