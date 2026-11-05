/**
 * Bounded, metadata-only Session history backfill (vNext N8).
 *
 * The live adapter ({@link installUsageRuntime}) can only observe events that
 * happen after a Host fiber is installed. This module fills the gap for stored
 * Sessions without taking any new Host dependency: it probes the *optional*
 * public `ctx.get('sessionPersistence')` service, pages through the stored
 * event log, and feeds every page into the pure collector's
 * {@link ingestUsageSessionEvents} transition. No file is read directly, no
 * storage package is imported, and the raw events are never retained: after a
 * page has been projected, only counters, coverage and sequence watermarks
 * survive in the returned state / metadata-only cursor.
 *
 * Completion contract (deliberately conservative):
 *
 * - Only Sessions present in `sessionPersistence.list()` are considered.
 *   `list()` has no promised order, so the module sorts by Session id before
 *   applying the bounded `maxSessions` window.
 * - Completeness is judged from `snapshot.eventCount`; a Session whose count is
 *   absent or malformed is never read and never marked complete.
 * - Pages are requested with exact `(offset, length)` bounds and every returned
 *   event must carry the expected contiguous `seq`. A short, oversized or
 *   reordered page is a failure, not an inference.
 * - A Session is marked `complete` through the collector's explicit
 *   `backfill-complete` transition only when the whole `[0, eventCount)` range
 *   has been read without a timeout, cancellation, budget truncation, I/O
 *   failure, close failure or unexplained ingest rejection. A matching
 *   checkpoint in the incoming cursor may attest the `[0, nextOffset)` prefix;
 *   a cursor whose revision differs from the current snapshot is ignored and
 *   the Session restarts at `seq 0`.
 * - Projection/data-quality gaps are *not* erased: the collector keeps them as
 *   coverage reasons beside the `complete` status, exactly as required by the
 *   usage contract. Only provisional `backfill-incomplete` markers are
 *   superseded by an accepted completion.
 *
 * Privacy / cursor contract:
 *
 * - The cursor contains only the profile hash and, per Session, the Session id,
 *   the next offset and the opaque persistence revision. It never contains
 *   events, payloads, arguments, tool output, timestamps or workspace names.
 * - With no `profileContext`, the backfill is fully disabled: the persistence
 *   service is not probed, no Session is listed and no cursor is emitted. The
 *   same is true when the optional service is absent.
 *
 * Budgets: reads are side-effect-free but can be heavy. The defaults are
 * intentionally small (`8` Sessions, `2_000` events/Session, `10_000` events
 * total, `100`-event pages, `5_000` ms wall clock) and every limit can be
 * overridden per call. Partial progress is resumable through the cursor.
 */
import type { SessionEvent, SessionId } from '@deepseek-ai/dsh-session'
import type {
  SessionHandle,
  SessionHandleReadResult,
  SessionPersistence,
  SessionPersistenceSnapshot,
} from '@deepseek-ai/dsh-session-persistence'
import {
  createUsageCollectorState,
  ingestUsageSessionEvent,
  ingestUsageSessionEvents,
  type UsageCollectorState,
  type UsageIngestBatchOutcome,
} from './usage-collector.ts'
import {
  buildUsageReport,
  recordUsageCoverage,
  type UsageCoverageStatus,
  type UsageReport,
  type UsageReportFilter,
  type UsageWorkspaceRef,
} from './usage-core.ts'
import type { UsageSourceClassifier } from './usage-event-projector.ts'
import { resolveUsageProfile } from './usage-profile.ts'

/** Hard resource bounds for one backfill run. */
export interface UsageBackfillLimits {
  /** Maximum number of not-yet-complete Sessions attempted in one run. */
  readonly maxSessions: number
  /** Maximum number of events read from any single Session in one run. */
  readonly maxEventsPerSession: number
  /** Maximum number of events read across all Sessions in one run. */
  readonly maxTotalEvents: number
  /** Maximum events requested per `SessionHandle.read` call. */
  readonly pageSize: number
  /** Wall-clock budget measured with `now` (defaults to `Date.now`). */
  readonly maxRuntimeMs: number
}

/** Small, runtime-friendly defaults; callers may raise them explicitly. */
export const DEFAULT_USAGE_BACKFILL_LIMITS: UsageBackfillLimits = Object.freeze({
  maxSessions: 8,
  maxEventsPerSession: 2_000,
  maxTotalEvents: 10_000,
  pageSize: 100,
  maxRuntimeMs: 5_000,
})

/** One metadata-only checkpoint. It deliberately holds no event data. */
export interface UsageBackfillCursorEntry {
  readonly sessionId: string
  /** Next logical `seq` to read; `eventCount` means the log was fully read. */
  readonly nextOffset: number
  /** Opaque persistence revision that the checkpoint was taken against. */
  readonly revision: string
}

/** Resume token for one profile. Every entry must belong to that profile. */
export interface UsageBackfillCursor {
  readonly profileHash: string
  readonly entries: readonly UsageBackfillCursorEntry[]
}

/** Why a backfill run never touched persistence. */
export type UsageBackfillDisabledReason =
  | 'profile-unknown'
  | 'session-persistence-unavailable'
  | 'classifier-unavailable'

/** Content-free counters for one run. */
export interface UsageBackfillStats {
  /** Snapshots returned by `list()`. */
  readonly listedSessions: number
  /** Sessions actually opened/read in this run. */
  readonly attemptedSessions: number
  readonly completedSessions: number
  /** Read but not complete because of budgets, cancellation, timeout or data. */
  readonly partialSessions: number
  /** Sessions with an I/O or ingest-contract failure. */
  readonly failedSessions: number
  /** Listed Sessions whose event count/revision/identity was unusable. */
  readonly unverifiableSessions: number
  /** Sessions skipped because a matching cursor already covered their log. */
  readonly alreadyCompleteSessions: number
  readonly eventsRead: number
  readonly pagesRead: number
  readonly acceptedEvents: number
  readonly rejectedEvents: number
  readonly cancelled: boolean
  readonly timedOut: boolean
  /** A session or event budget prevented this run from covering every list row. */
  readonly truncated: boolean
  readonly listFailures: number
  readonly openFailures: number
  readonly readFailures: number
  readonly closeFailures: number
  readonly completionFailures: number
  readonly ingestFailures: number
  /** Present only when nothing was attempted because a prerequisite is missing. */
  readonly disabled?: UsageBackfillDisabledReason
  /** Stable reason code → count; never event content. */
  readonly reasons: Readonly<Record<string, number>>
}

/** One bounded backfill result. */
export interface UsageBackfillResult {
  /** Collector state to install/replace in the caller. */
  readonly state: UsageCollectorState
  /** Metadata-only resume token; absent when the run was disabled. */
  readonly cursor?: UsageBackfillCursor
  /** Report built from `state` (optionally filtered by `reportFilter`). */
  readonly report: UsageReport
  /** Whether this run covered every listed Session's full history. */
  readonly coverageStatus: UsageCoverageStatus
  readonly stats: UsageBackfillStats
}

/** Inputs for one bounded backfill run. */
export interface UsageBackfillOptions {
  /** Host context; only its optional `get(name)` is probed. */
  readonly context: unknown
  /** Trusted, caller-supplied tool source classifier. Required. */
  readonly classify: UsageSourceClassifier
  /** Existing collector state (for example the live collector's). */
  readonly state?: UsageCollectorState
  /**
   * Current session → workspace projection. Backfill never invents
   * `event-time` attribution: a resolved Session is `current-mapping`, every
   * other Session is `unknown`.
   */
  readonly workspaces?: ReadonlyMap<string, string>
  /** Resume token from a previous run for the same profile. */
  readonly cursor?: UsageBackfillCursor
  readonly limits?: Partial<UsageBackfillLimits>
  /** Cooperative cancellation observed before every page/session. */
  readonly signal?: AbortSignal
  /** Clock override for the runtime budget (tests, deterministic hosts). */
  readonly now?: () => number
  /** Optional report filter; the default report is unfiltered. */
  readonly reportFilter?: UsageReportFilter
}

const OWN_REASONS = Object.freeze({
  disabledProfile: 'backfill-disabled-profile-unknown',
  disabledService: 'backfill-disabled-service-unavailable',
  disabledClassifier: 'backfill-disabled-classifier-unavailable',
  listFailed: 'backfill-list-failed',
  openFailed: 'backfill-open-failed',
  readFailed: 'backfill-read-failed',
  invalidPage: 'backfill-invalid-page',
  shortPage: 'backfill-short-page',
  ingestFailed: 'backfill-ingest-failed',
  batchRejected: 'backfill-batch-rejected',
  closeFailed: 'backfill-close-failed',
  completionFailed: 'backfill-completion-failed',
  unexplained: 'backfill-unexplained-ingest',
  cancelled: 'backfill-cancelled',
  timeout: 'backfill-timeout',
  forkInheritedPrefix: 'fork-inherited-prefix',
  budget: 'backfill-budget-truncated',
})

type UnknownRecord = { readonly [key: string]: unknown }

interface MutableStats {
  listedSessions: number
  attemptedSessions: number
  completedSessions: number
  partialSessions: number
  failedSessions: number
  unverifiableSessions: number
  alreadyCompleteSessions: number
  eventsRead: number
  pagesRead: number
  acceptedEvents: number
  rejectedEvents: number
  cancelled: boolean
  timedOut: boolean
  truncated: boolean
  listFailures: number
  openFailures: number
  readFailures: number
  closeFailures: number
  completionFailures: number
  ingestFailures: number
  readonly reasons: Map<string, number>
}

interface ListedSession {
  readonly sessionId: string
  readonly revision: string
  readonly eventCount: number
}


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

function nonBlank(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim().length > 0 ? value : undefined
}

function safeNonNegativeInteger(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : undefined
}

function positiveInteger(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0 ? value : fallback
}

function positiveDuration(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : fallback
}

function resolveLimits(input: Partial<UsageBackfillLimits> | undefined): UsageBackfillLimits {
  return {
    maxSessions: positiveInteger(readField(input, 'maxSessions'), DEFAULT_USAGE_BACKFILL_LIMITS.maxSessions),
    maxEventsPerSession: positiveInteger(
      readField(input, 'maxEventsPerSession'),
      DEFAULT_USAGE_BACKFILL_LIMITS.maxEventsPerSession,
    ),
    maxTotalEvents: positiveInteger(
      readField(input, 'maxTotalEvents'),
      DEFAULT_USAGE_BACKFILL_LIMITS.maxTotalEvents,
    ),
    pageSize: positiveInteger(readField(input, 'pageSize'), DEFAULT_USAGE_BACKFILL_LIMITS.pageSize),
    maxRuntimeMs: positiveDuration(readField(input, 'maxRuntimeMs'), DEFAULT_USAGE_BACKFILL_LIMITS.maxRuntimeMs),
  }
}

function createStats(): MutableStats {
  return {
    listedSessions: 0,
    attemptedSessions: 0,
    completedSessions: 0,
    partialSessions: 0,
    failedSessions: 0,
    unverifiableSessions: 0,
    alreadyCompleteSessions: 0,
    eventsRead: 0,
    pagesRead: 0,
    acceptedEvents: 0,
    rejectedEvents: 0,
    cancelled: false,
    timedOut: false,
    truncated: false,
    listFailures: 0,
    openFailures: 0,
    readFailures: 0,
    closeFailures: 0,
    completionFailures: 0,
    ingestFailures: 0,
    reasons: new Map(),
  }
}

function countReason(stats: MutableStats, reason: string): void {
  stats.reasons.set(reason, (stats.reasons.get(reason) ?? 0) + 1)
}

function snapshotStats(stats: MutableStats, disabled?: UsageBackfillDisabledReason): UsageBackfillStats {
  return Object.freeze({
    listedSessions: stats.listedSessions,
    attemptedSessions: stats.attemptedSessions,
    completedSessions: stats.completedSessions,
    partialSessions: stats.partialSessions,
    failedSessions: stats.failedSessions,
    unverifiableSessions: stats.unverifiableSessions,
    alreadyCompleteSessions: stats.alreadyCompleteSessions,
    eventsRead: stats.eventsRead,
    pagesRead: stats.pagesRead,
    acceptedEvents: stats.acceptedEvents,
    rejectedEvents: stats.rejectedEvents,
    cancelled: stats.cancelled,
    timedOut: stats.timedOut,
    truncated: stats.truncated,
    listFailures: stats.listFailures,
    openFailures: stats.openFailures,
    readFailures: stats.readFailures,
    closeFailures: stats.closeFailures,
    completionFailures: stats.completionFailures,
    ingestFailures: stats.ingestFailures,
    ...(disabled === undefined ? {} : { disabled }),
    reasons: Object.freeze(Object.fromEntries(stats.reasons)),
  })
}

function lookupService(context: unknown, name: string): unknown {
  if (!isRecord(context)) return undefined
  const get = readField(context, 'get')
  if (typeof get !== 'function') return undefined
  try {
    return (get as (serviceName: string) => unknown).call(context, name)
  } catch {
    return undefined
  }
}

function isPersistenceService(value: unknown): value is SessionPersistence {
  return isRecord(value)
    && typeof readField(value, 'list') === 'function'
    && typeof readField(value, 'open') === 'function'
}

function isAborted(signal: AbortSignal | undefined): boolean {
  if (signal === undefined) return false
  try {
    return signal.aborted === true
  } catch {
    // An unreadable cancellation flag must fail closed.
    return true
  }
}

function normalizeCursor(value: unknown, profileHash: string): ReadonlyMap<string, UsageBackfillCursorEntry> {
  const entries = new Map<string, UsageBackfillCursorEntry>()
  if (!isRecord(value) || readField(value, 'profileHash') !== profileHash) return entries
  const rawEntries = readField(value, 'entries')
  if (!Array.isArray(rawEntries)) return entries
  for (const raw of rawEntries) {
    if (!isRecord(raw)) continue
    const sessionId = nonBlank(readField(raw, 'sessionId'))
    const nextOffset = safeNonNegativeInteger(readField(raw, 'nextOffset'))
    const revision = nonBlank(readField(raw, 'revision'))
    if (sessionId === undefined || nextOffset === undefined || revision === undefined) continue
    if (entries.has(sessionId)) continue
    entries.set(sessionId, { sessionId, nextOffset, revision })
  }
  return entries
}

/** Parse `list()` rows defensively; any unusable row blocks a `complete` run. */
function normalizeSnapshots(
  raw: readonly unknown[],
  stats: MutableStats,
): { readonly sessions: readonly ListedSession[]; readonly complete: boolean } {
  let complete = true
  const byId = new Map<string, { revision: string; eventCount: number; conflict: boolean }>()
  for (const row of raw) {
    const header = readField(row, 'header')
    const sessionId = nonBlank(readField(header, 'id'))
    const revision = nonBlank(readField(row, 'revision'))
    const eventCount = safeNonNegativeInteger(readField(row, 'eventCount'))
    if (sessionId === undefined || revision === undefined || eventCount === undefined) {
      stats.unverifiableSessions += 1
      complete = false
      continue
    }
    const existing = byId.get(sessionId)
    if (existing !== undefined) {
      if (existing.revision !== revision || existing.eventCount !== eventCount) existing.conflict = true
      continue
    }
    byId.set(sessionId, { revision, eventCount, conflict: false })
  }
  const sessions: ListedSession[] = []
  for (const [sessionId, row] of byId) {
    if (row.conflict) {
      stats.unverifiableSessions += 1
      complete = false
      continue
    }
    sessions.push({ sessionId, revision: row.revision, eventCount: row.eventCount })
  }
  sessions.sort((left, right) => left.sessionId.localeCompare(right.sessionId))
  return { sessions, complete }
}

/** Accept any contiguous prefix up to the requested maximum; callers mark short pages partial. */
function validatePage(page: unknown, offset: number, length: number): readonly SessionEvent[] | undefined {
  const events = readField(page, 'events')
  if (!Array.isArray(events) || events.length > length) return undefined
  for (let index = 0; index < events.length; index += 1) {
    const seq = safeNonNegativeInteger(readField(events[index], 'seq'))
    if (seq !== offset + index) return undefined
  }
  return events as readonly SessionEvent[]
}

function workspaceFor(workspaces: ReadonlyMap<string, string> | undefined, sessionId: string): UsageWorkspaceRef {
  const workspaceId = workspaces?.get(sessionId)
  return typeof workspaceId === 'string' && workspaceId.trim().length > 0
    ? { workspaceId, attribution: 'current-mapping' }
    : { attribution: 'unknown' }
}

function countOutcomes(stats: MutableStats, results: readonly UsageIngestBatchOutcome[]): boolean {
  let explainable = true
  for (const outcome of results) {
    countReason(stats, outcome.reason)
    if (outcome.accepted) {
      stats.acceptedEvents += 1
      continue
    }
    stats.rejectedEvents += 1
    // A replay of already-observed seq values is the only acceptable rejection.
    if (outcome.reason !== 'duplicate-event') explainable = false
  }
  return explainable
}

/** Do not checkpoint past the last event when completion could not be recorded. */
function incompleteCheckpoint(offset: number, eventCount: number): number {
  return offset >= eventCount && eventCount > 0 ? eventCount - 1 : offset
}

/**
 * Run one bounded backfill pass.
 *
 * The function never throws for ordinary Host failures: a missing service, a
 * missing profile, a throwing `list`/`open`/`read`/`close`, cancellation and
 * budget exhaustion all resolve to a result with honest stats. Malformed
 * options (a missing classifier) degrade to a disabled result as well.
 */
export async function runUsageBackfill(options: UsageBackfillOptions): Promise<UsageBackfillResult> {
  const stats = createStats()
  let state: UsageCollectorState
  try {
    state = options.state ?? createUsageCollectorState()
  } catch {
    state = createUsageCollectorState()
  }

  const report = (current: UsageCollectorState): UsageReport =>
    buildUsageReport(current.usage, options.reportFilter)
  const finish = (
    current: UsageCollectorState,
    coverageStatus: UsageCoverageStatus,
    cursor: UsageBackfillCursor | undefined,
    disabled?: UsageBackfillDisabledReason,
  ): UsageBackfillResult => ({
    state: current,
    ...(cursor === undefined ? {} : { cursor }),
    report: report(current),
    coverageStatus,
    stats: snapshotStats(stats, disabled),
  })

  const profile = resolveUsageProfile(options.context)
  if (profile.status !== 'available') {
    countReason(stats, OWN_REASONS.disabledProfile)
    return finish(state, 'unknown', undefined, 'profile-unknown')
  }

  if (typeof options.classify !== 'function') {
    countReason(stats, OWN_REASONS.disabledClassifier)
    return finish(state, 'unknown', undefined, 'classifier-unavailable')
  }

  const service = lookupService(options.context, 'sessionPersistence')
  if (!isPersistenceService(service)) {
    countReason(stats, OWN_REASONS.disabledService)
    return finish(state, 'unknown', undefined, 'session-persistence-unavailable')
  }

  const limits = resolveLimits(options.limits)
  const signal = options.signal
  const clock = options.now ?? Date.now
  const startedAt = ((): number => {
    try {
      return clock()
    } catch {
      return Number.NaN
    }
  })()
  const deadline = Number.isFinite(startedAt) ? startedAt + limits.maxRuntimeMs : undefined

  function runtimeExpired(): boolean {
    if (deadline === undefined) return false
    try {
      return clock() >= deadline
    } catch {
      return true
    }
  }

  const priorEntries = normalizeCursor(options.cursor, profile.hash)
  const nextEntries = new Map<string, UsageBackfillCursorEntry>(priorEntries)

  if (isAborted(signal)) {
    stats.cancelled = true
    countReason(stats, OWN_REASONS.cancelled)
    return finish(state, 'unknown', undefined)
  }
  if (runtimeExpired()) {
    stats.timedOut = true
    countReason(stats, OWN_REASONS.timeout)
    return finish(state, 'unknown', undefined)
  }

  let rawSnapshots: readonly SessionPersistenceSnapshot[]
  try {
    const listed = signal === undefined
      ? await service.list()
      : await service.list({ signal })
    if (!Array.isArray(listed)) {
      stats.listFailures += 1
      countReason(stats, OWN_REASONS.listFailed)
      return finish(state, 'unknown', undefined)
    }
    rawSnapshots = listed
  } catch {
    if (isAborted(signal)) {
      stats.cancelled = true
      countReason(stats, OWN_REASONS.cancelled)
    } else {
      stats.listFailures += 1
      countReason(stats, OWN_REASONS.listFailed)
    }
    return finish(state, 'unknown', undefined)
  }

  stats.listedSessions = rawSnapshots.length
  const normalized = normalizeSnapshots(rawSnapshots, stats)
  let completeAll = normalized.complete

  // A snapshot that no longer matches the cursor revision restarts at seq 0;
  // a cursor entry for a Session outside the current list is dropped.
  const listedIds = new Set(normalized.sessions.map(session => session.sessionId))
  const revisionById = new Map(normalized.sessions.map(session => [session.sessionId, session.revision] as const))
  for (const sessionId of [...nextEntries.keys()]) {
    if (!listedIds.has(sessionId)) nextEntries.delete(sessionId)
  }

  const pending: ListedSession[] = []
  for (const session of normalized.sessions) {
    const prior = priorEntries.get(session.sessionId)
    if (
      prior !== undefined
      && prior.revision === session.revision
      && prior.nextOffset === session.eventCount
    ) {
      stats.alreadyCompleteSessions += 1
      nextEntries.set(session.sessionId, {
        sessionId: session.sessionId,
        nextOffset: session.eventCount,
        revision: session.revision,
      })
      continue
    }
    pending.push(session)
  }

  const bounded = pending.slice(0, limits.maxSessions)
  if (pending.length > bounded.length) {
    stats.truncated = true
    completeAll = false
    countReason(stats, OWN_REASONS.budget)
    let usage = state.usage
    for (const session of pending.slice(bounded.length)) {
      usage = recordUsageCoverage(usage, session.sessionId, {
        status: 'partial',
        reason: OWN_REASONS.budget,
        skippedSessions: 1,
      })
    }
    state = { ...state, usage }
  }

  for (const session of bounded) {
    if (isAborted(signal)) {
      stats.cancelled = true
      completeAll = false
      countReason(stats, OWN_REASONS.cancelled)
      break
    }
    if (runtimeExpired()) {
      stats.timedOut = true
      completeAll = false
      countReason(stats, OWN_REASONS.timeout)
      break
    }

    stats.attemptedSessions += 1
    const prior = priorEntries.get(session.sessionId)
    let startOffset = 0
    if (
      prior !== undefined
      && prior.revision === session.revision
      && prior.nextOffset <= session.eventCount
    ) {
      startOffset = prior.nextOffset
    }

    // An empty stored Session needs no completion transition: there is no
    // `seq` whose coverage could be marked, and no event to aggregate.
    if (session.eventCount === 0) {
      stats.completedSessions += 1
      nextEntries.set(session.sessionId, {
        sessionId: session.sessionId,
        nextOffset: 0,
        revision: session.revision,
      })
      continue
    }

    let handle: SessionHandle | undefined
    let inheritedEventCount = 0
    try {
      handle = await service.open(session.sessionId as SessionId, 'read', { signal })
      const inherited = safeNonNegativeInteger(readField(handle, 'inheritedEventCount'))
      if (inherited === undefined || inherited > session.eventCount) {
        stats.readFailures += 1
        stats.failedSessions += 1
        completeAll = false
        countReason(stats, OWN_REASONS.invalidPage)
        try { await handle.close() } catch {
          stats.closeFailures += 1
          countReason(stats, OWN_REASONS.closeFailed)
        }
        nextEntries.set(session.sessionId, {
          sessionId: session.sessionId,
          nextOffset: startOffset,
          revision: session.revision,
        })
        continue
      }
      inheritedEventCount = inherited
    } catch {
      if (isAborted(signal)) {
        stats.cancelled = true
        completeAll = false
        countReason(stats, OWN_REASONS.cancelled)
        break
      }
      stats.openFailures += 1
      stats.failedSessions += 1
      completeAll = false
      countReason(stats, OWN_REASONS.openFailed)
      nextEntries.set(session.sessionId, {
        sessionId: session.sessionId,
        nextOffset: startOffset,
        revision: session.revision,
      })
      continue
    }

    let offset = Math.max(startOffset, inheritedEventCount)
    let sessionRead = 0
    let cancelled = false
    let timedOut = false
    let truncated = false
    let shortPage = false
    let failure = false
    let explainable = true
    let closeFailed = false
    let completionFailed = false

    try {
      while (offset < session.eventCount) {
        if (isAborted(signal)) {
          cancelled = true
          break
        }
        if (runtimeExpired()) {
          timedOut = true
          break
        }
        const remainingSession = limits.maxEventsPerSession - sessionRead
        const remainingTotal = limits.maxTotalEvents - stats.eventsRead
        const take = Math.min(
          limits.pageSize,
          remainingSession,
          remainingTotal,
          session.eventCount - offset,
        )
        if (take <= 0) {
          truncated = true
          break
        }

        let page: SessionHandleReadResult
        try {
          page = await handle.read(offset, take, { signal })
        } catch {
          if (isAborted(signal)) {
            cancelled = true
          } else {
            stats.readFailures += 1
            countReason(stats, OWN_REASONS.readFailed)
            failure = true
          }
          break
        }

        // A page that resolved after cancellation is discarded: reads are
        // side-effect-free, and a cancelled run must not claim progress or
        // completion from work the caller tried to stop.
        if (isAborted(signal)) {
          cancelled = true
          break
        }

        const events = validatePage(page, offset, take)
        if (events === undefined) {
          stats.readFailures += 1
          countReason(stats, OWN_REASONS.invalidPage)
          failure = true
          break
        }

        stats.eventsRead += events.length
        sessionRead += events.length

        const workspace = workspaceFor(options.workspaces, session.sessionId)
        const inputs = events.map(event => ({
          kind: 'session-event' as const,
          sessionId: session.sessionId,
          event,
          workspace,
          classify: options.classify,
          origin: 'backfill' as const,
        }))

        let batch
        try {
          batch = ingestUsageSessionEvents(state, inputs)
        } catch {
          stats.ingestFailures += 1
          countReason(stats, OWN_REASONS.ingestFailed)
          failure = true
          break
        }

        if (batch.rejectedReason !== undefined) {
          stats.ingestFailures += 1
          countReason(stats, OWN_REASONS.batchRejected)
          failure = true
          break
        }

        state = batch.state
        stats.pagesRead += 1
        const pageExplainable = countOutcomes(stats, batch.results)
        if (!pageExplainable) {
          completeAll = false
          countReason(stats, OWN_REASONS.unexplained)
          explainable = false
          // Keep the checkpoint before the first unacceptable event so a later
          // run can retry exactly that record instead of claiming completion.
          const firstRejected = batch.results.findIndex(
            outcome => !outcome.accepted && outcome.reason !== 'duplicate-event',
          )
          offset += firstRejected < 0 ? events.length : firstRejected
          break
        }
        offset += events.length
        if (events.length < take) {
          shortPage = true
          break
        }
      }
    } finally {
      if (handle !== undefined) {
        try {
          await handle.close()
        } catch {
          closeFailed = true
          stats.closeFailures += 1
          countReason(stats, OWN_REASONS.closeFailed)
        }
      }
    }

    if (cancelled) {
      stats.cancelled = true
      stats.partialSessions += 1
      completeAll = false
      countReason(stats, OWN_REASONS.cancelled)
    } else if (timedOut) {
      stats.timedOut = true
      stats.partialSessions += 1
      completeAll = false
      countReason(stats, OWN_REASONS.timeout)
    } else if (failure || closeFailed || !explainable) {
      stats.failedSessions += 1
      completeAll = false
    } else if (truncated || shortPage || offset < session.eventCount) {
      stats.partialSessions += 1
      if (truncated) stats.truncated = true
      completeAll = false
      countReason(stats, shortPage ? OWN_REASONS.shortPage : OWN_REASONS.budget)
    } else {
      // Every event in `[0, eventCount)` has been read. The completion is the
      // only point that upgrades coverage to `complete`; data-quality reasons
      // already recorded by the collector survive it.
      try {
        const completion = ingestUsageSessionEvent(state, {
          kind: 'backfill-complete',
          sessionId: session.sessionId,
          fromSeq: inheritedEventCount,
          throughSeq: session.eventCount - 1,
          verified: true,
        })
        countReason(stats, completion.reason)
        if (!completion.accepted || completion.reason !== 'backfill-completed') {
          stats.completionFailures += 1
          stats.failedSessions += 1
          completionFailed = true
          completeAll = false
          countReason(stats, OWN_REASONS.completionFailed)
        } else {
          state = completion.state
          stats.completedSessions += 1
          if (inheritedEventCount > 0) {
            const usage = recordUsageCoverage(state.usage, session.sessionId, {
              status: 'partial',
              reason: OWN_REASONS.forkInheritedPrefix,
              skippedSessions: 1,
              skippedEvents: inheritedEventCount,
            })
            state = { ...state, usage }
            completeAll = false
          }
          offset = session.eventCount
        }
      } catch {
        stats.completionFailures += 1
        stats.failedSessions += 1
        completionFailed = true
        completeAll = false
        countReason(stats, OWN_REASONS.completionFailed)
      }
    }

    const checkpoint = closeFailed || completionFailed
      ? incompleteCheckpoint(offset, session.eventCount)
      : offset
    nextEntries.set(session.sessionId, {
      sessionId: session.sessionId,
      nextOffset: Math.min(checkpoint, session.eventCount),
      revision: session.revision,
    })
  }

  const cursorEntries = [...nextEntries.values()]
    .filter(entry => listedIds.has(entry.sessionId) && revisionById.get(entry.sessionId) === entry.revision)
    .sort((left, right) => left.sessionId.localeCompare(right.sessionId))
  const cursor: UsageBackfillCursor = {
    profileHash: profile.hash,
    entries: cursorEntries.map(entry => ({
      sessionId: entry.sessionId,
      nextOffset: entry.nextOffset,
      revision: entry.revision,
    })),
  }

  return finish(state, completeAll ? 'complete' : 'partial', cursor)
}
