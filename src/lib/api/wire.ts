// The server's own types, read off its contract. `docs/openapi.json` is generated from the
// backend's pydantic models (`just openapi`, kept fresh by a pytest), and `./schema.d.ts` is
// generated from that (`pnpm openapi:types`, kept fresh by ./schema.test). A wire type in
// lib/api is an alias of one of these, so a field renamed or retyped on the server is a tsc
// error here instead of an `undefined` at runtime. Where the client deliberately differs (a
// field a cached copy from an older build lacks, a field only the device writes), the alias
// says so with `CachedWithout` or an intersection, next to the reason.
import type { components } from './schema'

type Schemas = components['schemas']

/** A value as the server sends it. pydantic serialises every field, defaults included, so a
 *  field the schema marks optional (it has a default) is always present – deep. */
export type Served<T> = T extends readonly (infer U)[] ? Served<U>[]
  : T extends object ? { [K in keyof T]-?: Served<T[K]> }
  : T

/** A response model, as served. */
export type Out<N extends keyof Schemas> = Served<Schemas[N]>

/** A request model, as the client may write it (a defaulted field may be left out). */
export type In<N extends keyof Schemas> = Schemas[N]

/** `T` with the fields `K` optional: what a copy cached by an older build may lack. */
export type CachedWithout<T, K extends keyof T> = Omit<T, K> & Partial<Pick<T, K>>

/** A type-level check that a hand-typed request body still fits the server's model: write
 *  `type _XFits = Fits<Mine, In<'X'>>` beside it, and tsc fails the day it stops fitting. */
export type Fits<T extends U, U> = T extends U ? true : never
