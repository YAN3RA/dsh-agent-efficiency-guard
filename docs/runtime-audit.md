# Runtime audit

## Verified environment

- Node.js: `v24.22.1`
- npm: `12.2.1`
- pnpm: `11.28.5`
- DSH CLI: `0.2.1-rc.5`
- Original audit profile: `desktop`; CLI dump is blocked by Electron ownership (`profile "desktop" is managed exclusively by the Electron application`).
- 2026-11-01 verification used a fresh `web` template in an independent scratch `DSH_HOME`, profile `guard-smoke`; no production credentials or external connections were copied.
- Production package inventory lists `@daweifu/capability-menu@0.1.7`, `dsh-plugin-save-token@2.4.1`, `dsh-mcp-connector@0.2.87`, and this plugin as a source link. Only this plugin, not the old Capability Menu, appears in its bundle list.

## Source baseline

The public repository clone over `github.com:443` timed out. The same `@daweifu/capability-menu@0.1.7` was already installed locally, and the upstream source was obtained through the public codeload archive by the read-only audit worker. It was copied into this workspace before implementation.

The baseline had:

- capability registry, `meta_search`, `meta_invoke`, and Resident / On-demand / Disabled policy;
- DSH `0.2.1-rc.3` peer declarations;
- no Agent budget guard;
- no `agent/turn-stopping` loop guard;
- no `ctx.tools.guard()` final denial for budgets;
- tests hard-coded to POSIX `/tmp`, which caused Windows failures.

## Current workspace implementation (N6–N7, 2026-11-04)

- `src/guard-core.ts` retains legacy profile validation, Agent/Turn state isolation, Step/Tool counters and timing. Budget thresholds do not stop tasks.
- `src/guard-loop-core.ts` and `src/guard.ts` use bounded per-turn history, SHA-256 tool/result/error fingerprints, 3/5/8 repeat warnings, unchanged A-B cycle warnings, and a single local denial for a later matching call only when no-progress evidence meets the policy. Other calls and the Turn continue.
- `src/guard.ts` uses public DSH `agent/pre-step`, `tools/result`, `agent/disposed`, and `ctx.tools.guard()` APIs. It does not register `agent/turn-stopping`. Legacy blocking settings and convergence config are compatibility-only and logged/documented as deprecated.
- `tests/guard-core.spec.ts`, `tests/guard-loop-core.spec.ts`, and `tests/guard.spec.ts` cover core behavior and Host-hook integration.
- Fixed existing test fixtures to use `node:os` `tmpdir()` and Windows-safe paths.
- Updated Typert host-face typing to coexist with the installed `TypertRegistryContract` while preserving the legacy manual registration runtime path.
- Changed the package and runtime bundle identity to `dsh-thinking-guard`.

## Production boundary

This round did not write production profile configuration or restart Electron. The production manifest already points at this workspace through a source link, so building does update its linked `lib/` target; production runtime acceptance is not implied. Isolated tarball install, Web cold start and uninstall rollback have now been exercised. Large-result recovery, hot reload and real Electron/MCP authorization limits are recorded in [the current report](release-0.1.7/report.md).
