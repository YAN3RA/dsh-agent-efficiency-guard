import { describe, expect, it } from 'vitest'
import { TYPERT_REMOTE } from '../src/client/remote.ts'
import { USAGE_TYPERT_REMOTE } from '../src/client/usage-remote.ts'
import {
  HOST_FACE_NAMESPACE,
  HOST_FACE_PACKAGE,
  HOST_FACE_SERVICE,
  capabilityPolicyHostFace,
  mergeHostFaces,
} from '../src/host-face.ts'
import { usageHostFace } from '../src/usage/usage-host-face.ts'

const hostFace = capabilityPolicyHostFace()

/** `<method>` → `[wire, optional]` pairs, as the browser face declares them. */
function clientWireTable() {
  const table = new Map<string, [string, boolean][]>()
  for (const descriptor of TYPERT_REMOTE.descriptors) {
    table.set(
      descriptor.method,
      descriptor.parameters.map((parameter) => [
        parameter.wire,
        (parameter as { acceptsUndefined?: boolean }).acceptsUndefined === true,
      ]),
    )
  }
  return table
}

/** `<method>` → `[wire, optional]` pairs, as the host face declares them. */
function hostWireTable() {
  const table = new Map<string, [string, boolean][]>()
  for (const invocation of hostFace.invocations) {
    table.set(
      invocation.method,
      invocation.parameters.map((parameter) => [parameter.wire, parameter.acceptsUndefined === true]),
    )
  }
  return table
}

describe('capabilityPolicy host face', () => {
  it('registers the wire namespace the browser face calls', () => {
    expect(hostFace.package).toBe(HOST_FACE_PACKAGE)
    expect(hostFace.package).toBe(TYPERT_REMOTE.package)
    expect(hostFace.face).toBe('host')
    expect(hostFace.schemas).toEqual([])
    expect(hostFace.model).toEqual({ services: [], events: [], objects: [] })

    for (const invocation of hostFace.invocations) {
      expect(invocation.namespace).toBe(HOST_FACE_NAMESPACE)
      // The gateway resolves the receiver by service key and then asserts its
      // `typertRemote` binding, so this must be the gateway's own service key.
      expect(invocation.service).toBe(HOST_FACE_SERVICE)
      expect(invocation.invocation).toEqual({ kind: 'direct' })
    }
  })

  it('covers exactly the endpoints the browser face declares', () => {
    const host = [...hostWireTable().keys()].sort()
    const browser = [...clientWireTable().keys()].sort()
    expect(host).toEqual(browser)
    // Guard the guard: an empty table would make the comparison vacuous.
    expect(host.length).toBeGreaterThan(0)
  })

  it('sends every field the browser sends, with the same optionality', () => {
    const host = hostWireTable()
    for (const [method, expected] of clientWireTable()) {
      expect(host.get(method), method).toEqual(expected)
    }
  })

  it('satisfies the registry’s invocation rules', () => {
    const ids = new Set<string>()
    const endpoints = new Set<string>()
    const wireName = /^[A-Za-z0-9_$.-]+$/

    for (const invocation of hostFace.invocations) {
      expect(invocation.id.length).toBeGreaterThan(0)
      expect(ids.has(invocation.id)).toBe(false)
      ids.add(invocation.id)

      const endpoint = `${invocation.namespace}/${invocation.method}`
      expect(endpoints.has(endpoint)).toBe(false)
      endpoints.add(endpoint)

      expect(invocation.method).toMatch(wireName)
      expect(invocation.result.mode).toBe('strict')
      expect(invocation.result.typeSymbol.length).toBeGreaterThan(0)

      const wires = new Set<string>()
      for (const parameter of invocation.parameters) {
        expect(parameter.name).toMatch(wireName)
        expect(parameter.wire).toMatch(wireName)
        expect(parameter.source).toBe('json')
        expect(wires.has(parameter.wire)).toBe(false)
        wires.add(parameter.wire)
        expect(parameter.codec.mode).toBe('strict')
        expect(parameter.codec.typeSymbol.length).toBeGreaterThan(0)
      }
    }
  })

  it('decodes arguments with a pass-through codec', () => {
    // The gateway decodes arguments with `codec.create().parse(value)`; a
    // pass-through keeps rc-to-rc payload differences from being rejected after
    // the method signature has already accepted the call.
    const value = { nested: [1, 'two', null] }
    for (const invocation of hostFace.invocations) {
      expect(invocation.result.create().parse(value)).toBe(value)
      for (const parameter of invocation.parameters) {
        expect(parameter.codec.create().parse(value)).toBe(value)
      }
    }
  })
})

describe('merged host face', () => {
  // Regression: the browser mounts ONE Typert contribution
  // (`TYPERT_REMOTE_WITH_USAGE`), so the Host must claim one too. Two
  // `register()` calls for the same `package` make Typert withdraw the first
  // contribution's strict definitions; the endpoint then stays `hasSeen()` and
  // the gateway answers `gateway/definition-unavailable: … its strict definition
  // was withdrawn and SRC fallback is forbidden`. That was the production
  // `capabilityPolicy.classifyAll` failure.
  const merged = mergeHostFaces([capabilityPolicyHostFace(), usageHostFace()])

  it('keeps the single package identity every contribution must share', () => {
    expect(merged.package).toBe(HOST_FACE_PACKAGE)
    expect(merged.face).toBe('host')
    expect(usageHostFace().package).toBe(HOST_FACE_PACKAGE)
    expect(merged.schemas).toEqual([])
    expect(merged.model).toEqual({ services: [], events: [], objects: [] })
  })

  it('carries every invocation of both namespaces exactly once', () => {
    const ids = merged.invocations.map(invocation => invocation.id)
    expect(new Set(ids).size).toBe(ids.length)
    expect(ids).toEqual([
      ...capabilityPolicyHostFace().invocations.map(invocation => invocation.id),
      ...usageHostFace().invocations.map(invocation => invocation.id),
    ])
    const namespaces = new Set(merged.invocations.map(invocation => invocation.namespace))
    expect([...namespaces].sort()).toEqual(['capabilityPolicy', 'usage'])
  })

  it('covers exactly the endpoints the browser face asks for', () => {
    const hostEndpoints = new Set(merged.invocations.map(invocation => `${invocation.namespace}/${invocation.method}`))
    const clientEndpoints = [
      ...TYPERT_REMOTE.descriptors.map(descriptor => `${descriptor.namespace}/${descriptor.method}`),
      ...USAGE_TYPERT_REMOTE.descriptors.map(descriptor => `${descriptor.namespace}/${descriptor.method}`),
    ]
    for (const endpoint of clientEndpoints) expect(hostEndpoints.has(endpoint)).toBe(true)
    expect(hostEndpoints.size).toBe(clientEndpoints.length)
  })

  it('refuses to merge faces from different packages', () => {
    const foreign = { ...usageHostFace(), package: 'someone-else' }
    expect(() => mergeHostFaces([capabilityPolicyHostFace(), foreign])).toThrow(/package mismatch/)
  })

  it('refuses to merge duplicate invocation ids', () => {
    expect(() => mergeHostFaces([capabilityPolicyHostFace(), capabilityPolicyHostFace()]))
      .toThrow(/duplicate invocation/)
  })
})
