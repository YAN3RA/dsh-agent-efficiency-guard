import { describe, expect, it } from 'vitest'
import {
  EfficiencyGuard,
  canonicalJson,
  toolSignature,
  validateGuardConfig,
} from '../src/guard-core.ts'

describe('agent efficiency guard core', () => {
  it('canonicalizes object key order without retaining raw arguments', () => {
    expect(canonicalJson({ b: 2, a: 1 })).toBe('{"a":1,"b":2}')
    expect(toolSignature('read', { b: 2, a: 1 })).toBe(toolSignature('read', { a: 1, b: 2 }))
    expect(toolSignature('read', { a: 1 })).not.toBe(toolSignature('write', { a: 1 }))
  })

  it('validates ordered soft and hard thresholds', () => {
    expect(() => validateGuardConfig({
      profiles: {
        normal: {
          softSteps: 8,
          hardSteps: 8,
          softToolCalls: 1,
          hardToolCalls: 2,
          softDurationMs: 1,
          hardDurationMs: 2,
        },
      },
    })).toThrow(/softSteps must be less than hardSteps/)
  })

  it('keeps agent and turn counters isolated', () => {
    const guard = new EfficiencyGuard({
      profile: 'quick',
      profiles: {
        quick: { softSteps: 1, hardSteps: 2, softToolCalls: 1, hardToolCalls: 2, softDurationMs: 100, hardDurationMs: 200 },
      },
    })
    const first = {}
    const second = {}
    expect(guard.admitStep(first, 1, 0)).toEqual({ kind: 'allow' })
    expect(guard.admitStep(first, 1, 1)).toEqual({ kind: 'allow' })
    expect(guard.admitStep(first, 1, 2)).toMatchObject({ kind: 'deny', code: 'step-budget' })
    expect(guard.admitStep(second, 1, 2)).toEqual({ kind: 'allow' })
    expect(guard.admitStep(first, 2, 2)).toEqual({ kind: 'allow' })
  })

  it('hard-stops tool and time budgets before dispatch', () => {
    const guard = new EfficiencyGuard({
      profile: 'quick',
      profiles: {
        quick: { softSteps: 3, hardSteps: 5, softToolCalls: 1, hardToolCalls: 2, softDurationMs: 10, hardDurationMs: 20 },
      },
    })
    const agent = {}
    guard.admitStep(agent, 1, 0)
    expect(guard.observeTool(agent, 1, { name: 'read', arguments: { path: 'a' } }, 1).decision).toEqual({ kind: 'allow' })
    expect(guard.observeTool(agent, 1, { name: 'read', arguments: { path: 'b' } }, 2).decision).toEqual({ kind: 'allow' })
    expect(guard.observeTool(agent, 1, { name: 'read', arguments: { path: 'c' } }, 3).decision).toMatchObject({ kind: 'deny', code: 'tool-budget' })

    const timeAgent = {}
    guard.admitStep(timeAgent, 1, 0)
    expect(guard.admitStep(timeAgent, 1, 21)).toMatchObject({ kind: 'deny', code: 'time-budget' })
  })

  it('sends at most one convergence steer and stops repeated no-progress cycles', () => {
    const guard = new EfficiencyGuard({
      profile: 'quick',
      profiles: {
        quick: { softSteps: 1, hardSteps: 5, softToolCalls: 1, hardToolCalls: 5, softDurationMs: 10, hardDurationMs: 100 },
      },
      hostIntegration: { maxConvergenceSteersPerTurn: 1, maxNoProgressCycles: 2 },
    })
    const agent = {}
    guard.admitStep(agent, 1, 0)
    expect(guard.noteTurnStopping(agent, 1, false, true, 1)).toEqual({ shouldSteer: true, shouldStop: false })
    expect(guard.noteTurnStopping(agent, 1, false, true, 2)).toEqual({ shouldSteer: false, shouldStop: true })
    expect(guard.admitStep(agent, 1, 4)).toMatchObject({ kind: 'deny', code: 'no-progress-loop' })
  })

  it('resets no-progress cycles after a new result fingerprint', () => {
    const guard = new EfficiencyGuard({
      profile: 'quick',
      profiles: {
        quick: { softSteps: 1, hardSteps: 5, softToolCalls: 5, hardToolCalls: 6, softDurationMs: 10, hardDurationMs: 100 },
      },
      hostIntegration: { maxConvergenceSteersPerTurn: 1, maxNoProgressCycles: 2 },
    })
    const agent = {}
    guard.admitStep(agent, 1, 0)
    expect(guard.noteTurnStopping(agent, 1, false, true, 1).shouldSteer).toBe(true)
    guard.noteToolResult(agent, 1, 'read', { value: 'new' }, 2)
    expect(guard.noteTurnStopping(agent, 1, false, true, 3).shouldStop).toBe(false)
  })
})
