import { describe, expect, it, vi } from 'vitest'
import { MessageId, ToolCallId, type ToolResultMessage } from '@deepseek-ai/dsh-llm'
import {
  SessionSeq,
  TOOL_NOT_STARTED,
  TOOL_OUTCOME_UNKNOWN,
  type SessionEvent,
  type SessionEventMap,
} from '@deepseek-ai/dsh-session'
import { TOOL_ABORTED, TOOL_ABORTED_BEFORE_DISPATCH } from '@deepseek-ai/dsh-tools'
import {
  projectUsageSessionEvent,
  projectUsageSessionEventWithGaps,
  type UsageProjectionInput,
  type UsageSourceClassifier,
} from '../src/usage/usage-event-projector.ts'
import { applyUsageEvent, buildUsageReport, createUsageState } from '../src/usage/usage-core.ts'

const TIME = Date.UTC(2026, 10, 4, 10, 0, 0)
const workspace = { workspaceId: 'ws-1', attribution: 'event-time' } as const

type ToolResultError = NonNullable<SessionEventMap['tool/result']['error']>

const classify: UsageSourceClassifier = name => (
  name.startsWith('mcp__')
    ? { kind: 'mcp', providerId: name.split('__')[1] ?? 'unknown' }
    : { kind: 'unknown', reason: 'unmapped-tool' }
)

function toolCallEvent(
  data: Partial<SessionEventMap['tool/call']> = {},
  seq = 1,
  time = TIME,
): SessionEvent {
  return {
    type: 'tool/call',
    seq: SessionSeq(seq),
    time,
    data: {
      turn: 1,
      step: 1,
      callId: ToolCallId('call-1'),
      name: 'mcp__files__read',
      arguments: '{"token":"PRIVATE ARGUMENT"}',
      ...data,
    },
  }
}

function toolResultEvent(options: {
  code?: string
  isError?: boolean
  toolCallId?: string
  seq?: number
  time?: number
  error?: ToolResultError
} = {}): SessionEvent {
  const seq = options.seq ?? 2
  const toolCallId = ToolCallId(options.toolCallId ?? 'call-1')
  const message: ToolResultMessage = {
    id: MessageId('msg-1'),
    role: 'tool',
    toolCallId,
    ...(options.isError === undefined ? {} : { isError: options.isError }),
    source: { kind: 'tool', callId: toolCallId },
    content: [{ type: 'text', text: 'PRIVATE TOOL OUTPUT' }],
  }
  const data: SessionEventMap['tool/result'] = { turn: 1, step: 1, message }
  if (options.error !== undefined) data.error = options.error
  else if (options.code !== undefined) {
    data.error = { name: 'PrivateErrorName', code: options.code, reason: 'PRIVATE REASON' }
  }
  return {
    type: 'tool/result',
    seq: SessionSeq(seq),
    time: options.time ?? TIME + seq * 1000,
    surfaceOp: 'append',
    data,
  }
}

function input(event: SessionEvent, overrides: Partial<UsageProjectionInput> = {}): UsageProjectionInput {
  return { sessionId: 'session-a', event, workspace, classify, ...overrides }
}

function project(event: SessionEvent, overrides: Partial<UsageProjectionInput> = {}) {
  return projectUsageSessionEvent(input(event, overrides))
}

function detail(event: SessionEvent, overrides: Partial<UsageProjectionInput> = {}) {
  return projectUsageSessionEventWithGaps(input(event, overrides))
}

/**
 * A payload proxy that records every property the projector touches. The
 * caller asserts the exact whitelist afterwards, so an accidental read fails
 * loudly instead of being silently swallowed by the projector's getter guard.
 */
function recordingPayload<T extends object>(
  target: T,
): { readonly payload: T; readonly accessed: readonly string[] } {
  const accessed: string[] = []
  const payload = new Proxy(target, {
    get(object, key, receiver) {
      if (typeof key === 'string') accessed.push(key)
      return Reflect.get(object, key, receiver)
    },
    ownKeys(object) {
      accessed.push('[[ownKeys]]')
      return Reflect.ownKeys(object)
    },
    getOwnPropertyDescriptor(object, key) {
      accessed.push('[[getOwnPropertyDescriptor]]')
      return Reflect.getOwnPropertyDescriptor(object, key)
    },
  })
  return { payload, accessed }
}

describe('usage event projector', () => {
  it('projects a tool call into a metadata-only usage event', () => {
    const event = toolCallEvent({ arguments: '{"token":"PRIVATE ARGUMENT"}' })
    expect(project(event)).toEqual({
      type: 'tool-call',
      sessionId: 'session-a',
      seq: 1,
      time: TIME,
      workspace: { workspaceId: 'ws-1', attribution: 'event-time' },
      callId: 'call-1',
      capabilityId: 'mcp__files__read',
      source: { kind: 'mcp', providerId: 'files' },
    })
    expect(detail(event).gaps).toEqual([])
  })

  it('never reads or enumerates non-whitelisted tool-call payload fields', () => {
    const classifySpy = vi.fn(() => ({ kind: 'mcp', providerId: 'files' } as const))
    const data = recordingPayload({
      turn: 1,
      step: 1,
      callId: ToolCallId('call-1'),
      name: 'mcp__files__read',
      arguments: '{"token":"PRIVATE"}',
      meta: { secret: true },
    })
    const event = { type: 'tool/call', seq: 7, time: TIME, data: data.payload } as unknown as SessionEvent

    expect(projectUsageSessionEvent({ sessionId: 'session-a', event, workspace, classify: classifySpy })).toEqual({
      type: 'tool-call',
      sessionId: 'session-a',
      seq: 7,
      time: TIME,
      workspace: { workspaceId: 'ws-1', attribution: 'event-time' },
      callId: 'call-1',
      capabilityId: 'mcp__files__read',
      source: { kind: 'mcp', providerId: 'files' },
    })
    expect(classifySpy).toHaveBeenCalledTimes(1)
    expect(classifySpy).toHaveBeenCalledWith('mcp__files__read')
    expect(classifySpy.mock.calls[0]).toHaveLength(1)
    expect(data.accessed).toEqual(['callId', 'name'])
  })

  it('projects a successful tool result without reading content or error data', () => {
    const message = recordingPayload({
      id: MessageId('msg-1'),
      role: 'tool' as const,
      toolCallId: ToolCallId('call-1'),
      isError: false,
      source: { kind: 'tool' as const, callId: ToolCallId('call-1') },
      content: [{ type: 'text' as const, text: 'PRIVATE TOOL OUTPUT' }],
    })
    const data = recordingPayload({ turn: 1, step: 1, message: message.payload })
    const event = {
      type: 'tool/result',
      seq: 2,
      time: TIME + 2000,
      surfaceOp: 'append',
      data: data.payload,
    } as unknown as SessionEvent

    expect(projectUsageSessionEvent({ sessionId: 'session-a', event, workspace, classify })).toEqual({
      type: 'tool-result',
      sessionId: 'session-a',
      seq: 2,
      time: TIME + 2000,
      workspace: { workspaceId: 'ws-1', attribution: 'event-time' },
      callId: 'call-1',
      outcome: 'success',
    })
    expect(projectUsageSessionEventWithGaps({ sessionId: 'session-a', event, workspace, classify }).gaps).toEqual([])
    expect([...new Set(message.accessed)]).toEqual(['toolCallId', 'isError'])
    expect([...new Set(data.accessed)]).toEqual(['message'])
  })

  it('treats a result without isError as success', () => {
    expect(project(toolResultEvent())).toMatchObject({ outcome: 'success' })
  })

  it('reports an unreadable isError getter as malformed instead of success', () => {
    const message = new Proxy(
      {
        id: MessageId('msg-1'),
        role: 'tool',
        toolCallId: ToolCallId('call-1'),
        source: { kind: 'tool', callId: ToolCallId('call-1') },
        content: [{ type: 'text', text: 'PRIVATE TOOL OUTPUT' }],
      },
      {
        get(target, key, receiver) {
          if (key === 'isError') throw new Error('unreadable isError')
          return Reflect.get(target, key, receiver)
        },
      },
    )
    const event = {
      type: 'tool/result',
      seq: 2,
      time: TIME + 2000,
      surfaceOp: 'append',
      data: { turn: 1, step: 1, message },
    } as unknown as SessionEvent

    const projected = detail(event)
    expect(projected.event).toBeUndefined()
    expect(projected.gaps).toEqual([{ reason: 'malformed-tool-result', seq: 2 }])
  })

  it('reports an unreadable error payload as malformed instead of guessing an outcome', () => {
    const data = new Proxy(
      {
        turn: 1,
        step: 1,
        message: {
          id: MessageId('msg-1'),
          role: 'tool',
          toolCallId: ToolCallId('call-1'),
          isError: true,
          source: { kind: 'tool', callId: ToolCallId('call-1') },
          content: [{ type: 'text', text: 'PRIVATE TOOL OUTPUT' }],
        },
      },
      {
        get(target, key, receiver) {
          if (key === 'error') throw new Error('unreadable error')
          return Reflect.get(target, key, receiver)
        },
      },
    )
    const event = {
      type: 'tool/result',
      seq: 2,
      time: TIME + 2000,
      surfaceOp: 'append',
      data,
    } as unknown as SessionEvent

    const projected = detail(event)
    expect(projected.event).toBeUndefined()
    expect(projected.gaps).toEqual([{ reason: 'malformed-tool-result', seq: 2 }])
  })

  it.each([TOOL_ABORTED, TOOL_ABORTED_BEFORE_DISPATCH])(
    'maps the canonical cancellation code %s to cancelled',
    code => {
      const error = recordingPayload({ code })
      const projected = detail(toolResultEvent({ isError: true, error: error.payload as ToolResultError }))
      expect(projected.event).toMatchObject({ outcome: 'cancelled', errorCode: code })
      expect(projected.gaps).toEqual([])
      expect(error.accessed).toEqual(['code'])
    },
  )

  it('never infers denied without a canonical public denial code', () => {
    const withoutCode = detail(toolResultEvent({ isError: true }))
    expect(withoutCode.event).toMatchObject({ outcome: 'error' })
    expect(withoutCode.event).not.toHaveProperty('errorCode')
    expect(withoutCode.gaps).toEqual([{ reason: 'denied-not-observable', seq: 2 }])

    const guessedCode = detail(toolResultEvent({ isError: true, code: 'DENIED' }))
    expect(guessedCode.event).toMatchObject({ outcome: 'error', errorCode: 'DENIED' })
    expect(guessedCode.gaps).toEqual([{ reason: 'denied-not-observable', seq: 2 }])

    expect(withoutCode.event).not.toHaveProperty('outcome', 'denied')
    expect(guessedCode.event).not.toHaveProperty('outcome', 'denied')
  })

  it('keeps ordinary error codes while reporting the denial gap', () => {
    const projected = detail(toolResultEvent({ isError: true, code: 'TOOL_TIMEOUT' }))
    expect(projected.event).toMatchObject({ outcome: 'error', errorCode: 'TOOL_TIMEOUT' })
    expect(projected.gaps).toEqual([{ reason: 'denied-not-observable', seq: 2 }])
  })

  it('drops error codes that are not public identifiers', () => {
    const projected = detail(toolResultEvent({ isError: true, code: 'PRIVATE DETAIL WITH SPACES' }))
    expect(projected.event).toMatchObject({ outcome: 'error' })
    expect(projected.event).not.toHaveProperty('errorCode')
    expect(projected.gaps).toEqual([{ reason: 'denied-not-observable', seq: 2 }])
  })

  it.each([TOOL_OUTCOME_UNKNOWN, TOOL_NOT_STARTED])(
    'skips the synthetic recovery code %s and reports an unknown outcome',
    code => {
      const projected = detail(toolResultEvent({ isError: true, code }))
      expect(projected.event).toBeUndefined()
      expect(projected.gaps).toEqual([{ reason: 'outcome-unknown', seq: 2 }])
    },
  )

  it('leaves an interrupted call unresolved instead of counting a synthetic error', () => {
    let state = createUsageState()
    state = applyUsageEvent(state, project(toolCallEvent())!).state
    const synthetic = project(toolResultEvent({ isError: true, code: TOOL_OUTCOME_UNKNOWN }))
    expect(synthetic).toBeUndefined()
    expect(buildUsageReport(state)).toMatchObject({ calls: 1, failed: 0, unresolved: 1 })
  })

  it.each([
    'user/message',
    'assistant/message',
    'assistant/attempt',
    'request/header',
    'system/message',
    'skills/change',
    'plugin:vendor/record',
    'turn/start',
  ])('skips unsupported control-plane event %s without touching its payload', type => {
    const classifySpy = vi.fn(classify)
    const event = {
      type,
      seq: 5,
      time: TIME,
      get data(): unknown {
        throw new Error('unsupported event payload must not be read')
      },
    } as unknown as SessionEvent
    const projected = projectUsageSessionEventWithGaps({ sessionId: 'session-a', event, workspace, classify: classifySpy })
    expect(projected).toEqual({ gaps: [] })
    expect(classifySpy).not.toHaveBeenCalled()
  })

  it.each<[unknown, { reason: string; seq?: number }]>([
    [null, { reason: 'malformed-event' }],
    ['tool/call', { reason: 'malformed-event' }],
    [{}, { reason: 'malformed-event' }],
    [{ type: 7 }, { reason: 'malformed-event' }],
    [{ type: 'tool/call' }, { reason: 'malformed-tool-call' }],
    [{ type: 'tool/call', seq: 1, time: TIME, data: null }, { reason: 'malformed-tool-call', seq: 1 }],
    [{ type: 'tool/call', seq: 1, time: TIME, data: { name: 'mcp__files__read' } }, { reason: 'malformed-tool-call', seq: 1 }],
    [{ type: 'tool/call', seq: 1, time: TIME, data: { callId: 'call-1', name: '   ' } }, { reason: 'malformed-tool-call', seq: 1 }],
    [{ type: 'tool/result', seq: 2, time: TIME, data: { message: null } }, { reason: 'malformed-tool-result', seq: 2 }],
    [{ type: 'tool/result', seq: 2, time: TIME, data: { message: {} } }, { reason: 'malformed-tool-result', seq: 2 }],
    [{
      type: 'tool/result',
      seq: 2,
      time: TIME,
      data: { message: { toolCallId: 'call-1', isError: 'yes' } },
    }, { reason: 'malformed-tool-result', seq: 2 }],
  ])('reports a malformed event instead of throwing', (raw, expected) => {
    const projected = projectUsageSessionEventWithGaps({
      sessionId: 'session-a',
      event: raw as SessionEvent,
      workspace,
      classify,
    })
    expect(projected.event).toBeUndefined()
    expect(projected.gaps).toEqual([expected])
  })

  it('rejects a missing session identity before classifying', () => {
    const classifySpy = vi.fn(classify)
    expect(projectUsageSessionEventWithGaps({
      sessionId: '   ',
      event: toolCallEvent(),
      workspace,
      classify: classifySpy,
    })).toEqual({ gaps: [{ reason: 'invalid-session-id' }] })
    expect(classifySpy).not.toHaveBeenCalled()
  })

  it('degrades a throwing classifier to an unknown source with a gap', () => {
    const projected = detail(toolCallEvent(), {
      classify: () => {
        throw new Error('classifier unavailable')
      },
    })
    expect(projected.event).toMatchObject({
      capabilityId: 'mcp__files__read',
      source: { kind: 'unknown', reason: 'classifier-failed' },
    })
    expect(projected.gaps).toEqual([{ reason: 'classifier-failed', seq: 1 }])
  })

  it('treats an undefined classifier result as a valid unknown without a gap', () => {
    const projected = detail(toolCallEvent(), { classify: () => undefined })
    expect(projected.event).toMatchObject({
      capabilityId: 'mcp__files__read',
      source: { kind: 'unknown', reason: 'classifier-undetermined' },
    })
    expect(projected.gaps).toEqual([])
  })

  it('degrades an invalid classifier result instead of guessing ownership', () => {
    const projected = detail(toolCallEvent(), {
      classify: () => ({ kind: 'mcp' } as never),
    })
    expect(projected.event).toMatchObject({
      capabilityId: 'mcp__files__read',
      source: { kind: 'unknown', reason: 'invalid-classification' },
    })
    expect(projected.gaps).toEqual([{ reason: 'invalid-classification', seq: 1 }])
  })

  it('strips extra classifier fields and honors a supplied capability id', () => {
    const projected = project(toolCallEvent(), {
      classify: () => ({
        source: { kind: 'plugin-tool', providerId: 'pkg', token: 'PRIVATE' },
        capabilityId: 'cap:1',
        extra: 'PRIVATE',
      }),
    })
    expect(projected).toMatchObject({
      capabilityId: 'cap:1',
      source: { kind: 'plugin-tool', providerId: 'pkg' },
    })
    expect((projected as { source: Record<string, unknown> }).source).not.toHaveProperty('token')
  })

  it('trims providerId but keeps every other identifier verbatim', () => {
    const projected = project(toolCallEvent({ callId: ToolCallId(' call-1 ') }), {
      classify: () => ({
        source: { kind: 'plugin-tool', providerId: '  pkg  ' },
        capabilityId: ' cap:1 ',
      }),
    })
    expect(projected).toMatchObject({
      callId: ' call-1 ',
      capabilityId: ' cap:1 ',
      source: { kind: 'plugin-tool', providerId: 'pkg' },
    })

    const skill = project(toolCallEvent(), {
      classify: () => ({ kind: 'skill', entry: 'skill-tool', providerId: '  files  ' }),
    })
    expect(skill).toMatchObject({ source: { kind: 'skill', entry: 'skill-tool', providerId: 'files' } })
  })

  it('falls back to the tool name for a blank classifier capability id', () => {
    const projected = detail(toolCallEvent(), {
      classify: () => ({ source: { kind: 'native' }, capabilityId: '  ' }),
    })
    expect(projected.event).toMatchObject({ capabilityId: 'mcp__files__read', source: { kind: 'native' } })
    expect(projected.gaps).toEqual([{ reason: 'invalid-classification', seq: 1 }])
  })

  it('copies the caller workspace ref instead of retaining it', () => {
    const frozen = Object.freeze({ workspaceId: 'ws-1', attribution: 'event-time' as const })
    const projected = projectUsageSessionEvent(input(toolCallEvent(), { workspace: frozen }))
    expect(projected?.workspace).toEqual(frozen)
    expect(projected?.workspace).not.toBe(frozen)
  })

  it('forwards a workspace ref that usage-core must reject', () => {
    const projected = project(toolCallEvent(), { workspace: { attribution: 'bogus' as never } })
    expect(projected?.workspace).toMatchObject({ attribution: 'bogus' })
    expect(applyUsageEvent(createUsageState(), projected!)).toMatchObject({
      accepted: false,
      reason: 'invalid-event',
    })
  })

  it.each([
    { seq: -1, time: TIME, expectedSeq: undefined },
    { seq: 1, time: Number.NaN, expectedSeq: 1 },
    { seq: 1, time: Number.POSITIVE_INFINITY, expectedSeq: 1 },
    { seq: 1, time: 'not-a-time', expectedSeq: 1 },
    { time: TIME, expectedSeq: undefined },
  ])(
    'reports an invalid seq/time as a malformed-event gap while leaving core rejection intact',
    ({ seq, time, expectedSeq }) => {
      const event = {
        type: 'tool/call',
        ...(seq === undefined ? {} : { seq }),
        ...(time === undefined ? {} : { time }),
        data: { callId: 'call-1', name: 'mcp__files__read' },
      } as unknown as SessionEvent
      const projected = projectUsageSessionEventWithGaps(input(event))
      expect(projected.event).toBeDefined()
      expect(projected.gaps).toEqual([
        { reason: 'malformed-event', ...(expectedSeq === undefined ? {} : { seq: expectedSeq }) },
      ])
      expect(applyUsageEvent(createUsageState(), projected.event!)).toMatchObject({
        accepted: false,
        reason: 'invalid-event',
      })
    },
  )

  it('reports an unreadable seq getter as a gap and forwards no sentinel', () => {
    const event = {
      type: 'tool/call',
      get seq(): number {
        throw new Error('unreadable seq')
      },
      time: TIME,
      data: { callId: 'call-1', name: 'mcp__files__read' },
    } as unknown as SessionEvent
    const projected = projectUsageSessionEventWithGaps(input(event))
    expect(projected.event).toBeDefined()
    expect((projected.event as { seq?: number }).seq).toBeUndefined()
    expect(projected.gaps).toEqual([{ reason: 'malformed-event' }])
    expect(applyUsageEvent(createUsageState(), projected.event!)).toMatchObject({
      accepted: false,
      reason: 'invalid-event',
    })
  })

  it('feeds usage-core with pair-able metadata-only call and result events', () => {
    let state = createUsageState()
    state = applyUsageEvent(state, project(toolCallEvent())!).state
    state = applyUsageEvent(state, project(toolResultEvent({ isError: false }))!).state
    expect(buildUsageReport(state)).toMatchObject({
      calls: 1,
      succeeded: 1,
      failed: 0,
      denied: 0,
      cancelled: 0,
      unresolved: 0,
    })
  })
})
