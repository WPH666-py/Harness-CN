# Rebase report

- target: `../_work/rebase-0.2.1`
- base recorded in the manifest: `../_work/base/deepseek-harness-dsh-v0.1.5-rc.1`

## Added files

- copied: 294
- differs: 2
- missing: 3

## Modified files

- ours: 16
- conflict: 356
- base: 6
- missing: 28

## Needs a decision (131)

### packages/client/ui-sidebar-files (16)

- `packages/client/ui-sidebar-files/README.i18n.yaml` — conflict, unknown
- `packages/client/ui-sidebar-files/README.md` — conflict, unknown
- `packages/client/ui-sidebar-files/README.zh.md` — conflict, unknown
- `packages/client/ui-sidebar-files/src/client/definition.tsx` — conflict, unknown
- `packages/client/ui-sidebar-files/src/client/face.ts` — conflict, unknown
- `packages/client/ui-sidebar-files/src/client/FilesBody.module.css` — conflict, unknown
- `packages/client/ui-sidebar-files/src/client/FilesBody.tsx` — conflict, unknown
- `packages/client/ui-sidebar-files/src/client/index.ts` — conflict, unknown
- `packages/client/ui-sidebar-files/src/client/locales.ts` — conflict, unknown
- `packages/client/ui-sidebar-files/src/client/store.ts` — conflict, unknown
- `packages/client/ui-sidebar-files/tests/apply.client.spec.ts` — conflict, unknown
- `packages/client/ui-sidebar-files/tests/face.client.spec.ts` — conflict, unknown
- `packages/client/ui-sidebar-files/tests/files-body.client.spec.tsx` — conflict, unknown
- `packages/client/ui-sidebar-files/tests/mount.client.tsx` — conflict, unknown
- `packages/client/ui-sidebar-files/tests/scripted-list.client.ts` — conflict, unknown
- `packages/client/ui-sidebar-files/tests/store.client.spec.ts` — conflict, unknown

### apps/desktop/src (6)

- `apps/desktop/src/host-process.ts` — conflict, ours
- `apps/desktop/src/ipc.ts` — conflict, ours
- `apps/desktop/src/locale.ts` — conflict, ours
- `apps/desktop/src/main.ts` — conflict, ours
- `apps/desktop/src/project-manager.ts` — conflict, ours
- `apps/desktop/src/update-coordinator.ts` — conflict, ours

### docs (6)

- `docs/subsystems/filesystem.i18n.yaml` — conflict, unknown
- `docs/subsystems/filesystem.md` — conflict, unknown
- `docs/subsystems/filesystem.zh.md` — conflict, unknown
- `docs/subsystems/typert.i18n.yaml` — conflict, unknown
- `docs/subsystems/typert.md` — conflict, unknown
- `docs/subsystems/typert.zh.md` — conflict, unknown

### packages/fs/fs-local (6)

- `packages/fs/fs-local/README.i18n.yaml` — conflict, unknown
- `packages/fs/fs-local/README.md` — conflict, unknown
- `packages/fs/fs-local/README.zh.md` — conflict, unknown
- `packages/fs/fs-local/src/fsio.ts` — conflict, unknown
- `packages/fs/fs-local/src/index.ts` — conflict, unknown
- `packages/fs/fs-local/tests/filesystem.spec.ts` — conflict, unknown

### packages/e2b/fs-e2b (6)

- `packages/e2b/fs-e2b/package.json` — missing, mechanical
- `packages/e2b/fs-e2b/README.i18n.yaml` — missing, unknown
- `packages/e2b/fs-e2b/README.md` — missing, unknown
- `packages/e2b/fs-e2b/README.zh.md` — missing, unknown
- `packages/e2b/fs-e2b/src/index.ts` — missing, unknown
- `packages/e2b/fs-e2b/tests/filesystem.spec.ts` — missing, unknown

### packages/api/workspace-files (5)

- `packages/api/workspace-files/README.i18n.yaml` — conflict, unknown
- `packages/api/workspace-files/README.md` — conflict, unknown
- `packages/api/workspace-files/README.zh.md` — conflict, unknown
- `packages/api/workspace-files/src/index.ts` — conflict, unknown
- `packages/api/workspace-files/src/types.ts` — conflict, unknown

### packages/fs/fs (5)

- `packages/fs/fs/README.i18n.yaml` — conflict, unknown
- `packages/fs/fs/README.md` — conflict, unknown
- `packages/fs/fs/README.zh.md` — conflict, unknown
- `packages/fs/fs/src/index.ts` — conflict, unknown
- `packages/fs/fs/tests/service.spec.ts` — conflict, unknown

### .agents (3)

- `.agents/notes/implemented/architecture/2026-08-25-electron-desktop-packaging-and-updates.i18n.yaml` — conflict, unknown
- `.agents/notes/implemented/architecture/2026-08-25-electron-desktop-packaging-and-updates.md` — conflict, ours
- `.agents/notes/implemented/architecture/2026-08-25-electron-desktop-packaging-and-updates.zh.md` — conflict, ours

### packages/api/gateway (3)

- `packages/api/gateway/src/client/index.ts` — conflict, unknown
- `packages/api/gateway/src/index.ts` — conflict, unknown
- `packages/api/gateway/tests/gateway.client.spec.ts` — conflict, unknown

### packages/client/connection (3)

- `packages/client/connection/src/rpc-host.ts` — conflict, unknown
- `packages/client/connection/src/rpc.ts` — conflict, unknown
- `packages/client/connection/tests/fetch-routes.host.spec.ts` — conflict, unknown

### packages/client/ui-settings-models (3)

- `packages/client/ui-settings-models/src/client/CustomProviderCard.tsx` — conflict, unknown
- `packages/client/ui-settings-models/src/client/locales.ts` — conflict, unknown
- `packages/client/ui-settings-models/tests/provider-form.client.spec.tsx` — conflict, unknown

### packages/fs/fs-sandbox (3)

- `packages/fs/fs-sandbox/README.i18n.yaml` — conflict, unknown
- `packages/fs/fs-sandbox/README.md` — conflict, unknown
- `packages/fs/fs-sandbox/README.zh.md` — conflict, unknown

### packages/client/ui-primitives (2)

- `packages/client/ui-primitives/src/code-highlighting.ts` — differs, upstream
- `packages/client/ui-primitives/tests/code-highlighting.client.spec.tsx` — differs, upstream

### apps/desktop/tests (2)

- `apps/desktop/tests/project-manager.spec.ts` — conflict, ours
- `apps/desktop/tests/update-coordinator.spec.ts` — conflict, ours

### packages/bundle/base (2)

- `packages/bundle/base/cordis.patch.yml` — conflict, unknown
- `packages/bundle/base/package.json` — conflict, unknown

### packages/fs/tool-fs (2)

- `packages/fs/tool-fs/src/index.ts` — conflict, unknown
- `packages/fs/tool-fs/tests/tools.spec.ts` — conflict, unknown

### packages/typert/loader (2)

- `packages/typert/loader/src/index.ts` — conflict, unknown
- `packages/typert/loader/tests/loader.spec.ts` — conflict, unknown

### packages/typert/protocol (2)

- `packages/typert/protocol/src/index.ts` — conflict, unknown
- `packages/typert/protocol/src/types.ts` — conflict, unknown

### packages/typert/registry (2)

- `packages/typert/registry/src/service.ts` — conflict, unknown
- `packages/typert/registry/src/types.ts` — conflict, unknown

### .gitignore (1)

- `.gitignore` — conflict, ours

### apps/desktop-host/src (1)

- `apps/desktop-host/src/index.ts` — conflict, ours

### apps/desktop/electron-builder.config.mjs (1)

- `apps/desktop/electron-builder.config.mjs` — conflict, ours

### apps/desktop/package.json (1)

- `apps/desktop/package.json` — conflict, ours

### apps/desktop/README.i18n.yaml (1)

- `apps/desktop/README.i18n.yaml` — conflict, ours

### apps/desktop/README.md (1)

- `apps/desktop/README.md` — conflict, ours

### apps/desktop/README.zh.md (1)

- `apps/desktop/README.zh.md` — conflict, ours

### apps/desktop/scripts (1)

- `apps/desktop/scripts/package-target.ts` — conflict, ours

### package.json (1)

- `package.json` — conflict, ours

### packages/api/session-controller (1)

- `packages/api/session-controller/src/commands.ts` — conflict, unknown

### packages/bundle/web-app (1)

- `packages/bundle/web-app/package.json` — conflict, unknown

### packages/client/ui-sidebar-right (1)

- `packages/client/ui-sidebar-right/src/client/tab-registry.ts` — conflict, unknown

### packages/context/agent-instructions (1)

- `packages/context/agent-instructions/tests/agent-instructions.spec.ts` — conflict, unknown

### packages/credentials/authorization (1)

- `packages/credentials/authorization/tests/authorization.spec.ts` — conflict, unknown

### packages/extensions/cordis-client-runner (1)

- `packages/extensions/cordis-client-runner/src/client/slot-catalog.ts` — conflict, unknown

### packages/fs/README.i18n.yaml (1)

- `packages/fs/README.i18n.yaml` — conflict, unknown

### packages/fs/README.md (1)

- `packages/fs/README.md` — conflict, unknown

### packages/fs/README.zh.md (1)

- `packages/fs/README.zh.md` — conflict, unknown

### packages/skill/skill-filesystem (1)

- `packages/skill/skill-filesystem/tests/skill-filesystem.spec.ts` — conflict, unknown

### pnpm-lock.yaml (1)

- `pnpm-lock.yaml` — conflict, ours

### pnpm-workspace.yaml (1)

- `pnpm-workspace.yaml` — conflict, unknown

### README.i18n.yaml (1)

- `README.i18n.yaml` — conflict, unknown

### README.md (1)

- `README.md` — conflict, ours

### README.zh.md (1)

- `README.zh.md` — conflict, ours

### scripts (1)

- `scripts/verify-package-readme-model-experience.ts` — conflict, unknown

### THIRD_PARTY_NOTICES.md (1)

- `THIRD_PARTY_NOTICES.md` — conflict, unknown

### tsconfig.base.json (1)

- `tsconfig.base.json` — conflict, unknown

### tsconfig.client.json (1)

- `tsconfig.client.json` — conflict, unknown

### tsconfig.host.json (1)

- `tsconfig.host.json` — conflict, ours

### vendor (1)

- `vendor/README.md` — conflict, unknown

### packages/code-runtime/code-runtime-worker-thread (1)

- `packages/code-runtime/code-runtime-worker-thread/package.json` — missing, mechanical

### packages/code-runtime/code-runtime (1)

- `packages/code-runtime/code-runtime/package.json` — missing, mechanical

### packages/e2b/e2b (1)

- `packages/e2b/e2b/package.json` — missing, mechanical

### packages/e2b/subprocess-e2b (1)

- `packages/e2b/subprocess-e2b/package.json` — missing, mechanical

### packages/experimental/agent-team-web-profile (1)

- `packages/experimental/agent-team-web-profile/package.json` — missing, mechanical

### packages/experimental/code-runtime-python (1)

- `packages/experimental/code-runtime-python/package.json` — missing, mechanical

### packages/fs/tool-present (1)

- `packages/fs/tool-present/package.json` — missing, mechanical

### packages/hooks/hook-protocol (1)

- `packages/hooks/hook-protocol/package.json` — missing, mechanical

### packages/hooks/hooks-claude-code (1)

- `packages/hooks/hooks-claude-code/package.json` — missing, mechanical

### packages/hooks/hooks-codex (1)

- `packages/hooks/hooks-codex/package.json` — missing, mechanical

### packages/preset/agent-presets (1)

- `packages/preset/agent-presets/package.json` — missing, mechanical

### packages/runtime-diagnostics/invariants (1)

- `packages/runtime-diagnostics/invariants/package.json` — missing, mechanical

### packages/session-query/tool-session-query (1)

- `packages/session-query/tool-session-query/package.json` — missing, mechanical

### packages/session/session-title-all-prompts-llm (1)

- `packages/session/session-title-all-prompts-llm/package.json` — missing, mechanical

### packages/settings/settings-file (1)

- `packages/settings/settings-file/package.json` — missing, mechanical

### packages/skill/skill-badge (1)

- `packages/skill/skill-badge/package.json` — missing, mechanical

### packages/subagent/subagent-in-process-driver (1)

- `packages/subagent/subagent-in-process-driver/package.json` — missing, mechanical

### packages/terminal/tool-terminal (1)

- `packages/terminal/tool-terminal/package.json` — missing, mechanical

### packages/webhook/webhook-github (1)

- `packages/webhook/webhook-github/package.json` — missing, mechanical

### packages/webhook/webhook (1)

- `packages/webhook/webhook/package.json` — missing, mechanical

### packages/workflow/tool-ralph (1)

- `packages/workflow/tool-ralph/package.json` — missing, mechanical

### packages/workflow/workflow-worker-thread (1)

- `packages/workflow/workflow-worker-thread/package.json` — missing, mechanical
