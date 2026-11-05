import type { UsageState } from './usage-core.ts'
import type { UsageCollectorSession, UsageCollectorState } from './usage-collector.ts'
import {
  DEFAULT_USAGE_STATE_CODEC_LIMITS,
  UsageStateCodecError,
  decodeUsageState,
  encodeUsageState,
  type UsageStateCodecErrorCode,
  type UsageStateCodecLimits,
  type UsageStateCodecOptions,
  type UsageStateDocument,
} from './usage-state-codec.ts'

/**
 * Versioned, JSON-storable projection of {@link UsageCollectorState}.
 *
 * The collector state is exactly the metadata-only usage payload plus one
 * watermark entry per Session. Only `sessionId`, `firstObservedSeq`,
 * `observedSeq`, and `historyComplete` are persisted for a Session; there is
 * no field capable of holding a Session event, message, argument, tool output,
 * or any other raw payload. Unknown fields are rejected in both directions.
 *
 * The nested usage payload keeps its own schema and version and is validated by
 * its own codec. This outer envelope adds one schema version so the watermark
 * layout can evolve independently of the usage aggregates.
 */
export const USAGE_COLLECTOR_SCHEMA = 'dsh-agent-efficiency-guard/usage-collector'
export const USAGE_COLLECTOR_SCHEMA_VERSION = 1

export type UsageCollectorCodecErrorCode = UsageStateCodecErrorCode

export class UsageCollectorCodecError extends Error {
  constructor(
    readonly code: UsageCollectorCodecErrorCode,
    readonly path: string,
    message: string,
  ) {
    super(`${path}: ${message}`)
    this.name = 'UsageCollectorCodecError'
  }
}

/** One Session watermark row. The field set is closed on purpose. */
export interface UsageCollectorSessionDocument {
  readonly sessionId: string
  readonly firstObservedSeq?: number
  readonly observedSeq?: number
  readonly historyComplete: boolean
}

export interface UsageCollectorDocument {
  readonly schema: typeof USAGE_COLLECTOR_SCHEMA
  readonly version: typeof USAGE_COLLECTOR_SCHEMA_VERSION
  readonly usage: UsageStateDocument
  readonly sessions: readonly UsageCollectorSessionDocument[]
}

/**
 * Collector-level budgets.
 *
 * The state budgets are inherited unchanged so a collector document can never
 * be accepted while its nested usage payload violates the usage codec. The
 * additional session budget bounds the watermark map, which `UsageLimits` does
 * not cover.
 */
export interface UsageCollectorCodecLimits extends UsageStateCodecLimits {
  /** Number of persisted per-Session watermarks. */
  readonly maxSessions: number
}

export type UsageCollectorCodecOptions = Partial<UsageCollectorCodecLimits>

export const DEFAULT_USAGE_COLLECTOR_CODEC_LIMITS: UsageCollectorCodecLimits = Object.freeze({
  ...DEFAULT_USAGE_STATE_CODEC_LIMITS,
  maxSessions: 4_096,
})

const STATE_CODEC_LIMIT_KEYS = [
  'maxDocumentBytes',
  'maxCoverageSessions',
  'maxSessionIdLength',
  'maxWorkspaceIdLength',
  'maxCallIdLength',
  'maxCapabilityIdLength',
  'maxProviderIdLength',
  'maxReasonLength',
] as const satisfies readonly (keyof UsageStateCodecLimits)[]

const COLLECTOR_LIMIT_KEYS = [
  ...STATE_CODEC_LIMIT_KEYS,
  'maxSessions',
] as const satisfies readonly (keyof UsageCollectorCodecLimits)[]

const TEXT_ENCODER = new TextEncoder()

type UnknownRecord = { readonly [key: string]: unknown }

function fail(code: UsageCollectorCodecErrorCode, path: string, message: string): never {
  throw new UsageCollectorCodecError(code, path, message)
}

function isRecord(value: unknown): value is UnknownRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function hasOwn(value: UnknownRecord, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(value, key)
}

function childPath(path: string, key: string): string {
  return `${path}.${key}`
}

function itemPath(path: string, index: number): string {
  return `${path}[${index}]`
}

function resolveCollectorCodecLimits(
  options: UsageCollectorCodecOptions = {},
): UsageCollectorCodecLimits {
  if (!isRecord(options)) {
    fail('invalid-document', 'options', 'must be a plain object')
  }
  const resolved = { ...DEFAULT_USAGE_COLLECTOR_CODEC_LIMITS }
  for (const key of COLLECTOR_LIMIT_KEYS) {
    const value = options[key]
    if (value === undefined) continue
    if (!Number.isSafeInteger(value) || value < 1) {
      fail('invalid-document', `options.${key}`, 'must be a positive safe integer')
    }
    resolved[key] = value
  }
  return resolved
}

function stateCodecOptions(limits: UsageCollectorCodecLimits): UsageStateCodecOptions {
  return {
    maxDocumentBytes: limits.maxDocumentBytes,
    maxCoverageSessions: limits.maxCoverageSessions,
    maxSessionIdLength: limits.maxSessionIdLength,
    maxWorkspaceIdLength: limits.maxWorkspaceIdLength,
    maxCallIdLength: limits.maxCallIdLength,
    maxCapabilityIdLength: limits.maxCapabilityIdLength,
    maxProviderIdLength: limits.maxProviderIdLength,
    maxReasonLength: limits.maxReasonLength,
  }
}

/** Translate a nested codec path so callers always see the collector envelope. */
function collectorPath(path: string): string {
  if (path === '$') return '$.usage'
  if (path.startsWith('$.')) return `$.usage${path.slice(1)}`
  return path
}

function errorDetail(error: UsageStateCodecError): string {
  const prefix = `${error.path}: `
  return error.message.startsWith(prefix) ? error.message.slice(prefix.length) : error.message
}

/** Re-throw nested usage codec failures under the collector error type. */
function fromStateCodec<T>(run: () => T): T {
  try {
    return run()
  } catch (error) {
    if (error instanceof UsageStateCodecError) {
      throw new UsageCollectorCodecError(
        error.code,
        collectorPath(error.path),
        errorDetail(error),
      )
    }
    throw error
  }
}

function isUsageState(value: unknown): value is UsageState {
  return isRecord(value)
    && value.seenEvents instanceof Set
    && value.calls instanceof Map
    && value.aggregates instanceof Map
    && value.coverage instanceof Map
}

function isCollectorState(value: unknown): value is UsageCollectorState {
  return isRecord(value) && isUsageState(value.usage) && value.sessions instanceof Map
}

function expectPlainObject(value: unknown, path: string): UnknownRecord {
  if (!isRecord(value)) {
    fail('invalid-document', path, 'must be a plain object')
  }
  const prototype = Object.getPrototypeOf(value)
  if (prototype !== Object.prototype && prototype !== null) {
    fail('invalid-document', path, 'must be a plain object')
  }
  return value
}

function expectObject(
  value: unknown,
  path: string,
  required: readonly string[],
  optional: readonly string[] = [],
): UnknownRecord {
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

function expectSessionId(
  value: unknown,
  path: string,
  maxLength: number,
  code: UsageCollectorCodecErrorCode,
): string {
  if (typeof value !== 'string') fail(code, path, 'must be a string')
  if (value.trim().length === 0) fail(code, path, 'must not be empty')
  if (value.length > maxLength) {
    fail('limit-exceeded', path, `must be at most ${maxLength} characters`)
  }
  return value
}

function expectInteger(
  value: unknown,
  path: string,
  code: UsageCollectorCodecErrorCode,
): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    fail(code, path, 'must be a non-negative safe integer')
  }
  return value
}

function expectBoolean(
  value: unknown,
  path: string,
  code: UsageCollectorCodecErrorCode,
): boolean {
  if (typeof value !== 'boolean') fail(code, path, 'must be a boolean')
  return value
}

/**
 * The collector only produces both watermarks together. A one-sided pair is a
 * corrupted state, and `firstObservedSeq` can never exceed `observedSeq`.
 */
function validateWatermarks(
  firstObservedSeq: number | undefined,
  observedSeq: number | undefined,
  path: string,
  code: UsageCollectorCodecErrorCode,
): void {
  if ((firstObservedSeq === undefined) !== (observedSeq === undefined)) {
    fail(code, path, 'firstObservedSeq and observedSeq must be recorded together')
  }
  if (
    firstObservedSeq !== undefined
    && observedSeq !== undefined
    && firstObservedSeq > observedSeq
  ) {
    fail(code, `${path}.firstObservedSeq`, 'must not exceed observedSeq')
  }
}

function readSessionDocument(
  value: unknown,
  path: string,
  limits: UsageCollectorCodecLimits,
): UsageCollectorSessionDocument {
  const record = expectObject(
    value,
    path,
    ['sessionId', 'historyComplete'],
    ['firstObservedSeq', 'observedSeq'],
  )
  const sessionId = expectSessionId(
    record.sessionId,
    `${path}.sessionId`,
    limits.maxSessionIdLength,
    'invalid-document',
  )
  const firstObservedSeq = hasOwn(record, 'firstObservedSeq')
    ? expectInteger(record.firstObservedSeq, `${path}.firstObservedSeq`, 'invalid-document')
    : undefined
  const observedSeq = hasOwn(record, 'observedSeq')
    ? expectInteger(record.observedSeq, `${path}.observedSeq`, 'invalid-document')
    : undefined
  validateWatermarks(firstObservedSeq, observedSeq, path, 'inconsistent-state')
  const historyComplete = expectBoolean(
    record.historyComplete,
    `${path}.historyComplete`,
    'invalid-document',
  )
  return {
    sessionId,
    ...(firstObservedSeq !== undefined ? { firstObservedSeq } : {}),
    ...(observedSeq !== undefined ? { observedSeq } : {}),
    historyComplete,
  }
}

function encodeSessionDocument(
  sessionId: unknown,
  value: unknown,
  path: string,
  limits: UsageCollectorCodecLimits,
): UsageCollectorSessionDocument {
  const id = expectSessionId(
    sessionId,
    `${path}.sessionId`,
    limits.maxSessionIdLength,
    'inconsistent-state',
  )
  if (!isRecord(value)) fail('inconsistent-state', path, 'must be a session watermark object')
  const firstObservedSeq = value.firstObservedSeq === undefined
    ? undefined
    : expectInteger(value.firstObservedSeq, `${path}.firstObservedSeq`, 'inconsistent-state')
  const observedSeq = value.observedSeq === undefined
    ? undefined
    : expectInteger(value.observedSeq, `${path}.observedSeq`, 'inconsistent-state')
  validateWatermarks(firstObservedSeq, observedSeq, path, 'inconsistent-state')
  const historyComplete = expectBoolean(
    value.historyComplete,
    `${path}.historyComplete`,
    'inconsistent-state',
  )
  return {
    sessionId: id,
    ...(firstObservedSeq !== undefined ? { firstObservedSeq } : {}),
    ...(observedSeq !== undefined ? { observedSeq } : {}),
    historyComplete,
  }
}

function measureDocument(document: UsageCollectorDocument, maxBytes: number): void {
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

function decodeDocument(value: unknown, limits: UsageCollectorCodecLimits): UsageCollectorState {
  const root = expectObject(value, '$', ['schema', 'version', 'usage', 'sessions'])
  if (root.version !== USAGE_COLLECTOR_SCHEMA_VERSION) {
    if (
      typeof root.version !== 'number'
      || !Number.isSafeInteger(root.version)
      || root.version < 1
    ) {
      fail('invalid-document', '$.version', 'must be a positive safe integer')
    }
    fail(
      'unsupported-version',
      '$.version',
      `only version ${USAGE_COLLECTOR_SCHEMA_VERSION} is supported`,
    )
  }
  if (root.schema !== USAGE_COLLECTOR_SCHEMA) {
    fail('invalid-document', '$.schema', `must be ${USAGE_COLLECTOR_SCHEMA}`)
  }

  const usage = fromStateCodec(() => decodeUsageState(root.usage, stateCodecOptions(limits)))

  const rows = expectArray(root.sessions, '$.sessions', limits.maxSessions)
  const sessionDocuments: UsageCollectorSessionDocument[] = []
  const sessions = new Map<string, UsageCollectorSession>()
  rows.forEach((row, index) => {
    const path = itemPath('$.sessions', index)
    const session = readSessionDocument(row, path, limits)
    if (sessions.has(session.sessionId)) {
      fail('inconsistent-state', path, 'duplicates an earlier session')
    }
    sessions.set(session.sessionId, {
      ...(session.firstObservedSeq !== undefined
        ? { firstObservedSeq: session.firstObservedSeq }
        : {}),
      ...(session.observedSeq !== undefined ? { observedSeq: session.observedSeq } : {}),
      historyComplete: session.historyComplete,
    })
    sessionDocuments.push(session)
  })

  // Re-encode the decoded usage payload so the byte budget is measured against
  // the same normalized representation the encoder would produce. This also
  // proves the decoded state remains representable at the declared limits.
  const normalizedUsage = fromStateCodec(() => encodeUsageState(usage, stateCodecOptions(limits)))
  measureDocument({
    schema: USAGE_COLLECTOR_SCHEMA,
    version: USAGE_COLLECTOR_SCHEMA_VERSION,
    usage: normalizedUsage,
    sessions: sessionDocuments,
  }, limits.maxDocumentBytes)

  return { usage, sessions }
}

/**
 * Encode a collector state into a versioned, JSON-storable document.
 *
 * Throws {@link UsageCollectorCodecError} when the state cannot be represented
 * within the declared version, the nested usage limits, or the collector
 * budgets. Extra runtime fields on a Session watermark are ignored, never
 * copied; the emitted document only contains the four allow-listed fields.
 */
export function encodeUsageCollectorState(
  state: UsageCollectorState,
  options: UsageCollectorCodecOptions = {},
): UsageCollectorDocument {
  const limits = resolveCollectorCodecLimits(options)
  if (!isCollectorState(state)) {
    fail('inconsistent-state', '$', 'must be a collector state')
  }

  const sessions: UsageCollectorSessionDocument[] = []
  let index = 0
  for (const [sessionId, session] of state.sessions) {
    sessions.push(encodeSessionDocument(sessionId, session, itemPath('sessions', index), limits))
    index += 1
  }
  if (sessions.length > limits.maxSessions) {
    fail('limit-exceeded', 'sessions', `must contain at most ${limits.maxSessions} rows`)
  }

  const usage = fromStateCodec(() => encodeUsageState(state.usage, stateCodecOptions(limits)))
  const document: UsageCollectorDocument = {
    schema: USAGE_COLLECTOR_SCHEMA,
    version: USAGE_COLLECTOR_SCHEMA_VERSION,
    usage,
    sessions,
  }

  // Use the strict decoder as the single validator so encode and decode cannot
  // drift, mirroring the nested usage codec's own guarantee.
  decodeDocument(document, limits)
  return document
}

/** Encode and serialize in one step; the result is UTF-8 JSON text. */
export function encodeUsageCollectorStateJson(
  state: UsageCollectorState,
  options: UsageCollectorCodecOptions = {},
): string {
  return JSON.stringify(encodeUsageCollectorState(state, options))
}

/** Decode a collector document object. Unknown fields are rejected, not ignored. */
export function decodeUsageCollectorState(
  value: unknown,
  options: UsageCollectorCodecOptions = {},
): UsageCollectorState {
  return decodeDocument(value, resolveCollectorCodecLimits(options))
}

/** Parse and decode UTF-8 JSON text with the same schema and budget checks. */
export function decodeUsageCollectorStateJson(
  text: string,
  options: UsageCollectorCodecOptions = {},
): UsageCollectorState {
  const limits = resolveCollectorCodecLimits(options)
  if (typeof text !== 'string') fail('invalid-document', '$', 'must be a JSON string')
  const bytes = TEXT_ENCODER.encode(text).byteLength
  if (bytes > limits.maxDocumentBytes) {
    fail('limit-exceeded', '$', `document is ${bytes} UTF-8 bytes; limit is ${limits.maxDocumentBytes}`)
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    fail('invalid-json', '$', 'must be valid JSON')
  }
  return decodeDocument(parsed, limits)
}
