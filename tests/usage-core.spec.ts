import { describe, expect, it } from 'vitest'
import {
  applyUsageEvent,
  applyUsageEvents,
  buildUsageReport,
  createUsageState,
  markUsageSessionSkipped,
  recordUsageCoverage,
  type UsageEvent,
  type UsageCoverageStatus,
  type UsageToolCallEvent,
  type UsageToolResultEvent,
  type UsageSkillLoadEvent,
  type UsageState,
} from '../src/usage/usage-core.ts'

const workspace = { workspaceId: 'ws-a', attribution: 'event-time' as const }
const baseTime = Date.UTC(2026, 10, 3, 12)

function toolCall(overrides: Partial<UsageToolCallEvent> = {}): UsageToolCallEvent {
  return {
    type: 'tool-call',
    sessionId: 'session-a',
    seq: 1,
    time: Date.UTC(2026, 10, 3, 12),
    callId: 'call-1',
    capabilityId: 'mcp__files__read',
    source: { kind: 'mcp', providerId: 'files' },
    workspace,
    ...overrides,
  }
}

function toolResult(overrides: Partial<UsageToolResultEvent> = {}): UsageToolResultEvent {
  return {
    type: 'tool-result',
    sessionId: 'session-a',
    seq: 2,
    time: baseTime + 10,
    callId: 'call-1',
    outcome: 'success',
    workspace,
    ...overrides,
  }
}

function skillLoad(overrides: Partial<UsageSkillLoadEvent> = {}): UsageSkillLoadEvent {
  return {
    type: 'skill-load',
    sessionId: 'session-a',
    seq: 10,
    time: baseTime + 20,
    skillId: 'summarize',
    entry: 'slash-invocation',
    outcome: 'success',
    workspace,
    ...overrides,
  }
}

function apply(state: ReturnType<typeof createUsageState>, event: UsageEvent) {
  return applyUsageEvent(state, event)
}

function applySequentially(state: UsageState, events: readonly UsageEvent[]) {
  const results: Array<{ accepted: boolean; reason?: string }> = []
  for (const event of events) {
    const applied = applyUsageEvent(state, event)
    results.push(applied.reason === undefined
      ? { accepted: applied.accepted }
      : { accepted: applied.accepted, reason: applied.reason })
    state = applied.state
  }
  return { state, results }
}

describe('usage core', () => {
  it('deduplicates by session and event sequence without double-counting results', () => {
    let state = createUsageState()
    const call = toolCall()
    state = apply(state, call).state
    expect(apply(state, call)).toMatchObject({ accepted: false, reason: 'duplicate-event' })
    state = apply(state, {
      type: 'tool-result', sessionId: call.sessionId, seq: 2, time: call.time + 50,
      callId: call.callId, outcome: 'success', workspace,
    }).state
    const repeatedResult = apply(state, {
      type: 'tool-result', sessionId: call.sessionId, seq: 3, time: call.time + 51,
      callId: call.callId, outcome: 'error', errorCode: 'SHOULD_NOT_REPLACE', workspace,
    })
    state = repeatedResult.state
    const report = buildUsageReport(state)
    expect(report).toMatchObject({ calls: 1, succeeded: 1, failed: 0, unresolved: 0, duplicateResults: 1 })
  })

  it('pairs call ids within a Session, not globally', () => {
    let state = createUsageState()
    state = apply(state, toolCall({ sessionId: 'session-a', seq: 1, callId: 'same' })).state
    state = apply(state, toolCall({ sessionId: 'session-b', seq: 1, callId: 'same', capabilityId: 'read-local' })).state
    state = apply(state, {
      type: 'tool-result', sessionId: 'session-a', seq: 2, time: Date.UTC(2026, 10, 3, 12, 1),
      callId: 'same', outcome: 'success', workspace,
    }).state
    const report = buildUsageReport(state)
    expect(report.calls).toBe(2)
    expect(report.succeeded).toBe(1)
    expect(report.unresolved).toBe(1)
    expect(report.aggregates).toHaveLength(2)
  })

  it('tracks denied, cancelled, failed, and unresolved outcomes separately', () => {
    let state = createUsageState()
    const outcomes = ['error', 'denied', 'cancelled'] as const
    outcomes.forEach((outcome, index) => {
      const seq = index * 2 + 1
      state = apply(state, toolCall({ seq, callId: `c-${index}` })).state
      state = apply(state, {
        type: 'tool-result', sessionId: 'session-a', seq: seq + 1, time: Date.UTC(2026, 10, 3, 12) + seq,
        callId: `c-${index}`, outcome, ...(outcome === 'error' ? { errorCode: 'ERR_PRIVATE_DETAIL'.repeat(20) } : {}), workspace,
      }).state
    })
    state = apply(state, toolCall({ seq: 8, callId: 'pending' })).state
    const report = buildUsageReport(state)
    expect(report).toMatchObject({ calls: 4, failed: 1, denied: 1, cancelled: 1, unresolved: 1 })
    expect(report.aggregates.some(row => Object.keys(row.errors).some(code => code.includes('PRIVATE_DETAIL')))).toBe(false)
  })

  it('marks orphan results as partial coverage instead of inventing a call', () => {
    let state = createUsageState()
    state = apply(state, {
      type: 'tool-result', sessionId: 'session-missing', seq: 7, time: 10,
      callId: 'not-seen', outcome: 'error', errorCode: 'NO_CALL', workspace: { attribution: 'unknown' },
    }).state
    const report = buildUsageReport(state)
    expect(report).toMatchObject({ calls: 0, orphanResults: 1 })
    expect(report.coverage['session-missing']).toMatchObject({ status: 'partial', reasons: ['unmatched-result'] })
  })

  it('keeps unknown owner and workspace attribution explicit', () => {
    let state = createUsageState()
    state = apply(state, toolCall({
      source: { kind: 'unknown', reason: 'owner-not-exposed' },
      workspace: { attribution: 'unknown' },
    })).state
    const report = buildUsageReport(state)
    expect(report.aggregates[0]).toMatchObject({ capabilityKind: 'unknown', workspaceAttribution: 'unknown', unresolved: 1 })
    expect(report.coverage['session-a']?.status).toBe('partial')
    expect(report.coverage['session-a']?.reasons).toEqual(expect.arrayContaining(['unknown-tool-owner', 'workspace-attribution-unknown']))
  })

  it('marks duplicate call ids and current workspace mappings as coverage gaps', () => {
    let state = createUsageState()
    state = apply(state, toolCall({ workspace: { workspaceId: 'ws-current', attribution: 'current-mapping' } })).state
    state = apply(state, toolCall({ seq: 2 })).state
    const report = buildUsageReport(state)
    expect(report.calls).toBe(1)
    expect(report.coverage['session-a']?.status).toBe('partial')
    expect(report.coverage['session-a']?.reasons).toEqual(expect.arrayContaining(['workspace-current-mapping', 'duplicate-call-id']))
  })

  it('rejects current-mapping and event-time workspaces without a workspace id', () => {
    const state = createUsageState()
    const withoutId = apply(state, toolCall({ workspace: { attribution: 'current-mapping' } }))
    expect(withoutId).toEqual({ state, accepted: false, reason: 'invalid-event' })
    expect(buildUsageReport(withoutId.state).coverage).toEqual({})

    const blankId = apply(state, toolCall({ workspace: { workspaceId: '   ', attribution: 'current-mapping' } }))
    expect(blankId).toEqual({ state, accepted: false, reason: 'invalid-event' })

    const eventTimeWithoutId = apply(state, toolCall({ workspace: { attribution: 'event-time' } }))
    expect(eventTimeWithoutId).toEqual({ state, accepted: false, reason: 'invalid-event' })

    const batch = applyUsageEvents(state, [
      toolCall({ workspace: { attribution: 'current-mapping' } }),
      toolCall({ workspace: { workspaceId: 'ws-current', attribution: 'current-mapping' } }),
    ])
    expect(batch.results).toEqual([
      { accepted: false, reason: 'invalid-event' },
      { accepted: true },
    ])
    expect(batch.state.coverage.get('session-a')?.reasons).toContain('workspace-current-mapping')
  })

  it('fails closed when recordUsageCoverage receives an unknown status', () => {
    let state = createUsageState()
    state = recordUsageCoverage(state, 'session-a', { status: 'partial', reason: 'known-gap' })
    const snapshot = buildUsageReport(state)

    const rejected = recordUsageCoverage(state, 'session-a', {
      status: 'forged' as UsageCoverageStatus,
      reason: 'PRIVATE REASON',
      skippedEvents: 5,
    })
    expect(rejected).toBe(state)
    expect(buildUsageReport(rejected)).toEqual(snapshot)

    const fresh = createUsageState()
    expect(recordUsageCoverage(fresh, 'session-b', { status: 'forged' as UsageCoverageStatus })).toBe(fresh)
    expect(fresh.coverage.size).toBe(0)
  })

  it('counts only explicit Skill load observations and exposes missing source coverage', () => {
    let state = createUsageState()
    state = apply(state, {
      type: 'skill-load', sessionId: 'session-a', seq: 4, time: Date.UTC(2026, 10, 3),
      skillId: 'summarize', entry: 'slash-invocation', outcome: 'success', workspace,
    }).state
    const report = buildUsageReport(state, { capabilityKind: 'skill' })
    expect(report).toMatchObject({ calls: 1, succeeded: 1, unresolved: 0 })
    expect(report.aggregates[0]).toMatchObject({ capabilityId: 'summarize', capabilityKind: 'skill' })
    expect(report.coverage['session-a']?.reasons).toContain('unknown-skill-source')
  })

  it('normalizes blank and padded Skill providers in skill-load events', () => {
    let state = createUsageState()
    state = apply(state, skillLoad({ seq: 1, providerId: '   ' })).state
    let report = buildUsageReport(state)
    expect(report.aggregates).toHaveLength(1)
    expect(report.aggregates[0]).toMatchObject({ capabilityId: 'summarize', capabilityKind: 'skill' })
    expect(report.aggregates[0]?.providerId).toBeUndefined()
    expect(report.coverage['session-a']?.reasons).toContain('unknown-skill-source')

    state = apply(state, skillLoad({ seq: 2, providerId: ' writer ' })).state
    state = apply(state, skillLoad({ seq: 3, providerId: 'writer' })).state
    report = buildUsageReport(state)
    expect(report.calls).toBe(3)
    expect(report.aggregates).toHaveLength(2)
    expect(report.aggregates.find(row => row.providerId === 'writer')?.calls).toBe(2)
  })

  it('normalizes blank and padded Skill providers on tool-call sources', () => {
    let state = createUsageState()
    state = apply(state, toolCall({ source: { kind: 'skill', entry: 'skill-tool', providerId: '   ' } })).state
    state = apply(state, toolCall({
      seq: 2, callId: 'call-2', source: { kind: 'skill', entry: 'skill-tool', providerId: ' writer ' },
    })).state
    state = apply(state, toolCall({
      seq: 3, callId: 'call-3', source: { kind: 'skill', entry: 'skill-tool', providerId: 'writer' },
    })).state

    const report = buildUsageReport(state)
    expect(report.calls).toBe(3)
    expect(report.aggregates).toHaveLength(2)
    expect(report.aggregates.find(row => row.providerId === undefined)?.calls).toBe(1)
    expect(report.aggregates.find(row => row.providerId === 'writer')?.calls).toBe(2)
    expect(report.coverage['session-a']?.reasons).toContain('unknown-skill-source')
  })

  it('maps only stable classifier reasons into bounded coverage reasons', () => {
    const reasonsFor = (reason: string) => {
      const state = apply(createUsageState(), toolCall({ source: { kind: 'unknown', reason } })).state
      return buildUsageReport(state).coverage['session-a']?.reasons ?? []
    }

    expect(reasonsFor('tool-id-missing')).toContain('tool-id-missing')
    expect(reasonsFor('ambiguous-mcp-provider')).toContain('ambiguous-mcp-provider')
    expect(reasonsFor('missing-mcp-provider')).toContain('missing-mcp-provider')
    expect(reasonsFor('conflicting-trusted-sources')).toContain('conflicting-trusted-sources')
    expect(reasonsFor('skill-entry-not-observed')).toContain('skill-entry-not-observed')
    expect(reasonsFor('owner-not-verified')).toContain('unknown-tool-owner')

    const arbitrary = reasonsFor('PRIVATE REASON')
    expect(arbitrary).toContain('unknown-tool-owner')
    expect(arbitrary.join(' ')).not.toContain('PRIVATE')
  })

  it('keeps whitelisted classifier reasons within the coverage reason budget', () => {
    let state = createUsageState({ maxCoverageReasons: 1 })
    state = apply(state, toolCall({ source: { kind: 'unknown', reason: 'tool-id-missing' } })).state
    state = apply(state, toolCall({
      seq: 2, callId: 'call-2', source: { kind: 'unknown', reason: 'ambiguous-mcp-provider' },
    })).state

    const coverage = buildUsageReport(state).coverage['session-a']
    expect(coverage?.reasons).toEqual(['tool-id-missing'])
    expect(coverage?.reasonsTruncated).toBe(true)
  })

  it('preserves explicit unknown coverage and aggregates skipped-session reasons', () => {
    let state = createUsageState({ maxCoverageReasons: 1 })
    state = recordUsageCoverage(state, 'session-a', { status: 'unknown', reason: 'history-api-unavailable' })
    state = apply(state, toolCall()).state
    state = markUsageSessionSkipped(state, 'session-b', 'oversize-session', 100)
    state = markUsageSessionSkipped(state, 'session-b', 'page-budget')
    const report = buildUsageReport(state)
    expect(report.coverage['session-a']).toMatchObject({ status: 'unknown', reasons: ['history-api-unavailable'] })
    expect(report.coverage['session-b']).toMatchObject({ status: 'partial', skippedSessions: 2, skippedEvents: 100, reasons: ['oversize-session'], reasonsTruncated: true })
  })

  it('stops at event and call limits and marks coverage partial', () => {
    let state = createUsageState({ maxEvents: 2, maxCalls: 1 })
    state = apply(state, toolCall({ seq: 1 })).state
    const callLimit = apply(state, toolCall({ seq: 2, callId: 'second' }))
    expect(callLimit).toMatchObject({ accepted: false, reason: 'call-limit' })
    state = callLimit.state
    expect(buildUsageReport(state).coverage['session-a']?.reasons).toContain('call-limit')
    const afterCallLimit = apply(state, toolResult({ seq: 3, callId: 'call-1' }))
    expect(afterCallLimit).toMatchObject({ accepted: false, reason: 'call-limit' })
    expect(buildUsageReport(afterCallLimit.state).coverage['session-a']?.reasons).not.toContain('event-limit')

    let eventLimited = createUsageState({ maxEvents: 1 })
    eventLimited = apply(eventLimited, toolCall()).state
    const stopped = apply(eventLimited, {
      type: 'tool-result', sessionId: 'session-a', seq: 2, time: 20, callId: 'call-1', outcome: 'success', workspace,
    })
    expect(stopped).toMatchObject({ accepted: false, reason: 'event-limit' })
    expect(buildUsageReport(stopped.state).limitsReached).toBe(true)
  })

  it('applies a batch with the same per-event outcomes and totals as sequential application', () => {
    const events: UsageEvent[] = [
      toolCall({ seq: 1, callId: 'call-1' }),
      toolResult({ seq: 2, callId: 'call-1', outcome: 'success' }),
      toolCall({ seq: 1, callId: 'call-1' }), // duplicate event identity
      toolResult({ seq: 3, callId: 'call-1', outcome: 'error', errorCode: 'LATE' }), // duplicate result
      toolResult({ seq: 4, callId: 'missing', outcome: 'error', errorCode: 'NO_CALL' }), // orphan
      toolCall({
        seq: 5, callId: 'native-1', capabilityId: 'read-local',
        source: { kind: 'native' }, workspace: { attribution: 'unknown' },
      }),
      toolResult({ seq: 6, callId: 'native-1', outcome: 'denied', workspace: { attribution: 'unknown' } }),
      skillLoad({ seq: 7 }),
      skillLoad({ seq: 8, skillId: 'write', entry: 'skill-tool', outcome: 'error', errorCode: 'SKILL_FAILED', providerId: 'writer' }),
      toolCall({ seq: 9, callId: 'unknown-1', capabilityId: 'mystery', source: { kind: 'unknown', reason: 'owner-not-exposed' } }),
      toolResult({ seq: 10, callId: 'unknown-1', outcome: 'cancelled' }),
      toolCall({ seq: 11, callId: 'call-1', capabilityId: 'second-call-id' }), // duplicate call id
      toolCall({ seq: 12, callId: 'mapped', workspace: { workspaceId: 'ws-current', attribution: 'current-mapping' } }),
      toolResult({ seq: 13, callId: 'mapped', workspace: { workspaceId: 'ws-current', attribution: 'current-mapping' } }),
      toolCall({ seq: 14, sessionId: '' }), // invalid event
    ]
    const sequential = applySequentially(createUsageState(), events)
    const batched = applyUsageEvents(createUsageState(), events)

    expect(batched.results).toEqual(sequential.results)
    expect(batched.accepted).toBe(sequential.results.filter(result => result.accepted).length)
    expect(batched.rejected).toBe(events.length - batched.accepted)
    expect(batched.state.totalEvents).toBe(sequential.state.totalEvents)
    expect(batched.state.totalCalls).toBe(sequential.state.totalCalls)
    expect(batched.state.orphanResults).toBe(1)
    expect(batched.state.duplicateResults).toBe(1)
    expect([...batched.state.calls.keys()].sort()).toEqual([...sequential.state.calls.keys()].sort())
    expect(buildUsageReport(batched.state)).toEqual(buildUsageReport(sequential.state))
  })

  it('keeps limit and duplicate coverage identical within one batch', () => {
    const events: UsageEvent[] = [
      toolCall({ seq: 1, callId: 'c-1' }),
      toolResult({ seq: 2, callId: 'c-1' }),
      toolCall({ seq: 3, callId: 'c-2' }),
      toolCall({ seq: 4, callId: 'c-3' }),
      toolResult({ seq: 5, callId: 'c-3' }),
      skillLoad({ seq: 6 }),
      toolResult({ seq: 7, callId: 'c-2', outcome: 'error', errorCode: 'ERR' }),
    ]
    const limits = { maxEvents: 5, maxCalls: 2 }
    const sequential = applySequentially(createUsageState(limits), events)
    const batched = applyUsageEvents(createUsageState(limits), events)

    expect(batched.results).toEqual(sequential.results)
    expect(batched.results.map(result => result.reason)).toEqual([
      undefined, undefined, undefined, 'call-limit', 'call-limit', 'call-limit', 'call-limit',
    ])
    expect(buildUsageReport(batched.state)).toEqual(buildUsageReport(sequential.state))
    const coverage = buildUsageReport(batched.state).coverage['session-a']
    expect(coverage?.reasons).toContain('call-limit')
    expect(coverage?.reasons).not.toContain('event-limit')
    expect(coverage?.skippedEvents).toBe(4)
    expect(buildUsageReport(batched.state).limitsReached).toBe(true)
  })

  it('distinguishes duplicate events from limit-rejected events after a stop', () => {
    const events: UsageEvent[] = [
      toolCall({ seq: 1, callId: 'c-1' }),
      toolCall({ seq: 2, callId: 'c-2' }),
      toolCall({ seq: 3, callId: 'c-3' }), // event limit
      toolCall({ seq: 1, callId: 'c-1' }), // already-seen identity
      toolCall({ seq: 3, callId: 'c-3' }), // limit-rejected events are not marked seen
    ]
    const limits = { maxEvents: 2 }
    const sequential = applySequentially(createUsageState(limits), events)
    const batched = applyUsageEvents(createUsageState(limits), events)

    expect(batched.results.map(result => result.reason)).toEqual([
      undefined, undefined, 'event-limit', 'duplicate-event', 'event-limit',
    ])
    expect(batched.results).toEqual(sequential.results)
    expect(buildUsageReport(batched.state)).toEqual(buildUsageReport(sequential.state))
    expect(buildUsageReport(batched.state).coverage['session-a']?.skippedEvents).toBe(2)
  })

  it('does not mutate the input state and clones a shared aggregate at most once per batch', () => {
    let base = createUsageState()
    base = apply(base, toolCall({ seq: 1, callId: 'base-call' })).state
    base = apply(base, toolResult({ seq: 2, callId: 'base-call' })).state

    const snapshot = buildUsageReport(base)
    const baseAggregate = [...base.aggregates.values()][0]!
    const baseCoverage = base.coverage.get('session-a')!
    const baseSeen = new Set(base.seenEvents)

    const events: UsageEvent[] = Array.from({ length: 50 }, (_, index) => toolCall({
      seq: 100 + index,
      callId: `extra-${index}`,
    }))
    const batched = applyUsageEvents(base, events)

    expect(buildUsageReport(base)).toEqual(snapshot)
    expect(base.totalCalls).toBe(1)
    expect(base.totalEvents).toBe(2)
    expect(base.seenEvents).toEqual(baseSeen)
    expect(baseAggregate.calls).toBe(1)
    expect(baseAggregate.unresolved).toBe(0)
    expect(baseCoverage.status).toBe('complete')
    expect(baseCoverage.reasons).toEqual([])

    expect(batched.state).not.toBe(base)
    expect(batched.state.seenEvents).not.toBe(base.seenEvents)
    expect(batched.state.calls).not.toBe(base.calls)
    expect(batched.state.aggregates).not.toBe(base.aggregates)
    expect(batched.state.aggregates.get([...base.aggregates.keys()][0]!)).not.toBe(baseAggregate)
    expect(batched.state.totalCalls).toBe(51)
    expect(batched.state.totalEvents).toBe(52)
    expect(batched.state.aggregates.get([...base.aggregates.keys()][0]!)?.calls).toBe(51)
    expect(batched.state.aggregates.get([...base.aggregates.keys()][0]!)?.unresolved).toBe(50)
  })

  it('applies 20k events in one batch without per-event state copying', () => {
    const events: UsageEvent[] = []
    const firstTime = Date.UTC(2026, 10, 3, 12)
    for (let index = 0; index < 10_000; index += 1) {
      const seq = index * 2 + 1
      events.push(toolCall({
        seq,
        callId: `perf-${index}`,
        capabilityId: `cap-${index % 100}`,
        time: firstTime + index,
      }))
      events.push(toolResult({
        seq: seq + 1,
        callId: `perf-${index}`,
        time: firstTime + index + 1,
      }))
    }

    const started = performance.now()
    const batched = applyUsageEvents(createUsageState(), events)
    const elapsed = performance.now() - started

    expect(batched.state.totalEvents).toBe(20_000)
    expect(batched.rejected).toBe(0)
    expect(buildUsageReport(batched.state)).toMatchObject({
      calls: 10_000, succeeded: 10_000, failed: 0, unresolved: 0, orphanResults: 0, duplicateResults: 0,
    })

    // Deliberately generous: one boundary copy costs tens of milliseconds here, while
    // folding applyUsageEvent once per event copies the growing seen-events/calls maps
    // ~10^8 times and takes seconds on the same machine. The floor between the two is
    // wide, so this is a catastrophic-regression guard rather than a tight benchmark.
    expect(elapsed).toBeLessThan(2_000)
  })

  it('returns the same state reference for an empty batch and unchanged single events', () => {
    const state = createUsageState()
    expect(applyUsageEvents(state, [])).toEqual({ state, results: [], accepted: 0, rejected: 0 })
    const call = toolCall()
    const accepted = apply(state, call)
    expect(applyUsageEvent(accepted.state, call)).toEqual({
      state: accepted.state,
      accepted: false,
      reason: 'duplicate-event',
    })
  })
})
