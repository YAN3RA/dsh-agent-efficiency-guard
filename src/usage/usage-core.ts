import type { UsageClassificationReason } from './usage-classifier.ts'

export type UsageCapabilityKind = 'mcp' | 'plugin-tool' | 'native' | 'skill' | 'unknown'
export type WorkspaceAttribution = 'event-time' | 'current-mapping' | 'unknown'
export type UsageCoverageStatus = 'complete' | 'partial' | 'unknown'
export type UsageSkillEntry = 'skill-tool' | 'slash-invocation' | 'meta-invoke'

export interface UsageWorkspaceRef {
  readonly workspaceId?: string
  readonly attribution: WorkspaceAttribution
}

export type UsageSource =
  | { readonly kind: 'mcp'; readonly providerId: string }
  | { readonly kind: 'plugin-tool'; readonly providerId: string }
  | { readonly kind: 'native' }
  | { readonly kind: 'skill'; readonly providerId?: string; readonly entry: UsageSkillEntry }
  | { readonly kind: 'unknown'; readonly reason: string }

interface UsageEventBase {
  readonly sessionId: string
  readonly seq: number
  readonly time: number
  readonly workspace: UsageWorkspaceRef
}

/** Already-projected metadata. Adapters must not pass raw event payloads or arguments. */
export interface UsageToolCallEvent extends UsageEventBase {
  readonly type: 'tool-call'
  readonly callId: string
  readonly capabilityId: string
  readonly source: UsageSource
}

export type UsageResultOutcome = 'success' | 'error' | 'denied' | 'cancelled'

/** Only the matched call id, outcome and an optional short error code are retained. */
export interface UsageToolResultEvent extends UsageEventBase {
  readonly type: 'tool-result'
  readonly callId: string
  readonly outcome: UsageResultOutcome
  readonly errorCode?: string
}

export interface UsageSkillLoadEvent extends UsageEventBase {
  readonly type: 'skill-load'
  readonly skillId: string
  readonly providerId?: string
  readonly entry: UsageSkillEntry
  readonly outcome: 'success' | 'error'
  readonly errorCode?: string
}

export type UsageEvent = UsageToolCallEvent | UsageToolResultEvent | UsageSkillLoadEvent

export interface UsageCoverageInput {
  readonly status: UsageCoverageStatus
  readonly fromSeq?: number
  readonly throughSeq?: number
  readonly reason?: string
  readonly skippedSessions?: number
  readonly skippedEvents?: number
}

export interface UsageLimits {
  readonly maxEvents: number
  readonly maxCalls: number
  readonly maxCoverageReasons: number
  readonly maxErrorCodeLength: number
}

export interface UsageAggregate {
  readonly sessionId: string
  readonly date: string
  readonly workspaceId?: string
  readonly workspaceAttribution: WorkspaceAttribution
  readonly capabilityId: string
  readonly capabilityKind: UsageCapabilityKind
  readonly providerId?: string
  calls: number
  succeeded: number
  failed: number
  denied: number
  cancelled: number
  unresolved: number
  lastUsedAt?: number
  firstObservedAt: number
  errors: Map<string, number>
}

export interface UsageSessionCoverage {
  status: UsageCoverageStatus
  fromSeq?: number
  throughSeq?: number
  skippedSessions: number
  skippedEvents: number
  reasons: string[]
  reasonsTruncated: boolean
}

export interface UsageCallState {
  readonly aggregateKey: string
  readonly result?: UsageResultOutcome
}

export interface UsageState {
  readonly limits: UsageLimits
  readonly seenEvents: Set<string>
  readonly calls: Map<string, UsageCallState>
  readonly aggregates: Map<string, UsageAggregate>
  readonly coverage: Map<string, UsageSessionCoverage>
  readonly totalEvents: number
  readonly totalCalls: number
  readonly stoppedByLimit: boolean
  readonly orphanResults: number
  readonly duplicateResults: number
}

export type ApplyUsageReason = 'duplicate-event' | 'invalid-event' | 'event-limit' | 'call-limit'

export interface ApplyUsageResult {
  readonly state: UsageState
  readonly accepted: boolean
  readonly reason?: ApplyUsageReason
}

/** Per-event outcome inside a batch; carries no intermediate state snapshot. */
export interface UsageEventOutcome {
  readonly accepted: boolean
  readonly reason?: ApplyUsageReason
}

export interface ApplyUsageBatchResult {
  readonly state: UsageState
  /** One outcome per input event, in the same order. */
  readonly results: readonly UsageEventOutcome[]
  readonly accepted: number
  readonly rejected: number
}

export interface UsageReportFilter {
  readonly fromMs?: number
  readonly toMs?: number
  readonly sessionId?: string
  readonly workspaceId?: string
  readonly capabilityKind?: UsageCapabilityKind
}

export interface UsageReport {
  readonly aggregates: readonly Readonly<Omit<UsageAggregate, 'errors'> & { errors: Readonly<Record<string, number>> }>[]
  readonly calls: number
  readonly succeeded: number
  readonly failed: number
  readonly denied: number
  readonly cancelled: number
  readonly unresolved: number
  readonly coverage: Readonly<Record<string, UsageSessionCoverage>>
  readonly orphanResults: number
  readonly duplicateResults: number
  readonly limitsReached: boolean
}

export const DEFAULT_USAGE_LIMITS: UsageLimits = Object.freeze({
  maxEvents: 250_000,
  maxCalls: 100_000,
  maxCoverageReasons: 32,
  maxErrorCodeLength: 128,
})

const STATUS_RANK: Record<UsageCoverageStatus, number> = { complete: 0, partial: 1, unknown: 2 }
const COVERAGE_STATUSES: ReadonlySet<string> = new Set<UsageCoverageStatus>(['complete', 'partial', 'unknown'])

/**
 * Stable classifier reason codes that may become coverage reasons.
 *
 * `UsageSource.reason` is caller-supplied text. It must never be copied into
 * coverage as-is: only this finite classifier vocabulary may pass, and any
 * unrecognized text falls back to the historical generic reason below.
 *
 * `owner-not-verified` keeps the existing `unknown-tool-owner` label; the more
 * specific MCP/skill reasons stay distinguishable instead of collapsing into
 * that generic reason.
 */
const UNKNOWN_COVERAGE_REASON: Readonly<Record<UsageClassificationReason, string>> = Object.freeze({
  'tool-id-missing': 'tool-id-missing',
  'owner-not-verified': 'unknown-tool-owner',
  'ambiguous-mcp-provider': 'ambiguous-mcp-provider',
  'missing-mcp-provider': 'missing-mcp-provider',
  'conflicting-trusted-sources': 'conflicting-trusted-sources',
  'skill-id-missing': 'skill-id-missing',
  'skill-entry-not-observed': 'skill-entry-not-observed',
})

const FALLBACK_UNKNOWN_COVERAGE_REASON = 'unknown-tool-owner'

function isCoverageStatus(value: unknown): value is UsageCoverageStatus {
  return typeof value === 'string' && COVERAGE_STATUSES.has(value)
}

function unknownCoverageReason(reason: string): string {
  const normalized = reason.trim()
  return Object.hasOwn(UNKNOWN_COVERAGE_REASON, normalized)
    ? UNKNOWN_COVERAGE_REASON[normalized as UsageClassificationReason]
    : FALLBACK_UNKNOWN_COVERAGE_REASON
}

function validNonNegativeInteger(value: number | undefined): boolean {
  return value === undefined || (Number.isSafeInteger(value) && value >= 0)
}

function validText(value: string): boolean {
  return value.trim().length > 0
}

function normalizeOptionalText(value: string | undefined): string | undefined {
  if (typeof value !== 'string') return undefined
  const trimmed = value.trim()
  return trimmed.length > 0 ? trimmed : undefined
}

function safeErrorCode(value: string | undefined, maxLength: number): string | undefined {
  if (value === undefined || value.length === 0 || value.length > maxLength) return undefined
  return /^[A-Za-z0-9_.:-]+$/.test(value) ? value : undefined
}

function eventKey(sessionId: string, seq: number): string {
  return JSON.stringify([sessionId, seq])
}

function callKey(sessionId: string, callId: string): string {
  return JSON.stringify([sessionId, callId])
}

interface UsageSourceParts {
  readonly kind: UsageCapabilityKind
  readonly providerId?: string
  readonly unknownReason?: string
}

function sourceParts(source: UsageSource): UsageSourceParts | undefined {
  if (source.kind === 'mcp' || source.kind === 'plugin-tool') {
    if (!validText(source.providerId)) return undefined
    return { kind: source.kind, providerId: source.providerId }
  }
  if (source.kind === 'skill') {
    if (!['skill-tool', 'slash-invocation', 'meta-invoke'].includes(source.entry)) return undefined
    const providerId = normalizeOptionalText(source.providerId)
    return { kind: 'skill', ...(providerId === undefined ? {} : { providerId }) }
  }
  if (source.kind === 'native') return { kind: 'native' }
  if (source.kind === 'unknown') {
    const unknownReason = normalizeOptionalText(source.reason)
    return unknownReason === undefined ? undefined : { kind: 'unknown', unknownReason }
  }
  return undefined
}

function newCoverage(): UsageSessionCoverage {
  return { status: 'complete', skippedSessions: 0, skippedEvents: 0, reasons: [], reasonsTruncated: false }
}

/**
 * Merge one coverage observation into `target` in place.
 *
 * `withCoverage` hands this a private copy; the batch draft hands it the single
 * mutable coverage snapshot it already owns. Both paths therefore share the
 * exact same status/reason/skipped-event semantics.
 */
function mergeCoverageInto(target: UsageSessionCoverage, limits: UsageLimits, input: UsageCoverageInput): void {
  if (STATUS_RANK[input.status] >= STATUS_RANK[target.status]) target.status = input.status
  if (input.fromSeq !== undefined) {
    target.fromSeq = target.fromSeq === undefined ? input.fromSeq : Math.min(target.fromSeq, input.fromSeq)
  }
  if (input.throughSeq !== undefined) {
    target.throughSeq = target.throughSeq === undefined ? input.throughSeq : Math.max(target.throughSeq, input.throughSeq)
  }
  target.skippedSessions += Math.max(0, input.skippedSessions ?? 0)
  target.skippedEvents += Math.max(0, input.skippedEvents ?? 0)
  if (input.reason && !target.reasons.includes(input.reason)) {
    if (target.reasons.length < limits.maxCoverageReasons) target.reasons.push(input.reason.slice(0, 256))
    else target.reasonsTruncated = true
  }
}

function withCoverage(state: UsageState, sessionId: string, input: UsageCoverageInput): UsageState {
  if (
    !validText(sessionId)
    || !isCoverageStatus(input.status)
    || !validNonNegativeInteger(input.fromSeq)
    || !validNonNegativeInteger(input.throughSeq)
  ) return state
  const previous = state.coverage.get(sessionId)
  const next = previous === undefined
    ? newCoverage()
    : { ...previous, reasons: [...previous.reasons] }
  mergeCoverageInto(next, state.limits, input)
  const coverage = new Map(state.coverage)
  coverage.set(sessionId, next)
  return { ...state, coverage }
}

export function createUsageState(limits: Partial<UsageLimits> = {}): UsageState {
  const resolved: UsageLimits = { ...DEFAULT_USAGE_LIMITS, ...limits }
  for (const [key, value] of Object.entries(resolved)) {
    if (!Number.isSafeInteger(value) || value < 1) throw new Error(`${key} must be a positive safe integer`)
  }
  return {
    limits: resolved,
    seenEvents: new Set(),
    calls: new Map(),
    aggregates: new Map(),
    coverage: new Map(),
    totalEvents: 0,
    totalCalls: 0,
    stoppedByLimit: false,
    orphanResults: 0,
    duplicateResults: 0,
  }
}

export function recordUsageCoverage(state: UsageState, sessionId: string, input: UsageCoverageInput): UsageState {
  return withCoverage(state, sessionId, input)
}

function aggregateKey(event: UsageToolCallEvent, kind: UsageCapabilityKind, providerId?: string): string {
  return JSON.stringify([
    event.sessionId,
    new Date(event.time).toISOString().slice(0, 10),
    event.workspace.workspaceId ?? null,
    event.workspace.attribution,
    event.capabilityId,
    kind,
    providerId ?? null,
  ])
}

function invalidEvent(event: UsageEvent): boolean {
  if (!validText(event.sessionId) || !Number.isSafeInteger(event.seq) || event.seq < 0 || !Number.isFinite(event.time) || !Number.isFinite(new Date(event.time).getTime())) return true
  if (!['event-time', 'current-mapping', 'unknown'].includes(event.workspace.attribution)) return true
  if (event.workspace.workspaceId !== undefined && !validText(event.workspace.workspaceId)) return true
  if (event.workspace.attribution !== 'unknown' && event.workspace.workspaceId === undefined) return true
  if (event.type === 'tool-call') return !validText(event.callId) || !validText(event.capabilityId) || sourceParts(event.source) === undefined
  if (event.type === 'tool-result') return !validText(event.callId) || !['success', 'error', 'denied', 'cancelled'].includes(event.outcome)
  if (event.type === 'skill-load') return !validText(event.skillId) || !['skill-tool', 'slash-invocation', 'meta-invoke'].includes(event.entry) || !['success', 'error'].includes(event.outcome)
  return true
}

function createAggregate(event: UsageToolCallEvent, kind: UsageCapabilityKind, providerId: string | undefined): UsageAggregate {
  return {
    sessionId: event.sessionId,
    date: new Date(event.time).toISOString().slice(0, 10),
    ...(event.workspace.workspaceId !== undefined ? { workspaceId: event.workspace.workspaceId } : {}),
    workspaceAttribution: event.workspace.attribution,
    capabilityId: event.capabilityId,
    capabilityKind: kind,
    ...(providerId !== undefined ? { providerId } : {}),
    calls: 0,
    succeeded: 0,
    failed: 0,
    denied: 0,
    cancelled: 0,
    unresolved: 0,
    firstObservedAt: event.time,
    errors: new Map(),
  }
}

/**
 * Mutable batch draft.
 *
 * `state` stays untouched: the draft only stores entries it actually changes
 * (pending maps/set) and clones a base aggregate or coverage entry the first
 * time that entry is touched. Containers are rebuilt once in
 * {@link materializeDraft}.
 */
interface UsageDraft {
  readonly base: UsageState
  readonly limits: UsageLimits
  readonly seenEvents: Set<string>
  readonly calls: Map<string, UsageCallState>
  readonly aggregates: Map<string, UsageAggregate>
  readonly coverage: Map<string, UsageSessionCoverage>
  totalEvents: number
  totalCalls: number
  stoppedByLimit: boolean
  orphanResults: number
  duplicateResults: number
}

function createDraft(state: UsageState): UsageDraft {
  return {
    base: state,
    limits: state.limits,
    seenEvents: new Set(),
    calls: new Map(),
    aggregates: new Map(),
    coverage: new Map(),
    totalEvents: state.totalEvents,
    totalCalls: state.totalCalls,
    stoppedByLimit: state.stoppedByLimit,
    orphanResults: state.orphanResults,
    duplicateResults: state.duplicateResults,
  }
}

function draftHasEvent(draft: UsageDraft, identity: string): boolean {
  return draft.seenEvents.has(identity) || draft.base.seenEvents.has(identity)
}

function draftCall(draft: UsageDraft, identity: string): UsageCallState | undefined {
  return draft.calls.get(identity) ?? draft.base.calls.get(identity)
}

function withDraftCoverage(draft: UsageDraft, sessionId: string, input: UsageCoverageInput): void {
  if (
    !validText(sessionId)
    || !isCoverageStatus(input.status)
    || !validNonNegativeInteger(input.fromSeq)
    || !validNonNegativeInteger(input.throughSeq)
  ) return
  let next = draft.coverage.get(sessionId)
  if (next === undefined) {
    const previous = draft.base.coverage.get(sessionId)
    next = previous === undefined ? newCoverage() : { ...previous, reasons: [...previous.reasons] }
    draft.coverage.set(sessionId, next)
  }
  mergeCoverageInto(next, draft.limits, input)
}

/** Clone the base aggregate into the draft once so it can be mutated in place. */
function mutableDraftAggregate(draft: UsageDraft, key: string): UsageAggregate | undefined {
  const pending = draft.aggregates.get(key)
  if (pending !== undefined) return pending
  const base = draft.base.aggregates.get(key)
  if (base === undefined) return undefined
  const copy = { ...base, errors: new Map(base.errors) }
  draft.aggregates.set(key, copy)
  return copy
}

function addDraftCallAggregate(draft: UsageDraft, event: UsageToolCallEvent, kind: UsageCapabilityKind, providerId: string | undefined): string {
  const key = aggregateKey(event, kind, providerId)
  let aggregate = draft.aggregates.get(key)
  if (aggregate === undefined) {
    const base = draft.base.aggregates.get(key)
    aggregate = base === undefined ? createAggregate(event, kind, providerId) : { ...base, errors: new Map(base.errors) }
    draft.aggregates.set(key, aggregate)
  }
  aggregate.calls += 1
  aggregate.unresolved += 1
  aggregate.firstObservedAt = Math.min(aggregate.firstObservedAt, event.time)
  aggregate.lastUsedAt = Math.max(aggregate.lastUsedAt ?? event.time, event.time)
  return key
}

function applyDraftOutcome(draft: UsageDraft, aggregateId: string, outcome: UsageResultOutcome, errorCode?: string): void {
  const aggregate = mutableDraftAggregate(draft, aggregateId)
  if (aggregate === undefined) return
  aggregate.unresolved = Math.max(0, aggregate.unresolved - 1)
  if (outcome === 'success') aggregate.succeeded += 1
  else if (outcome === 'error') {
    aggregate.failed += 1
    const code = safeErrorCode(errorCode, draft.limits.maxErrorCodeLength)
    if (code) aggregate.errors.set(code, (aggregate.errors.get(code) ?? 0) + 1)
  } else if (outcome === 'denied') aggregate.denied += 1
  else aggregate.cancelled += 1
}

type UsageLimitReason = Extract<ApplyUsageReason, 'event-limit' | 'call-limit'>

/**
 * Recover which limit stopped the state without adding a field to `UsageState`.
 * The v1 codec rejects unknown fields, and both counters are already persisted.
 *
 * A call-limit stop can only happen while `totalEvents < maxEvents` because the
 * event-limit check runs first; no counter advances after a stop. Therefore a
 * stopped state with `totalEvents >= maxEvents` was stopped by the event limit,
 * and any other stopped state was stopped by the call limit.
 */
function stoppedLimitReason(totalEvents: number, limits: UsageLimits): UsageLimitReason {
  return totalEvents >= limits.maxEvents ? 'event-limit' : 'call-limit'
}

function applyEventToDraft(draft: UsageDraft, event: UsageEvent): UsageEventOutcome {
  if (invalidEvent(event)) return { accepted: false, reason: 'invalid-event' }
  const identity = eventKey(event.sessionId, event.seq)
  if (draftHasEvent(draft, identity)) return { accepted: false, reason: 'duplicate-event' }
  if (draft.stoppedByLimit) {
    const reason = stoppedLimitReason(draft.totalEvents, draft.limits)
    withDraftCoverage(draft, event.sessionId, {
      status: 'partial', reason, skippedEvents: 1, fromSeq: event.seq, throughSeq: event.seq,
    })
    return { accepted: false, reason }
  }
  if (draft.totalEvents >= draft.limits.maxEvents) {
    draft.stoppedByLimit = true
    withDraftCoverage(draft, event.sessionId, {
      status: 'partial', reason: 'event-limit', skippedEvents: 1, fromSeq: event.seq, throughSeq: event.seq,
    })
    return { accepted: false, reason: 'event-limit' }
  }
  if ((event.type === 'tool-call' || event.type === 'skill-load') && draft.totalCalls >= draft.limits.maxCalls) {
    draft.stoppedByLimit = true
    withDraftCoverage(draft, event.sessionId, {
      status: 'partial', reason: 'call-limit', skippedEvents: 1, fromSeq: event.seq, throughSeq: event.seq,
    })
    return { accepted: false, reason: 'call-limit' }
  }

  draft.seenEvents.add(identity)
  draft.totalEvents += 1
  if (event.type === 'tool-call') {
    const callIdentity = callKey(event.sessionId, event.callId)
    if (draftCall(draft, callIdentity) !== undefined) {
      withDraftCoverage(draft, event.sessionId, { status: 'partial', reason: 'duplicate-call-id', fromSeq: event.seq, throughSeq: event.seq })
      return { accepted: true }
    }
    const source = sourceParts(event.source)!
    const key = addDraftCallAggregate(draft, event, source.kind, source.providerId)
    draft.calls.set(callIdentity, { aggregateKey: key })
    draft.totalCalls += 1
    const reasons: string[] = []
    if (source.kind === 'unknown') reasons.push(unknownCoverageReason(source.unknownReason!))
    if (source.kind === 'skill' && source.providerId === undefined) reasons.push('unknown-skill-source')
    if (event.workspace.attribution === 'current-mapping') reasons.push('workspace-current-mapping')
    if (event.workspace.attribution === 'unknown') reasons.push('workspace-attribution-unknown')
    for (const reason of reasons) withDraftCoverage(draft, event.sessionId, { status: 'partial', reason, fromSeq: event.seq, throughSeq: event.seq })
    if (reasons.length === 0) withDraftCoverage(draft, event.sessionId, { status: 'complete', fromSeq: event.seq, throughSeq: event.seq })
    return { accepted: true }
  }

  if (event.type === 'skill-load') {
    const providerId = normalizeOptionalText(event.providerId)
    const skillEvent: UsageToolCallEvent = {
      type: 'tool-call',
      sessionId: event.sessionId,
      seq: event.seq,
      time: event.time,
      workspace: event.workspace,
      callId: `skill-load:${event.seq}`,
      capabilityId: event.skillId,
      source: { kind: 'skill', ...(providerId === undefined ? {} : { providerId }), entry: event.entry },
    }
    const key = addDraftCallAggregate(draft, skillEvent, 'skill', providerId)
    draft.totalCalls += 1
    applyDraftOutcome(draft, key, event.outcome, event.errorCode)
    const reasons = [
      ...(providerId === undefined ? ['unknown-skill-source'] : []),
      ...(event.workspace.attribution === 'current-mapping' ? ['workspace-current-mapping'] : []),
      ...(event.workspace.attribution === 'unknown' ? ['workspace-attribution-unknown'] : []),
    ]
    for (const reason of reasons) withDraftCoverage(draft, event.sessionId, { status: 'partial', reason, fromSeq: event.seq, throughSeq: event.seq })
    if (reasons.length === 0) withDraftCoverage(draft, event.sessionId, { status: 'complete', fromSeq: event.seq, throughSeq: event.seq })
    return { accepted: true }
  }

  const callIdentity = callKey(event.sessionId, event.callId)
  const call = draftCall(draft, callIdentity)
  if (call === undefined) {
    draft.orphanResults += 1
    withDraftCoverage(draft, event.sessionId, {
      status: 'partial', reason: 'unmatched-result', skippedEvents: 1, fromSeq: event.seq, throughSeq: event.seq,
    })
    return { accepted: true }
  }
  if (call.result !== undefined) {
    draft.duplicateResults += 1
    return { accepted: true }
  }

  draft.calls.set(callIdentity, { ...call, result: event.outcome })
  applyDraftOutcome(draft, call.aggregateKey, event.outcome, event.errorCode)
  withDraftCoverage(draft, event.sessionId, { status: 'complete', fromSeq: event.seq, throughSeq: event.seq })
  return { accepted: true }
}

/** Rebuild the immutable boundary once: each touched container is copied a single time. */
function materializeDraft(draft: UsageDraft): UsageState {
  const base = draft.base
  const unchanged = draft.seenEvents.size === 0
    && draft.calls.size === 0
    && draft.aggregates.size === 0
    && draft.coverage.size === 0
    && draft.totalEvents === base.totalEvents
    && draft.totalCalls === base.totalCalls
    && draft.stoppedByLimit === base.stoppedByLimit
    && draft.orphanResults === base.orphanResults
    && draft.duplicateResults === base.duplicateResults
  if (unchanged) return base

  let seenEvents = base.seenEvents
  if (draft.seenEvents.size > 0) {
    const next = new Set(base.seenEvents)
    for (const identity of draft.seenEvents) next.add(identity)
    seenEvents = next
  }
  let calls = base.calls
  if (draft.calls.size > 0) {
    const next = new Map(base.calls)
    for (const [identity, call] of draft.calls) next.set(identity, call)
    calls = next
  }
  let aggregates = base.aggregates
  if (draft.aggregates.size > 0) {
    const next = new Map(base.aggregates)
    for (const [key, aggregate] of draft.aggregates) next.set(key, aggregate)
    aggregates = next
  }
  let coverage = base.coverage
  if (draft.coverage.size > 0) {
    const next = new Map(base.coverage)
    for (const [sessionId, entry] of draft.coverage) next.set(sessionId, entry)
    coverage = next
  }
  return {
    limits: base.limits,
    seenEvents,
    calls,
    aggregates,
    coverage,
    totalEvents: draft.totalEvents,
    totalCalls: draft.totalCalls,
    stoppedByLimit: draft.stoppedByLimit,
    orphanResults: draft.orphanResults,
    duplicateResults: draft.duplicateResults,
  }
}

/**
 * Apply a batch of metadata-only events as one pure transition.
 *
 * The batch owns a single mutable draft: every touched aggregate/coverage entry
 * is cloned out of `state` at most once, and each of the four containers is
 * copied once in {@link materializeDraft}. Cost is O(events + state), instead
 * of the O(events × state) that repeated {@link applyUsageEvent} calls pay when
 * a caller already holds a list. Per-event duplicate and limit semantics are
 * identical to applying the same events one by one.
 */
export function applyUsageEvents(state: UsageState, events: readonly UsageEvent[]): ApplyUsageBatchResult {
  if (events.length === 0) return { state, results: [], accepted: 0, rejected: 0 }
  const draft = createDraft(state)
  const results: UsageEventOutcome[] = []
  let accepted = 0
  for (const event of events) {
    const outcome = applyEventToDraft(draft, event)
    results.push(outcome)
    if (outcome.accepted) accepted += 1
  }
  return { state: materializeDraft(draft), results, accepted, rejected: events.length - accepted }
}

/** Apply one metadata-only event. This pure transition performs no I/O or raw payload parsing. */
export function applyUsageEvent(state: UsageState, event: UsageEvent): ApplyUsageResult {
  const applied = applyUsageEvents(state, [event])
  const outcome = applied.results[0]!
  return outcome.reason === undefined
    ? { state: applied.state, accepted: outcome.accepted }
    : { state: applied.state, accepted: outcome.accepted, reason: outcome.reason }
}

export function markUsageSessionSkipped(state: UsageState, sessionId: string, reason: string, skippedEvents = 0): UsageState {
  if (!validText(sessionId) || !validText(reason)) return state
  return withCoverage(state, sessionId, { status: 'partial', reason, skippedSessions: 1, skippedEvents })
}

export function buildUsageReport(state: UsageState, filter: UsageReportFilter = {}): UsageReport {
  const totals = { calls: 0, succeeded: 0, failed: 0, denied: 0, cancelled: 0, unresolved: 0 }
  const aggregates = [...state.aggregates.values()]
    .filter(row => filter.fromMs === undefined || row.lastUsedAt! >= filter.fromMs)
    .filter(row => filter.toMs === undefined || row.firstObservedAt <= filter.toMs)
    .filter(row => filter.sessionId === undefined || row.sessionId === filter.sessionId)
    .filter(row => filter.workspaceId === undefined || row.workspaceId === filter.workspaceId)
    .filter(row => filter.capabilityKind === undefined || row.capabilityKind === filter.capabilityKind)
    .map(row => {
      totals.calls += row.calls
      totals.succeeded += row.succeeded
      totals.failed += row.failed
      totals.denied += row.denied
      totals.cancelled += row.cancelled
      totals.unresolved += row.unresolved
      return { ...row, errors: Object.fromEntries(row.errors) }
    })
    .sort((a, b) => b.calls - a.calls || a.capabilityId.localeCompare(b.capabilityId) || a.sessionId.localeCompare(b.sessionId))
  return {
    aggregates,
    ...totals,
    coverage: Object.fromEntries([...state.coverage].map(([id, value]) => [id, { ...value, reasons: [...value.reasons] }])),
    orphanResults: state.orphanResults,
    duplicateResults: state.duplicateResults,
    limitsReached: state.stoppedByLimit,
  }
}
