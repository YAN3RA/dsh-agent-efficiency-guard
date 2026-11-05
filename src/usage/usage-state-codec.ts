import type {
  UsageAggregate,
  UsageCallState,
  UsageCapabilityKind,
  UsageCoverageStatus,
  UsageLimits,
  UsageResultOutcome,
  UsageSessionCoverage,
  UsageState,
  WorkspaceAttribution,
} from './usage-core.ts'

/**
 * Versioned, JSON-storable projection of {@link UsageState}.
 *
 * The codec is deliberately pure: it does not read or write files, resolve Host
 * paths, inspect Session events, or accept raw arguments/messages/tool bodies.
 * Only the metadata already present in `UsageState` is encoded.
 *
 * Version 1 is the first persisted schema. There is no migration path from an
 * older schema because none exists. A document with any other version, a
 * missing/extra field, a wrong type, or a value over its budget is rejected as
 * a whole; no map, set, counter, or string is silently cleared or truncated.
 */
export const USAGE_STATE_SCHEMA = 'dsh-agent-efficiency-guard/usage-state'
export const USAGE_STATE_SCHEMA_VERSION = 1

export type UsageStateCodecErrorCode =
  | 'invalid-json'
  | 'invalid-document'
  | 'unsupported-version'
  | 'limit-exceeded'
  | 'inconsistent-state'

export class UsageStateCodecError extends Error {
  constructor(
    readonly code: UsageStateCodecErrorCode,
    readonly path: string,
    message: string,
  ) {
    super(`${path}: ${message}`)
    this.name = 'UsageStateCodecError'
  }
}

export interface UsageStateDocumentLimits {
  readonly maxEvents: number
  readonly maxCalls: number
  readonly maxCoverageReasons: number
  readonly maxErrorCodeLength: number
}

export interface UsageStateDocumentSeenEvent {
  readonly sessionId: string
  readonly seq: number
}

export interface UsageStateDocumentCall {
  readonly sessionId: string
  readonly callId: string
  /** Zero-based index into `aggregates`; avoids persisting opaque map keys. */
  readonly aggregateIndex: number
  readonly result?: UsageResultOutcome
}

export interface UsageStateDocumentError {
  readonly code: string
  readonly count: number
}

export interface UsageStateDocumentAggregate {
  readonly sessionId: string
  readonly date: string
  readonly workspaceId?: string
  readonly workspaceAttribution: WorkspaceAttribution
  readonly capabilityId: string
  readonly capabilityKind: UsageCapabilityKind
  readonly providerId?: string
  readonly calls: number
  readonly succeeded: number
  readonly failed: number
  readonly denied: number
  readonly cancelled: number
  readonly unresolved: number
  readonly firstObservedAt: number
  readonly lastUsedAt?: number
  readonly errors: readonly UsageStateDocumentError[]
}

export interface UsageStateDocumentCoverage {
  readonly sessionId: string
  readonly status: UsageCoverageStatus
  readonly fromSeq?: number
  readonly throughSeq?: number
  readonly skippedSessions: number
  readonly skippedEvents: number
  readonly reasons: readonly string[]
  readonly reasonsTruncated: boolean
}

export interface UsageStateDocumentTotals {
  readonly totalEvents: number
  readonly totalCalls: number
  readonly stoppedByLimit: boolean
  readonly orphanResults: number
  readonly duplicateResults: number
}

export interface UsageStateDocument {
  readonly schema: typeof USAGE_STATE_SCHEMA
  readonly version: typeof USAGE_STATE_SCHEMA_VERSION
  readonly limits: UsageStateDocumentLimits
  readonly seenEvents: readonly UsageStateDocumentSeenEvent[]
  readonly calls: readonly UsageStateDocumentCall[]
  readonly aggregates: readonly UsageStateDocumentAggregate[]
  readonly coverage: readonly UsageStateDocumentCoverage[]
  readonly totals: UsageStateDocumentTotals
}

/**
 * Hard limits applied to a persisted document.
 *
 * `UsageLimits` already bounds events, calls, coverage reasons, and error-code
 * length. The remaining budgets are conservative constants because the Host
 * does not publish a storage/row limit for this plugin-local data. They are
 * intentionally independent of Host paths and filesystem policy.
 */
export interface UsageStateCodecLimits {
  /** UTF-8 bytes of the serialized JSON document. */
  readonly maxDocumentBytes: number
  /** Number of persisted coverage sessions (UsageLimits has no such field). */
  readonly maxCoverageSessions: number
  readonly maxSessionIdLength: number
  readonly maxWorkspaceIdLength: number
  readonly maxCallIdLength: number
  readonly maxCapabilityIdLength: number
  readonly maxProviderIdLength: number
  /** Matches the 256-character slice applied by usage-core when adding reasons. */
  readonly maxReasonLength: number
}

export const DEFAULT_USAGE_STATE_CODEC_LIMITS: UsageStateCodecLimits = Object.freeze({
  maxDocumentBytes: 16 * 1024 * 1024,
  maxCoverageSessions: 4_096,
  maxSessionIdLength: 512,
  maxWorkspaceIdLength: 512,
  maxCallIdLength: 512,
  maxCapabilityIdLength: 512,
  maxProviderIdLength: 512,
  maxReasonLength: 256,
})

export type UsageStateCodecOptions = Partial<UsageStateCodecLimits>

const CODEC_LIMIT_KEYS = [
  'maxDocumentBytes',
  'maxCoverageSessions',
  'maxSessionIdLength',
  'maxWorkspaceIdLength',
  'maxCallIdLength',
  'maxCapabilityIdLength',
  'maxProviderIdLength',
  'maxReasonLength',
] as const satisfies readonly (keyof UsageStateCodecLimits)[]

const COVERAGE_STATUSES: readonly UsageCoverageStatus[] = ['complete', 'partial', 'unknown']
const CAPABILITY_KINDS: readonly UsageCapabilityKind[] = ['mcp', 'plugin-tool', 'native', 'skill', 'unknown']
const WORKSPACE_ATTRIBUTIONS: readonly WorkspaceAttribution[] = ['event-time', 'current-mapping', 'unknown']
const RESULT_OUTCOMES: readonly UsageResultOutcome[] = ['success', 'error', 'denied', 'cancelled']
const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/
const ERROR_CODE_PATTERN = /^[A-Za-z0-9_.:-]+$/
const TEXT_ENCODER = new TextEncoder()

function fail(code: UsageStateCodecErrorCode, path: string, message: string): never {
  throw new UsageStateCodecError(code, path, message)
}

function childPath(path: string, key: string): string {
  return `${path}.${key}`
}

function itemPath(path: string, index: number): string {
  return `${path}[${index}]`
}

function hasOwn(value: Record<string, unknown>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(value, key)
}

function resolveCodecLimits(options: UsageStateCodecOptions): UsageStateCodecLimits {
  const resolved = { ...DEFAULT_USAGE_STATE_CODEC_LIMITS }
  for (const key of CODEC_LIMIT_KEYS) {
    const value = options[key]
    if (value === undefined) continue
    if (!Number.isSafeInteger(value) || value < 1) {
      fail('invalid-document', `options.${key}`, 'must be a positive safe integer')
    }
    resolved[key] = value
  }
  return resolved
}

function expectPlainObject(value: unknown, path: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    fail('invalid-document', path, 'must be a plain object')
  }
  const prototype = Object.getPrototypeOf(value)
  if (prototype !== Object.prototype && prototype !== null) {
    fail('invalid-document', path, 'must be a plain object')
  }
  return value as Record<string, unknown>
}

function expectObject(
  value: unknown,
  path: string,
  required: readonly string[],
  optional: readonly string[] = [],
): Record<string, unknown> {
  const record = expectPlainObject(value, path)
  const allowed = new Set<string>([...required, ...optional])
  for (const key of Object.keys(record)) {
    if (!allowed.has(key)) fail('invalid-document', childPath(path, key), 'is not allowed')
  }
  for (const key of required) {
    if (!hasOwn(record, key)) fail('invalid-document', childPath(path, key), 'is required')
  }
  return record
}

function expectArray(value: unknown, path: string, maxLength?: number): readonly unknown[] {
  if (!Array.isArray(value)) fail('invalid-document', path, 'must be an array')
  if (maxLength !== undefined && value.length > maxLength) {
    fail('limit-exceeded', path, `must contain at most ${maxLength} rows`)
  }
  return value
}

function expectString(value: unknown, path: string, maxLength: number): string {
  if (typeof value !== 'string') fail('invalid-document', path, 'must be a string')
  if (value.length > maxLength) fail('limit-exceeded', path, `must be at most ${maxLength} characters`)
  if (value.trim().length === 0) fail('invalid-document', path, 'must not be empty')
  return value
}

function expectText(value: unknown, path: string, maxLength: number): string {
  if (typeof value !== 'string') fail('invalid-document', path, 'must be a string')
  if (value.length > maxLength) fail('limit-exceeded', path, `must be at most ${maxLength} characters`)
  if (value.length === 0) fail('invalid-document', path, 'must not be empty')
  return value
}

function expectInteger(value: unknown, path: string, minimum = 0): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < minimum) {
    fail(
      'invalid-document',
      path,
      minimum === 0 ? 'must be a non-negative safe integer' : `must be a safe integer >= ${minimum}`,
    )
  }
  return value
}

function expectBoolean(value: unknown, path: string): boolean {
  if (typeof value !== 'boolean') fail('invalid-document', path, 'must be a boolean')
  return value
}

function expectTimestamp(value: unknown, path: string): number {
  if (
    typeof value !== 'number'
    || !Number.isFinite(value)
    || Number.isNaN(new Date(value).getTime())
  ) {
    fail('invalid-document', path, 'must be a finite timestamp')
  }
  return value
}

function expectDate(value: unknown, path: string): string {
  if (typeof value !== 'string' || !DATE_PATTERN.test(value)) {
    fail('invalid-document', path, 'must be an ISO calendar date (YYYY-MM-DD)')
  }
  const parsed = Date.parse(`${value}T00:00:00.000Z`)
  if (!Number.isFinite(parsed) || new Date(parsed).toISOString().slice(0, 10) !== value) {
    fail('invalid-document', path, 'must be a valid ISO calendar date')
  }
  return value
}

function expectEnum<T extends string>(value: unknown, allowed: readonly T[], path: string): T {
  if (typeof value !== 'string' || !allowed.includes(value as T)) {
    fail('invalid-document', path, `must be one of ${allowed.join(', ')}`)
  }
  return value as T
}

function expectErrorCode(value: unknown, path: string, limits: UsageLimits): string {
  const code = expectText(value, path, limits.maxErrorCodeLength)
  if (!ERROR_CODE_PATTERN.test(code)) {
    fail('invalid-document', path, 'contains unsupported characters')
  }
  return code
}

function eventKey(sessionId: string, seq: number): string {
  return JSON.stringify([sessionId, seq])
}

function callKey(sessionId: string, callId: string): string {
  return JSON.stringify([sessionId, callId])
}

/**
 * Mirrors the private key derivation in `usage-core.ts`. If that derivation
 * changes, this document format must move to a new schema version.
 */
function aggregateKeyFromFields(
  sessionId: string,
  date: string,
  workspaceId: string | undefined,
  workspaceAttribution: WorkspaceAttribution,
  capabilityId: string,
  capabilityKind: UsageCapabilityKind,
  providerId: string | undefined,
): string {
  return JSON.stringify([
    sessionId,
    date,
    workspaceId ?? null,
    workspaceAttribution,
    capabilityId,
    capabilityKind,
    providerId ?? null,
  ])
}

function aggregateKey(aggregate: UsageAggregate): string {
  return aggregateKeyFromFields(
    aggregate.sessionId,
    aggregate.date,
    aggregate.workspaceId,
    aggregate.workspaceAttribution,
    aggregate.capabilityId,
    aggregate.capabilityKind,
    aggregate.providerId,
  )
}

function parseTuple(key: unknown, path: string): readonly unknown[] {
  if (typeof key !== 'string') fail('inconsistent-state', path, 'must be a string key')
  let parsed: unknown = undefined
  try {
    parsed = JSON.parse(key)
  } catch {
    fail('inconsistent-state', path, 'is not a valid composite key')
  }
  if (!Array.isArray(parsed) || parsed.length !== 2) {
    fail('inconsistent-state', path, 'is not a valid composite key')
  }
  return parsed
}

function parseEventKey(key: unknown, path: string): UsageStateDocumentSeenEvent {
  const parsed = parseTuple(key, path)
  if (typeof parsed[0] !== 'string' || !Number.isSafeInteger(parsed[1]) || (parsed[1] as number) < 0) {
    fail('inconsistent-state', path, 'is not a valid event key')
  }
  return { sessionId: parsed[0], seq: parsed[1] as number }
}

function parseCallKey(key: unknown, path: string): { sessionId: string; callId: string } {
  const parsed = parseTuple(key, path)
  if (typeof parsed[0] !== 'string' || typeof parsed[1] !== 'string') {
    fail('inconsistent-state', path, 'is not a valid call key')
  }
  return { sessionId: parsed[0], callId: parsed[1] }
}

function measureDocument(document: UsageStateDocument, maxBytes: number): void {
  let json: string
  try {
    json = JSON.stringify(document)
  } catch {
    fail('invalid-document', '$', 'must be JSON serializable')
  }
  if (typeof json !== 'string') fail('invalid-document', '$', 'must be JSON serializable')
  const bytes = TEXT_ENCODER.encode(json).byteLength
  if (bytes > maxBytes) {
    fail('limit-exceeded', '$', `document is ${bytes} UTF-8 bytes; limit is ${maxBytes}`)
  }
}

function readLimits(value: unknown): UsageLimits {
  const record = expectObject(value, '$.limits', [
    'maxEvents',
    'maxCalls',
    'maxCoverageReasons',
    'maxErrorCodeLength',
  ])
  return {
    maxEvents: expectInteger(record.maxEvents, '$.limits.maxEvents', 1),
    maxCalls: expectInteger(record.maxCalls, '$.limits.maxCalls', 1),
    maxCoverageReasons: expectInteger(record.maxCoverageReasons, '$.limits.maxCoverageReasons', 1),
    maxErrorCodeLength: expectInteger(record.maxErrorCodeLength, '$.limits.maxErrorCodeLength', 1),
  }
}

function readSeenEvents(
  value: unknown,
  limits: UsageLimits,
  codec: UsageStateCodecLimits,
): UsageStateDocumentSeenEvent[] {
  const rows = expectArray(value, '$.seenEvents', limits.maxEvents)
  const events: UsageStateDocumentSeenEvent[] = []
  const keys = new Set<string>()
  rows.forEach((row, index) => {
    const path = itemPath('$.seenEvents', index)
    const record = expectObject(row, path, ['sessionId', 'seq'])
    const event: UsageStateDocumentSeenEvent = {
      sessionId: expectString(record.sessionId, `${path}.sessionId`, codec.maxSessionIdLength),
      seq: expectInteger(record.seq, `${path}.seq`, 0),
    }
    const key = eventKey(event.sessionId, event.seq)
    if (keys.has(key)) fail('inconsistent-state', path, 'duplicates an earlier event')
    keys.add(key)
    events.push(event)
  })
  return events
}

function readCalls(value: unknown, limits: UsageLimits, codec: UsageStateCodecLimits): UsageStateDocumentCall[] {
  const rows = expectArray(value, '$.calls', limits.maxCalls)
  const calls: UsageStateDocumentCall[] = []
  const keys = new Set<string>()
  rows.forEach((row, index) => {
    const path = itemPath('$.calls', index)
    const record = expectObject(row, path, ['sessionId', 'callId', 'aggregateIndex'], ['result'])
    const call: UsageStateDocumentCall = {
      sessionId: expectString(record.sessionId, `${path}.sessionId`, codec.maxSessionIdLength),
      callId: expectString(record.callId, `${path}.callId`, codec.maxCallIdLength),
      aggregateIndex: expectInteger(record.aggregateIndex, `${path}.aggregateIndex`, 0),
      ...(hasOwn(record, 'result')
        ? { result: expectEnum(record.result, RESULT_OUTCOMES, `${path}.result`) }
        : {}),
    }
    const key = callKey(call.sessionId, call.callId)
    if (keys.has(key)) fail('inconsistent-state', path, 'duplicates an earlier call')
    keys.add(key)
    calls.push(call)
  })
  return calls
}

interface AggregateRow {
  readonly key: string
  readonly document: UsageStateDocumentAggregate
  readonly errors: readonly (readonly [string, number])[]
}

function readAggregates(
  value: unknown,
  limits: UsageLimits,
  codec: UsageStateCodecLimits,
): AggregateRow[] {
  const rows = expectArray(value, '$.aggregates', limits.maxCalls)
  const aggregates: AggregateRow[] = []
  const keys = new Set<string>()
  rows.forEach((row, index) => {
    const path = itemPath('$.aggregates', index)
    const record = expectObject(
      row,
      path,
      [
        'sessionId',
        'date',
        'workspaceAttribution',
        'capabilityId',
        'capabilityKind',
        'calls',
        'succeeded',
        'failed',
        'denied',
        'cancelled',
        'unresolved',
        'firstObservedAt',
        'errors',
      ],
      ['workspaceId', 'providerId', 'lastUsedAt'],
    )
    const sessionId = expectString(record.sessionId, `${path}.sessionId`, codec.maxSessionIdLength)
    const date = expectDate(record.date, `${path}.date`)
    const workspaceAttribution = expectEnum(
      record.workspaceAttribution,
      WORKSPACE_ATTRIBUTIONS,
      `${path}.workspaceAttribution`,
    )
    const workspaceId = hasOwn(record, 'workspaceId')
      ? expectString(record.workspaceId, `${path}.workspaceId`, codec.maxWorkspaceIdLength)
      : undefined
    if (workspaceAttribution === 'event-time' && workspaceId === undefined) {
      fail('inconsistent-state', `${path}.workspaceId`, 'is required for event-time attribution')
    }
    const capabilityId = expectString(record.capabilityId, `${path}.capabilityId`, codec.maxCapabilityIdLength)
    const capabilityKind = expectEnum(record.capabilityKind, CAPABILITY_KINDS, `${path}.capabilityKind`)
    const providerId = hasOwn(record, 'providerId')
      ? expectString(record.providerId, `${path}.providerId`, codec.maxProviderIdLength)
      : undefined
    if ((capabilityKind === 'mcp' || capabilityKind === 'plugin-tool') && providerId === undefined) {
      fail('inconsistent-state', `${path}.providerId`, 'is required for this capability kind')
    }
    if ((capabilityKind === 'native' || capabilityKind === 'unknown') && providerId !== undefined) {
      fail('inconsistent-state', `${path}.providerId`, 'is not allowed for this capability kind')
    }
    const calls = expectInteger(record.calls, `${path}.calls`, 1)
    const succeeded = expectInteger(record.succeeded, `${path}.succeeded`, 0)
    const failed = expectInteger(record.failed, `${path}.failed`, 0)
    const denied = expectInteger(record.denied, `${path}.denied`, 0)
    const cancelled = expectInteger(record.cancelled, `${path}.cancelled`, 0)
    const unresolved = expectInteger(record.unresolved, `${path}.unresolved`, 0)
    if (succeeded + failed + denied + cancelled + unresolved !== calls) {
      fail('inconsistent-state', path, 'outcome counters must add up to calls')
    }
    const firstObservedAt = expectTimestamp(record.firstObservedAt, `${path}.firstObservedAt`)
    const lastUsedAt = hasOwn(record, 'lastUsedAt')
      ? expectTimestamp(record.lastUsedAt, `${path}.lastUsedAt`)
      : undefined
    if (lastUsedAt !== undefined && lastUsedAt < firstObservedAt) {
      fail('inconsistent-state', `${path}.lastUsedAt`, 'must not precede firstObservedAt')
    }

    const errorRows = expectArray(record.errors, `${path}.errors`, calls)
    const errorDocuments: UsageStateDocumentError[] = []
    const errorPairs: (readonly [string, number])[] = []
    const errorCodes = new Set<string>()
    let errorTotal = 0
    errorRows.forEach((errorRow, errorIndex) => {
      const errorPath = itemPath(`${path}.errors`, errorIndex)
      const errorRecord = expectObject(errorRow, errorPath, ['code', 'count'])
      const code = expectErrorCode(errorRecord.code, `${errorPath}.code`, limits)
      const count = expectInteger(errorRecord.count, `${errorPath}.count`, 1)
      if (errorCodes.has(code)) fail('inconsistent-state', errorPath, 'duplicates an error code')
      errorCodes.add(code)
      errorTotal += count
      errorDocuments.push({ code, count })
      errorPairs.push([code, count])
    })
    if (!Number.isSafeInteger(errorTotal) || errorTotal > failed) {
      fail('inconsistent-state', `${path}.errors`, 'error counts cannot exceed failed calls')
    }

    const key = aggregateKeyFromFields(
      sessionId,
      date,
      workspaceId,
      workspaceAttribution,
      capabilityId,
      capabilityKind,
      providerId,
    )
    if (keys.has(key)) fail('inconsistent-state', path, 'duplicates an earlier aggregate')
    keys.add(key)
    aggregates.push({
      key,
      errors: errorPairs,
      document: {
        sessionId,
        date,
        ...(workspaceId !== undefined ? { workspaceId } : {}),
        workspaceAttribution,
        capabilityId,
        capabilityKind,
        ...(providerId !== undefined ? { providerId } : {}),
        calls,
        succeeded,
        failed,
        denied,
        cancelled,
        unresolved,
        firstObservedAt,
        ...(lastUsedAt !== undefined ? { lastUsedAt } : {}),
        errors: errorDocuments,
      },
    })
  })
  return aggregates
}

function readCoverage(
  value: unknown,
  limits: UsageLimits,
  codec: UsageStateCodecLimits,
): UsageStateDocumentCoverage[] {
  const rows = expectArray(value, '$.coverage', codec.maxCoverageSessions)
  const coverage: UsageStateDocumentCoverage[] = []
  const sessionIds = new Set<string>()
  rows.forEach((row, index) => {
    const path = itemPath('$.coverage', index)
    const record = expectObject(
      row,
      path,
      ['sessionId', 'status', 'skippedSessions', 'skippedEvents', 'reasons', 'reasonsTruncated'],
      ['fromSeq', 'throughSeq'],
    )
    const sessionId = expectString(record.sessionId, `${path}.sessionId`, codec.maxSessionIdLength)
    if (sessionIds.has(sessionId)) fail('inconsistent-state', path, 'duplicates an earlier coverage session')
    sessionIds.add(sessionId)
    const status = expectEnum(record.status, COVERAGE_STATUSES, `${path}.status`)
    const fromSeq = hasOwn(record, 'fromSeq')
      ? expectInteger(record.fromSeq, `${path}.fromSeq`, 0)
      : undefined
    const throughSeq = hasOwn(record, 'throughSeq')
      ? expectInteger(record.throughSeq, `${path}.throughSeq`, 0)
      : undefined
    if (fromSeq !== undefined && throughSeq !== undefined && fromSeq > throughSeq) {
      fail('inconsistent-state', `${path}.fromSeq`, 'must not exceed throughSeq')
    }
    const skippedSessions = expectInteger(record.skippedSessions, `${path}.skippedSessions`, 0)
    const skippedEvents = expectInteger(record.skippedEvents, `${path}.skippedEvents`, 0)
    const reasonRows = expectArray(record.reasons, `${path}.reasons`, limits.maxCoverageReasons)
    const reasons: string[] = []
    const seenReasons = new Set<string>()
    reasonRows.forEach((reason, reasonIndex) => {
      const reasonPath = itemPath(`${path}.reasons`, reasonIndex)
      const text = expectText(reason, reasonPath, codec.maxReasonLength)
      if (seenReasons.has(text)) fail('inconsistent-state', reasonPath, 'duplicates an earlier reason')
      seenReasons.add(text)
      reasons.push(text)
    })
    const reasonsTruncated = expectBoolean(record.reasonsTruncated, `${path}.reasonsTruncated`)
    if (reasonsTruncated && reasons.length !== limits.maxCoverageReasons) {
      fail(
        'inconsistent-state',
        `${path}.reasonsTruncated`,
        'requires reasons at the configured maxCoverageReasons limit',
      )
    }
    coverage.push({
      sessionId,
      status,
      ...(fromSeq !== undefined ? { fromSeq } : {}),
      ...(throughSeq !== undefined ? { throughSeq } : {}),
      skippedSessions,
      skippedEvents,
      reasons,
      reasonsTruncated,
    })
  })
  return coverage
}

function readTotals(value: unknown): UsageStateDocumentTotals {
  const record = expectObject(value, '$.totals', [
    'totalEvents',
    'totalCalls',
    'stoppedByLimit',
    'orphanResults',
    'duplicateResults',
  ])
  return {
    totalEvents: expectInteger(record.totalEvents, '$.totals.totalEvents', 0),
    totalCalls: expectInteger(record.totalCalls, '$.totals.totalCalls', 0),
    stoppedByLimit: expectBoolean(record.stoppedByLimit, '$.totals.stoppedByLimit'),
    orphanResults: expectInteger(record.orphanResults, '$.totals.orphanResults', 0),
    duplicateResults: expectInteger(record.duplicateResults, '$.totals.duplicateResults', 0),
  }
}

function decodeDocument(value: unknown, codec: UsageStateCodecLimits): UsageState {
  const root = expectObject(value, '$', [
    'schema',
    'version',
    'limits',
    'seenEvents',
    'calls',
    'aggregates',
    'coverage',
    'totals',
  ])
  if (root.version !== USAGE_STATE_SCHEMA_VERSION) {
    if (
      typeof root.version !== 'number'
      || !Number.isSafeInteger(root.version)
      || root.version < 1
    ) {
      fail('invalid-document', '$.version', 'must be a positive safe integer')
    }
    fail('unsupported-version', '$.version', `only version ${USAGE_STATE_SCHEMA_VERSION} is supported`)
  }
  if (root.schema !== USAGE_STATE_SCHEMA) {
    fail('invalid-document', '$.schema', `must be ${USAGE_STATE_SCHEMA}`)
  }

  const limits = readLimits(root.limits)
  const seenEvents = readSeenEvents(root.seenEvents, limits, codec)
  const calls = readCalls(root.calls, limits, codec)
  const aggregateRows = readAggregates(root.aggregates, limits, codec)
  const coverage = readCoverage(root.coverage, limits, codec)
  const totals = readTotals(root.totals)

  const aggregateKeys = aggregateRows.map(row => row.key)
  calls.forEach((call, index) => {
    const target = aggregateRows[call.aggregateIndex]
    if (target === undefined) {
      fail(
        'inconsistent-state',
        `${itemPath('$.calls', index)}.aggregateIndex`,
        'does not reference an aggregate in this document',
      )
    }
    if (target.document.sessionId !== call.sessionId) {
      fail(
        'inconsistent-state',
        `${itemPath('$.calls', index)}.aggregateIndex`,
        'must reference an aggregate in the same session',
      )
    }
  })

  if (totals.totalEvents !== seenEvents.length) {
    fail('inconsistent-state', '$.totals.totalEvents', 'must equal the number of seen events')
  }
  if (totals.totalEvents > limits.maxEvents) {
    fail('limit-exceeded', '$.totals.totalEvents', `must not exceed ${limits.maxEvents}`)
  }
  if (totals.totalCalls > limits.maxCalls) {
    fail('limit-exceeded', '$.totals.totalCalls', `must not exceed ${limits.maxCalls}`)
  }
  if (calls.length > totals.totalCalls) {
    fail('inconsistent-state', '$.calls', 'cannot contain more calls than totalCalls')
  }
  if (totals.orphanResults > totals.totalEvents) {
    fail('inconsistent-state', '$.totals.orphanResults', 'cannot exceed totalEvents')
  }
  if (totals.duplicateResults > totals.totalEvents) {
    fail('inconsistent-state', '$.totals.duplicateResults', 'cannot exceed totalEvents')
  }

  let aggregateCallTotal = 0
  for (const row of aggregateRows) aggregateCallTotal += row.document.calls
  if (!Number.isSafeInteger(aggregateCallTotal) || aggregateCallTotal !== totals.totalCalls) {
    fail('inconsistent-state', '$.totals.totalCalls', 'must equal the sum of aggregate call counts')
  }

  const normalized: UsageStateDocument = {
    schema: USAGE_STATE_SCHEMA,
    version: USAGE_STATE_SCHEMA_VERSION,
    limits: {
      maxEvents: limits.maxEvents,
      maxCalls: limits.maxCalls,
      maxCoverageReasons: limits.maxCoverageReasons,
      maxErrorCodeLength: limits.maxErrorCodeLength,
    },
    seenEvents,
    calls,
    aggregates: aggregateRows.map(row => row.document),
    coverage,
    totals,
  }
  measureDocument(normalized, codec.maxDocumentBytes)

  const seenEventSet = new Set<string>()
  for (const event of seenEvents) seenEventSet.add(eventKey(event.sessionId, event.seq))

  const callMap = new Map<string, UsageCallState>()
  for (const call of calls) {
    const targetKey = aggregateKeys[call.aggregateIndex]
    if (targetKey === undefined) {
      fail('inconsistent-state', '$.calls', 'references an aggregate outside the document')
    }
    callMap.set(callKey(call.sessionId, call.callId), {
      aggregateKey: targetKey,
      ...(call.result !== undefined ? { result: call.result } : {}),
    })
  }

  const aggregateMap = new Map<string, UsageAggregate>()
  for (const row of aggregateRows) {
    const document = row.document
    aggregateMap.set(row.key, {
      sessionId: document.sessionId,
      date: document.date,
      ...(document.workspaceId !== undefined ? { workspaceId: document.workspaceId } : {}),
      workspaceAttribution: document.workspaceAttribution,
      capabilityId: document.capabilityId,
      capabilityKind: document.capabilityKind,
      ...(document.providerId !== undefined ? { providerId: document.providerId } : {}),
      calls: document.calls,
      succeeded: document.succeeded,
      failed: document.failed,
      denied: document.denied,
      cancelled: document.cancelled,
      unresolved: document.unresolved,
      firstObservedAt: document.firstObservedAt,
      ...(document.lastUsedAt !== undefined ? { lastUsedAt: document.lastUsedAt } : {}),
      errors: new Map(row.errors),
    })
  }

  const coverageMap = new Map<string, UsageSessionCoverage>()
  for (const entry of coverage) {
    coverageMap.set(entry.sessionId, {
      status: entry.status,
      ...(entry.fromSeq !== undefined ? { fromSeq: entry.fromSeq } : {}),
      ...(entry.throughSeq !== undefined ? { throughSeq: entry.throughSeq } : {}),
      skippedSessions: entry.skippedSessions,
      skippedEvents: entry.skippedEvents,
      reasons: [...entry.reasons],
      reasonsTruncated: entry.reasonsTruncated,
    })
  }

  return {
    limits,
    seenEvents: seenEventSet,
    calls: callMap,
    aggregates: aggregateMap,
    coverage: coverageMap,
    totalEvents: totals.totalEvents,
    totalCalls: totals.totalCalls,
    stoppedByLimit: totals.stoppedByLimit,
    orphanResults: totals.orphanResults,
    duplicateResults: totals.duplicateResults,
  }
}

/**
 * Encode a state into a versioned, JSON-storable document.
 *
 * Throws {@link UsageStateCodecError} when the state cannot be represented
 * within the declared version, UsageLimits, or codec budgets. It never drops
 * rows or truncates strings to fit.
 */
export function encodeUsageState(
  state: UsageState,
  options: UsageStateCodecOptions = {},
): UsageStateDocument {
  const codec = resolveCodecLimits(options)
  const aggregateDocuments: UsageStateDocumentAggregate[] = []
  const aggregateIndexes = new Map<string, number>()
  for (const [key, aggregate] of state.aggregates) {
    if (aggregateKey(aggregate) !== key) {
      fail('inconsistent-state', '$.aggregates', 'aggregate map key does not match its metadata')
    }
    aggregateIndexes.set(key, aggregateDocuments.length)
    aggregateDocuments.push({
      sessionId: aggregate.sessionId,
      date: aggregate.date,
      ...(aggregate.workspaceId !== undefined ? { workspaceId: aggregate.workspaceId } : {}),
      workspaceAttribution: aggregate.workspaceAttribution,
      capabilityId: aggregate.capabilityId,
      capabilityKind: aggregate.capabilityKind,
      ...(aggregate.providerId !== undefined ? { providerId: aggregate.providerId } : {}),
      calls: aggregate.calls,
      succeeded: aggregate.succeeded,
      failed: aggregate.failed,
      denied: aggregate.denied,
      cancelled: aggregate.cancelled,
      unresolved: aggregate.unresolved,
      firstObservedAt: aggregate.firstObservedAt,
      ...(aggregate.lastUsedAt !== undefined ? { lastUsedAt: aggregate.lastUsedAt } : {}),
      errors: [...aggregate.errors].map(([code, count]) => ({ code, count })),
    })
  }

  const seenEvents = [...state.seenEvents].map((key, index): UsageStateDocumentSeenEvent => (
    parseEventKey(key, itemPath('seenEvents', index))
  ))

  const calls = [...state.calls].map(([key, call], index): UsageStateDocumentCall => {
    const path = itemPath('calls', index)
    const parsed = parseCallKey(key, path)
    const target = aggregateIndexes.get(call.aggregateKey)
    if (target === undefined) {
      fail('inconsistent-state', `${path}.aggregateKey`, 'does not reference an aggregate in this state')
    }
    return {
      sessionId: parsed.sessionId,
      callId: parsed.callId,
      aggregateIndex: target,
      ...(call.result !== undefined ? { result: call.result } : {}),
    }
  })

  const coverage = [...state.coverage].map(([sessionId, entry]): UsageStateDocumentCoverage => {
    return {
      sessionId,
      status: entry.status,
      ...(entry.fromSeq !== undefined ? { fromSeq: entry.fromSeq } : {}),
      ...(entry.throughSeq !== undefined ? { throughSeq: entry.throughSeq } : {}),
      skippedSessions: entry.skippedSessions,
      skippedEvents: entry.skippedEvents,
      reasons: [...entry.reasons],
      reasonsTruncated: entry.reasonsTruncated,
    }
  })

  const document: UsageStateDocument = {
    schema: USAGE_STATE_SCHEMA,
    version: USAGE_STATE_SCHEMA_VERSION,
    limits: {
      maxEvents: state.limits.maxEvents,
      maxCalls: state.limits.maxCalls,
      maxCoverageReasons: state.limits.maxCoverageReasons,
      maxErrorCodeLength: state.limits.maxErrorCodeLength,
    },
    seenEvents,
    calls,
    aggregates: aggregateDocuments,
    coverage,
    totals: {
      totalEvents: state.totalEvents,
      totalCalls: state.totalCalls,
      stoppedByLimit: state.stoppedByLimit,
      orphanResults: state.orphanResults,
      duplicateResults: state.duplicateResults,
    },
  }

  // Reuse the strict decoder as the single validator so encoding and loading
  // cannot drift. The reconstructed state is intentionally discarded.
  decodeDocument(document, codec)
  return document
}

/** Encode and serialize in one step; the result is UTF-8 JSON text. */
export function encodeUsageStateJson(
  state: UsageState,
  options: UsageStateCodecOptions = {},
): string {
  return JSON.stringify(encodeUsageState(state, options))
}

/** Decode a document object. Unknown fields are rejected, not ignored. */
export function decodeUsageState(
  value: unknown,
  options: UsageStateCodecOptions = {},
): UsageState {
  return decodeDocument(value, resolveCodecLimits(options))
}

/** Parse and decode UTF-8 JSON text with the same schema and budget checks. */
export function decodeUsageStateJson(
  text: string,
  options: UsageStateCodecOptions = {},
): UsageState {
  const codec = resolveCodecLimits(options)
  if (typeof text !== 'string') fail('invalid-document', '$', 'must be a JSON string')
  const bytes = TEXT_ENCODER.encode(text).byteLength
  if (bytes > codec.maxDocumentBytes) {
    fail('limit-exceeded', '$', `document is ${bytes} UTF-8 bytes; limit is ${codec.maxDocumentBytes}`)
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    fail('invalid-json', '$', 'must be valid JSON')
  }
  return decodeDocument(parsed, codec)
}
