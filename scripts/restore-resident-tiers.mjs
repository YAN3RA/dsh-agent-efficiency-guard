#!/usr/bin/env node
/**
 * Restore the patch's Resident tools after a bulk "make everything On-demand"
 * move, without touching any other tier choice.
 *
 * WHY THIS EXISTS
 * ---------------
 * `replayMoves()` in `src/policy.ts` replays every recorded state-file move on
 * top of the patch rules, so a UI move always wins. A bulk move to On-demand
 * therefore overrides the patch's `resident:` list and every tool becomes
 * discoverable-only — including `read`/`write`/`edit`/`grep`.
 *
 * This script removes ONLY the moves that currently contradict the patch's
 * Resident list, leaving every other entry untouched. It is deliberately
 * narrow: it never adds an On-demand or Disabled move.
 *
 * Usage:
 *   node scripts/restore-resident-tiers.mjs --dry-run     # report only
 *   node scripts/restore-resident-tiers.mjs               # apply
 *   node scripts/restore-resident-tiers.mjs --file <path> # non-default state
 */
import { readFile, writeFile, rename } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'

const args = process.argv.slice(2)
const dryRun = args.includes('--dry-run')
const fileIndex = args.indexOf('--file')
const stateFile = fileIndex !== -1 && args[fileIndex + 1] !== undefined
  ? args[fileIndex + 1]
  : join(process.env.DSH_HOME ?? join(homedir(), '.dsh'), 'capability-menu-policy.json')

/** The Resident list this repo's bundle patch ships. Keep in sync with cordis.patch.yml. */
const PATCH_RESIDENT = ['bash', 'read', 'write', 'edit', 'read_image', 'glob', 'grep']

const raw = await readFile(stateFile, 'utf8')
const state = JSON.parse(raw)
const tools = state.tools ?? {}

const conflicts = PATCH_RESIDENT.filter(name => tools[name] !== undefined && tools[name] !== 'resident')
if (conflicts.length === 0) {
  console.log('No conflict: every patch-Resident tool is already Resident or unrecorded.')
  process.exit(0)
}

console.log(`State file: ${stateFile}`)
console.log(`Patch declares Resident: ${PATCH_RESIDENT.join(', ')}`)
console.log(`Overridden to another tier (${conflicts.length}):`)
for (const name of conflicts) console.log(`  ${name}: ${tools[name]} -> resident`)

if (dryRun) {
  console.log('\n--dry-run: nothing written. Re-run without --dry-run to apply.')
  process.exit(0)
}

for (const name of conflicts) delete tools[name]
state.tools = tools
state.version = state.version ?? 3

const temporary = `${stateFile}.tmp-${randomUUID()}`
await writeFile(temporary, JSON.stringify(state, null, 2) + '\n', { encoding: 'utf8', flag: 'wx' })
await rename(temporary, stateFile)
console.log(`\nApplied: removed ${conflicts.length} overriding move(s). Restart DSH to take effect.`)
