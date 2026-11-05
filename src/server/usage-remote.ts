/**
 * Host-side Typert gateway for the read-only `usage` Remote namespace.
 *
 * It is deliberately separate from `src/server/remote.ts` (the capability
 * management face): usage observation is a distinct, optional service with its
 * own lifecycle, and the browser must be able to ask for a snapshot without
 * depending on the capability registry being mounted.
 *
 * What it does — one thing only: resolve the optional runtime service, take its
 * synchronous `snapshot()`, and project it into the bounded JSON-safe
 * {@link UsageSnapshot} contract declared in `src/usage/usage-host-face.ts`.
 * Nothing here writes, refreshes, or mutates Host state, so `getSnapshot` and
 * `refresh` differ in *why* the browser calls them, not in what they do: the
 * runtime reads its in-memory collector state synchronously, so a "refresh" is a
 * plain re-read. A cached copy is never returned — a snapshot is built per call,
 * which is also what makes the two endpoints independently testable.
 *
 * What it never does:
 *
 * - never returns a raw Session, event, tool argument, or tool result. The
 *   projection copies a fixed allowlist of fields, so junk hung off the runtime
 *   snapshot (an `events` array, extra keys on a row) cannot reach the wire;
 * - never declares a static `inject` for the runtime. The service is optional,
 *   and a static requirement would unmount the gateway — turning "usage is not
 *   installed" into a 404. It is probed with `ctx.get('usageRuntime')`, the same
 *   untracked lookup `src/usage/usage-runtime.ts` uses for its own optional
 *   siblings;
 * - never trims strings that the core already bounds (`maxErrorCodeLength`,
 *   `maxCoverageReasons`) and never fails a whole panel over one malformed row.
 *
 * Activation: the package root mounts {@link UsageGateway} (`ctx.plugin(...)`)
 * and claims the namespace with `registerUsageHostFace`; the browser contributes
 * `USAGE_TYPERT_REMOTE` from `src/client/usage-remote.ts`. Both are exported
 * here / there so the root entry does not have to know the wire details.
 *
 * @module dsh-agent-efficiency-guard/server/usage-remote
 */
import type { Context } from '@deepseek-ai/cordis'
import { TypertRemoteService, Remote } from '@deepseek-ai/dsh-typert-protocol'
import {
  USAGE_HOST_FACE_NAMESPACE,
  USAGE_HOST_FACE_SERVICE,
  USAGE_RUNTIME_SERVICE,
  USAGE_SNAPSHOT_AGGREGATE_LIMIT,
  USAGE_SNAPSHOT_COVERAGE_LIMIT,
  USAGE_SNAPSHOT_ERROR_COUNT_LIMIT,
  isUsageRecord,
  type UsageRuntimeSnapshotSource,
  type UsageSnapshot,
  type UsageSnapshotAggregate,
  type UsageSnapshotCapabilityKind,
  type UsageSnapshotCoverage,
  type UsageSnapshotCoverageStatus,
  type UsageSnapshotMetadata,
  type UsageSnapshotReport,
  type UsageSnapshotStats,
  type UsageSnapshotUnavailable,
  type UsageSnapshotUnavailableReason,
  type UsageSnapshotWorkspaceAttribution,
} from '../usage/usage-host-face.ts'

type UnknownRecord = { readonly [key: string]: unknown }

const CAPABILITY_KINDS: ReadonlySet<string> = new Set<UsageSnapshotCapabilityKind>([
  'mcp', 'plugin-tool', 'native', 'skill', 'unknown',
])

const WORKSPACE_ATTRIBUTIONS: ReadonlySet<string> = new Set<UsageSnapshotWorkspaceAttribution>([
  'event-time', 'current-mapping', 'unknown',
])

const COVERAGE_STATUSES: ReadonlySet<string> = new Set<UsageSnapshotCoverageStatus>([
  'complete', 'partial', 'unknown',
])

/** Build the "no snapshot" answer. Every field is a stable literal, never free text. */
export function unavailableSnapshot(reason: UsageSnapshotUnavailableReason): UsageSnapshotUnavailable {
  return { available: false, reason }
}

/**
 * Read one field without letting a hostile getter escape. A throw makes the
 * field absent, exactly like a missing one.
 */
function readField(value: UnknownRecord, key: string): unknown {
  try {
    return value[key]
  } catch {
    return undefined
  }
}

/** A finite, non-negative integer counter, or `undefined` when the value is not one. */
function readCounter(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : undefined
}

/** An optional absolute timestamp (`undefined` is meaningful for `lastUsedAt`). */
function readTimestamp(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined
}

/** A required non-empty string. */
function readText(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim().length > 0 ? value : undefined
}

/** An optional non-empty string, dropped when blank rather than sent as `''`. */
function readOptionalText(value: unknown): string | undefined {
  return readText(value)
}

/** Project a bounded counter map (`Map` or plain object) into a JSON object. */
function projectCounts(value: unknown, limit = Number.POSITIVE_INFINITY): Readonly<Record<string, number>> | undefined {
  const rows = value instanceof Map ? [...value.entries()] : isUsageRecord(value) ? Object.entries(value) : undefined
  if (rows === undefined) return undefined
  const counts: Record<string, number> = Object.create(null) as Record<string, number>
  let kept = 0
  for (const [key, count] of rows) {
    if (typeof key !== 'string' || key.length === 0) continue
    const normalized = readCounter(count)
    if (normalized === undefined) continue
    if (kept >= limit) break
    counts[key] = normalized
    kept += 1
  }
  return counts
}

/** Project one aggregate row, or `undefined` when the row cannot be trusted. */
function projectAggregate(value: unknown): UsageSnapshotAggregate | undefined {
  if (!isUsageRecord(value)) return undefined
  const sessionId = readText(readField(value, 'sessionId'))
  const date = readText(readField(value, 'date'))
  const capabilityId = readText(readField(value, 'capabilityId'))
  const capabilityKind = readField(value, 'capabilityKind')
  const workspaceAttribution = readField(value, 'workspaceAttribution')
  const calls = readCounter(readField(value, 'calls'))
  const succeeded = readCounter(readField(value, 'succeeded'))
  const failed = readCounter(readField(value, 'failed'))
  const denied = readCounter(readField(value, 'denied'))
  const cancelled = readCounter(readField(value, 'cancelled'))
  const unresolved = readCounter(readField(value, 'unresolved'))
  const firstObservedAt = readTimestamp(readField(value, 'firstObservedAt'))
  const errors = projectCounts(readField(value, 'errors'), USAGE_SNAPSHOT_ERROR_COUNT_LIMIT)
  if (
    sessionId === undefined || date === undefined || capabilityId === undefined
    || typeof capabilityKind !== 'string' || !CAPABILITY_KINDS.has(capabilityKind)
    || typeof workspaceAttribution !== 'string' || !WORKSPACE_ATTRIBUTIONS.has(workspaceAttribution)
    || calls === undefined || succeeded === undefined || failed === undefined
    || denied === undefined || cancelled === undefined || unresolved === undefined
    || firstObservedAt === undefined || errors === undefined
  ) return undefined
  const workspaceId = readOptionalText(readField(value, 'workspaceId'))
  const providerId = readOptionalText(readField(value, 'providerId'))
  const lastUsedAt = readTimestamp(readField(value, 'lastUsedAt'))
  return {
    sessionId,
    date,
    ...(workspaceId === undefined ? {} : { workspaceId }),
    workspaceAttribution: workspaceAttribution as UsageSnapshotWorkspaceAttribution,
    capabilityId,
    capabilityKind: capabilityKind as UsageSnapshotCapabilityKind,
    ...(providerId === undefined ? {} : { providerId }),
    calls,
    succeeded,
    failed,
    denied,
    cancelled,
    unresolved,
    ...(lastUsedAt === undefined ? {} : { lastUsedAt }),
    firstObservedAt,
    errors,
  }
}

/** Project one coverage record, or `undefined` when it cannot be trusted. */
function projectCoverage(value: unknown): UsageSnapshotCoverage | undefined {
  if (!isUsageRecord(value)) return undefined
  const status = readField(value, 'status')
  const skippedSessions = readCounter(readField(value, 'skippedSessions'))
  const skippedEvents = readCounter(readField(value, 'skippedEvents'))
  const rawReasons = readField(value, 'reasons')
  const reasonsTruncated = readField(value, 'reasonsTruncated')
  if (
    typeof status !== 'string' || !COVERAGE_STATUSES.has(status)
    || skippedSessions === undefined || skippedEvents === undefined
    || !Array.isArray(rawReasons) || typeof reasonsTruncated !== 'boolean'
  ) return undefined
  const reasons = rawReasons.filter((reason): reason is string => typeof reason === 'string')
  const fromSeq = readCounter(readField(value, 'fromSeq'))
  const throughSeq = readCounter(readField(value, 'throughSeq'))
  return {
    status: status as UsageSnapshotCoverageStatus,
    ...(fromSeq === undefined ? {} : { fromSeq }),
    ...(throughSeq === undefined ? {} : { throughSeq }),
    skippedSessions,
    skippedEvents,
    reasons,
    reasonsTruncated,
  }
}

/**
 * Project `coverage` into a capped object.
 *
 * The collector already bounds this by Session count; the cap is the last line
 * of defence against an unexpected Host, and insertion order is preserved so
 * the result stays deterministic for a given state.
 */
function projectCoverageMap(value: unknown): Readonly<Record<string, UsageSnapshotCoverage>> | undefined {
  const rows = value instanceof Map ? [...value.entries()] : isUsageRecord(value) ? Object.entries(value) : undefined
  if (rows === undefined) return undefined
  const coverage: Record<string, UsageSnapshotCoverage> = Object.create(null) as Record<string, UsageSnapshotCoverage>
  let kept = 0
  for (const [sessionId, raw] of rows) {
    if (kept >= USAGE_SNAPSHOT_COVERAGE_LIMIT) break
    if (typeof sessionId !== 'string' || sessionId.length === 0) continue
    const row = projectCoverage(raw)
    if (row === undefined) continue
    coverage[sessionId] = row
    kept += 1
  }
  return coverage
}

/** Project the already-aggregated report; never an event, call, or argument. */
export function projectUsageReport(value: unknown): UsageSnapshotReport | undefined {
  if (!isUsageRecord(value)) return undefined
  const rawAggregates = readField(value, 'aggregates')
  const rawCoverage = readField(value, 'coverage')
  const coverage = projectCoverageMap(rawCoverage)
  const coverageRows = rawCoverage instanceof Map
    ? rawCoverage.size
    : isUsageRecord(rawCoverage) ? Object.keys(rawCoverage).length : 0
  const coverageTruncated = coverageRows > USAGE_SNAPSHOT_COVERAGE_LIMIT
  const calls = readCounter(readField(value, 'calls'))
  const succeeded = readCounter(readField(value, 'succeeded'))
  const failed = readCounter(readField(value, 'failed'))
  const denied = readCounter(readField(value, 'denied'))
  const cancelled = readCounter(readField(value, 'cancelled'))
  const unresolved = readCounter(readField(value, 'unresolved'))
  const orphanResults = readCounter(readField(value, 'orphanResults'))
  const duplicateResults = readCounter(readField(value, 'duplicateResults'))
  const limitsReached = readField(value, 'limitsReached')
  if (
    !Array.isArray(rawAggregates) || coverage === undefined
    || calls === undefined || succeeded === undefined || failed === undefined
    || denied === undefined || cancelled === undefined || unresolved === undefined
    || orphanResults === undefined || duplicateResults === undefined
    || typeof limitsReached !== 'boolean'
  ) return undefined
  const aggregates: UsageSnapshotAggregate[] = []
  let keptRows = 0
  let droppedRows = 0
  let errorCountsTruncated = false
  for (const raw of rawAggregates) {
    const rawErrors = isUsageRecord(raw) ? readField(raw, 'errors') : undefined
    const errorCount = rawErrors instanceof Map
      ? rawErrors.size
      : isUsageRecord(rawErrors) ? Object.keys(rawErrors).length : 0
    if (errorCount > USAGE_SNAPSHOT_ERROR_COUNT_LIMIT) errorCountsTruncated = true
    const row = projectAggregate(raw)
    if (row === undefined) {
      droppedRows += 1
      continue
    }
    if (keptRows >= USAGE_SNAPSHOT_AGGREGATE_LIMIT) {
      droppedRows += 1
      continue
    }
    aggregates.push(row)
    keptRows += 1
  }
  return {
    aggregates,
    calls,
    succeeded,
    failed,
    denied,
    cancelled,
    unresolved,
    coverage,
    orphanResults,
    duplicateResults,
    limitsReached: limitsReached || droppedRows > 0 || coverageTruncated || errorCountsTruncated,
  }
}

/** Project install-time metadata; an unrecognized shape fails the snapshot. */
function projectMetadata(value: unknown): UsageSnapshotMetadata | undefined {
  if (!isUsageRecord(value)) return undefined
  const profile = readField(value, 'profile')
  const workspaceRegistry = readField(value, 'workspaceRegistry')
  const capability = readField(value, 'capability')
  const feed = readField(value, 'feed')
  if (readField(value, 'mode') !== 'memory' || feed !== 'session/event'
    || typeof workspaceRegistry !== 'boolean' || typeof capability !== 'boolean'
    || !isUsageRecord(profile)) return undefined
  const status = readField(profile, 'status')
  let projectedProfile: UsageSnapshotMetadata['profile']
  if (status === 'known') {
    const name = readText(readField(profile, 'name'))
    if (name === undefined) return undefined
    projectedProfile = { status: 'known', name }
  } else if (status === 'unknown') {
    const reason = readText(readField(profile, 'reason'))
    if (readField(profile, 'label') !== 'profile unknown' || reason === undefined) return undefined
    projectedProfile = { status: 'unknown', label: 'profile unknown', reason }
  } else return undefined
  return {
    mode: 'memory',
    profile: projectedProfile,
    workspaceRegistry,
    capability,
    feed: 'session/event',
  }
}

/** Project the adapter counters; every field is already a bounded integer/code. */
function projectStats(value: unknown): UsageSnapshotStats | undefined {
  if (!isUsageRecord(value)) return undefined
  const received = readCounter(readField(value, 'received'))
  const delivered = readCounter(readField(value, 'delivered'))
  const accepted = readCounter(readField(value, 'accepted'))
  const duplicates = readCounter(readField(value, 'duplicates'))
  const invalid = readCounter(readField(value, 'invalid'))
  const dropped = readCounter(readField(value, 'dropped'))
  const batches = readCounter(readField(value, 'batches'))
  const reasons = projectCounts(readField(value, 'reasons'))
  if (
    received === undefined || delivered === undefined || accepted === undefined
    || duplicates === undefined || invalid === undefined || dropped === undefined
    || batches === undefined || reasons === undefined
  ) return undefined
  return { received, delivered, accepted, duplicates, invalid, dropped, batches, reasons }
}

/**
 * Project an unknown `snapshot()` return value into the wire contract.
 *
 * Exported for tests and for any future Host-side consumer that wants the same
 * bounded view without going through Remote. Structural failures answer
 * `snapshot-invalid` (an honest "the runtime is broken" state) instead of
 * throwing into the gateway, where it would surface as a transport failure.
 */
export function projectUsageSnapshot(value: unknown): UsageSnapshot {
  if (!isUsageRecord(value)) return unavailableSnapshot('snapshot-invalid')
  const metadata = projectMetadata(readField(value, 'metadata'))
  const stats = projectStats(readField(value, 'stats'))
  const report = projectUsageReport(readField(value, 'report'))
  if (metadata === undefined || stats === undefined || report === undefined) {
    return unavailableSnapshot('snapshot-invalid')
  }
  return { available: true, metadata, stats, report }
}

/** Result of probing the optional runtime service. */
type UsageRuntimeLookup =
  | { readonly status: 'absent' }
  | { readonly status: 'unreadable' }
  | { readonly status: 'ready'; readonly runtime: UsageRuntimeSnapshotSource }

/**
 * Probe the optional runtime service without declaring a dependency.
 *
 * `ctx.get` is untracked: calling it neither creates an inject edge nor throws
 * on a Host that never installed the runtime. A duck-typed `get` is read first
 * so the probe also works for the lightweight contexts used in tests.
 */
function lookupUsageRuntime(ctx: Context): UsageRuntimeLookup {
  const get = (ctx as unknown as { get?: (name: string) => unknown }).get
  if (typeof get !== 'function') return { status: 'absent' }
  let service: unknown
  try {
    service = get.call(ctx, USAGE_RUNTIME_SERVICE)
  } catch {
    return { status: 'absent' }
  }
  if (service === undefined || service === null) return { status: 'absent' }
  if (!isUsageRecord(service)) return { status: 'unreadable' }
  // A service that is present but does not expose the agreed read method has
  // simply no snapshot to give; that is different from "not installed".
  if (typeof readField(service, 'snapshot') !== 'function') return { status: 'unreadable' }
  return { status: 'ready', runtime: service as unknown as UsageRuntimeSnapshotSource }
}

/**
 * Take the current snapshot and project it.
 *
 * Every Host-side failure is mapped to a stable, panel-explainable state:
 * service absent → `service-absent`, `snapshot()` throws or returns nothing →
 * `snapshot-unavailable`, unreadable payload → `snapshot-invalid`. None of them
 * is an exception, so a browser poll never turns into an error toast.
 */
export function readUsageSnapshot(ctx: Context): UsageSnapshot {
  const lookup = lookupUsageRuntime(ctx)
  if (lookup.status === 'absent') return unavailableSnapshot('service-absent')
  if (lookup.status === 'unreadable') return unavailableSnapshot('snapshot-unavailable')
  let value: unknown
  try {
    value = lookup.runtime.snapshot()
  } catch {
    return unavailableSnapshot('snapshot-unavailable')
  }
  if (value === undefined) return unavailableSnapshot('snapshot-unavailable')
  return projectUsageSnapshot(value)
}

/**
 * Host-side remote face for the `usage` namespace.
 *
 * No static `inject`: the runtime service is optional (see the module comment).
 * Typert resolves the receiver by the service key given to `super`, which stays
 * mounted whether or not a runtime exists.
 */
export class UsageGateway extends TypertRemoteService {
  constructor(ctx: Context) {
    super(ctx, USAGE_HOST_FACE_SERVICE, { namespace: USAGE_HOST_FACE_NAMESPACE })
  }

  /** Current bounded snapshot; `{ available: false }` when usage is not installed. */
  @Remote('getSnapshot')
  getSnapshot(): UsageSnapshot {
    return readUsageSnapshot(this.ctx)
  }

  /**
   * Re-read the snapshot now.
   *
   * The collector state is synchronous and in memory, so there is nothing to
   * await and nothing to queue: this is a second sample, not a different
   * operation. The UI calls it from the panel's refresh control.
   */
  @Remote('refresh')
  refresh(): UsageSnapshot {
    return readUsageSnapshot(this.ctx)
  }
}

/** Register the remote gateway on a context. */
export const name = 'agent-efficiency-guard-usage-remote'

/**
 * Mount the gateway. Deliberately exports no `inject`: the runtime is optional
 * and the gateway must be reachable on a Host that never installed it.
 */
export function apply(ctx: Context): void {
  ctx.plugin(UsageGateway)
}
