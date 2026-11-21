/**
 * builtin-register — publishes this package's built-in entity decl
 * factories on the cross-package `globalThis` seam at MODULE LOAD.
 *
 * Why globalThis: `makeServiceRoutes` (sdk) merges built-in decls at
 * import time — before `initDal` runs — and the dependency direction
 * forbids either side importing the other (`sdk ⇢̸ dal`, `dal ⇢̸ sdk`).
 * The only shared token is the `Symbol.for` registry key. Registration
 * is by-factory-id so `bun --hot`/tsx reloads REPLACE, never stack —
 * same contract as the sdk lifecycle process-registry.
 *
 * Factories are invoked at mount time by the consumer (`makeServiceRoutes`)
 * with an sdk-owned context (`{ actor }`) — auth primitives never cross
 * the boundary either.
 */

import { builtinSequenceEntityDecl, type BuiltinDeclCtx } from "./sequence-decl.js";

export const BUILTIN_DECL_REGISTRY_KEY = Symbol.for("primebrick.builtin-entity-decl-factories");

export interface BuiltinDeclFactory {
  id: string;
  make: (ctx: BuiltinDeclCtx) => Record<string, unknown>[];
}

type RegistryMap = Map<string, BuiltinDeclFactory>;

export function registerBuiltinEntityDeclFactory(factory: BuiltinDeclFactory): void {
  const g = globalThis as Record<symbol, RegistryMap | undefined>;
  (g[BUILTIN_DECL_REGISTRY_KEY] ??= new Map()).set(factory.id, factory);
}

// Side effect — importing @primebrick/dal-pg makes its builtin entities
// mountable by construction. No module code required.
registerBuiltinEntityDeclFactory({
  id: "dal.sequences",
  make: (ctx) => [builtinSequenceEntityDecl(ctx)],
});
