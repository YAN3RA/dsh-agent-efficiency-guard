/**
 * 思考限制 container — wires `GuardPanel` to the real Guard switches.
 *
 * `GuardPanel` is the pure view (hook-free, walkable by the test suite). This
 * container owns the two things that need a hook: reading the switches from the
 * Host and writing a toggle back.
 *
 * Failure handling is deliberate:
 * - A failed read renders the switches as unavailable, not as "off"; an unknown
 *   switch state must never look like a deliberate choice.
 * - A failed write restores the previous value and shows the reason, so the
 *   switch never claims a state the Host did not accept.
 * - Only one write is in flight at a time; the panel disables itself meanwhile.
 */
import { createElement, useCallback, useEffect, useRef, useState, type ReactElement } from 'react'
import { GuardPanel, type GuardSectionId } from './GuardPanel.tsx'
import type { PluginSectionKey } from './PluginSection.tsx'
import type { GuardSwitches } from './remote.ts'

/** The remote face this container reads; a subset of `CapabilityPolicyRemote`. */
export interface GuardSwitchRemote {
  getGuard?(): Promise<{ ok: true; value: GuardSwitches } | { ok: false; error: { code: string; message: string } }>
  updateGuard?(change: Partial<GuardSwitches>): Promise<{ ok: true; value: void } | { ok: false; error: { code: string; message: string } }>
  /** Used by 总览 for the tier split; declared here so one object serves both. */
  classifyAll?(): Promise<
    { ok: true; value: readonly { class: 'resident' | 'on-demand' | 'disabled' }[] }
    | { ok: false; error: { code: string; message: string } }
  >
}

export interface GuardContainerProps {
  readonly t: (key: PluginSectionKey) => string
  readonly remote: GuardSwitchRemote
  /** Fixed thresholds; the implementation does not expose per-level edits. */
  readonly duplicateThresholds?: readonly number[]
}

/** Section id → Guard switch it controls. */
const SECTION_FIELD: Readonly<Record<GuardSectionId, keyof GuardSwitches>> = {
  duplicate_call: 'duplicateDetection',
  alternating_cycle: 'alternatingCycleDetection',
  no_progress: 'noProgressProtection',
}

interface State {
  readonly switches?: GuardSwitches
  readonly error?: string
  readonly busy: boolean
}

export function GuardContainer(props: GuardContainerProps): ReactElement {
  const { t, remote, duplicateThresholds } = props
  const [state, setState] = useState<State>({ busy: false })
  const alive = useRef(true)

  useEffect(() => {
    alive.current = true
    return () => { alive.current = false }
  }, [])

  const load = useCallback(async (): Promise<void> => {
    if (remote.getGuard === undefined) {
      setState({ busy: false, error: 'Host does not expose Guard switches.' })
      return
    }
    const result = await remote.getGuard()
    if (!alive.current) return
    if (result.ok) setState({ switches: result.value, busy: false })
    else setState({ busy: false, error: result.error.message })
  }, [remote])

  useEffect(() => { void load() }, [load])

  const toggle = useCallback(async (id: GuardSectionId, next: boolean): Promise<void> => {
    const field = SECTION_FIELD[id]
    const previous = state.switches
    if (previous === undefined) return
    // Optimistic: the switch moves immediately, and a rejection restores it.
    setState({ switches: { ...previous, [field]: next }, busy: true })
    if (remote.updateGuard === undefined) {
      setState({ switches: previous, busy: false, error: 'Host does not accept Guard changes.' })
      return
    }
    const result = await remote.updateGuard({ [field]: next })
    if (!alive.current) return
    if (result.ok) setState({ switches: { ...previous, [field]: next }, busy: false })
    else setState({ switches: previous, busy: false, error: result.error.message })
  }, [remote, state.switches])

  const reset = useCallback(async (): Promise<void> => {
    const previous = state.switches
    if (previous === undefined || remote.updateGuard === undefined) return
    const defaults: GuardSwitches = {
      enabled: true,
      duplicateDetection: true,
      alternatingCycleDetection: true,
      noProgressProtection: true,
    }
    setState({ switches: defaults, busy: true })
    const result = await remote.updateGuard(defaults)
    if (!alive.current) return
    if (result.ok) setState({ switches: defaults, busy: false })
    else setState({ switches: previous, busy: false, error: result.error.message })
  }, [remote, state.switches])

  const switches = state.switches
  return createElement('div', { className: 'mc-guard-container' },
    state.error !== undefined && createElement('p', { className: 'mc-error-hint' }, state.error),
    createElement(GuardPanel, {
      t,
      duplicateThresholds,
      // Undefined while loading or after a failed read: the panel then renders
      // the switches disabled rather than as a false "off".
      enabled: switches === undefined
        ? undefined
        : {
            duplicate_call: switches.duplicateDetection,
            alternating_cycle: switches.alternatingCycleDetection,
            no_progress: switches.noProgressProtection,
          },
      onToggle: switches === undefined || state.busy ? undefined : (id: GuardSectionId, next: boolean) => { void toggle(id, next) },
      onReset: switches === undefined || state.busy ? undefined : () => { void reset() },
    }),
  )
}
