/**
 * Pure projector from public DSH Session events to metadata-only Usage events.
 *
 * Privacy contract (vNext §3.9 / §3.10): only these fields are read —
 * `tool/call` `seq/time/data.callId/data.name`, and `tool/result`
 * `seq/time/data.message.toolCallId/data.message.isError/data.error.code`.
 * `data.arguments`, tool result content, user/assistant text, `data.meta`,
 * `data.error.name` and `data.error.reason` are never read, stored, or
 * returned. The implementation deliberately avoids spreading events or
 * payloads so non-whitelisted fields cannot be copied by accident.
 *
 * Outcome contract, verified against the installed public types
 * (`@deepseek-ai/dsh-session` and `@deepseek-ai/dsh-tools` 0.2.1-rc.3):
 * - `cancelled` is provable only from the exported canonical codes
 *   `TOOL_ABORTED` / `TOOL_ABORTED_BEFORE_DISPATCH`.
 * - `denied` has no canonical public code: a `PreToolDecision` denial carries
 *   only an optional tool-supplied `ToolErrorInfo`, and the default denial path
 *   attaches no `info` at all. Denials are therefore never inferred; every
 *   non-cancel failure projects as `error` and reports the
 *   `denied-not-observable` gap so callers can record coverage honestly.
 * - Synthetic crash-recovery results (`TOOL_OUTCOME_UNKNOWN` /
 *   `TOOL_NOT_STARTED`) are not real outcomes; they are skipped with the
 *   `outcome-unknown` gap so an interrupted call stays `unresolved` instead of
 *   being counted as a failure.
 *
 * `seq`/`time` are forwarded unchanged so `usage-core.ts` still owns event
 * rejection; an invalid pair additionally reports a `malformed-event` gap so a
 * caller can see the coverage loss without re-validating the payload.
 */
import { TOOL_NOT_STARTED, TOOL_OUTCOME_UNKNOWN, type SessionEvent } from '@deepseek-ai/dsh-session'
import { TOOL_ABORTED, TOOL_ABORTED_BEFORE_DISPATCH } from '@deepseek-ai/dsh-tools'
import type {
  UsageEvent,
  UsageResultOutcome,
  UsageSource,
  UsageToolCallEvent,
  UsageToolResultEvent,
  UsageWorkspaceRef,
  WorkspaceAttribution,
} from './usage-core.ts'

/** Why a Session event could not become a complete Usage event. */
export type UsageProjectionGapReason =
  | 'invalid-session-id'
  | 'malformed-event'
  | 'malformed-tool-call'
  | 'malformed-tool-result'
  | 'classifier-failed'
  | 'invalid-classification'
  | 'denied-not-observable'
  | 'outcome-unknown'

/** One bounded coverage gap; never contains raw payload text. */
export interface UsageProjectionGap {
  readonly reason: UsageProjectionGapReason
  readonly seq?: number
}

/**
 * Classifier result. `capabilityId` defaults to the tool name; supplying it lets
 * a trusted classifier normalize a capability identity without re-deriving it
 * from arguments.
 */
export interface UsageToolClassification {
  readonly source: UsageSource
  readonly capabilityId?: string
}

/**
 * Caller-supplied, trusted source classifier. It only receives the public tool
 * name, never the raw event, arguments, or tool output. Returning `undefined`
 * is a legitimate abstention and projects as `unknown` without a gap; only an
 * invalid non-undefined result is reported as `invalid-classification`.
 */
export type UsageSourceClassifier = (
  toolName: string,
) => UsageSource | UsageToolClassification | undefined

export interface UsageProjectionInput {
  readonly sessionId: string
  readonly event: SessionEvent
  readonly workspace: UsageWorkspaceRef
  readonly classify: UsageSourceClassifier
}

export interface UsageEventProjection {
  readonly event?: UsageEvent
  readonly gaps: readonly UsageProjectionGap[]
}

const ERROR_CODE_PATTERN = /^[A-Za-z0-9_.:-]+$/
const UNREADABLE = Symbol('unreadable')

type UnknownRecord = { readonly [key: string]: unknown }

function isRecord(value: unknown): value is UnknownRecord {
  return typeof value === 'object' && value !== null
}

/**
 * Read exactly one whitelisted property. A throwing getter returns
 * {@link UNREADABLE} instead of collapsing into `undefined`, so callers can
 * keep "unreadable" distinct from "missing".
 */
function readField(value: unknown, key: string): unknown {
  if (!isRecord(value)) return undefined
  try {
    return (value as Record<string, unknown>)[key]
  } catch {
    return UNREADABLE
  }
}

/**
 * Read an optional whitelisted property, folding an unreadable getter into
 * absence. Fields that decide validity (`type`, `seq`, `time`, `isError`,
 * error `code`) are read with {@link readField} directly so a read failure
 * cannot masquerade as a legitimate missing value.
 */
function readOptionalField(value: unknown, key: string): unknown {
  const field = readField(value, key)
  return field === UNREADABLE ? undefined : field
}

function readNonBlankString(value: unknown, key: string): string | undefined {
  const field = readOptionalField(value, key)
  return typeof field === 'string' && field.trim().length > 0 ? field : undefined
}

/** Unlike {@link readNonBlankString}, provider ids are stored trimmed. */
function readTrimmedNonBlankString(value: unknown, key: string): string | undefined {
  const field = readOptionalField(value, key)
  return typeof field === 'string' && field.trim().length > 0 ? field.trim() : undefined
}

function safeSeq(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : undefined
}

function safeTime(value: unknown): number | undefined {
  return typeof value === 'number'
    && Number.isFinite(value)
    && Number.isFinite(new Date(value).getTime())
    ? value
    : undefined
}

function gap(reason: UsageProjectionGapReason, seq: number | undefined): UsageProjectionGap {
  return seq === undefined ? { reason } : { reason, seq }
}

/** Copy only the public workspace ref fields; invalid values stay invalid for core. */
function projectWorkspace(value: unknown): UsageWorkspaceRef {
  const workspaceId = readNonBlankString(value, 'workspaceId')
  const attribution = readOptionalField(value, 'attribution')
  return {
    ...(workspaceId === undefined ? {} : { workspaceId }),
    // Forwarded as-is: `usage-core` owns the attribution validation and rejects
    // an unknown value without throwing.
    attribution: attribution as WorkspaceAttribution,
  }
}

/** Copy a valid classifier source, dropping any extra fields it may carry. */
function projectSource(value: unknown): UsageSource | undefined {
  const kind = readOptionalField(value, 'kind')
  if (kind === 'native') return { kind: 'native' }
  if (kind === 'mcp' || kind === 'plugin-tool') {
    const providerId = readTrimmedNonBlankString(value, 'providerId')
    return providerId === undefined ? undefined : { kind, providerId }
  }
  if (kind === 'skill') {
    const entry = readOptionalField(value, 'entry')
    if (entry !== 'skill-tool' && entry !== 'slash-invocation' && entry !== 'meta-invoke') return undefined
    const rawProviderId = readOptionalField(value, 'providerId')
    if (rawProviderId !== undefined && typeof rawProviderId !== 'string') return undefined
    const providerId = typeof rawProviderId === 'string' && rawProviderId.trim().length > 0
      ? rawProviderId.trim()
      : undefined
    return { kind: 'skill', entry, ...(providerId === undefined ? {} : { providerId }) }
  }
  if (kind === 'unknown') {
    const reason = readNonBlankString(value, 'reason')
    return reason === undefined ? undefined : { kind: 'unknown', reason }
  }
  return undefined
}

interface ClassifiedTool {
  readonly source: UsageSource
  readonly capabilityId?: string
  readonly gaps: readonly UsageProjectionGapReason[]
}

function classifyTool(toolName: string, classifier: UsageSourceClassifier): ClassifiedTool {
  let raw: unknown
  try {
    raw = classifier(toolName)
  } catch {
    return {
      source: { kind: 'unknown', reason: 'classifier-failed' },
      gaps: ['classifier-failed'],
    }
  }
  // An abstention is a valid answer, not a malformed classification.
  if (raw === undefined) {
    return {
      source: { kind: 'unknown', reason: 'classifier-undetermined' },
      gaps: [],
    }
  }
  const wrapped = readOptionalField(raw, 'source')
  const source = projectSource(wrapped === undefined ? raw : wrapped)
  if (source === undefined) {
    return {
      source: { kind: 'unknown', reason: 'invalid-classification' },
      gaps: ['invalid-classification'],
    }
  }
  if (wrapped === undefined) return { source, gaps: [] }
  const rawCapabilityId = readOptionalField(raw, 'capabilityId')
  if (rawCapabilityId === undefined) return { source, gaps: [] }
  if (typeof rawCapabilityId === 'string' && rawCapabilityId.trim().length > 0) {
    return { source, capabilityId: rawCapabilityId, gaps: [] }
  }
  return { source, gaps: ['invalid-classification'] }
}

function projectToolCall(
  input: UsageProjectionInput,
  sessionId: string,
  event: unknown,
  seqRaw: unknown,
  timeRaw: unknown,
  gapSeq: number | undefined,
): UsageEventProjection {
  const data = readField(event, 'data')
  const callId = readNonBlankString(data, 'callId')
  const name = readNonBlankString(data, 'name')
  if (callId === undefined || name === undefined) {
    return { gaps: [gap('malformed-tool-call', gapSeq)] }
  }
  const classified = classifyTool(name, input.classify)
  const callEvent: UsageToolCallEvent = {
    type: 'tool-call',
    sessionId,
    seq: seqRaw as number,
    time: timeRaw as number,
    workspace: projectWorkspace(input.workspace),
    callId,
    capabilityId: classified.capabilityId ?? name,
    source: classified.source,
  }
  return {
    event: callEvent,
    gaps: classified.gaps.map(reason => gap(reason, gapSeq)),
  }
}

function projectToolResult(
  input: UsageProjectionInput,
  sessionId: string,
  event: unknown,
  seqRaw: unknown,
  timeRaw: unknown,
  gapSeq: number | undefined,
): UsageEventProjection {
  const data = readField(event, 'data')
  const message = readField(data, 'message')
  const callId = readNonBlankString(message, 'toolCallId')
  if (callId === undefined) {
    return { gaps: [gap('malformed-tool-result', gapSeq)] }
  }
  const isError = readField(message, 'isError')
  if (isError === UNREADABLE || (isError !== undefined && typeof isError !== 'boolean')) {
    return { gaps: [gap('malformed-tool-result', gapSeq)] }
  }
  const base = {
    type: 'tool-result' as const,
    sessionId,
    seq: seqRaw as number,
    time: timeRaw as number,
    workspace: projectWorkspace(input.workspace),
    callId,
  }
  if (isError !== true) {
    return { event: { ...base, outcome: 'success' }, gaps: [] }
  }
  const rawError = readField(data, 'error')
  if (rawError === UNREADABLE) {
    return { gaps: [gap('malformed-tool-result', gapSeq)] }
  }
  const rawCode = readField(rawError, 'code')
  if (rawCode === UNREADABLE) {
    return { gaps: [gap('malformed-tool-result', gapSeq)] }
  }
  const code = typeof rawCode === 'string' && ERROR_CODE_PATTERN.test(rawCode) ? rawCode : undefined
  if (code === TOOL_NOT_STARTED || code === TOOL_OUTCOME_UNKNOWN) {
    return { gaps: [gap('outcome-unknown', gapSeq)] }
  }
  const cancelled = code === TOOL_ABORTED || code === TOOL_ABORTED_BEFORE_DISPATCH
  const outcome: UsageResultOutcome = cancelled ? 'cancelled' : 'error'
  const resultEvent: UsageToolResultEvent = {
    ...base,
    outcome,
    ...(code === undefined ? {} : { errorCode: code }),
  }
  return {
    event: resultEvent,
    gaps: cancelled ? [] : [gap('denied-not-observable', gapSeq)],
  }
}

/**
 * Project one public Session event, keeping any coverage gap visible.
 *
 * `event` is absent for unsupported/control-plane records (which are not gaps),
 * for malformed records, and for crash-recovery placeholders whose outcome is
 * unknowable. An event with an invalid `seq`/`time` is still returned so
 * `usage-core` can reject it, together with an additional `malformed-event`
 * gap that records the coverage loss.
 */
export function projectUsageSessionEventWithGaps(input: UsageProjectionInput): UsageEventProjection {
  const sessionId = typeof input.sessionId === 'string' && input.sessionId.trim().length > 0
    ? input.sessionId
    : undefined
  if (sessionId === undefined) return { gaps: [{ reason: 'invalid-session-id' }] }

  const event = input.event as unknown
  if (!isRecord(event)) return { gaps: [{ reason: 'malformed-event' }] }
  const type = readField(event, 'type')
  if (type !== 'tool/call' && type !== 'tool/result') {
    return { gaps: typeof type === 'string' ? [] : [{ reason: 'malformed-event' }] }
  }

  const seqRaw = readField(event, 'seq')
  const timeRaw = readField(event, 'time')
  // An unreadable getter must not leak its sentinel into the projected event.
  const seqValue = seqRaw === UNREADABLE ? undefined : seqRaw
  const timeValue = timeRaw === UNREADABLE ? undefined : timeRaw
  const gapSeq = safeSeq(seqValue)
  const timingGap = gapSeq !== undefined && safeTime(timeValue) !== undefined
    ? undefined
    : gap('malformed-event', gapSeq)
  const projection = type === 'tool/call'
    ? projectToolCall(input, sessionId, event, seqValue, timeValue, gapSeq)
    : projectToolResult(input, sessionId, event, seqValue, timeValue, gapSeq)
  if (timingGap === undefined || projection.event === undefined) return projection
  return { event: projection.event, gaps: [timingGap, ...projection.gaps] }
}

/**
 * Convenience wrapper for bulk streaming: returns the metadata-only Usage event
 * and drops gap reporting. Use {@link projectUsageSessionEventWithGaps} when a
 * coverage gap must be recorded (denial ambiguity, malformed or recovered
 * records).
 */
export function projectUsageSessionEvent(input: UsageProjectionInput): UsageEvent | undefined {
  return projectUsageSessionEventWithGaps(input).event
}
