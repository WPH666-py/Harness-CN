# Agent Note: The authorization seam lets a flow commit through its session

Status: implemented

English | [中文](2026-10-17-authorization-session-commit.zh.md)

## Problem

The rc.28 desktop build could start the DeepSeek account sign-in but never finish it. Clicking **登录** opened the platform page, the browser returned to the loopback callback, `POST /auth-api/v0/dsh/auth_init` and `POST /auth-api/v0/dsh/auth_exchange` both answered `200` (`code: 0`) — and the Host then logged

```text
[deepseek-account] sign-in failed { errorCode: 'storage' }
```

The settings section stayed on its signed-out arm. The credential store gained a `deepseek-account-platform/device` record for the attempt but never `deepseek-account-platform/default`, the record the grant would live in.

## Cause

`@deepseek-ai/dsh-deepseek-account-platform` (0.1.7-rc.2, installed from npm into the desktop seed) finishes an exchange by committing the grant through the authorization seam:

```js
await session.commit({ kind: 'grant', payload: { … } })
```

The runtime shipped its own `@deepseek-ai/dsh-authorization` (0.1.5-rc.29, packed from this workspace), whose `AuthorizationSession` exposed only `method`, `signal`, `notify` and `prompt`; a flow was expected to write its record by calling `ctx.credentials.modifyRecord` itself. The seam confirmed the commit by watching `credentials/record-updated`, so the older contract worked — but `session.commit` did not exist, and the platform maps its failed commit to the `storage` error code.

The two packages were never exercised together: the section could not reach `startSignIn` before the namespace fix in [2026-10-17-account-login-namespace](../bug-fix/2026-10-17-account-login-namespace.md), so the mismatch stayed hidden.

## Evidence

- Every published version of the platform package commits through the session — 0.1.7-alpha.1, 0.1.7-alpha.2, 0.1.7-rc.1, 0.1.7-rc.2 and 0.2.1-rc.1 all contain exactly one `session.commit(` call. Pinning an older platform build therefore cannot fix the pairing.
- The installed `dsh-authorization@0.1.5-rc.28` declared `AuthorizationSession` with four members (its `lib/types/index.d.ts`) and its `lib/index.js` contained no `commit(` call at all.
- Upstream (`origin/master`, fetched shallow at `1517a4dbca`) has since grown the same member — `commit(record: CredentialRecord): Promise<void>` — plus the `committing` bookkeeping behind it, so this is a forward-port of an upstream seam, not a local invention.
- With the seam patched into the installed profile the exchange path no longer stops at the missing member: the unit cases below pin the commit contract, and the rebuilt payload is where the browser round-trip is re-verified end to end.

## Decision

Add the commit member to the seam, keeping this workspace's stricter settlement behaviour:

- `AuthorizationSession.commit(record)` writes the record through `ctx.credentials.modifyRecord(flow.key, …)` after refusing when the attempt is gone or the signal was withdrawn, so a late commit cannot resurrect a cancelled attempt.
- `InFlight.committing` records that a write is in flight; `cancel()` and a caller's withdrawal only abort the controller when no commit is running, so cancellation waits for the store instead of tearing the write in half.
- The workspace's `INVARIANT`-coded listener rethrow in `settle()` stays: it is a local guarantee upstream's file no longer carries, and dropping it while swapping the file broke `authorization.spec.ts`.
- Two spec cases pin the new contract: a flow that commits through the session settles `authorized` with the record stored, and a flow that commits after its attempt was withdrawn is refused and stores nothing.

## Alternatives considered

**Pin an older platform package.** Impossible: no published version predates the session commit.

**Ship npm's `dsh-credentials` / `dsh-authorization` (0.1.7-rc.2) in the desktop seed instead of the workspace tarballs.** That would replace the credentials stack every runtime consumer reads (LLM providers included) to fix one seam, and it would leave the workspace's own 0.1.5 line unable to run the account packages forever.

**Have the platform write through `ctx.credentials` itself.** The platform is an installed npm package, not workspace source; patching it in the seed would fork a published dependency.

## Consequences

The desktop seed's `dsh-authorization` tarball carries the commit member, so any account platform published on the 0.1.7 line pairs with this runtime. A flow may now commit through the session or write through `ctx.credentials` directly; the seam confirms both, and cancelling during a commit waits for the store rather than aborting the write.
