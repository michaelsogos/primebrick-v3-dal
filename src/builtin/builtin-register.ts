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

import { builtinSequenceEntityDecl, builtinSequenceNav, builtinSequenceRpc, type BuiltinDeclCtx } from "./sequence-decl.js";

export const BUILTIN_DECL_REGISTRY_KEY = Symbol.for("primebrick.builtin-entity-decl-factories");

export interface BuiltinDeclFactory {
  id: string;
  make: (ctx: BuiltinDeclCtx) => Record<string, unknown>[];
  /** RPC route contribution — the builtin's governed action surface
   *  (e.g. `sequence-set`). Emitted under the same owned-namespace rules
   *  as `make`: permissions/i18n keys derive inside the factory, the SDK
   *  merges these into makeServiceRoutes' `rpc` input verbatim. */
  rpc?: (ctx: BuiltinDeclCtx) => Record<string, unknown>[];
  /** Nav contribution — appended LAST inside the named sibling's nav/routes
   *  by createMicroservice (pinned `order` wins at render, unpinned sort alphabetically —
   *  array position no longer carries ordering semantics). The sibling
   *  is auto-created when the module declares none. */
  nav?: (ctx: BuiltinDeclCtx) => BuiltinNavContribution;
}

export interface BuiltinNavContribution {
  /** Sibling slug the leaf lives under (always "settings" today). */
  sibling_id: string;
  /** i18n key of the auto-created sibling node. */
  sibling_label_key: string;
  /** Lucide icon of the auto-created sibling node. */
  sibling_icon: string;
  /** Leaf slug inside the sibling (`<ns>/settings/<leaf_id>`). */
  leaf_id: string;
  /** i18n key of the leaf label. */
  label_key: string;
  /** Lucide icon of the leaf. */
  icon: string;
  /** Wire entity the leaf's dict page binds to. */
  entity: string;
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
  rpc: (ctx) => builtinSequenceRpc(ctx),
  nav: (ctx) => builtinSequenceNav(ctx),
});
