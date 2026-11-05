/**
 * Pure Session usage collector (vNext N8 M5).
 *
 * This module turns one already-observed public Session event into metadata-only
 * usage state. It deliberately owns no listener, timer, persistence, or Host
 * service: `ingestUsageSessionEvent(state, input)` is a referentially pure
 * reducer over a caller-supplied state, so the same event can be replayed or
 * deduplicated without touching the outside world.
 *
 * Responsibilities:
 *
 * - Project through {@link projectUsageSessionEventWithGaps}; only the
 *   metadata-only `UsageEvent` is handed to `applyUsageEvent`.
 * - Record every projection or data gap through `recordUsageCoverage`.
 * - Advance a per-Session observed `seq` watermark for *all* Session events,
 *   including records that are not tool calls.
 * - Observe adjacent `seq` holes and record `sequence-gap` coverage with the
 *   exact number of missing events.
 * - Keep real-time observation explicitly `partial` (`live-only`) and keep an
 *   in-progress backfill `partial` (`backfill-incomplete`). Only a separate,
 *   explicit and internally consistent `backfill-complete` input may mark the
 *   coverage `complete`.
 *
 * Privacy contract (vNext §3.9 / §3.10): the reducer never stores the raw
 * Session event, refuses to copy payload fields beyond what the projector
 * reads, and only keeps ids, counters, coverage reasons, and sequence numbers.
 * Arguments, tool output, messages, error names/reasons, and classifier input
 * beyond the tool name are never retained.
 *
 * Idempotency: a Session `seq` is treated as monotonic. A second event at or
 * below the observed watermark is a duplicate observation and leaves the state
 * untouched, so replayed projections cannot add calls or coverage gaps twice.
 *
 * Bulk ingestion: {@link ingestUsageSessionEvents} folds an ordered page of
 * Session events with the exact per-event semantics of
 * {@link ingestUsageSessionEvent}, but hands every projected event to
 * `applyUsageEvents` in one batch. That keeps a whole page O(events + state)
 * instead of the O(events × state) copying of one `applyUsageEvent` call per
 * event. The batch rejects the whole page (state untouched) when a Session's
 * `seq` goes backwards, so an out-of-order page can never pair a result with a
 * call that appears later in the same page and leak an orphan count.
 */
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import {
  applyUsageEvent,
  applyUsageEvents,
  createUsageState,
  recordUsageCoverage,
  type UsageCallState,
  type UsageEvent,
  type UsageEventOutcome,
  type UsageLimits,
  type UsageSessionCoverage,
  type UsageState,
  type UsageWorkspaceRef,
  type WorkspaceAttribution,
} from './usage-core.ts'
import {
  projectUsageSessionEventWithGaps,
  type UsageEventProjection,
  type UsageProjectionGap,
  type UsageSourceClassifier,
} from './usage-event-projector.ts'

/** How the caller obtained the event. It determines the provisional coverage reason. */
export type UsageIngestOrigin = 'live' | 'backfill'

/** Stable reason codes for one ingest transition. */
export type UsageIngestReason =
  | 'counted-event'
  | 'observed-event'
  | 'coverage-gap'
  | 'duplicate-event'
  | 'invalid-event'
  | 'limit-reached'
  | 'backfill-completed'
  | 'invalid-backfill-completion'
  | 'invalid-input'

/** Metadata retained per Session; it never references the raw event. */
export interface UsageCollectorSession {
  /** Lowest Session `seq` observed by this collector. */
  readonly firstObservedSeq?: number
  /** Highest Session `seq` observed by this collector, tool or not. */
  readonly observedSeq?: number
  /** True only after an explicit, accepted `backfill-complete` input. */
  readonly historyComplete: boolean
}

/** Collector state = core usage state + per-Session observation watermarks. */
export interface UsageCollectorState {
  readonly usage: UsageState
  readonly sessions: ReadonlyMap<string, UsageCollectorSession>
}

/**
 * One real or backfilled Session event.
 *
 * `kind` may be omitted for events; it exists so a caller writing a mixed
 * stream can discriminate against {@link UsageBackfillCompleteInput}.
 */
export interface UsageIngestEventInput {
  readonly kind?: 'session-event'
  readonly sessionId: string
  readonly event: SessionEvent
  readonly workspace: UsageWorkspaceRef
  readonly classify: UsageSourceClassifier
  readonly origin: UsageIngestOrigin
}

/**
 * Explicit proof that a backfill page loop reached the end of a Session.
 *
 * The caller must set this only after reading every page through `throughSeq`
 * and verifying that `fromSeq..throughSeq` covers the observed watermark. The
 * reducer re-checks the range against its own observations and fails closed on
 * any inconsistency; it cannot verify the remote read itself.
 */
export interface UsageBackfillCompleteInput {
  readonly kind: 'backfill-complete'
  readonly sessionId: string
  readonly fromSeq: number
  readonly throughSeq: number
  /** Must be the literal `true`; any other runtime value fails closed. */
  readonly verified: true
}

export type UsageIngestInput = UsageIngestEventInput | UsageBackfillCompleteInput

/** Result of one pure ingest transition. */
export interface UsageIngestResult {
  readonly state: UsageCollectorState
  readonly accepted: boolean
  readonly reason: UsageIngestReason
}

/** Per-event outcome of a batch ingest; it carries no intermediate state. */
export interface UsageIngestBatchOutcome {
  readonly accepted: boolean
  readonly reason: UsageIngestReason
}

/** Why a whole batch was rejected before any state transition. */
export type UsageIngestBatchRejection = 'invalid-batch' | 'out-of-order-batch'

/**
 * Result of one pure batch ingest transition.
 *
 * `results` is aligned with the input array. `rejectedReason` is set only when
 * the entire batch was refused without touching `state`; in that case every
 * per-event outcome is `invalid-input` and no classifier was called.
 */
export interface UsageIngestBatchResult {
  readonly state: UsageCollectorState
  readonly results: readonly UsageIngestBatchOutcome[]
  readonly accepted: number
  readonly rejected: number
  readonly rejectedReason?: UsageIngestBatchRejection
}

export const LIVE_ONLY_REASON = 'live-only'
export const BACKFILL_INCOMPLETE_REASON = 'backfill-incomplete'
export const SEQUENCE_GAP_REASON = 'sequence-gap'

const PROVISIONAL_REASONS: ReadonlySet<string> = new Set([
  LIVE_ONLY_REASON,
  BACKFILL_INCOMPLETE_REASON,
  SEQUENCE_GAP_REASON,
])

const WORKSPACE_ATTRIBUTIONS: ReadonlySet<string> = new Set<WorkspaceAttribution>([
  'event-time',
  'current-mapping',
  'unknown',
])

export function createUsageCollectorState(limits: Partial<UsageLimits> = {}): UsageCollectorState {
  return { usage: createUsageState(limits), sessions: new Map() }
}

type UnknownRecord = { readonly [key: string]: unknown }

function isRecord(value: unknown): value is UnknownRecord {
  return typeof value === 'object' && value !== null
}

/** Read exactly one property; a throwing getter degrades to absent. */
function readField(value: unknown, key: string): unknown {
  if (!isRecord(value)) return undefined
  try {
    return (value as Record<string, unknown>)[key]
  } catch {
    return undefined
  }
}

function validText(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0
}

function safeSeq(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : undefined
}

/** Runtime shape check so a wrong `state` argument fails closed instead of throwing. */
function isCollectorState(value: unknown): value is UsageCollectorState {
  if (!isRecord(value)) return false
  const usage = value.usage
  return isRecord(usage)
    && usage.coverage instanceof Map
    && usage.seenEvents instanceof Set
    && usage.calls instanceof Map
    && usage.aggregates instanceof Map
    && value.sessions instanceof Map
}

/** Copy only the public workspace ref fields after validating them. */
function normalizeWorkspace(value: unknown): UsageWorkspaceRef | undefined {
  if (!isRecord(value)) return undefined
  const attribution = readField(value, 'attribution')
  if (typeof attribution !== 'string' || !WORKSPACE_ATTRIBUTIONS.has(attribution)) return undefined
  const rawWorkspaceId = readField(value, 'workspaceId')
  let workspaceId: string | undefined
  if (rawWorkspaceId !== undefined) {
    if (!validText(rawWorkspaceId)) return undefined
    workspaceId = rawWorkspaceId
  }
  if (attribution === 'event-time' && workspaceId === undefined) return undefined
  return {
    ...(workspaceId === undefined ? {} : { workspaceId }),
    attribution: attribution as WorkspaceAttribution,
  }
}

function invalid(state: UsageCollectorState, reason: UsageIngestReason = 'invalid-input'): UsageIngestResult {
  return { state, accepted: false, reason }
}

function advanceObservation(
  sessions: ReadonlyMap<string, UsageCollectorSession>,
  sessionId: string,
  previous: UsageCollectorSession | undefined,
  seq: number,
): ReadonlyMap<string, UsageCollectorSession> {
  const next = new Map(sessions)
  next.set(sessionId, {
    firstObservedSeq: previous?.firstObservedSeq ?? seq,
    observedSeq: previous?.observedSeq === undefined ? seq : Math.max(previous.observedSeq, seq),
    historyComplete: previous?.historyComplete ?? false,
  })
  return next
}

function recordProjectionGap(
  usage: UsageState,
  sessionId: string,
  gap: UsageProjectionGap,
  fallbackSeq: number,
  skippedEvents: number,
): UsageState {
  const seq = gap.seq ?? fallbackSeq
  return recordUsageCoverage(usage, sessionId, {
    status: 'partial',
    reason: gap.reason,
    fromSeq: seq,
    throughSeq: seq,
    ...(skippedEvents > 0 ? { skippedEvents } : {}),
  })
}

function ingestSessionEvent(state: UsageCollectorState, input: UsageIngestEventInput): UsageIngestResult {
  const sessionId = input.sessionId
  const origin = input.origin
  const classify = input.classify
  const event: unknown = input.event
  if (
    !validText(sessionId)
    || !isRecord(event)
    || (origin !== 'live' && origin !== 'backfill')
    || typeof classify !== 'function'
  ) {
    return invalid(state)
  }

  const seq = safeSeq(readField(event, 'seq'))
  if (seq === undefined) return invalid(state)
  const workspace = normalizeWorkspace(input.workspace)
  if (workspace === undefined) return invalid(state)

  const previous = state.sessions.get(sessionId)
  // Live delivery is monotonic, so its sequence watermark is a valid duplicate
  // gate. Backfill deliberately revisits lower sequences and relies on the core
  // event identity check to avoid counting events already seen live.
  if (origin === 'live' && previous?.observedSeq !== undefined && seq <= previous.observedSeq) {
    return { state, accepted: false, reason: 'duplicate-event' }
  }

  const projection = projectUsageSessionEventWithGaps({
    sessionId,
    event: event as SessionEvent,
    workspace,
    classify,
  })

  let usage = state.usage
  let accepted = true
  let reason: UsageIngestReason = 'observed-event'
  let counted = false

  if (projection.event !== undefined) {
    const applied = applyUsageEvent(usage, projection.event)
    usage = applied.state
    if (applied.accepted) {
      counted = true
      reason = 'counted-event'
    } else if (applied.reason === 'duplicate-event') {
      // The core already knows this identity. Keep coverage untouched and only
      // synchronize the observation watermark.
      return {
        state: {
          usage,
          sessions: advanceObservation(state.sessions, sessionId, previous, seq),
        },
        accepted: false,
        reason: 'duplicate-event',
      }
    } else if (applied.reason === 'invalid-event') {
      accepted = false
      reason = 'invalid-event'
    } else {
      accepted = false
      reason = 'limit-reached'
    }
  }

  if (previous?.observedSeq !== undefined && seq > previous.observedSeq + 1) {
    const missing = seq - previous.observedSeq - 1
    usage = recordUsageCoverage(usage, sessionId, {
      status: 'partial',
      reason: SEQUENCE_GAP_REASON,
      fromSeq: previous.observedSeq + 1,
      throughSeq: seq - 1,
      skippedEvents: missing,
    })
  }

  if (projection.event === undefined) {
    // A gap-only projection skipped the event itself, so count one skipped
    // event once even if the projector reports several reasons for it.
    let skippedEvents = projection.gaps.length > 0 ? 1 : 0
    for (const gap of projection.gaps) {
      usage = recordProjectionGap(usage, sessionId, gap, seq, skippedEvents)
      skippedEvents = 0
    }
    if (projection.gaps.length > 0) {
      reason = 'coverage-gap'
    }
  } else if (counted) {
    // The call/result was counted; projection gaps are caveats, not skips.
    for (const gap of projection.gaps) {
      usage = recordProjectionGap(usage, sessionId, gap, seq, 0)
    }
  } else if (reason === 'invalid-event') {
    // Core rejected the event. Do not count it, but keep the skip explicit.
    usage = recordUsageCoverage(usage, sessionId, {
      status: 'partial',
      reason: 'invalid-event',
      fromSeq: seq,
      throughSeq: seq,
      skippedEvents: 1,
    })
  }
  // Limit rejections already recorded `event-limit` / `call-limit` in core;
  // recording them again here would double-count `skippedEvents`.

  usage = recordUsageCoverage(usage, sessionId, {
    status: 'partial',
    reason: origin === 'live' ? LIVE_ONLY_REASON : BACKFILL_INCOMPLETE_REASON,
    fromSeq: seq,
    throughSeq: seq,
  })

  return {
    state: {
      usage,
      sessions: advanceObservation(state.sessions, sessionId, previous, seq),
    },
    accepted,
    reason,
  }
}

function completeBackfill(state: UsageCollectorState, input: UsageBackfillCompleteInput): UsageIngestResult {
  const sessionId = input.sessionId
  const fromSeq = input.fromSeq
  const throughSeq = input.throughSeq
  if (
    !validText(sessionId)
    || safeSeq(fromSeq) === undefined
    || safeSeq(throughSeq) === undefined
    || fromSeq > throughSeq
    || input.verified !== true
  ) {
    return invalid(state, 'invalid-backfill-completion')
  }

  const previous = state.sessions.get(sessionId)
  // A completion that does not cover what this collector actually observed
  // cannot be verified and must not upgrade coverage.
  if (previous?.observedSeq !== undefined && throughSeq < previous.observedSeq) {
    return invalid(state, 'invalid-backfill-completion')
  }
  if (previous?.firstObservedSeq !== undefined && fromSeq > previous.firstObservedSeq) {
    return invalid(state, 'invalid-backfill-completion')
  }

  const existing = state.usage.coverage.get(sessionId)
  const existingFrom = existing?.fromSeq ?? fromSeq
  const existingThrough = existing?.throughSeq ?? throughSeq
  if (
    previous?.historyComplete === true
    && existing?.status === 'complete'
    && existingFrom <= fromSeq
    && existingThrough >= throughSeq
  ) {
    return { state, accepted: true, reason: 'backfill-completed' }
  }

  const coverage: UsageSessionCoverage = {
    status: 'complete',
    fromSeq: Math.min(existingFrom, fromSeq),
    throughSeq: Math.max(existingThrough, throughSeq),
    skippedSessions: existing?.skippedSessions ?? 0,
    skippedEvents: existing?.skippedEvents ?? 0,
    // Verified history supersedes the provisional live/backfill markers and
    // scoped sequence holes. Data gaps (denials, malformed records, ...) stay
    // visible as caveats next to the complete status.
    reasons: (existing?.reasons ?? []).filter(reason => !PROVISIONAL_REASONS.has(reason)),
    reasonsTruncated: existing?.reasonsTruncated ?? false,
  }
  const coverageMap = new Map(state.usage.coverage)
  coverageMap.set(sessionId, coverage)

  const sessions = new Map(state.sessions)
  sessions.set(sessionId, {
    ...(previous?.firstObservedSeq === undefined ? {} : { firstObservedSeq: previous.firstObservedSeq }),
    ...(previous?.observedSeq === undefined ? {} : { observedSeq: previous.observedSeq }),
    historyComplete: true,
  })

  return {
    state: { usage: { ...state.usage, coverage: coverageMap }, sessions },
    accepted: true,
    reason: 'backfill-completed',
  }
}

/**
 * Ingest one Session event or one explicit backfill completion.
 *
 * Pure: the returned state is a new value and the input event is never stored.
 * Invalid or inconsistent input returns the original state unchanged.
 */
export function ingestUsageSessionEvent(
  state: UsageCollectorState,
  input: UsageIngestInput,
): UsageIngestResult {
  if (!isCollectorState(state as unknown)) return invalid(state)
  if (!isRecord(input as unknown)) return invalid(state)
  const kind = readField(input, 'kind')
  if (kind === 'backfill-complete') {
    return completeBackfill(state, input as UsageBackfillCompleteInput)
  }
  if (kind !== undefined && kind !== 'session-event') return invalid(state)
  return ingestSessionEvent(state, input as UsageIngestEventInput)
}

interface ParsedBatchEvent {
  readonly sessionId: string
  readonly seq: number
  readonly event: SessionEvent
  readonly workspace: UsageWorkspaceRef
  readonly classify: UsageSourceClassifier
  readonly origin: UsageIngestOrigin
}

interface PlannedBatchEvent extends ParsedBatchEvent {
  readonly projection: UsageEventProjection
  readonly previousSeq?: number
  readonly coreIndex?: number
}

/** Validate one batch element before any projection or classifier call. */
function parseBatchEvent(input: unknown): ParsedBatchEvent | undefined {
  if (!isRecord(input)) return undefined
  const kind = readField(input, 'kind')
  if (kind !== undefined && kind !== 'session-event') return undefined
  const sessionId = readField(input, 'sessionId')
  if (!validText(sessionId)) return undefined
  const event = readField(input, 'event')
  if (!isRecord(event)) return undefined
  const seq = safeSeq(readField(event, 'seq'))
  if (seq === undefined) return undefined
  const workspace = normalizeWorkspace(readField(input, 'workspace'))
  if (workspace === undefined) return undefined
  const classify = readField(input, 'classify')
  if (typeof classify !== 'function') return undefined
  const origin = readField(input, 'origin')
  if (origin !== 'live' && origin !== 'backfill') return undefined
  return {
    sessionId,
    seq,
    event: event as SessionEvent,
    workspace,
    classify: classify as UsageSourceClassifier,
    origin,
  }
}

/**
 * Mirror of the internal call identity `usage-core` builds. It is used only to
 * seed the single call a coverage probe may need; pairing itself stays owned by
 * the core batch.
 */
function probeCallKey(sessionId: string, callId: string): string {
  return JSON.stringify([sessionId, callId])
}

/** Coverage-only state: big containers stay empty so a merge is O(#Sessions). */
function createCoverageCarrier(usage: UsageState): UsageState {
  return {
    ...usage,
    seenEvents: new Set<string>(),
    calls: new Map<string, UsageCallState>(),
    aggregates: new Map(),
  }
}

/**
 * Reproduce the coverage writes `usage-core` makes for one event without
 * copying the whole usage state.
 *
 * The probe runs the real `applyUsageEvent` against a throwaway state that
 * carries only the evolving coverage map and the one call entry the event can
 * match. Merge order, status, reason truncation and skipped counts therefore
 * stay in core, so a batched page cannot drift from the single-event path.
 */
function probeCoreCoverage(
  carrier: UsageState,
  event: UsageEvent,
  outcome: UsageEventOutcome | undefined,
  calls: ReadonlyMap<string, UsageCallState>,
): UsageState {
  const limits = carrier.limits
  let probeLimits: UsageLimits
  let seedKey: string | undefined
  let seedCall: UsageCallState | undefined

  if (outcome?.reason === 'event-limit') {
    probeLimits = { ...limits, maxEvents: 0 }
  } else if (outcome?.reason === 'call-limit') {
    probeLimits = { ...limits, maxEvents: Number.MAX_SAFE_INTEGER, maxCalls: 0 }
  } else {
    probeLimits = { ...limits, maxEvents: Number.MAX_SAFE_INTEGER, maxCalls: Number.MAX_SAFE_INTEGER }
    if (event.type === 'tool-call' || event.type === 'tool-result') {
      const key = probeCallKey(event.sessionId, event.callId)
      const call = calls.get(key)
      if (call !== undefined) {
        seedKey = key
        seedCall = call
      }
    }
  }

  const seededCalls = new Map<string, UsageCallState>()
  if (seedKey !== undefined && seedCall !== undefined) seededCalls.set(seedKey, seedCall)

  const scratch: UsageState = {
    limits: probeLimits,
    seenEvents: new Set<string>(),
    calls: seededCalls,
    aggregates: new Map(),
    coverage: carrier.coverage,
    totalEvents: 0,
    totalCalls: 0,
    stoppedByLimit: false,
    orphanResults: 0,
    duplicateResults: 0,
  }
  return { ...carrier, coverage: applyUsageEvent(scratch, event).state.coverage }
}

/** Keep the local call shadow used only to seed coverage probes. */
function trackAcceptedCall(calls: Map<string, UsageCallState>, event: UsageEvent): void {
  if (event.type === 'tool-call') {
    const key = probeCallKey(event.sessionId, event.callId)
    if (!calls.has(key)) calls.set(key, { aggregateKey: key })
  } else if (event.type === 'tool-result') {
    const key = probeCallKey(event.sessionId, event.callId)
    const call = calls.get(key)
    if (call !== undefined && call.result === undefined) calls.set(key, { ...call, result: event.outcome })
  }
}

/**
 * Ingest an ordered page of Session events as one pure transition.
 *
 * Semantics are identical to calling {@link ingestUsageSessionEvent} once per
 * element, in order: the duplicate watermark covers every event (tool or not),
 * adjacent `seq` holes and projection gaps keep exact `skippedEvents` counts,
 * and a result still pairs with a call from an earlier element or from the
 * incoming state. Core counters and aggregates are folded by a single
 * `applyUsageEvents` call, and coverage merges replay in event order.
 *
 * A Session's `seq` must be non-decreasing across the page. A page that goes
 * backwards is rejected as a whole (`rejectedReason: 'out-of-order-batch'`)
 * with the state untouched and no classifier call, so a reversed result can
 * never be counted as an orphan. `backfill-complete` inputs are not part of a
 * batch; use {@link ingestUsageSessionEvent} for that explicit transition.
 */
export function ingestUsageSessionEvents(
  state: UsageCollectorState,
  inputs: readonly UsageIngestEventInput[],
): UsageIngestBatchResult {
  if (!isCollectorState(state as unknown) || !Array.isArray(inputs)) {
    return { state, results: [], accepted: 0, rejected: 0, rejectedReason: 'invalid-batch' }
  }

  const count = inputs.length
  const parsed: Array<ParsedBatchEvent | undefined> = new Array(count)
  const lastSeq = new Map<string, number>()
  for (let index = 0; index < count; index += 1) {
    const item = parseBatchEvent(inputs[index])
    parsed[index] = item
    if (item === undefined) continue
    const previous = lastSeq.get(item.sessionId)
    if (previous !== undefined && item.seq < previous) {
      return {
        state,
        results: Array.from({ length: count }, () => ({ accepted: false, reason: 'invalid-input' as const })),
        accepted: 0,
        rejected: count,
        rejectedReason: 'out-of-order-batch',
      }
    }
    lastSeq.set(item.sessionId, item.seq)
  }

  const sessions = new Map(state.sessions)
  const planned: Array<PlannedBatchEvent | undefined> = new Array(count)
  const duplicates: boolean[] = new Array(count).fill(false)
  const coreEvents: UsageEvent[] = []
  for (let index = 0; index < count; index += 1) {
    const item = parsed[index]
    if (item === undefined) continue
    const previous = sessions.get(item.sessionId)
    if (item.origin === 'live' && previous?.observedSeq !== undefined && item.seq <= previous.observedSeq) {
      duplicates[index] = true
      continue
    }
    const projection = projectUsageSessionEventWithGaps({
      sessionId: item.sessionId,
      event: item.event,
      workspace: item.workspace,
      classify: item.classify,
    })
    const coreIndex = projection.event === undefined ? undefined : coreEvents.length
    if (projection.event !== undefined) coreEvents.push(projection.event)
    planned[index] = {
      ...item,
      projection,
      ...(previous?.observedSeq === undefined ? {} : { previousSeq: previous.observedSeq }),
      ...(coreIndex === undefined ? {} : { coreIndex }),
    }
    sessions.set(item.sessionId, {
      firstObservedSeq: previous?.firstObservedSeq ?? item.seq,
      observedSeq: previous?.observedSeq === undefined ? item.seq : Math.max(previous.observedSeq, item.seq),
      historyComplete: previous?.historyComplete ?? false,
    })
  }

  const applied = applyUsageEvents(state.usage, coreEvents)
  const outcomes: UsageIngestBatchOutcome[] = new Array(count)
  let coverage = createCoverageCarrier(state.usage)
  const calls = new Map<string, UsageCallState>(state.usage.calls)
  let changed = false
  let acceptedCount = 0

  for (let index = 0; index < count; index += 1) {
    const item = parsed[index]
    if (item === undefined) {
      outcomes[index] = { accepted: false, reason: 'invalid-input' }
      continue
    }
    if (duplicates[index]) {
      outcomes[index] = { accepted: false, reason: 'duplicate-event' }
      continue
    }

    changed = true
    const plan = planned[index]!
    const projection = plan.projection
    const coreOutcome = plan.coreIndex === undefined ? undefined : applied.results[plan.coreIndex]

    if (coreOutcome?.reason === 'duplicate-event') {
      // Core already knows this identity: only the observation watermark moves,
      // exactly like the single-event early return.
      outcomes[index] = { accepted: false, reason: 'duplicate-event' }
      continue
    }

    if (projection.event !== undefined && coreOutcome?.reason !== 'invalid-event') {
      coverage = probeCoreCoverage(coverage, projection.event, coreOutcome, calls)
    }

    if (plan.previousSeq !== undefined && plan.seq > plan.previousSeq + 1) {
      const missing = plan.seq - plan.previousSeq - 1
      coverage = recordUsageCoverage(coverage, plan.sessionId, {
        status: 'partial',
        reason: SEQUENCE_GAP_REASON,
        fromSeq: plan.previousSeq + 1,
        throughSeq: plan.seq - 1,
        skippedEvents: missing,
      })
    }

    let accepted = true
    let reason: UsageIngestReason = 'observed-event'
    if (projection.event === undefined) {
      // A gap-only projection skipped the event itself, so count one skipped
      // event once even if the projector reports several reasons for it.
      let skippedEvents = projection.gaps.length > 0 ? 1 : 0
      for (const gap of projection.gaps) {
        coverage = recordProjectionGap(coverage, plan.sessionId, gap, plan.seq, skippedEvents)
        skippedEvents = 0
      }
      if (projection.gaps.length > 0) reason = 'coverage-gap'
    } else if (coreOutcome?.accepted === true) {
      for (const gap of projection.gaps) {
        coverage = recordProjectionGap(coverage, plan.sessionId, gap, plan.seq, 0)
      }
      reason = 'counted-event'
      trackAcceptedCall(calls, projection.event)
    } else if (coreOutcome?.reason === 'invalid-event') {
      accepted = false
      reason = 'invalid-event'
      coverage = recordUsageCoverage(coverage, plan.sessionId, {
        status: 'partial',
        reason: 'invalid-event',
        fromSeq: plan.seq,
        throughSeq: plan.seq,
        skippedEvents: 1,
      })
    } else {
      accepted = false
      reason = 'limit-reached'
    }

    coverage = recordUsageCoverage(coverage, plan.sessionId, {
      status: 'partial',
      reason: plan.origin === 'live' ? LIVE_ONLY_REASON : BACKFILL_INCOMPLETE_REASON,
      fromSeq: plan.seq,
      throughSeq: plan.seq,
    })

    outcomes[index] = { accepted, reason }
    if (accepted) acceptedCount += 1
  }

  if (!changed) return { state, results: outcomes, accepted: 0, rejected: count }
  return {
    state: { usage: { ...applied.state, coverage: coverage.coverage }, sessions },
    results: outcomes,
    accepted: acceptedCount,
    rejected: count - acceptedCount,
  }
}
