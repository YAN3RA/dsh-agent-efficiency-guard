# Runtime audit

## Verified environment

- Node.js: `v24.22.1`
- npm: `12.2.1`
- pnpm: `11.28.5`
- DSH CLI: `0.2.1-rc.5`
- Profile: `desktop`
- `dsh --profile desktop --dump-config`: blocked by the Electron-owned profile guard (`profile "desktop" is managed exclusively by the Electron application`); no production profile files were changed.
- Existing desktop bundle includes `@daweifu/capability-menu@0.1.7`, `dsh-plugin-save-token@2.4.1`, and `dsh-mcp-connector@0.2.87`.

## Source baseline

The public repository clone over `github.com:443` timed out. The same `@daweifu/capability-menu@0.1.7` was already installed locally, and the upstream source was obtained through the public codeload archive by the read-only audit worker. It was copied into this workspace before implementation.

The baseline had:

- capability registry, `meta_search`, `meta_invoke`, and Resident / On-demand / Disabled policy;
- DSH `0.2.1-rc.3` peer declarations;
- no Agent budget guard;
- no `agent/turn-stopping` loop guard;
- no `ctx.tools.guard()` final denial for budgets;
- tests hard-coded to POSIX `/tmp`, which caused Windows failures.

## Current implementation changes

- Added `src/guard-core.ts` with profile validation, per-Agent/per-Turn state isolation, stable SHA-256 tool signatures, Step / Tool / Time budgets, duplicate detection, and bounded no-progress loop state.
- Added `src/guard.ts` using public DSH `agent/pre-step`, `agent/turn-stopping`, `tools/result`, `agent/disposed`, and `ctx.tools.guard()` APIs.
- Added `tests/guard-core.spec.ts`.
- Fixed existing test fixtures to use `node:os` `tmpdir()` and Windows-safe paths.
- Updated Typert host-face typing to coexist with the installed `TypertRegistryContract` while preserving the legacy manual registration runtime path.
- Changed the package and runtime bundle identity to `dsh-agent-efficiency-guard`.

## Production boundary

No `C:\Users\yansui\.dsh\profiles\desktop` file, bundle, package installation, or production state file was modified. Installation and profile switching remain a later migration step requiring an isolated test profile and explicit rollback verification.
