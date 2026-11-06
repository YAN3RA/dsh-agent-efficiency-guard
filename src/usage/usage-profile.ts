/**
 * Profile partitioning for usage statistics.
 *
 * The runtime currently probes `ctx.get('profileContext')?.name` as a
 * best-effort profile label. The workspace's installed public type declarations
 * do not declare this service, so the name is not a verified Host contract.
 * Missing or unusable names disable profile-scoped backfill and storage.
 *
 * - No immutable profile id is available through a verified contract. If the
 *   observed name changes, its derived partition changes; same-name deletion and
 *   recreation cannot be distinguished.
 * - A hash key can partition records if a future adapter uses shared storage,
 *   but it does not make the backend profile-local. The public storage-domain
 *   API does not accept a profile or path; Host routing and backend roots remain
 *   unverified, so this module does not authorize persistence.
 * - Names are used exactly as observed: no case folding or Unicode
 *   normalization. A case or normalization change yields a different hash.
 * - The name is not safe path material. The hash is only a stable record key,
 *   not an authentication mechanism: a writer that rewrites `profileName` and
 *   `hash` together produces a document valid for the new name.
 *
 * The module is pure: it reads only the unknown context it is handed, never
 * touches the filesystem, never imports a storage package, and never inspects
 * Session data. `available` means only that the context supplied a safe name at
 * this instant; it does not establish the active Host profile or isolation.
 *
 * Envelope decoding fails closed. Schema, version, name and hash must all match
 * the currently resolved profile; any mismatch rejects the whole document
 * before its payload is returned. A wrong-profile document is never repaired,
 * merged, or partially projected.
 */
import { createHash } from 'node:crypto'

/** Persisted envelope schema id. Changing it is a storage-format change. */
export const USAGE_PROFILE_SCHEMA = 'dsh-thinking-guard/usage-profile'
/** First and only envelope version. Unknown versions are rejected as a whole. */
export const USAGE_PROFILE_SCHEMA_VERSION = 1
/** Length of the lowercase SHA-256 hex partition key. */
export const USAGE_PROFILE_HASH_LENGTH = 64
/** Exact partition-key shape; used to reject path-like or malformed values. */
export const USAGE_PROFILE_HASH_PATTERN = /^[a-f0-9]{64}$/
/** Maximum profile-name length in UTF-16 code units. */
export const USAGE_PROFILE_MAX_NAME_LENGTH = 128
/** Maximum nesting depth accepted in a JSON payload. */
export const USAGE_PROFILE_MAX_PAYLOAD_DEPTH = 64

/**
 * Stable hash domain. It separates this partition key from any other SHA-256
 * use in the plugin. Do not change it without accepting that every existing
 * partition becomes unreachable: the domain is part of the stored key, not a
 * versioned envelope field.
 */
const HASH_DOMAIN = 'dsh-thinking-guard/usage-profile\u0000'

/**
 * Characters that cannot appear in a profile identity.
 *
 * - `\p{C}` rejects controls, format characters (zero-width and bidi marks),
 *   surrogates, private-use and unassigned code points.
 * - `\p{Zl}` / `\p{Zp}` reject line and paragraph separators.
 * - The literal set rejects path separators, Windows path/ADS syntax and the
 *   remaining Windows-reserved punctuation.
 */
const UNSAFE_NAME_CHARACTERS = /[\p{C}\p{Zl}\p{Zp}/\\:*?"<>|]/u

const ENVELOPE_FIELDS = ['profileName', 'hash', 'schema', 'version', 'payload'] as const

/**
 * The only payload shape this module stores: a value that survives
 * `JSON.stringify`/`JSON.parse` without losing information. `-0` is rejected
 * because JSON serializes it as `0`, and non-finite numbers because JSON cannot
 * represent them at all.
 */
export type UsageProfileJsonValue =
  | null
  | boolean
  | number
  | string
  | readonly UsageProfileJsonValue[]
  | { readonly [key: string]: UsageProfileJsonValue }

/** A resolved profile identity: the public name and its derived partition key. */
export interface UsageProfileIdentity {
  readonly name: string
  readonly hash: string
}

/** Why a context could not yield a usable profile identity. */
export type UsageProfileUnavailableReason =
  | 'context-unavailable'
  | 'profile-context-missing'
  | 'profile-context-invalid'
  | 'profile-name-missing'
  | 'profile-name-invalid'

/**
 * Result of resolving an unknown Cordis context.
 *
 * Unavailable is an ordinary result, not an error: a Host without the public
 * service must degrade to "no profile partition" rather than guess one.
 */
export type UsageProfileResolution =
  | ({ readonly status: 'available' } & UsageProfileIdentity)
  | { readonly status: 'unavailable'; readonly reason: UsageProfileUnavailableReason }

/** Envelope errors. No code ever carries profile payload data in its message. */
export type UsageProfileErrorCode =
  | 'invalid-profile'
  | 'invalid-json'
  | 'invalid-document'
  | 'unsupported-version'
  | 'profile-mismatch'
  | 'invalid-payload'
  | 'limit-exceeded'

export class UsageProfileError extends Error {
  constructor(
    readonly code: UsageProfileErrorCode,
    readonly path: string,
    message: string,
  ) {
    super(`${path}: ${message}`)
    this.name = 'UsageProfileError'
  }
}

/** The strict, profile-bound persisted document. */
export interface UsageProfileEnvelope<T extends UsageProfileJsonValue = UsageProfileJsonValue> {
  readonly profileName: string
  readonly hash: string
  readonly schema: typeof USAGE_PROFILE_SCHEMA
  readonly version: typeof USAGE_PROFILE_SCHEMA_VERSION
  readonly payload: T
}

function fail(code: UsageProfileErrorCode, path: string, message: string): never {
  throw new UsageProfileError(code, path, message)
}

function childPath(path: string, key: string): string {
  return `${path}.${key}`
}

function itemPath(path: string, index: number): string {
  return `${path}[${index}]`
}

function unavailable(reason: UsageProfileUnavailableReason): UsageProfileResolution {
  return Object.freeze({ status: 'unavailable', reason })
}

/**
 * Whether a value is a safe profile identity.
 *
 * Unicode letters, marks, digits and emoji are accepted; the hash — not this
 * name — is what becomes a path component. Separators, Windows-reserved
 * punctuation, controls, format characters, line separators, surrounding
 * whitespace, `.`/`..` and trailing dots are rejected because they are either
 * path syntax, invisible, or normalized away by the filesystem, any of which
 * would make the identity ambiguous.
 */
export function isSafeUsageProfileName(value: unknown): value is string {
  if (typeof value !== 'string') return false
  if (value.length === 0 || value.length > USAGE_PROFILE_MAX_NAME_LENGTH) return false
  if (value.trim() !== value) return false
  if (value === '.' || value === '..' || value.endsWith('.')) return false
  return !UNSAFE_NAME_CHARACTERS.test(value)
}

/**
 * Derive the fixed-length partition key for a profile name.
 *
 * Returns `undefined` for an unsafe/blank name instead of hashing it: an
 * invalid name must be reported as unavailable, never silently converted into
 * a usable partition. The hash is deterministic across processes and platforms
 * because the same UTF-8 bytes and domain are used everywhere.
 */
export function hashUsageProfileName(name: string): string | undefined {
  if (!isSafeUsageProfileName(name)) return undefined
  return createHash('sha256').update(HASH_DOMAIN, 'utf8').update(name, 'utf8').digest('hex')
}

/**
 * Resolve `ctx.get('profileContext')?.name` from an unknown context.
 *
 * Every property read is guarded, so a missing service, a throwing getter, a
 * hostile Proxy or a non-object response degrades to `unavailable` and never
 * throws. No filesystem access occurs, so a missing profile cannot create,
 * migrate or overwrite anything.
 */
export function resolveUsageProfile(context: unknown): UsageProfileResolution {
  if (context === null || (typeof context !== 'object' && typeof context !== 'function')) {
    return unavailable('context-unavailable')
  }

  let get: unknown
  try {
    get = (context as { readonly get?: unknown }).get
  } catch {
    return unavailable('context-unavailable')
  }
  if (typeof get !== 'function') return unavailable('context-unavailable')

  let profileContext: unknown
  try {
    profileContext = get.call(context, 'profileContext')
  } catch {
    return unavailable('context-unavailable')
  }
  if (profileContext === undefined || profileContext === null) {
    return unavailable('profile-context-missing')
  }
  if (
    (typeof profileContext !== 'object' && typeof profileContext !== 'function')
    || Array.isArray(profileContext)
  ) {
    return unavailable('profile-context-invalid')
  }

  let name: unknown
  try {
    name = (profileContext as { readonly name?: unknown }).name
  } catch {
    return unavailable('profile-name-invalid')
  }
  if (name === undefined || name === null) return unavailable('profile-name-missing')
  if (!isSafeUsageProfileName(name)) return unavailable('profile-name-invalid')

  const hash = hashUsageProfileName(name)
  // `isSafeUsageProfileName` and the hash use the same predicate; this branch
  // exists only so a future divergence fails closed instead of producing a key.
  if (hash === undefined) return unavailable('profile-name-invalid')

  return Object.freeze({ status: 'available', name, hash })
}

function expectProfileIdentity(value: unknown): UsageProfileIdentity {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    fail('invalid-profile', '$.profile', 'must be a profile identity object')
  }
  const record = value as Record<string, unknown>
  const nameDescriptor = Object.getOwnPropertyDescriptor(record, 'name')
  if (nameDescriptor === undefined || !('value' in nameDescriptor)) {
    fail('invalid-profile', '$.profile.name', 'must be a data property')
  }
  const name = nameDescriptor.value
  if (!isSafeUsageProfileName(name)) {
    fail('invalid-profile', '$.profile.name', 'must be a safe profile name')
  }
  const hashDescriptor = Object.getOwnPropertyDescriptor(record, 'hash')
  if (hashDescriptor === undefined || !('value' in hashDescriptor)) {
    fail('invalid-profile', '$.profile.hash', 'must be a data property')
  }
  const hash = hashDescriptor.value
  if (typeof hash !== 'string' || !USAGE_PROFILE_HASH_PATTERN.test(hash)) {
    fail('invalid-profile', '$.profile.hash', 'must be a 64-character lowercase SHA-256 hex digest')
  }
  if (hashUsageProfileName(name) !== hash) {
    fail('invalid-profile', '$.profile.hash', 'does not match the profile name')
  }
  return { name, hash }
}

function expectEnvelopeObject(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    fail('invalid-document', '$', 'must be a plain object')
  }
  const prototype = Object.getPrototypeOf(value)
  if (prototype !== Object.prototype && prototype !== null) {
    fail('invalid-document', '$', 'must be a plain object')
  }
  const record = value as Record<string, unknown>
  if (Object.getOwnPropertySymbols(record).length > 0) {
    fail('invalid-document', '$', 'must not contain symbol properties')
  }
  const keys = Object.keys(record)
  if (Object.getOwnPropertyNames(record).length !== keys.length) {
    fail('invalid-document', '$', 'must not contain non-enumerable properties')
  }
  for (const key of keys) {
    if (!(ENVELOPE_FIELDS as readonly string[]).includes(key)) {
      fail('invalid-document', childPath('$', key), 'is not allowed')
    }
  }
  for (const field of ENVELOPE_FIELDS) {
    const descriptor = Object.getOwnPropertyDescriptor(record, field)
    if (descriptor === undefined) {
      fail('invalid-document', childPath('$', field), 'is required')
    }
    if (!('value' in descriptor)) {
      fail('invalid-document', childPath('$', field), 'must be a data property')
    }
  }
  return record
}

/**
 * Validate a payload against the lossless-JSON rules.
 *
 * Beyond JSON syntax this rejects values that `JSON.stringify` would silently
 * drop or change: undefined/function/symbol values, non-finite numbers, `-0`,
 * class instances, Date/Map/Set, sparse arrays, extra array properties, symbol
 * keys, non-enumerable properties, accessors, cycles, and `__proto__` keys.
 */
function validateJsonValue(
  value: unknown,
  path: string,
  depth: number,
  seen: WeakSet<object>,
): asserts value is UsageProfileJsonValue {
  if (depth > USAGE_PROFILE_MAX_PAYLOAD_DEPTH) {
    fail('limit-exceeded', path, `payload nesting exceeds ${USAGE_PROFILE_MAX_PAYLOAD_DEPTH} levels`)
  }
  if (value === null) return

  switch (typeof value) {
    case 'string':
    case 'boolean':
      return
    case 'number':
      if (!Number.isFinite(value) || Object.is(value, -0)) {
        fail('invalid-payload', path, 'must be a finite JSON number other than -0')
      }
      return
    case 'object':
      break
    default:
      fail('invalid-payload', path, 'must be a JSON value (null, boolean, finite number, string, array or plain object)')
  }

  if (seen.has(value)) fail('invalid-payload', path, 'must not contain cycles')
  seen.add(value)
  try {
    if (Array.isArray(value)) {
      if (Object.getPrototypeOf(value) !== Array.prototype) {
        fail('invalid-payload', path, 'must be a plain array')
      }
      if (Object.getOwnPropertySymbols(value).length > 0) {
        fail('invalid-payload', path, 'must not contain symbol properties')
      }
      // A dense array owns exactly `length` plus one property per index.
      if (Object.getOwnPropertyNames(value).length !== value.length + 1) {
        fail('invalid-payload', path, 'must be a dense array without extra properties')
      }
      for (let index = 0; index < value.length; index += 1) {
        const descriptor = Object.getOwnPropertyDescriptor(value, String(index))
        if (descriptor === undefined || !('value' in descriptor) || !descriptor.enumerable) {
          fail('invalid-payload', itemPath(path, index), 'must be an enumerable data property')
        }
        validateJsonValue(descriptor.value, itemPath(path, index), depth + 1, seen)
      }
      return
    }

    const prototype = Object.getPrototypeOf(value)
    if (prototype !== Object.prototype && prototype !== null) {
      fail('invalid-payload', path, 'must be a plain object')
    }
    if (Object.getOwnPropertySymbols(value).length > 0) {
      fail('invalid-payload', path, 'must not contain symbol properties')
    }
    const keys = Object.keys(value)
    if (Object.getOwnPropertyNames(value).length !== keys.length) {
      fail('invalid-payload', path, 'must not contain non-enumerable properties')
    }
    for (const key of keys) {
      if (key === '__proto__') {
        fail('invalid-payload', childPath(path, key), 'is not allowed')
      }
      const descriptor = Object.getOwnPropertyDescriptor(value, key)
      if (descriptor === undefined || !('value' in descriptor)) {
        fail('invalid-payload', childPath(path, key), 'must be a data property')
      }
      validateJsonValue(descriptor.value, childPath(path, key), depth + 1, seen)
    }
  } finally {
    seen.delete(value)
  }
}

function cloneJsonValue(value: UsageProfileJsonValue): UsageProfileJsonValue {
  if (Array.isArray(value)) {
    return (value as readonly UsageProfileJsonValue[]).map((item) => cloneJsonValue(item))
  }
  if (value !== null && typeof value === 'object') {
    const clone: Record<string, UsageProfileJsonValue> = {}
    for (const [key, item] of Object.entries(value)) {
      clone[key] = cloneJsonValue(item as UsageProfileJsonValue)
    }
    return clone
  }
  return value
}

/**
 * Build a strict envelope bound to one resolved profile.
 *
 * Encoding validates both the identity and the payload. It never guesses a
 * missing hash and never accepts a name/hash pair that was not derived from the
 * name itself.
 */
export function encodeUsageProfileEnvelope<T extends UsageProfileJsonValue>(
  profile: UsageProfileIdentity,
  payload: T,
): UsageProfileEnvelope<T> {
  const identity = expectProfileIdentity(profile)
  validateJsonValue(payload, '$.payload', 0, new WeakSet())
  return Object.freeze({
    profileName: identity.name,
    hash: identity.hash,
    schema: USAGE_PROFILE_SCHEMA,
    version: USAGE_PROFILE_SCHEMA_VERSION,
    payload,
  })
}

/** Encode and serialize in one step; the result is UTF-8 JSON text. */
export function encodeUsageProfileJson<T extends UsageProfileJsonValue>(
  profile: UsageProfileIdentity,
  payload: T,
): string {
  return JSON.stringify(encodeUsageProfileEnvelope(profile, payload))
}

/**
 * Decode an envelope for exactly the expected profile.
 *
 * The checks are ordered from structural to identity-bound: an unknown field,
 * wrong type or unsupported version is rejected as a document error; a
 * different name/hash pair, or a hash that does not belong to the embedded
 * name, is rejected as `profile-mismatch`. Only after every check passes is a
 * detached copy of the payload returned. A wrong-profile payload is never
 * returned, even as a diagnostic.
 */
export function decodeUsageProfileEnvelope<T extends UsageProfileJsonValue = UsageProfileJsonValue>(
  profile: UsageProfileIdentity,
  value: unknown,
): UsageProfileEnvelope<T> {
  const expected = expectProfileIdentity(profile)
  const record = expectEnvelopeObject(value)

  if (record.schema !== USAGE_PROFILE_SCHEMA) {
    fail('invalid-document', '$.schema', 'is not the usage-profile schema')
  }

  const version = record.version
  if (typeof version !== 'number' || !Number.isSafeInteger(version)) {
    fail('invalid-document', '$.version', 'must be an integer')
  }
  if (version !== USAGE_PROFILE_SCHEMA_VERSION) {
    fail('unsupported-version', '$.version', `must be ${USAGE_PROFILE_SCHEMA_VERSION}`)
  }

  const profileName = record.profileName
  if (!isSafeUsageProfileName(profileName)) {
    fail('invalid-document', '$.profileName', 'must be a safe profile name')
  }

  const hash = record.hash
  if (typeof hash !== 'string' || !USAGE_PROFILE_HASH_PATTERN.test(hash)) {
    fail('invalid-document', '$.hash', 'must be a 64-character lowercase SHA-256 hex digest')
  }
  if (hashUsageProfileName(profileName) !== hash) {
    fail('profile-mismatch', '$.hash', 'does not match the envelope profile name')
  }
  if (profileName !== expected.name || hash !== expected.hash) {
    fail('profile-mismatch', '$', 'belongs to a different usage profile')
  }

  validateJsonValue(record.payload, '$.payload', 0, new WeakSet())

  return Object.freeze({
    profileName,
    hash,
    schema: USAGE_PROFILE_SCHEMA,
    version: USAGE_PROFILE_SCHEMA_VERSION,
    payload: cloneJsonValue(record.payload) as T,
  })
}

/** Parse and decode UTF-8 JSON text with the same profile checks. */
export function decodeUsageProfileJson<T extends UsageProfileJsonValue = UsageProfileJsonValue>(
  profile: UsageProfileIdentity,
  text: string,
): UsageProfileEnvelope<T> {
  if (typeof text !== 'string') fail('invalid-document', '$', 'must be a JSON string')
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    fail('invalid-json', '$', 'must be valid JSON')
  }
  return decodeUsageProfileEnvelope<T>(profile, parsed)
}
