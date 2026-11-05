import { describe, expect, it } from 'vitest'
import {
  DEFAULT_REPEAT_THRESHOLDS,
  LOOP_HISTORY_LIMIT,
  createGuardLoopState,
  guardResultFingerprint,
  guardToolSignature,
  observeGuardLoop,
} from '../src/guard-loop-core.ts'

describe('guard loop core', () => {
  it('canonicalizes argument object key order into an exact repeat signature', () => {
    expect(guardToolSignature('read', { z: 2, a: { y: 1, x: 0 } }))
      .toBe(guardToolSignature('read', { a: { x: 0, y: 1 }, z: 2 }))
    expect(guardToolSignature('read', { path: 'a' }))
      .not.toBe(guardToolSignature('write', { path: 'a' }))
  })

  it('escalates warnings at 3, 5, and 8 consecutive calls while allowing changed results', () => {
    let state = createGuardLoopState(3)
    for (let count = 1; count <= 8; count += 1) {
      const result = observeGuardLoop(state, 3, {
        name: 'read', arguments: { path: 'changing' }, outcome: 'success', resultFingerprint: `value-${count}`,
      })
      state = result.state
      if ([3, 5, 8].includes(count)) {
        expect(result.decision).toMatchObject({ repeatCount: count, repeatThreshold: count, warning: 'repeat', blockCandidate: false })
      } else {
        expect(result.decision.warning).toBe('none')
        expect(result.decision.repeatThreshold).toBeUndefined()
      }
    }
  })

  it('warns on an A-B-A-B alternating sequence without blocking when both results change', () => {
    let state = createGuardLoopState(4)
    const call = (name: string, value: number, fingerprint: string) => {
      const result = observeGuardLoop(state, 4, {
        name,
        arguments: { value },
        outcome: 'success',
        resultFingerprint: fingerprint,
      })
      state = result.state
      return result.decision
    }

    expect(call('tool-a', 1, 'a-before').warning).toBe('none')
    expect(call('tool-b', 2, 'b-before').warning).toBe('none')
    expect(call('tool-a', 1, 'a-after').warning).toBe('none')
    expect(call('tool-b', 2, 'b-after')).toMatchObject({
      alternatingCycle: true,
      warning: 'alternating-cycle',
      blockCandidate: false,
      noProgressEvidence: 'none',
    })
  })

  it('counts only consecutive exact repeats', () => {
    let state = createGuardLoopState(1)
    state = observeGuardLoop(state, 1, { name: 'read', arguments: {}, outcome: 'success', resultFingerprint: 'same' }).state
    state = observeGuardLoop(state, 1, { name: 'write', arguments: {}, outcome: 'success', resultFingerprint: 'changed' }).state
    const result = observeGuardLoop(state, 1, { name: 'read', arguments: {}, outcome: 'success', resultFingerprint: 'same' })
    expect(result.decision).toMatchObject({ repeatCount: 1, warning: 'none', blockCandidate: false })
  })

  it('detects a repeated three-tool cycle and only candidate-blocks an unchanged cycle', () => {
    let state = createGuardLoopState(2)
    for (const [name, fingerprint] of [['tool-a', 'a'], ['tool-b', 'b'], ['tool-c', 'c'], ['tool-a', 'a'], ['tool-b', 'b']] as const) {
      state = observeGuardLoop(state, 2, { name, arguments: {}, outcome: 'success', resultFingerprint: fingerprint }).state
    }
    const result = observeGuardLoop(state, 2, { name: 'tool-c', arguments: {}, outcome: 'success', resultFingerprint: 'c' })
    expect(result.decision).toMatchObject({
      alternatingCycle: true,
      warning: 'alternating-cycle',
      blockCandidate: true,
      noProgressEvidence: 'unchanged-cycle',
    })
  })

  it('marks an unchanged complete alternating cycle as a block candidate', () => {
    let state = createGuardLoopState(4)
    for (const [name, fingerprint] of [['tool-a', 'a'], ['tool-b', 'b'], ['tool-a', 'a']] as const) {
      state = observeGuardLoop(state, 4, {
        name, arguments: {}, outcome: 'success', resultFingerprint: fingerprint,
      }).state
    }
    const result = observeGuardLoop(state, 4, {
      name: 'tool-b', arguments: {}, outcome: 'success', resultFingerprint: 'b',
    })
    expect(result.decision).toMatchObject({
      alternatingCycle: true,
      warning: 'alternating-cycle',
      blockCandidate: true,
      noProgressEvidence: 'unchanged-cycle',
    })
  })

  it('does not make a block candidate when an exact repeat produces changed output', () => {
    const first = observeGuardLoop(createGuardLoopState(1), 1, {
      name: 'read', arguments: { path: 'file' }, outcome: 'success', resultFingerprint: 'old',
    })
    const second = observeGuardLoop(first.state, 1, {
      name: 'read', arguments: { path: 'file' }, outcome: 'success', resultFingerprint: 'new',
    })
    expect(second.decision).toMatchObject({ warning: 'none', blockCandidate: false, noProgressEvidence: 'none' })
  })

  it('requires unchanged error evidence and the highest repeat threshold before a block candidate', () => {
    let state = createGuardLoopState(1)
    const fingerprint = guardResultFingerprint('error', { code: 'EHOSTUNREACH' })
    for (let index = 1; index < 8; index += 1) {
      const result = observeGuardLoop(state, 1, {
        name: 'request', arguments: { id: 1 }, outcome: 'error', resultFingerprint: fingerprint,
      })
      state = result.state
      expect(result.decision.blockCandidate).toBe(false)
    }
    const eighth = observeGuardLoop(state, 1, {
      name: 'request', arguments: { id: 1 }, outcome: 'error', resultFingerprint: fingerprint,
    })
    expect(eighth.decision).toMatchObject({
      repeatCount: 8,
      repeatThreshold: 8,
      warning: 'repeat',
      blockCandidate: true,
      noProgressEvidence: 'unchanged-error',
    })
  })

  it('does not candidate-block a repeated call when the outcome class changes', () => {
    const first = observeGuardLoop(createGuardLoopState(1), 1, {
      name: 'request', arguments: {}, outcome: 'error', resultFingerprint: 'same',
    })
    const second = observeGuardLoop(first.state, 1, {
      name: 'request', arguments: {}, outcome: 'success', resultFingerprint: 'same',
    })
    expect(second.decision.blockCandidate).toBe(false)
  })

  it('ignores excluded and polling tools without shifting the detector window', () => {
    const initial = observeGuardLoop(createGuardLoopState(1), 1, {
      name: 'read', arguments: { path: 'x' }, outcome: 'success', resultFingerprint: 'v1',
    })
    const excluded = observeGuardLoop(initial.state, 1, {
      name: 'meta_search', arguments: { query: 'x' }, outcome: 'success', resultFingerprint: 'meta',
    }, { excludedTools: new Set(['meta_search']) })
    const polling = observeGuardLoop(excluded.state, 1, {
      name: 'wait_status', arguments: { job: 'x' }, outcome: 'success', resultFingerprint: 'pending',
    }, { pollingTools: new Set(['wait_status']) })

    expect(excluded.decision.ignored).toBe(true)
    expect(polling.decision.ignored).toBe(true)
    expect(polling.state).toBe(initial.state)
    const repeated = observeGuardLoop(polling.state, 1, {
      name: 'read', arguments: { path: 'x' }, outcome: 'success', resultFingerprint: 'v1',
    })
    expect(repeated.decision).toMatchObject({ repeatCount: 2, warning: 'none', blockCandidate: false })
  })

  it('retains only hashes, never raw arguments or results', () => {
    const rawArgument = 'private-path-7f21e'
    const rawResult = { content: 'private-result-90bc3' }
    const observed = observeGuardLoop(createGuardLoopState(6), 6, {
      name: 'read', arguments: { path: rawArgument }, outcome: 'success', result: rawResult,
    })
    const retained = JSON.stringify(observed.state)
    expect(retained).not.toContain(rawArgument)
    expect(retained).not.toContain(rawResult.content)
    expect(observed.state.history[0].signature).toMatch(/^[a-f0-9]{64}$/)
    expect(observed.state.history[0].resultFingerprint).toMatch(/^[a-f0-9]{64}$/)
  })

  it('bounds retained history to the most recent 16 observations', () => {
    let state = createGuardLoopState(9)
    for (let i = 0; i < LOOP_HISTORY_LIMIT + 5; i += 1) {
      state = observeGuardLoop(state, 9, {
        name: 'write', arguments: { index: i }, outcome: 'success', resultFingerprint: `result-${i}`,
      }).state
    }
    expect(state.history).toHaveLength(LOOP_HISTORY_LIMIT)
    expect(state.history.at(-1)?.signature).toBe(guardToolSignature('write', { index: LOOP_HISTORY_LIMIT + 4 }))
  })

  it('resets history at a new turn and keeps caller-controlled Agent isolation', () => {
    const agentA = observeGuardLoop(createGuardLoopState(1), 1, {
      name: 'read', arguments: {}, outcome: 'success', resultFingerprint: 'same',
    }).state
    const agentB = createGuardLoopState(1)
    const otherAgent = observeGuardLoop(agentB, 1, {
      name: 'read', arguments: {}, outcome: 'success', resultFingerprint: 'same',
    })
    expect(otherAgent.decision.repeatCount).toBe(1)

    const nextTurn = observeGuardLoop(agentA, 2, {
      name: 'read', arguments: {}, outcome: 'success', resultFingerprint: 'same',
    })
    expect(nextTurn.state.turn).toBe(2)
    expect(nextTurn.decision.repeatCount).toBe(1)
  })

  it('uses deterministic 3/5/8 repeat warning thresholds', () => {
    expect(DEFAULT_REPEAT_THRESHOLDS).toEqual([3, 5, 8])
  })
})
