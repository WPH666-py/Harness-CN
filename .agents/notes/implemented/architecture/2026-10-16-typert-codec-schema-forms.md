# Agent Note: Typert codecs accept the lazily created schema form newer releases emit

Status: implemented

English | [中文](2026-10-16-typert-codec-schema-forms.zh.md)

## Problem

The DeepSeek account packages this product ships carry their Remote surface as generated typert manifests. In the releases that carry the bonus-credit reads and acknowledgements (`0.1.7-rc.2`), those manifests describe a codec's runtime schema as a `create()` factory — `codec: { mode: 'strict', typeSymbol: '@deepseek-ai/dsh-deepseek-account/types#SignInAttemptId', create: () => z.intersection(z.string(), z.unknown()) }` — where this line's generator emits the eager object form, `schema: <ZodType>`. Named schema records moved with it, from `{ name, schema }` to `{ name, create }`.

The mounted row therefore failed at boot, and because a typert contributor that cannot register fails the whole tree, the failure was total rather than local:

```
dsh desktop: plugin tree failed to load: failed to apply loader entry typert-loader (@deepseek-ai/dsh-typert-loader):
typert-loader: 1 typert contributor(s) failed to register:
  - typert-loader: @deepseek-ai/dsh-api-account-controller invocation "@deepseek-ai/dsh-api-account-controller#account/cancelSignIn" parameter codec is not backed by a zod v4 schema
```

The 0.2 generation of the loader, registry, gateway, and protocol — extracted from the packaged desktop build that ships these rows in production — reads the same field through the factory: the validator requires `typeof codec.create === 'function'`, the registry materializes a record with `record.value ??= record.create()`, and the gateway decodes with `codec.create().parse(value)`. Two generated forms of one declaration were in the wild at once, and this line could only read one of them.

## Decision

Every place that resolves a declared codec schema accepts both forms. Nothing else about codecs, dispatch, wire shape, or type linking changes.

`packages/typert/protocol/src/types.ts` declares `TypertSchemaSource` with both optional fields and a `typertSchemaOf(source)` that returns an eager `schema` as-is and otherwise calls `create()`; a strict codec variant now declares `schema?` and `create?` instead of requiring the eager field. Both are re-exported from the package index, because the API gateway already depends on the protocol package at run time.

`packages/typert/loader/src/index.ts` resolves a descriptor through a local `generatedSchema(source)` before validating the result as a zod v4 schema, in the named-schema check and in `requireStrictCodec` alike. The resolver is local rather than imported: the loader's peers are the cordis loader and registry, its only runtime dependency is `schemastery`, and its consumers are the boot path — a five-line resolver is cheaper than a new dependency on the packages that boot. `packages/typert/registry/src/service.ts` keeps zod as its only runtime dependency and materializes through a local helper for the same reason.

`packages/typert/registry/src/types.ts` separates the two forms that were previously one interface: `TypertSchema` is the declared form (optional `schema`, optional `create`) and `TypertSchemaRecord` is the materialized form (required `schema`), so a consumer of the registry cannot be handed an unmaterialized record by the type system. `validateSchemas` materializes before recording and rejects a declaration that offers neither field with `typert: schema "<name>" declares neither a schema nor a create() factory`.

`packages/api/gateway/src/index.ts` (host `decode`) and `packages/api/gateway/src/client/index.ts` (`requireStrictCodec`, `parseInput`) resolve through `typertSchemaOf` from the protocol package. Both now report a codec that declares no runtime schema — `strict codec for wire field <field> declares no runtime schema` and `client api: generated Remote <endpoint> field <field> has no runtime schema` — instead of dereferencing a field the manifest may not have.

## What this does not change

The repository's own generator still emits the eager form, so every committed catalog artifact is byte-identical and `gen-cordis-catalog` / `verify-cordis-catalog` have nothing to rewrite. Validation stays as strict as it was: a codec that declares neither form, or resolves to something that is not a zod v4 schema with `parse`, still fails the row and the tree at boot.

Calling a generated factory more than once is safe by construction: the emitted factory memoizes its own value (`const _schema = () => (_schema$value ??= …)`), so the gateway's per-decode resolution allocates nothing after the first call.

## Alternatives considered

- Patch the generated account manifest to the eager form. It is a build artifact of another package, regenerated on every upstream release, and the patch would have to be rewritten and re-verified on each bump while hiding the incompatibility rather than defining it.
- Stay on the `0.1.7-alpha.1` account packages, whose manifests already read here. They mount on this line, but the bonus-credit reads and acknowledgements (`getUnnotifiedBonuses`, `ackBonusNotified`) first appear in `0.1.7-rc.2`, and granting credits after sign-in is the feature the account surface exists for.
- Move this line's typert packages to the 0.2 generation. Carrying a second protocol generation beside a `dsh-v0.1.5-rc.1` baseline is a much larger change than accepting a second declared schema form, and it would move every generated artifact in the repository.
- Have the loader and registry import the protocol helper instead of keeping local resolvers. It would make the boot path depend on the protocol package to share five lines; both packages keep their single runtime dependency instead.
- Accept only the newer form and stop emitting the eager one. That rewrites every committed catalog artifact and every generated manifest in the repository for no behavioural gain, and would make the read path depend on a form only a newer generator produces.

## Consequences

The account packages can be shipped on this line: `@deepseek-ai/dsh-deepseek-account-platform` and `@deepseek-ai/dsh-api-account-controller` `0.1.7-rc.2` boot with their rows mounted from the Desktop Host's patch layer, and a probe of the shipping path reports the host ready with `getState`, `getBalance`, `startSignIn`, `getUnnotifiedBonuses`, and `ackBonusNotified` all present. The same boot died at 16.1 s with `parameter codec is not backed by a zod v4 schema` before this change and reported ready at 15.4 s after it.

Two generated forms must be read for as long as this line carries packages generated by a newer one, so the read points stay dual by design and a future generator change is a two-branch concern rather than a one-branch one.

`packages/typert/loader/tests/loader.spec.ts` asserts the resolved schema through either field (`codec.schema ?? codec.create?.()`). The two `packages/typert/generator/tests/cordis-catalog.spec.ts` failures (14 signature type-link coverage violations in `ctx.workspaceFiles` and `ctx.fs`) are not caused by this change: they reproduce with the typert and gateway changes stashed.

The declaration these read points agree on is owned by [Typert remote method calls](../architecture/2026-08-02-typert-remote-method-calls.md), and the packages that need it are pinned in `apps/desktop/src/bundled-plugins.ts`.
