import { describe, expect, it } from 'vitest'
import {
  USAGE_PROFILE_HASH_LENGTH,
  USAGE_PROFILE_MAX_NAME_LENGTH,
  USAGE_PROFILE_MAX_PAYLOAD_DEPTH,
  USAGE_PROFILE_SCHEMA,
  USAGE_PROFILE_SCHEMA_VERSION,
  UsageProfileError,
  decodeUsageProfileEnvelope,
  decodeUsageProfileJson,
  encodeUsageProfileEnvelope,
  encodeUsageProfileJson,
  hashUsageProfileName,
  isSafeUsageProfileName,
  resolveUsageProfile,
  type UsageProfileIdentity,
  type UsageProfileJsonValue,
} from '../src/usage/usage-profile.ts'

function contextWith(profileContext: unknown): unknown {
  return { get: (key: string) => (key === 'profileContext' ? profileContext : undefined) }
}

function resolved(name: string): UsageProfileIdentity {
  const result = resolveUsageProfile(contextWith({ name }))
  if (result.status !== 'available') {
    throw new Error(`expected an available profile for ${JSON.stringify(name)}: ${result.reason}`)
  }
  return { name: result.name, hash: result.hash }
}

function expectError(run: () => unknown, code: UsageProfileError['code']): UsageProfileError {
  try {
    run()
  } catch (error) {
    expect(error).toBeInstanceOf(UsageProfileError)
    const failure = error as UsageProfileError
    expect(failure.code).toBe(code)
    return failure
  }
  throw new Error(`expected UsageProfileError(${code})`)
}

function withoutField(document: Record<string, unknown>, field: string): Record<string, unknown> {
  const copy = { ...document }
  delete copy[field]
  return copy
}

describe('usage profile resolution', () => {
  it('returns unavailable when the context or the profile service is missing', () => {
    expect(resolveUsageProfile(undefined))
      .toEqual({ status: 'unavailable', reason: 'context-unavailable' })
    expect(resolveUsageProfile(null))
      .toEqual({ status: 'unavailable', reason: 'context-unavailable' })
    expect(resolveUsageProfile('desktop'))
      .toEqual({ status: 'unavailable', reason: 'context-unavailable' })
    expect(resolveUsageProfile({}))
      .toEqual({ status: 'unavailable', reason: 'context-unavailable' })
    expect(resolveUsageProfile({ get: 42 }))
      .toEqual({ status: 'unavailable', reason: 'context-unavailable' })
    expect(resolveUsageProfile({ get: () => undefined }))
      .toEqual({ status: 'unavailable', reason: 'profile-context-missing' })
    expect(resolveUsageProfile({ get: () => null }))
      .toEqual({ status: 'unavailable', reason: 'profile-context-missing' })
  })

  it('distinguishes a malformed profile service from a missing one', () => {
    expect(resolveUsageProfile({ get: () => 'desktop' }))
      .toEqual({ status: 'unavailable', reason: 'profile-context-invalid' })
    expect(resolveUsageProfile({ get: () => 7 }))
      .toEqual({ status: 'unavailable', reason: 'profile-context-invalid' })
    expect(resolveUsageProfile({ get: () => [] }))
      .toEqual({ status: 'unavailable', reason: 'profile-context-invalid' })
  })

  it('never throws for a hostile context or a throwing name getter', () => {
    const throwingGet = {
      get(): unknown {
        throw new Error('get failed')
      },
    }
    expect(resolveUsageProfile(throwingGet))
      .toEqual({ status: 'unavailable', reason: 'context-unavailable' })

    const hostile = new Proxy({}, {
      get(): unknown {
        throw new Error('trap')
      },
    })
    expect(resolveUsageProfile(hostile))
      .toEqual({ status: 'unavailable', reason: 'context-unavailable' })

    const throwingName = {
      get: () => Object.defineProperty({}, 'name', {
        get(): unknown {
          throw new Error('name failed')
        },
      }),
    }
    expect(resolveUsageProfile(throwingName))
      .toEqual({ status: 'unavailable', reason: 'profile-name-invalid' })
  })

  it('reads only the public profileContext key', () => {
    const keys: string[] = []
    const context = {
      get(key: string): unknown {
        keys.push(key)
        return { name: 'desktop' }
      },
    }
    const result = resolveUsageProfile(context)
    expect(result.status).toBe('available')
    expect(keys).toEqual(['profileContext'])
  })

  it('treats a missing, blank or non-string name as unavailable', () => {
    expect(resolveUsageProfile(contextWith({})))
      .toEqual({ status: 'unavailable', reason: 'profile-name-missing' })
    expect(resolveUsageProfile(contextWith({ name: undefined })))
      .toEqual({ status: 'unavailable', reason: 'profile-name-missing' })
    expect(resolveUsageProfile(contextWith({ name: null })))
      .toEqual({ status: 'unavailable', reason: 'profile-name-missing' })

    for (const name of ['', '   ', 7, true, {}, []]) {
      expect(resolveUsageProfile(contextWith({ name })))
        .toEqual({ status: 'unavailable', reason: 'profile-name-invalid' })
    }
  })

  it('rejects every path-like or invisible name shape', () => {
    const unsafe = [
      '.',
      '..',
      '../desktop',
      '..\\desktop',
      'desktop/child',
      'desktop\\child',
      'C:desktop',
      'desktop:stream',
      'desk\u0000top',
      'desk\ntop',
      'desk\ttop',
      ' desktop',
      'desktop ',
      'desktop.',
      'a|b',
      'a*b',
      'a?b',
      'a"b',
      'a<b',
      'a>b',
      'a\u2028b',
      'a\u2029b',
      'a\u200Bb',
      'x'.repeat(USAGE_PROFILE_MAX_NAME_LENGTH + 1),
    ]
    for (const name of unsafe) {
      expect(isSafeUsageProfileName(name)).toBe(false)
      expect(hashUsageProfileName(name)).toBeUndefined()
      expect(resolveUsageProfile(contextWith({ name })))
        .toEqual({ status: 'unavailable', reason: 'profile-name-invalid' })
    }
  })

  it('accepts bounded unicode and ordinary profile names without rewriting them', () => {
    const names = [
      'desktop',
      'default',
      'profile_1',
      'profile-1',
      'my.profile',
      '工作区-测试',
      'pérfil-é',
      'profile-🚀',
      'x'.repeat(USAGE_PROFILE_MAX_NAME_LENGTH),
    ]
    for (const name of names) {
      expect(isSafeUsageProfileName(name)).toBe(true)
      const result = resolveUsageProfile(contextWith({ name }))
      expect(result.status).toBe('available')
      if (result.status === 'available') {
        expect(result.name).toBe(name)
        expect(result.hash).toMatch(/^[a-f0-9]{64}$/)
      }
    }
  })
})

describe('usage profile partition key', () => {
  it('is a deterministic lowercase SHA-256 with a fixed known value', () => {
    const first = resolved('desktop')
    const second = resolved('desktop')
    expect(first.hash).toBe(second.hash)
    expect(first.hash).toHaveLength(USAGE_PROFILE_HASH_LENGTH)
    expect(first.hash).toMatch(/^[a-f0-9]{64}$/)
    // Locks the hash domain: changing it would strand every stored partition.
    // The domain carries the package name, so the rename to dsh-thinking-guard
    // moved these values. That is safe only because the runtime is `memory`-mode
    // and persists no partition; a future on-disk backend must not repeat this
    // without a migration.
    expect(first.hash).toBe('6c66f3440325fce99a479d5dc86ea7a2dd0d4ba845d90dc76f96fcab93f4f61e')
    expect(resolved('工作区-测试').hash)
      .toBe('fe17c779671cf4b3323f81a4405b5bd15e77230db087a849445b5e3b195a74b4')
  })

  it('separates case variants, renamed profiles and unicode profiles', () => {
    const hashes = new Set(
      ['desktop', 'Desktop', 'deskt0p', 'desktop-renamed', '工作区', 'pérfil']
        .map((name) => resolved(name).hash),
    )
    expect(hashes.size).toBe(6)
  })

  it('treats a rename as a different partition rather than relinking history', () => {
    const before = resolved('desktop')
    const after = resolved('desktop-renamed')
    expect(before.hash).not.toBe(after.hash)

    const oldDocument = encodeUsageProfileEnvelope(before, { calls: 4 })
    expectError(() => decodeUsageProfileEnvelope(after, oldDocument), 'profile-mismatch')
  })
})

describe('usage profile envelope', () => {
  it('round-trips every JSON value kind with the exact profile identity', () => {
    const profile = resolved('工作区-测试')
    const payload = {
      calls: 12,
      ok: true,
      missing: null,
      label: '统计',
      nested: [{ id: 's-1', values: [1, 2.5, 'x', false, null] }],
    }
    const envelope = encodeUsageProfileEnvelope(profile, payload)

    expect(Object.keys(envelope)).toEqual(['profileName', 'hash', 'schema', 'version', 'payload'])
    expect(envelope.profileName).toBe(profile.name)
    expect(envelope.hash).toBe(profile.hash)
    expect(envelope.schema).toBe(USAGE_PROFILE_SCHEMA)
    expect(envelope.version).toBe(USAGE_PROFILE_SCHEMA_VERSION)

    const parsed: unknown = JSON.parse(JSON.stringify(envelope))
    const decoded = decodeUsageProfileEnvelope(profile, parsed)
    expect(decoded.payload).toEqual(payload)
    expect(decoded.profileName).toBe(profile.name)
    expect(decoded.hash).toBe(profile.hash)
    expect(JSON.parse(encodeUsageProfileJson(profile, payload))).toEqual(envelope)
    expect(decodeUsageProfileJson(profile, encodeUsageProfileJson(profile, payload)).payload)
      .toEqual(payload)
  })

  it('returns a detached payload copy', () => {
    const profile = resolved('desktop')
    const envelope = encodeUsageProfileEnvelope(profile, { calls: 3 })
    const decoded = decodeUsageProfileEnvelope(profile, envelope)
    const decodedPayload = decoded.payload as { calls: number }
    decodedPayload.calls = 99
    expect((envelope.payload as { calls: number }).calls).toBe(3)
  })

  it('rejects an identity whose hash was not derived from its name', () => {
    const profile = resolved('desktop')
    const envelope = encodeUsageProfileEnvelope(profile, { calls: 1 })
    expectError(() => encodeUsageProfileEnvelope(
      { name: '../escape', hash: 'a'.repeat(64) },
      null,
    ), 'invalid-profile')
    expectError(() => encodeUsageProfileEnvelope(
      { name: 'desktop', hash: 'b'.repeat(64) },
      null,
    ), 'invalid-profile')
    expectError(() => decodeUsageProfileEnvelope(
      { name: 'desktop', hash: 'b'.repeat(64) },
      envelope,
    ), 'invalid-profile')
  })

  it('fails closed on mismatched or inconsistent cross-profile envelopes without exposing payload', () => {
    const desktop = resolved('desktop')
    const laptop = resolved('laptop')
    const envelope = encodeUsageProfileEnvelope(desktop, { secret: 'desktop-only' })

    const failure = expectError(
      () => decodeUsageProfileEnvelope(laptop, envelope),
      'profile-mismatch',
    )
    expect(failure.message).not.toContain('desktop-only')
    expect(failure.message).not.toContain('desktop')
    expect(failure.message).not.toContain('laptop')

    expectError(() => decodeUsageProfileEnvelope(desktop, {
      ...envelope,
      profileName: laptop.name,
    }), 'profile-mismatch')
    expectError(() => decodeUsageProfileEnvelope(desktop, {
      ...envelope,
      hash: laptop.hash,
    }), 'profile-mismatch')
  })

  it('rejects missing, extra, mistyped and unsupported envelope fields', () => {
    const profile = resolved('desktop')
    const envelope = encodeUsageProfileEnvelope(profile, { calls: 1 })
    const document: Record<string, unknown> = { ...envelope }

    for (const field of ['profileName', 'hash', 'schema', 'version', 'payload']) {
      expectError(() => decodeUsageProfileEnvelope(profile, withoutField(document, field)), 'invalid-document')
    }

    expectError(() => decodeUsageProfileEnvelope(profile, { ...document, extra: true }), 'invalid-document')
    expectError(() => decodeUsageProfileEnvelope(profile, { ...document, schema: 'other/schema' }), 'invalid-document')
    expectError(() => decodeUsageProfileEnvelope(profile, { ...document, version: 2 }), 'unsupported-version')
    expectError(() => decodeUsageProfileEnvelope(profile, { ...document, version: '1' }), 'invalid-document')
    expectError(() => decodeUsageProfileEnvelope(profile, { ...document, version: 1.5 }), 'invalid-document')
    expectError(() => decodeUsageProfileEnvelope(profile, { ...document, profileName: 7 }), 'invalid-document')
    expectError(() => decodeUsageProfileEnvelope(profile, { ...document, profileName: '../desktop' }), 'invalid-document')
    expectError(() => decodeUsageProfileEnvelope(profile, { ...document, hash: 'A'.repeat(64) }), 'invalid-document')
    expectError(() => decodeUsageProfileEnvelope(profile, { ...document, hash: 'a'.repeat(63) }), 'invalid-document')
    expectError(() => decodeUsageProfileEnvelope(profile, { ...document, hash: 7 }), 'invalid-document')

    for (const malformed of [null, [], 'text', 42]) {
      expectError(() => decodeUsageProfileEnvelope(profile, malformed), 'invalid-document')
    }
    expectError(() => decodeUsageProfileJson(profile, '{not json'), 'invalid-json')
    expectError(() => decodeUsageProfileJson(profile, 42 as unknown as string), 'invalid-document')
  })

  it('rejects accessor-backed and non-enumerable envelope fields without invoking them', () => {
    const profile = resolved('desktop')
    const document: Record<string, unknown> = { ...encodeUsageProfileEnvelope(profile, { calls: 1 }) }

    let invoked = false
    Object.defineProperty(document, 'schema', {
      enumerable: true,
      get(): unknown {
        invoked = true
        throw new Error('schema getter')
      },
    })
    expectError(() => decodeUsageProfileEnvelope(profile, document), 'invalid-document')
    expect(invoked).toBe(false)

    const hidden: Record<string, unknown> = { ...encodeUsageProfileEnvelope(profile, { calls: 1 }) }
    Object.defineProperty(hidden, 'hidden', { value: true })
    expectError(() => decodeUsageProfileEnvelope(profile, hidden), 'invalid-document')
  })
})

describe('usage profile payload safety', () => {
  it('rejects values that JSON would drop, change or reject', () => {
    const profile = resolved('desktop')
    const invalid: Array<[string, unknown]> = [
      ['undefined', undefined],
      ['function', () => 1],
      ['symbol', Symbol('payload')],
      ['bigint', 1n],
      ['NaN', Number.NaN],
      ['Infinity', Number.POSITIVE_INFINITY],
      ['negative zero', -0],
      ['Date', new Date(0)],
      ['Map', new Map([['x', 1]])],
      ['Set', new Set([1])],
      ['class instance', new (class Payload { value = 1 })()],
      ['non-plain object', Object.create({ inherited: 1 })],
      ['sparse array', [1, , 3]],
      ['array extra property', Object.assign([1, 2], { extra: true })],
      ['array symbol property', Object.assign([1], { [Symbol('x')]: 1 })],
      ['getter property', Object.defineProperty({}, 'value', { enumerable: true, get: () => 1 })],
      ['undefined property', { value: undefined }],
      ['nested undefined', { list: [1, undefined] }],
      ['__proto__ key', JSON.parse('{"__proto__":{"polluted":true}}') as unknown],
    ]

    for (const [label, value] of invalid) {
      const failure = expectError(
        () => encodeUsageProfileEnvelope(profile, value as UsageProfileJsonValue),
        'invalid-payload',
      )
      expect(failure.path, label).toContain('$.payload')
    }
  })

  it('rejects cycles and over-deep payloads', () => {
    const profile = resolved('desktop')
    const cyclic: Record<string, unknown> = {}
    cyclic.self = cyclic
    expectError(
      () => encodeUsageProfileEnvelope(profile, cyclic as unknown as UsageProfileJsonValue),
      'invalid-payload',
    )

    let deep: UsageProfileJsonValue = 'leaf'
    for (let index = 0; index < USAGE_PROFILE_MAX_PAYLOAD_DEPTH + 1; index += 1) {
      deep = [deep]
    }
    expectError(() => encodeUsageProfileEnvelope(profile, deep), 'limit-exceeded')
  })

  it('revalidates the payload on decode, not only on encode', () => {
    const profile = resolved('desktop')
    const envelope = encodeUsageProfileEnvelope(profile, { calls: 1 })
    expectError(() => decodeUsageProfileEnvelope(profile, {
      ...envelope,
      payload: { calls: undefined },
    }), 'invalid-payload')
    expectError(() => decodeUsageProfileEnvelope(profile, {
      ...envelope,
      payload: JSON.parse('{"total":1e999}') as unknown,
    }), 'invalid-payload')
  })
})
