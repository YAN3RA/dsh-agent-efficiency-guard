import { describe, expect, it } from 'vitest'
import {
  DEFAULT_USAGE_COLLECTOR_CODEC_LIMITS,
  UsageCollectorCodecError,
  decodeUsageCollectorState,
  decodeUsageCollectorStateJson,
  encodeUsageCollectorState,
  encodeUsageCollectorStateJson,
  type UsageCollectorCodecErrorCode,
} from '../src/usage/usage-collector-codec.ts'
import {
  applyUsageEvent,
  buildUsageReport,
  createUsageState,
  markUsageSessionSkipped,
  recordUsageCoverage,
  type UsageEvent,
  type UsageState,
  type UsageToolCallEvent,
  type UsageToolResultEvent,
} from '../src/usage/usage-core.ts'
import {
  createUsageCollectorState,
  type UsageCollectorSession,
  type UsageCollectorState,
} from '../src/usage/usage-collector.ts'

const TIME = Date.UTC(2026, 10, 4, 10, 0, 0)
const eventTimeWorkspace = { workspaceId: 'ws-a', attribution: 'event-time' as const }
const unknownWorkspace = { attribution: 'unknown' as const }

type MutableRecord = Record<string, unknown>

interface MutableDocument {
  schema: unknown
  version: unknown
  usage: MutableRecord
  sessions: MutableRecord[]
  [key: string]: unknown
}

function toolCall(overrides: Partial<UsageToolCallEvent> = {}): UsageToolCallEvent {
  return {
    type: 'tool-call',
    sessionId: 'session-a',
    seq: 1,
    time: TIME,
    callId: 'call-1',
    capabilityId: 'mcp__files__read',
    source: { kind: 'mcp', providerId: 'files' },
    workspace: eventTimeWorkspace,
    ...overrides,
  }
}

function toolResult(overrides: Partial<UsageToolResultEvent> = {}): UsageToolResultEvent {
  return {
    type: 'tool-result',
    sessionId: 'session-a',
    seq: 2,
    time: TIME + 1_000,
    callId: 'call-1',
    outcome: 'success',
    workspace: eventTimeWorkspace,
    ...overrides,
  }
}

function apply(state: UsageState, event: UsageEvent): UsageState {
  const result = applyUsageEvent(state, event)
  expect(result.accepted).toBe(true)
  return result.state
}

function richUsage(): UsageState {
  let state = createUsageState({
    maxEvents: 64,
    maxCalls: 32,
    maxCoverageReasons: 4,
    maxErrorCodeLength: 16,
  })
  state = apply(state, toolCall())
  state = apply(state, toolResult({ outcome: 'error', errorCode: 'E_TIMEOUT' }))
  state = apply(state, toolCall({
    seq: 3,
    callId: 'call-2',
    capabilityId: 'unknown-tool',
    source: { kind: 'unknown', reason: 'owner-not-exposed' },
    workspace: unknownWorkspace,
  }))
  state = apply(state, toolResult({
    seq: 4,
    callId: 'call-2',
    outcome: 'denied',
    workspace: unknownWorkspace,
  }))
  state = apply(state, toolCall({
    sessionId: 'session-b',
    seq: 5,
    time: TIME + 4_000,
    callId: 'call-3',
    capabilityId: 'native-tool',
    source: { kind: 'native' },
    workspace: { workspaceId: 'ws-b', attribution: 'current-mapping' },
  }))
  state = apply(state, {
    type: 'skill-load',
    sessionId: 'session-b',
    seq: 6,
    time: TIME + 5_000,
    skillId: 'skill-a',
    providerId: 'bundle-a',
    entry: 'meta-invoke',
    outcome: 'success',
    workspace: { workspaceId: 'ws-b', attribution: 'current-mapping' },
  })
  state = markUsageSessionSkipped(state, 'session-c', 'oversize-session', 3)
  state = recordUsageCoverage(state, 'session-d', { status: 'unknown', skippedSessions: 1 })
  return state
}

function richCollector(): UsageCollectorState {
  const sessions = new Map<string, UsageCollectorSession>([
    ['session-a', { firstObservedSeq: 1, observedSeq: 2, historyComplete: false }],
    ['session-b', { firstObservedSeq: 5, observedSeq: 6, historyComplete: true }],
    ['session-c', { firstObservedSeq: 7, observedSeq: 8, historyComplete: false }],
  ])
  return { usage: richUsage(), sessions }
}

function rawDocument(state: UsageCollectorState = richCollector()): MutableDocument {
  return JSON.parse(encodeUsageCollectorStateJson(state)) as MutableDocument
}

function codecError(run: () => unknown): UsageCollectorCodecError {
  try {
    run()
  } catch (error) {
    if (error instanceof UsageCollectorCodecError) return error
    throw error
  }
  throw new Error('expected UsageCollectorCodecError')
}

function expectCode(run: () => unknown, code: UsageCollectorCodecErrorCode): void {
  expect(codecError(run).code).toBe(code)
}

describe('usage collector codec', () => {
  it('round-trips the usage payload and every Session watermark', () => {
    const state = richCollector()
    const document = encodeUsageCollectorState(state)
    expect(document.schema).toBe('dsh-thinking-guard/usage-collector')
    expect(document.version).toBe(1)
    expect(Object.keys(document).sort()).toEqual(['schema', 'sessions', 'usage', 'version'])
    expect(document.usage.schema).toBe('dsh-thinking-guard/usage-state')
    expect(document.sessions).toHaveLength(3)

    const decoded = decodeUsageCollectorStateJson(encodeUsageCollectorStateJson(state))
    expect(decoded.usage.limits).toEqual(state.usage.limits)
    expect([...decoded.usage.seenEvents]).toEqual([...state.usage.seenEvents])
    expect([...decoded.usage.calls.entries()]).toEqual([...state.usage.calls.entries()])
    expect([...decoded.usage.aggregates.entries()]).toEqual([...state.usage.aggregates.entries()])
    expect([...decoded.usage.coverage.entries()]).toEqual([...state.usage.coverage.entries()])
    expect(buildUsageReport(decoded.usage)).toEqual(buildUsageReport(state.usage))
    expect(decoded.usage).toMatchObject({
      totalEvents: state.usage.totalEvents,
      totalCalls: state.usage.totalCalls,
      stoppedByLimit: state.usage.stoppedByLimit,
      orphanResults: state.usage.orphanResults,
      duplicateResults: state.usage.duplicateResults,
    })
    expect([...decoded.sessions.entries()]).toEqual([...state.sessions.entries()])
  })

  it('round-trips an empty collector state', () => {
    const state = createUsageCollectorState()
    const document = encodeUsageCollectorState(state)
    expect(document.sessions).toEqual([])

    const decoded = decodeUsageCollectorStateJson(encodeUsageCollectorStateJson(state))
    expect(decoded.sessions.size).toBe(0)
    expect(decoded.usage.seenEvents.size).toBe(0)
    expect(decoded.usage.calls.size).toBe(0)
    expect(decoded.usage.aggregates.size).toBe(0)
    expect(decoded.usage.coverage.size).toBe(0)
    expect(decoded.usage.totalEvents).toBe(0)
    expect(decoded.usage.totalCalls).toBe(0)
  })

  it('preserves a completed history that never observed a sequence number', () => {
    const state: UsageCollectorState = {
      usage: createUsageState(),
      sessions: new Map([
        ['session-empty-history', { historyComplete: true }],
      ]),
    }
    const decoded = decodeUsageCollectorStateJson(encodeUsageCollectorStateJson(state))
    expect(decoded.sessions.get('session-empty-history')).toEqual({ historyComplete: true })
  })

  it('returns containers that do not alias the source or each other', () => {
    const state = richCollector()
    const document = encodeUsageCollectorState(state)
    const decoded = decodeUsageCollectorState(document)

    expect(decoded.usage).not.toBe(state.usage)
    expect(decoded.usage.seenEvents).not.toBe(state.usage.seenEvents)
    expect(decoded.usage.calls).not.toBe(state.usage.calls)
    expect(decoded.usage.aggregates).not.toBe(state.usage.aggregates)
    expect(decoded.usage.coverage).not.toBe(state.usage.coverage)
    expect(decoded.sessions).not.toBe(state.sessions)
    expect(decoded.sessions.get('session-a')).not.toBe(state.sessions.get('session-a'))

    ;(document.sessions[0] as { observedSeq?: number }).observedSeq = 999
    expect(decoded.sessions.get('session-a')?.observedSeq).toBe(2)
    expect(state.sessions.get('session-a')?.observedSeq).toBe(2)

    ;(decoded.sessions as Map<string, UsageCollectorSession>)
      .set('session-injected', { historyComplete: false })
    expect(state.sessions.has('session-injected')).toBe(false)

    decoded.usage.seenEvents.add('injected')
    expect(state.usage.seenEvents.has('injected')).toBe(false)

    const decodedAggregate = [...decoded.usage.aggregates.values()][0]
    decodedAggregate.errors.set('INJECTED', 1)
    expect([...state.usage.aggregates.values()].some(row => row.errors.has('INJECTED'))).toBe(false)

    decoded.usage.coverage.get('session-a')!.reasons.push('injected')
    expect(state.usage.coverage.get('session-a')!.reasons).not.toContain('injected')

    const second = decodeUsageCollectorState(encodeUsageCollectorState(state))
    expect([...second.sessions.keys()]).toEqual(['session-a', 'session-b', 'session-c'])
    expect(second.sessions.get('session-a')?.observedSeq).toBe(2)
  })

  it('does not mutate the document it decodes', () => {
    const document = rawDocument()
    const snapshot = JSON.parse(JSON.stringify(document)) as MutableDocument
    decodeUsageCollectorState(document)
    expect(document).toEqual(snapshot)
  })

  it('persists only allow-listed watermark fields, never raw event data', () => {
    const dirtySession = {
      firstObservedSeq: 7,
      observedSeq: 7,
      historyComplete: false,
      event: { type: 'tool/call', seq: 7, data: { arguments: 'PRIVATE_ARGUMENT' } },
      arguments: 'PRIVATE_ARGUMENT',
      messages: [{ content: 'PRIVATE_MESSAGE' }],
      credentials: { token: 'PRIVATE_TOKEN' },
      data: { payload: 'PRIVATE_PAYLOAD' },
    } as unknown as UsageCollectorSession
    const state: UsageCollectorState = {
      usage: createUsageState(),
      sessions: new Map([['session-private', dirtySession]]),
    }

    const json = encodeUsageCollectorStateJson(state)
    expect(json).not.toContain('PRIVATE')
    const document = JSON.parse(json) as MutableDocument
    expect(Object.keys(document.sessions[0]).sort()).toEqual([
      'firstObservedSeq',
      'historyComplete',
      'observedSeq',
      'sessionId',
    ])
  })

  it('rejects unsupported or missing versions without inventing a migration', () => {
    const document = rawDocument()
    expectCode(() => decodeUsageCollectorState({ ...document, version: 2 }), 'unsupported-version')
    expectCode(() => decodeUsageCollectorState({ ...document, version: '1' }), 'invalid-document')
    expectCode(() => decodeUsageCollectorState({ ...document, version: 0 }), 'invalid-document')

    const missing = rawDocument()
    delete (missing as Record<string, unknown>).version
    expectCode(() => decodeUsageCollectorState(missing), 'invalid-document')

    const wrongSchema = rawDocument()
    wrongSchema.schema = 'dsh-thinking-guard/usage-state'
    expectCode(() => decodeUsageCollectorState(wrongSchema), 'invalid-document')
  })

  it('rejects a Session watermark without the historyComplete flag', () => {
    const document = rawDocument()
    delete document.sessions[0].historyComplete
    expectCode(() => decodeUsageCollectorState(document), 'invalid-document')

    const state = richCollector()
    const session = state.sessions.get('session-a') as { historyComplete?: boolean }
    delete session.historyComplete
    expectCode(() => encodeUsageCollectorState(state), 'inconsistent-state')
  })

  it('rejects unknown or missing fields instead of ignoring them', () => {
    expectCode(() => decodeUsageCollectorState(null), 'invalid-document')
    expectCode(() => decodeUsageCollectorState([]), 'invalid-document')

    const extraTopLevel = { ...rawDocument(), events: [] }
    expectCode(() => decodeUsageCollectorState(extraTopLevel), 'invalid-document')

    const missingSessions = rawDocument()
    delete (missingSessions as Record<string, unknown>).sessions
    expectCode(() => decodeUsageCollectorState(missingSessions), 'invalid-document')

    const extraSession = rawDocument()
    extraSession.sessions[0].event = { type: 'tool/call', data: { arguments: 'PRIVATE' } }
    expectCode(() => decodeUsageCollectorState(extraSession), 'invalid-document')
    expect(codecError(() => decodeUsageCollectorState(extraSession)).path).toContain('event')

    const unknownNested = rawDocument()
    unknownNested.usage.events = []
    expectCode(() => decodeUsageCollectorState(unknownNested), 'invalid-document')
    expect(codecError(() => decodeUsageCollectorState(unknownNested)).path).toBe('$.usage.events')
  })

  it('rejects malformed watermark values and inconsistent sequence pairs', () => {
    const cases: Array<[string, (document: MutableDocument) => void, UsageCollectorCodecErrorCode]> = [
      ['sessionId type', document => { document.sessions[0].sessionId = 42 }, 'invalid-document'],
      ['sessionId empty', document => { document.sessions[0].sessionId = '' }, 'invalid-document'],
      ['sessionId whitespace', document => { document.sessions[0].sessionId = '  ' }, 'invalid-document'],
      ['negative seq', document => { document.sessions[0].firstObservedSeq = -1 }, 'invalid-document'],
      ['fractional seq', document => { document.sessions[0].observedSeq = 1.5 }, 'invalid-document'],
      ['string seq', document => { document.sessions[0].observedSeq = '2' }, 'invalid-document'],
      ['unsafe seq', document => {
        document.sessions[0].observedSeq = Number.MAX_SAFE_INTEGER + 1
      }, 'invalid-document'],
      ['history flag type', document => { document.sessions[0].historyComplete = 1 }, 'invalid-document'],
      ['one-sided sequence pair', document => { delete document.sessions[0].observedSeq }, 'inconsistent-state'],
      ['first after observed', document => { document.sessions[0].firstObservedSeq = 99 }, 'inconsistent-state'],
    ]

    for (const [label, mutate, code] of cases) {
      const document = rawDocument()
      mutate(document)
      expect(codecError(() => decodeUsageCollectorState(document)).code, label).toBe(code)
    }
  })

  it('enforces identifier and Session budgets instead of truncating', () => {
    const maxId = 's'.repeat(DEFAULT_USAGE_COLLECTOR_CODEC_LIMITS.maxSessionIdLength)
    const maxDocument = rawDocument()
    maxDocument.sessions[0].sessionId = maxId
    expect(() => decodeUsageCollectorState(maxDocument)).not.toThrow()

    const longDocument = rawDocument()
    longDocument.sessions[0].sessionId = `${maxId}s`
    expectCode(() => decodeUsageCollectorState(longDocument), 'limit-exceeded')

    const state: UsageCollectorState = {
      usage: createUsageState(),
      sessions: new Map([[`${maxId}s`, { historyComplete: false }]]),
    }
    expectCode(() => encodeUsageCollectorState(state), 'limit-exceeded')
  })

  it('rejects duplicate Session watermarks', () => {
    const document = rawDocument()
    document.sessions.push({ ...document.sessions[0] })
    expectCode(() => decodeUsageCollectorState(document), 'inconsistent-state')
  })

  it('rejects a corrupted nested usage payload with a collector-scoped path', () => {
    const document = rawDocument()
    const totals = document.usage.totals as MutableRecord
    document.usage.totals = { ...totals, totalEvents: Number(totals.totalEvents) + 1 }
    const error = codecError(() => decodeUsageCollectorState(document))
    expect(error.code).toBe('inconsistent-state')
    expect(error.path.startsWith('$.usage')).toBe(true)

    const state = richCollector()
    const [key, aggregate] = [...state.usage.aggregates.entries()][0]
    state.usage.aggregates.delete(key)
    state.usage.aggregates.set('corrupt-aggregate-key', aggregate)
    const encodeError = codecError(() => encodeUsageCollectorState(state))
    expect(encodeError.code).toBe('inconsistent-state')
    expect(encodeError.path.startsWith('$.usage')).toBe(true)
  })

  it('enforces the serialized byte budget at the exact boundary', () => {
    const state = richCollector()
    const document = encodeUsageCollectorState(state)
    const bytes = new TextEncoder().encode(JSON.stringify(document)).byteLength
    expect(bytes).toBeGreaterThan(0)

    expect(() => encodeUsageCollectorState(state, { maxDocumentBytes: bytes })).not.toThrow()
    expectCode(() => encodeUsageCollectorState(state, { maxDocumentBytes: bytes - 1 }), 'limit-exceeded')
    expect(() => decodeUsageCollectorState(document, { maxDocumentBytes: bytes })).not.toThrow()
    expectCode(() => decodeUsageCollectorState(document, { maxDocumentBytes: bytes - 1 }), 'limit-exceeded')

    const json = encodeUsageCollectorStateJson(state)
    expectCode(
      () => decodeUsageCollectorStateJson(json, { maxDocumentBytes: bytes - 1 }),
      'limit-exceeded',
    )
  })

  it('enforces the Session watermark budget at the exact boundary', () => {
    const state = richCollector()
    expect(() => encodeUsageCollectorState(state, { maxSessions: 3 })).not.toThrow()
    expectCode(() => encodeUsageCollectorState(state, { maxSessions: 2 }), 'limit-exceeded')

    const document = rawDocument()
    expectCode(() => decodeUsageCollectorState(document, { maxSessions: 2 }), 'limit-exceeded')
  })

  it('rejects invalid codec options', () => {
    const state = richCollector()
    expectCode(() => encodeUsageCollectorState(state, { maxDocumentBytes: 0 }), 'invalid-document')
    expectCode(() => encodeUsageCollectorState(state, { maxSessions: 1.5 }), 'invalid-document')
    expectCode(() => decodeUsageCollectorState(rawDocument(), { maxSessions: -1 }), 'invalid-document')
  })

  it('refuses to encode a corrupted in-memory collector state', () => {
    const notAMap: UsageCollectorState = {
      usage: createUsageState(),
      sessions: [] as unknown as ReadonlyMap<string, UsageCollectorSession>,
    }
    expectCode(() => encodeUsageCollectorState(notAMap), 'inconsistent-state')

    const state = richCollector()
    const session = state.sessions.get('session-a') as { observedSeq?: number }
    delete session.observedSeq
    expectCode(() => encodeUsageCollectorState(state), 'inconsistent-state')
  })

  it('rejects invalid or oversized JSON text', () => {
    expectCode(() => decodeUsageCollectorStateJson('{'), 'invalid-json')
    expectCode(
      () => decodeUsageCollectorStateJson('x'.repeat(256), { maxDocumentBytes: 128 }),
      'limit-exceeded',
    )
  })
})
