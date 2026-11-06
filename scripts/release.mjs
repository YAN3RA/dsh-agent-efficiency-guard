#!/usr/bin/env node
/**
 * Build, pack, and name the release asset with a content hash.
 *
 * WHY THE HASH IS IN THE FILE NAME
 * --------------------------------
 * A profile installs this plugin from a Release asset URL, and pnpm caches the
 * resolved tarball by URL + integrity. Overwriting an asset under the SAME name
 * therefore does not take effect: `pnpm install --force`, `store prune`, and
 * deleting `node_modules` all keep resolving the cached integrity, so the old
 * `lib/` is installed again. This was observed in practice and cost a release.
 *
 * Naming the asset after the tarball's own SHA-256 changes the URL whenever the
 * bytes change, so the cache cannot serve stale content. Same bytes reuse the
 * same name, which keeps repeat runs idempotent.
 *
 * Usage:
 *   node scripts/release.mjs --dry-run   # build + pack + print the name
 *   node scripts/release.mjs             # also print the exact upload command
 */
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { readFile, readdir, unlink } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const dryRun = process.argv.includes('--dry-run')

/**
 * Resolve npm, tolerating hosts where only `npm-cli.js` exists.
 *
 * This machine runs DSH's bundled node, which ships without an `npm` binary on
 * PATH; the system npm is a script that must be invoked through node. Trying
 * the plain command first keeps CI (which does have `npm`) unchanged.
 */
function resolveNpm() {
  try {
    execFileSync('npm', ['--version'], { cwd: ROOT, stdio: 'pipe' })
    return { command: 'npm', prefix: [] }
  } catch {
    const cli = process.env['NPM_CLI_JS']
    if (cli !== undefined && cli.length > 0) return { command: process.execPath, prefix: [cli] }
    throw new Error(
      'npm not found. Set NPM_CLI_JS to the absolute path of npm-cli.js, '
      + 'or run this script where `npm` is on PATH.',
    )
  }
}

const NPM = resolveNpm()

function run(command, args) {
  return execFileSync(command, args, { cwd: ROOT, encoding: 'utf8', stdio: 'pipe' })
}

function runNpm(args) {
  return execFileSync(NPM.command, [...NPM.prefix, ...args], { cwd: ROOT, encoding: 'utf8', stdio: 'pipe' })
}

const pkg = JSON.parse(await readFile(join(ROOT, 'package.json'), 'utf8'))
const version = pkg.version
const base = `${pkg.name}-${version}`
const plain = `${base}.tgz`

// A stale tarball from an earlier run would be packed again and silently
// shipped, so remove every previous tarball for this version first.
for (const entry of await readdir(ROOT)) {
  if (entry.startsWith(`${base}`) && entry.endsWith('.tgz')) await unlink(join(ROOT, entry))
}

console.log(`[release] building ${pkg.name}@${version}`)
runNpm(['run', 'build'])

console.log('[release] packing')
runNpm(['pack', '--silent'])

const bytes = await readFile(join(ROOT, plain))
const hash = createHash('sha256').update(bytes).digest('hex').slice(0, 8)
const hashed = `${base}-${hash}.tgz`

// Rename rather than copy: two tarballs for one version invites uploading the
// wrong one, which is exactly the failure this script exists to prevent.
const { rename } = await import('node:fs/promises')
await rename(join(ROOT, plain), join(ROOT, hashed))

const tag = `v${version}`
const repo = 'YAN3RA/dsh-thinking-guard'
const url = `https://github.com/${repo}/releases/download/${tag}/${hashed}`

console.log('')
console.log(`[release] asset     ${hashed}`)
console.log(`[release] bytes     ${bytes.length}`)
console.log(`[release] sha256    ${hash}`)
console.log(`[release] asset url ${url}`)
console.log('')
console.log('[release] upload with:')
console.log(`  gh release upload ${tag} ${hashed} --clobber`)
console.log('')
console.log('[release] then point the profile at the hashed asset url above.')
console.log('[release] NEVER reuse a plain unhashed asset name for a changed build.')

if (dryRun) {
  console.log('')
  console.log('[release] --dry-run: the tarball above was produced and named, nothing was uploaded.')
}
