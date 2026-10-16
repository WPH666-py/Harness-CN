/**
 * Pure generated-artifact and runtime-registry types. The registry stores Zod
 * schemas separately from generated package reflection metadata.
 * @module @deepseek-ai/dsh-typert-registry/types
 */

import type { z } from 'zod'
import type { InvocationDescriptor } from '@deepseek-ai/dsh-typert-protocol'

/** Independently compiled side that produced a contribution. */
export type TypertFace = 'host' | 'client'

/** Structured JSDoc tag retained by generated runtime metadata. */
export interface TypertDocTag {
  readonly name: string
  readonly argument?: string
  readonly comment?: string
  readonly text: string
}

/** Source documentation retained on reflected package elements. */
export interface TypertDocumentation {
  readonly description?: string
  readonly summary?: string
  readonly tags: readonly TypertDocTag[]
  readonly jsDoc?: string
}

/** One generated public member signature. */
export interface TypertMemberModel {
  readonly kind: 'property' | 'method' | 'getter' | 'setter' | 'call' | 'construct' | 'index'
  readonly name: string
  readonly signature: string
  readonly summary?: string
  readonly jsDoc?: string
}

/** One named type declaration referenced by a reflected business surface. */
export interface TypertTypeModel {
  readonly name: string
  readonly declaration: string
}

/** Runtime reflection metadata for one Cordis service. */
export interface TypertServiceModel extends TypertDocumentation {
  readonly key: string
  readonly exportName: string
  readonly members: readonly TypertMemberModel[]
  readonly types: readonly TypertTypeModel[]
}

/** Runtime reflection metadata for one Cordis event. */
export interface TypertEventModel extends TypertDocumentation {
  readonly name: string
  readonly mode?: string
  readonly signature: string
}

/** Runtime reflection metadata for one explicitly exported reference object. */
export interface TypertObjectModel extends TypertDocumentation {
  readonly name: string
  readonly exportName: string
  readonly members: readonly TypertMemberModel[]
  readonly types: readonly TypertTypeModel[]
}

/** Generated business reflection for one package on one face. */
export interface TypertPackageModel {
  readonly services: readonly TypertServiceModel[]
  readonly events: readonly TypertEventModel[]
  readonly objects: readonly TypertObjectModel[]
}

/**
 * One generated live Zod schema declaration. Both generated forms are accepted:
 * the eager `schema` this line's generator emits, and the lazy `create()`
 * factory newer generators emit for self-referential schemas. Registration
 * materializes the declaration, so live records always carry `schema`.
 */
export interface TypertSchema {
  readonly name: string
  /** Eager runtime schema. */
  readonly schema?: z.ZodType
  /** Lazy runtime-schema factory accepted in place of `schema`. */
  readonly create?: () => z.ZodType
}

/** One generated package contribution registered and withdrawn atomically. */
export interface TypertContribution {
  readonly package: string
  readonly face: TypertFace
  readonly schemas: readonly TypertSchema[]
  readonly model: TypertPackageModel
  /** Host invocation definitions, empty when the package exports no Remote methods. */
  readonly invocations: readonly InvocationDescriptor[]
}

/** A live schema plus its contribution identity, with the declaration materialized. */
export interface TypertSchemaRecord {
  readonly name: string
  readonly schema: z.ZodType
  readonly package: string
  readonly face: TypertFace
  readonly key: string
}

/** A live generated package model plus its stable identity. */
export interface TypertPackageRecord {
  readonly package: string
  readonly face: TypertFace
  readonly key: string
  readonly model: TypertPackageModel
}

/** Filter for schema enumeration. */
export interface TypertSchemaFilter {
  readonly package?: string
  readonly face?: TypertFace
}

/** Filter for package-model enumeration. */
export interface TypertPackageFilter {
  readonly package?: string
  readonly face?: TypertFace
}
