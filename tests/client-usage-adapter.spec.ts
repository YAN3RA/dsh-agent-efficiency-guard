/**
 * Rules for the pure `usage` snapshot → panel adapter.
 *
 * These tests exercise the projection without React, a browser or a Host: the
 * fixtures are wire-shaped rows (the same fields `usage/getSnapshot` returns),
 * and the assertions check the aggregation, the day window, the honesty rules
 * around coverage/attribution, and the "unavailable is not zero" contract.
 */
import { describe, expect, it, vi } from 'vitest'
import {
  USAGE_ADAPTER_ERRORS,
  USAGE_MAX_COVERAGE_REASONS,
  USAGE_PANEL_RANGES,
  USAGE_UNAVAILABLE_MESSAGES,
  createUsagePanelApi,
  formatUsageDay,
  mapUsageSnapshot,
  mergedWorkspaceAttribution,
  parseUsageDay,
  toUsagePanelResult,
  usageDayWindow,
  type UsagePanelRemote,
} from '../src/client/usage-adapter.ts'
import { RemoteError } from '@deepseek-ai/dsh-typert-protocol'
import type { RemoteResult } from '@deepseek-ai/dsh-typert-protocol'
import type {
  UsageSnapshot,
  UsageSnapshotAggregate,
  UsageSnapshotAvailable,
  UsageSnapshotCoverage,
  UsageSnapshotReport,
} from '../src/client/usage-remote.ts'
import type { UsageQuery } from '../src/client/usage.tsx'

/** 2026-11-04T20:00:00Z — “today” for every assertion below. */
const NOW = Date.UTC(2026, 10, 4, 20, 0)
const QUERY: UsageQuery = { days: 7 }

function row(overrides: Partial<UsageSnapshotAggregate> = {}): UsageSnapshotAggregate {
  return {
    sessionId: 'session-1',
    date: '2026-11-04',
    workspaceId: 'ws-a',
    workspaceAttribution: 'current-mapping',
    capabilityId: 'mcp__github__search',
    capabilityKind: 'mcp',
    providerId: 'github',
    calls: 1,
    succeeded: 1,
    failed: 0,
    denied: 0,
    cancelled: 0,
    unresolved: 0,
    lastUsedAt: NOW - 3_600_000,
    firstObservedAt: NOW - 7_200_000,
    errors: {},
    ...overrides,
  }
}

function coverage(overrides: Partial<UsageSnapshotCoverage> = {}): UsageSnapshotCoverage {
  return {
    status: 'complete',
    skippedSessions: 0,
    skippedEvents: 0,
    reasons: [],
    reasonsTruncated: false,
    ...overrides,
  }
}

function available(
  rows: readonly UsageSnapshotAggregate[],
  report: Partial<UsageSnapshotReport> = {},
): UsageSnapshotAvailable {
  return {
    available: true,
    metadata: {
      mode: 'memory',
      profile: { status: 'known', name: 'desktop' },
      workspaceRegistry: true,
      capability: true,
      feed: 'session/event',
    },
    stats: {
      received: 0,
      delivered: 0,
      accepted: 0,
      duplicates: 0,
      invalid: 0,
      dropped: 0,
      batches: 0,
      reasons: {},
    },
    report: {
      aggregates: rows,
      calls: 0,
      succeeded: 0,
      failed: 0,
      denied: 0,
      cancelled: 0,
      unresolved: 0,
      coverage: {},
      orphanResults: 0,
      duplicateResults: 0,
      limitsReached: false,
      ...report,
    },
  }
}

describe('usage day window', () => {
  it('covers today plus the previous days-1 UTC dates', () => {
    expect(usageDayWindow(7, NOW)).toEqual({
      days: 7,
      startDay: parseUsageDay('2026-10-29')!,
      endDay: parseUsageDay('2026-11-04')!,
      startDate: '2026-10-29',
      endDate: '2026-11-04',
    })
    expect(usageDayWindow(15, NOW).startDate).toBe('2026-10-21')
    expect(usageDayWindow(30, NOW).startDate).toBe('2026-10-06')
  })

  it('falls back to 7 days for an out-of-contract value and a bad clock', () => {
    expect(usageDayWindow(9 as 7, NOW).days).toBe(7)
    expect(usageDayWindow(7, Number.NaN)).toMatchObject({
      startDate: '1969-12-26',
      endDate: '1970-01-01',
    })
  })

  it('parses strict YYYY-MM-DD dates only and round-trips the day index', () => {
    expect(parseUsageDay('2026-11-04')).toBe(Date.UTC(2026, 10, 4) / 86_400_000)
    expect(formatUsageDay(parseUsageDay('2026-02-28')!)).toBe('2026-02-28')
    for (const invalid of ['2026-02-31', '2026-13-01', '2026-1-4', '20261104', '', 'x']) {
      expect(parseUsageDay(invalid), invalid).toBeUndefined()
    }
  })

  it('keeps rows inside the 7-day window and drops older or future ones', () => {
    const snapshot = available([
      row({ date: '2026-11-04', calls: 3 }),
      row({ date: '2026-10-29', calls: 2 }),
      row({ date: '2026-10-28', calls: 100 }),
      row({ date: '2026-11-05', calls: 200 }),
    ])
    const mapped = mapUsageSnapshot(snapshot, QUERY, NOW)
    expect(mapped.totals?.calls).toBe(5)
    // The wider window is what makes the older row visible again.
    expect(mapUsageSnapshot(snapshot, { days: 30 }, NOW).totals?.calls).toBe(105)
  })
})

describe('capability aggregation', () => {
  it('merges the same capabilityId + kind + providerId across sessions and days', () => {
    const mapped = mapUsageSnapshot(available([
      row({ sessionId: 's1', date: '2026-11-03', calls: 2, succeeded: 2, lastUsedAt: NOW - 10_000 }),
      row({ sessionId: 's2', date: '2026-11-04', calls: 1, succeeded: 0, failed: 1, lastUsedAt: NOW - 5_000 }),
    ]), QUERY, NOW)

    expect(mapped.capabilities).toHaveLength(1)
    const capability = mapped.capabilities![0]
    expect(capability.name).toBe('mcp__github__search')
    // The id is a composite key so two kinds/providers of the same id stay apart.
    expect(capability.id).not.toBe(capability.name)
    expect(capability.id).toContain('mcp__github__search')
    expect(capability.kind).toBe('mcp')
    expect(capability.source).toBe('github')
    expect(capability.calls).toBe(3)
    expect(capability.succeeded).toBe(2)
    expect(capability.failed).toBe(1)
    expect(capability.lastUsedAt).toBe(NOW - 5_000)
    // Exposure tier is not on the wire: report unknown, never invent `resident`.
    expect(capability.status).toBe('unknown')
    expect(capability.suggestion).toBeUndefined()
  })

  it('keeps different providers or kinds of the same id as separate rows', () => {
    const mapped = mapUsageSnapshot(available([
      row({ providerId: 'github' }),
      row({ providerId: 'github-enterprise' }),
      row({ capabilityKind: 'skill', capabilityId: 'mcp__github__search', providerId: undefined }),
    ]), QUERY, NOW)

    expect(mapped.capabilities).toHaveLength(3)
    expect(new Set(mapped.capabilities!.map(capability => capability.id)).size).toBe(3)
    // Rows without a provider report no invented source; unknown kind rows do
    // not borrow a server name.
    expect(mapped.capabilities!.find(capability => capability.kind === 'skill')?.source).toBeUndefined()
  })

  it('sums the outcome counters and derives the per-kind totals', () => {
    const mapped = mapUsageSnapshot(available([
      row({ calls: 5, succeeded: 3, failed: 1, denied: 1, cancelled: 0, unresolved: 0 }),
      row({ sessionId: 's2', capabilityId: 'mcp__dbx__query', providerId: 'dbx', calls: 2, succeeded: 2 }),
      row({ capabilityId: 'artifact_tool', capabilityKind: 'skill', providerId: undefined, calls: 4, succeeded: 4 }),
      row({ capabilityId: 'run_code', capabilityKind: 'plugin-tool', providerId: 'demo-plugin', calls: 1 }),
      row({ capabilityId: 'bash', capabilityKind: 'native', providerId: undefined, calls: 3 }),
      row({ capabilityId: 'mystery', capabilityKind: 'unknown', providerId: undefined, calls: 2, unresolved: 2 }),
    ]), QUERY, NOW)

    expect(mapped.totals).toMatchObject({
      calls: 17,
      succeeded: 12,
      failed: 1,
      denied: 1,
      cancelled: 0,
      unresolved: 2,
      distinctCapabilities: 6,
      mcpCalls: 7,
      activeMcpServers: 2,
      skillCalls: 4,
      pluginToolCalls: 1,
      nativeCalls: 3,
      unknownCalls: 2,
    })
    // No capability catalog in the snapshot → the 30-day idle metric stays unset.
    expect(mapped.totals?.idleCandidates).toBeUndefined()
  })

  it('reports an observation window from the rows and the mapping time', () => {
    const mapped = mapUsageSnapshot(available([
      row({ firstObservedAt: NOW - 90_000, lastUsedAt: NOW - 1_000 }),
      row({ sessionId: 's2', firstObservedAt: NOW - 50_000, lastUsedAt: NOW - 20_000 }),
    ]), QUERY, NOW)
    expect(mapped.generatedAt).toBe(NOW)
    expect(mapped.coverage?.from).toBe(NOW - 90_000)
    expect(mapped.coverage?.through).toBe(NOW - 1_000)
  })

  it('does not mutate the snapshot it maps', () => {
    const source = available([
      row({ calls: 2, lastUsedAt: NOW - 1_000 }),
      row({ sessionId: 's2', calls: 1, lastUsedAt: NOW - 9_000 }),
    ])
    const before = JSON.parse(JSON.stringify(source))
    mapUsageSnapshot(source, QUERY, NOW)
    expect(JSON.parse(JSON.stringify(source))).toEqual(before)
  })
})

describe('coverage', () => {
  it('treats a snapshot without coverage as unknown, not complete', () => {
    const mapped = mapUsageSnapshot(available([row()], { coverage: {} }), QUERY, NOW)
    expect(mapped.coverage?.status).toBe('unknown')
  })

  it('keeps partial coverage and merges per-session reasons, skips and bounds', () => {
    const reasons = Array.from({ length: USAGE_MAX_COVERAGE_REASONS + 2 }, (_, index) => `reason-${index}`)
    const mapped = mapUsageSnapshot(available([row()], {
      coverage: {
        'session-1': coverage({
          status: 'partial',
          skippedSessions: 2,
          skippedEvents: 7,
          reasons: ['history-missing', ...reasons],
          reasonsTruncated: true,
        }),
        'session-2': coverage({
          status: 'partial',
          skippedEvents: 1,
          reasons: ['history-missing', 'page-limit'],
        }),
      },
    }), QUERY, NOW)

    const merged = mapped.coverage!
    expect(merged.status).toBe('partial')
    expect(merged.skippedSessions).toBe(2)
    expect(merged.skippedEvents).toBe(8)
    // Union, not concatenation: a reason shared by two sessions appears once.
    expect(merged.reasons).toEqual(['history-missing', ...reasons.slice(0, USAGE_MAX_COVERAGE_REASONS - 1)])
    expect(merged.reasonsTruncated).toBe(true)
  })

  it('degrades to unknown when any session is unknown', () => {
    const mapped = mapUsageSnapshot(available([row()], {
      coverage: {
        'session-1': coverage({ status: 'complete' }),
        'session-2': coverage({ status: 'unknown', reasons: ['session-not-readable'] }),
      },
    }), QUERY, NOW)
    expect(mapped.coverage?.status).toBe('unknown')
  })

  it('never claims event-time attribution once rows are merged', () => {
    const eventTimeSnapshot = available([
      row({ workspaceAttribution: 'event-time' }),
      row({ sessionId: 's2', workspaceAttribution: 'event-time' }),
    ])
    const mapped = mapUsageSnapshot(eventTimeSnapshot, QUERY, NOW)
    expect(mapped.coverage?.workspaceAttribution).toBe('current-mapping')

    expect(mergedWorkspaceAttribution([row({ workspaceAttribution: 'current-mapping' })])).toBe('current-mapping')
    expect(mergedWorkspaceAttribution([
      row({ workspaceAttribution: 'current-mapping' }),
      row({ sessionId: 's2', workspaceAttribution: 'unknown' }),
    ])).toBe('unknown')
    expect(mergedWorkspaceAttribution([])).toBe('unknown')
  })

  it('downgrades complete coverage when rows were dropped or the Host hit its cap', () => {
    const dropped = mapUsageSnapshot(available([
      row(),
      row({ date: '2026-11-03' }),
      row({ date: 'not-a-date' }),
    ], { coverage: { 'session-1': coverage() } }), QUERY, NOW)
    expect(dropped.coverage?.status).toBe('partial')
    expect(dropped.notes?.some(note => note.includes('1 条聚合行的日期无法解析'))).toBe(true)
    expect(dropped.totals?.calls).toBe(2)

    const capped = mapUsageSnapshot(available([row()], {
      coverage: { 'session-1': coverage() },
      limitsReached: true,
    }), QUERY, NOW)
    expect(capped.coverage?.status).toBe('partial')
    expect(capped.notes?.some(note => note.includes('上限'))).toBe(true)
  })

  it('reports orphan and duplicate results without counting them as success', () => {
    const mapped = mapUsageSnapshot(available([row()], {
      coverage: { 'session-1': coverage() },
      orphanResults: 2,
      duplicateResults: 3,
    }), QUERY, NOW)
    expect(mapped.totals?.succeeded).toBe(1)
    expect(mapped.notes?.some(note => note.includes('2 条调用结果未配对'))).toBe(true)
    expect(mapped.notes?.some(note => note.includes('3 条重复调用结果'))).toBe(true)
  })
})

describe('unavailable snapshots', () => {
  it('maps { available: false } to an explicit error, never to zero totals', () => {
    for (const reason of ['service-absent', 'snapshot-unavailable', 'snapshot-invalid'] as const) {
      const result = toUsagePanelResult({ available: false, reason }, QUERY, NOW)
      expect(result.ok).toBe(false)
      if (result.ok) throw new Error('unreachable')
      expect(result.error.code).toBe(reason)
      expect(result.error.message).toBe(USAGE_UNAVAILABLE_MESSAGES[reason])
      // No `value` at all: the panel shows the reason and keeps showing nothing.
      expect('value' in result).toBe(false)
      expect(result.error.message).toContain('0')
    }
  })

  it('rejects structurally invalid payloads instead of guessing', () => {
    for (const invalid of [null, undefined, {}, 'snapshot', { available: 'yes' }, { available: true }, { available: true, report: null }]) {
      const result = toUsagePanelResult(invalid, QUERY, NOW)
      expect(result.ok, JSON.stringify(invalid)).toBe(false)
      if (result.ok) throw new Error('unreachable')
      expect(result.error.code).toBe(USAGE_ADAPTER_ERRORS.invalidSnapshot)
    }
  })

  it('surfaces an unavailable answer through the panel api as an error', async () => {
    const remote: UsagePanelRemote = {
      getSnapshot: async () => ({ ok: true, value: { available: false, reason: 'service-absent' } }),
      refresh: async () => ({ ok: true, value: { available: false, reason: 'service-absent' } }),
    }
    const api = createUsagePanelApi(remote, { now: () => NOW })
    const result = await api.getSnapshot(QUERY)
    expect(result.ok).toBe(false)
    if (result.ok) throw new Error('unreachable')
    expect(result.error.code).toBe('service-absent')
  })
})

describe('panel api', () => {
  it('maps a readable snapshot for the requested window', async () => {
    const getSnapshot = vi.fn(async () => ({
      ok: true as const,
      value: available([row({ date: '2026-11-04', calls: 2 }), row({ date: '2026-11-03', calls: 1 })]),
    }))
    const refresh = vi.fn(async () => ({ ok: true as const, value: available([]) }))
    const api = createUsagePanelApi({ getSnapshot, refresh }, { now: () => NOW })

    const result = await api.getSnapshot({ days: 7 })
    expect(getSnapshot).toHaveBeenCalledTimes(1)
    expect(refresh).not.toHaveBeenCalled()
    expect(result.ok).toBe(true)
    if (!result.ok) throw new Error('unreachable')
    expect(result.value.totals?.calls).toBe(3)
    expect(result.value.generatedAt).toBe(NOW)
  })

  it('can read through refresh()', async () => {
    const getSnapshot = vi.fn(async () => ({ ok: true as const, value: available([row({ calls: 1 })]) }))
    const refresh = vi.fn(async () => ({ ok: true as const, value: available([row({ calls: 4 })]) }))
    const api = createUsagePanelApi({ getSnapshot, refresh }, { now: () => NOW, method: 'refresh' })
    const result = await api.getSnapshot(QUERY)
    expect(refresh).toHaveBeenCalledTimes(1)
    expect(getSnapshot).not.toHaveBeenCalled()
    if (!result.ok) throw new Error('unreachable')
    expect(result.value.totals?.calls).toBe(4)
  })

  it('resolves the remote lazily and reports an unmounted namespace as an error', async () => {
    let face: UsagePanelRemote | undefined
    const api = createUsagePanelApi(() => face, { now: () => NOW })
    const unmounted = await api.getSnapshot(QUERY)
    expect(unmounted.ok).toBe(false)
    if (unmounted.ok) throw new Error('unreachable')
    expect(unmounted.error.code).toBe(USAGE_ADAPTER_ERRORS.remoteUnmounted)

    face = { getSnapshot: async () => ({ ok: true as const, value: available([row()]) }), refresh: async () => ({ ok: true as const, value: available([]) }) }
    const mounted = await api.getSnapshot(QUERY)
    expect(mounted.ok).toBe(true)
    if (!mounted.ok) throw new Error('unreachable')
    expect(mounted.value.totals?.calls).toBe(1)
  })

  it('folds a thrown call and a Remote error branch into the same envelope', async () => {
    const throwing = createUsagePanelApi({
      getSnapshot: async () => { throw new Error('carrier lost') },
      refresh: async () => { throw new Error('carrier lost') },
    }, { now: () => NOW })
    const thrown = await throwing.getSnapshot(QUERY)
    expect(thrown.ok).toBe(false)
    if (thrown.ok) throw new Error('unreachable')
    expect(thrown.error.code).toBe(USAGE_ADAPTER_ERRORS.transport)
    expect(thrown.error.message).toContain('carrier lost')

    // The real Remote face answers `RemoteResult` with a `RemoteError` in the
    // error branch; the adapter passes its stable code and message through.
    const failure: RemoteResult<UsageSnapshot> = {
      ok: false,
      error: new RemoteError('gateway/internal', 'connection reset', {}),
    }
    const failed = createUsagePanelApi({
      getSnapshot: async () => failure,
      refresh: async () => failure,
    }, { now: () => NOW })
    const errorBranch = await failed.getSnapshot(QUERY)
    expect(errorBranch.ok).toBe(false)
    if (errorBranch.ok) throw new Error('unreachable')
    expect(errorBranch.error).toEqual({ code: 'gateway/internal', message: 'connection reset' })
  })
})

describe('filters', () => {
  const snapshot = available([
    row({ workspaceId: 'ws-a', calls: 2 }),
    row({ sessionId: 's2', workspaceId: 'ws-b', capabilityId: 'mcp__dbx__query', providerId: 'dbx', calls: 5 }),
    row({
      sessionId: 's3',
      workspaceId: undefined,
      workspaceAttribution: 'unknown',
      capabilityId: 'artifact_tool',
      capabilityKind: 'skill',
      providerId: undefined,
      calls: 3,
    }),
    // Outside the 7-day window but still a legitimate filter option.
    row({ sessionId: 's4', date: '2026-09-01', workspaceId: 'ws-old', calls: 9 }),
  ])

  it('derives ranges, workspaces and kinds from the snapshot rows', () => {
    const mapped = mapUsageSnapshot(snapshot, QUERY, NOW)
    expect(mapped.filters?.ranges).toEqual([...USAGE_PANEL_RANGES])
    expect(mapped.filters?.workspaces).toEqual([
      { id: 'ws-a', label: 'ws-a' },
      { id: 'ws-b', label: 'ws-b' },
      { id: 'ws-old', label: 'ws-old' },
    ])
    expect(mapped.filters?.kinds).toEqual(['mcp', 'skill'])
  })

  it('filters by workspace without letting unattributed rows leak in', () => {
    const mapped = mapUsageSnapshot(snapshot, { days: 7, workspaceId: 'ws-b' }, NOW)
    expect(mapped.totals?.calls).toBe(5)
    expect(mapped.capabilities?.map(capability => capability.name)).toEqual(['mcp__dbx__query'])
    // Options still describe the whole snapshot, not just the filtered subset.
    expect(mapped.filters?.workspaces).toHaveLength(3)
    expect(mapped.notes).toContain('工作区与类型筛选在本机快照上完成，不额外请求 Host。')
  })

  it('filters by kind and reports only that kind’s totals', () => {
    const mapped = mapUsageSnapshot(snapshot, { days: 7, kind: 'skill' }, NOW)
    expect(mapped.totals).toMatchObject({ calls: 3, skillCalls: 3, mcpCalls: 0, distinctCapabilities: 1 })
    expect(mapped.capabilities?.map(capability => capability.name)).toEqual(['artifact_tool'])
  })

  it('applies workspace and kind together', () => {
    const mapped = mapUsageSnapshot(snapshot, { days: 7, workspaceId: 'ws-a', kind: 'skill' }, NOW)
    expect(mapped.totals?.calls).toBe(0)
    expect(mapped.capabilities).toEqual([])
    // Coverage still describes the observation window, not the filtered subset.
    expect(mapped.coverage?.status).toBe('unknown')
  })
})
