# Acceptance report — implementation slice

## Passed checks

Executed in `plugin` with Node.js `v24.22.1`, pnpm `11.28.5`, and DSH peer packages `0.2.1-rc.3`:

- `pnpm install --frozen-lockfile` — passed.
- `pnpm exec vitest run tests/guard-core.spec.ts` — 6/6 passed.
- `pnpm typecheck` — passed.
- `pnpm test` — 14 test files, 203 tests passed.
- `pnpm build` — passed; client bundle emitted successfully.

The full test suite initially had 95 Windows failures because fixtures used `/tmp`. The fixtures were changed to `node:os` `tmpdir()` plus platform-safe path joins; the final full run passed without changing production behavior.

## Implemented in this slice

- Capability Menu source baseline copied into a new workspace plugin package.
- Resident / On-demand / Disabled capability catalog behavior retained.
- `meta_search` and `meta_invoke` behavior retained.
- Step, business-tool, and duration budgets.
- Per-Agent / per-Turn state isolation.
- Stable argument signatures without persisting raw arguments.
- Duplicate-call reminder with bounded state.
- One convergence hint per Turn.
- Observable no-progress loop protection with next-step rejection.
- Public `ctx.tools.guard()` final denial.
- Public Agent Hook integration and cleanup.
- PI-Desktop / Save Token ownership boundary and safe fallback documentation.
- Windows-safe test fixtures.
- Package runtime identity changed to `dsh-agent-efficiency-guard`.

## Not claimed yet

- The production `desktop` profile has not been switched.
- No npm package was published.
- No isolated DSH profile installation smoke test has been run.
- The Electron-owned `desktop` profile cannot be dumped by the CLI, so actual browser startup and remote API loading remain to be verified inside an isolated profile.
- No documented PI-Desktop Token Saver / Prompt Cache adapter was available locally; the plugin therefore does not claim direct host service reuse.
- The management UI has not yet added dedicated Guard statistics; the existing capability UI remains available.

## Suggested isolated-profile verification

1. Copy the `desktop` profile to a disposable test profile.
2. Install this package into that profile without loading the old Capability Menu package.
3. Verify `meta_search`, `meta_invoke`, resident/on-demand/disabled policy, `ctx.tools.guard()`, Save Token coexistence, MCP Session restrictions, and browser settings loading.
4. Capture the isolated profile startup result and then either keep the profile or roll it back.
