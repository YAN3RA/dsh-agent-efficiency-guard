import { createHash } from 'node:crypto'

export const LOOP_HISTORY_LIMIT = 16
export const DEFAULT_REPEAT_THRESHOLDS = Object.freeze([3, 5, 8] as const)

export type GuardToolOutcome = 'success' | 'error' | 'denied' | 'cancelled'

type LoopHistoryEntry = {
  readonly callId?: string
  readonly dispatchSequence?: number
  readonly signature: string
  readonly outcome: GuardToolOutcome
  readonly resultFingerprint?: string
}

/** Caller owns one state per Agent and Turn; only fingerprints are retained. */
export interface GuardLoopState {
  readonly turn: number
  readonly history: readonly LoopHistoryEntry[]
}

export interface GuardLoopObservation {
  readonly name: string
  readonly arguments?: unknown
  readonly signature?: string
  readonly callId?: string
  readonly dispatchSequence?: number
  readonly outcome: GuardToolOutcome
  /** Precomputed safe fingerprint, or provide result for local hashing. */
  readonly resultFingerprint?: string
  readonly result?: unknown
}

export interface GuardLoopOptions {
  readonly repeatThresholds?: readonly number[]
  /** Disable sequence-cycle detection after overlapping dispatches were observed. */
  readonly disableSequenceDetection?: boolean
  /**
   * Alternating-cycle detection switch. False reports no cycle at all, leaving
   * the repeat-detection path (and its reminders) untouched.
   */
  readonly alternatingCycleEnabled?: boolean
  /**
   * No-progress protection switch. False keeps detection and reminders but makes
   * no call blockable, so the local denial never fires.
   */
  readonly noProgressProtection?: boolean
  /** Exact tool names ignored without changing the recent-call window. */
  readonly excludedTools?: ReadonlySet<string>
  /** Exact tool names ignored without changing the recent-call window. */
  readonly pollingTools?: ReadonlySet<string>
  /** Exact tool names that may warn but can never become a block candidate. */
  readonly warnOnlyTools?: ReadonlySet<string>
}

export type NoProgressEvidence = 'none' | 'unchanged-result' | 'unchanged-error' | 'unchanged-cycle'

export interface GuardLoopDecision {
  readonly ignored: boolean
  readonly signature?: string
  readonly repeatCount: number
  readonly alternatingCycle: boolean
  readonly warning: 'none' | 'repeat' | 'alternating-cycle'
  readonly repeatThreshold?: number
  /** Advisory only. The caller must not block without applying its own policy. */
  readonly blockCandidate: boolean
  readonly noProgressEvidence: NoProgressEvidence
}

export interface GuardLoopObservationResult {
  readonly state: GuardLoopState
  readonly decision: GuardLoopDecision
}

export function createGuardLoopState(turn: number): GuardLoopState {
  return { turn, history: [] }
}

function canonicalJson(value: unknown, seen = new Set<object>()): string {
  if (value === null) return 'null'
  if (typeof value === 'string' || typeof value === 'boolean') return JSON.stringify(value)
  if (typeof value === 'number') return Number.isFinite(value) ? JSON.stringify(value) : 'null'
  if (typeof value === 'undefined') return '"[undefined]"'
  if (typeof value === 'bigint') return JSON.stringify(value.toString())
  if (typeof value !== 'object') return JSON.stringify(String(value))
  if (seen.has(value)) throw new TypeError('Cannot fingerprint a cyclic value')
  seen.add(value)
  let result: string
  if (Array.isArray(value)) {
    result = `[${value.map(item => canonicalJson(item, seen)).join(',')}]`
  } else {
    const record = value as Record<string, unknown>
    result = `{${Object.keys(record).sort().map(key => `${JSON.stringify(key)}:${canonicalJson(record[key], seen)}`).join(',')}}`
  }
  seen.delete(value)
  return result
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex')
}

export function guardToolSignature(name: string, argumentsValue: unknown): string {
  return sha256(`${name}\0${canonicalJson(argumentsValue)}`)
}

/** Fingerprint a result/error transiently; raw content is never returned or retained. */
export function guardResultFingerprint(outcome: GuardToolOutcome, value: unknown): string {
  return sha256(`${outcome}\0${canonicalJson(value)}`)
}

function fingerprintsMatch(a: LoopHistoryEntry, b: LoopHistoryEntry): boolean {
  return a.outcome === b.outcome
    && a.resultFingerprint !== undefined
    && b.resultFingerprint !== undefined
    && a.resultFingerprint === b.resultFingerprint
}

function unchangedEvidence(previous: LoopHistoryEntry | undefined, current: LoopHistoryEntry): NoProgressEvidence {
  if (previous === undefined || !fingerprintsMatch(previous, current)) return 'none'
  return current.outcome === 'error' ? 'unchanged-error' : 'unchanged-result'
}

function cycleLength(history: readonly LoopHistoryEntry[]): number {
  const maxLength = Math.floor(history.length / 2)
  for (let length = 2; length <= maxLength; length += 1) {
    const first = history.slice(-2 * length, -length)
    const second = history.slice(-length)
    if (new Set(second.map(entry => entry.signature)).size < 2) continue
    if (first.every((entry, index) => entry.signature === second[index]?.signature)) return length
  }
  return 0
}

function noopDecision(): GuardLoopDecision {
  return {
    ignored: true,
    repeatCount: 0,
    alternatingCycle: false,
    warning: 'none',
    blockCandidate: false,
    noProgressEvidence: 'none',
  }
}

/**
 * Pure bounded detector. It never enforces a step, call-count, or duration budget.
 * Alternating cycles warn; a local-block candidate requires matching result/error
 * fingerprints for every leg of the repeated cycle.
 */
export function observeGuardLoop(
  previousState: GuardLoopState,
  turn: number,
  observation: GuardLoopObservation,
  options: GuardLoopOptions = {},
): GuardLoopObservationResult {
  const base = previousState.turn === turn ? previousState : createGuardLoopState(turn)
  if (options.excludedTools?.has(observation.name) || options.pollingTools?.has(observation.name)) {
    return { state: base, decision: noopDecision() }
  }

  const signature = observation.signature ?? guardToolSignature(observation.name, observation.arguments)
  const fingerprint = observation.resultFingerprint
    ?? (Object.hasOwn(observation, 'result') ? guardResultFingerprint(observation.outcome, observation.result) : undefined)
  const current: LoopHistoryEntry = {
    ...(observation.callId !== undefined ? { callId: observation.callId } : {}),
    ...(observation.dispatchSequence !== undefined ? { dispatchSequence: observation.dispatchSequence } : {}),
    signature,
    outcome: observation.outcome,
    ...(fingerprint !== undefined ? { resultFingerprint: fingerprint } : {}),
  }
  const history = base.history.slice(-LOOP_HISTORY_LIMIT)
  let repeatCount = 1
  for (let index = history.length - 1; index >= 0; index -= 1) {
    if (history[index].signature !== signature) break
    repeatCount += 1
  }
  const previousConsecutive = history.at(-1)?.signature === signature ? history.at(-1) : undefined
  const exactEvidence = unchangedEvidence(previousConsecutive, current)
  const nextHistory = [...history, current].slice(-LOOP_HISTORY_LIMIT)
  const cycleSize = options.disableSequenceDetection === true || options.alternatingCycleEnabled === false
    ? 0
    : cycleLength(nextHistory)
  const alternatingCycle = cycleSize > 0
  let cycleEvidence: NoProgressEvidence = 'none'
  if (alternatingCycle) {
    const previousCycle = nextHistory.slice(-2 * cycleSize, -cycleSize)
    const latestCycle = nextHistory.slice(-cycleSize)
    if (previousCycle.every((entry, index) => fingerprintsMatch(entry, latestCycle[index]))) {
      cycleEvidence = 'unchanged-cycle'
    }
  }

  const thresholds = [...(options.repeatThresholds ?? DEFAULT_REPEAT_THRESHOLDS)].sort((a, b) => a - b)
  if (thresholds.length === 0 || thresholds.some(value => !Number.isSafeInteger(value) || value < 2)
    || new Set(thresholds).size !== thresholds.length) {
    throw new Error('repeatThresholds must contain unique integers >= 2')
  }
  const repeatThreshold = thresholds.includes(repeatCount) ? repeatCount : undefined
  const warning = alternatingCycle ? 'alternating-cycle' : repeatThreshold !== undefined ? 'repeat' : 'none'
  const noProgressEvidence = cycleEvidence !== 'none' ? cycleEvidence : exactEvidence
  const blockCandidate = options.noProgressProtection !== false
    && !options.warnOnlyTools?.has(observation.name)
    && (cycleEvidence !== 'none'
      || (exactEvidence !== 'none' && repeatCount >= thresholds[thresholds.length - 1]))

  return {
    state: { turn, history: nextHistory },
    decision: {
      ignored: false,
      signature,
      repeatCount,
      alternatingCycle,
      warning,
      ...(repeatThreshold !== undefined ? { repeatThreshold } : {}),
      blockCandidate,
      noProgressEvidence,
    },
  }
}
