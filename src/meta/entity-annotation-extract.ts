/**
 * Static entity-annotation extractor — the deterministic source of property
 * types for the schema pipeline (`primebrick-db check/compare`).
 *
 * Runtime metadata (`design:type`) is transpiler-dependent: `tsc` emits it
 * faithfully, Bun collapses unions to the first member, esbuild/`tsx` emit
 * nothing at all. Type annotations never make it to runtime — but they are
 * always present in source. The TypeScript compiler API reads them with full
 * alias resolution (`UUID`, `Decimal`, `Vector`, literal unions, …), so the
 * extracted map is identical under every runtime.
 *
 * Inheritance: concrete entities often declare no decorators of their own —
 * `class ConfigEntryEntity extends ConfigEntityBase {}` inherits both the
 * `@Entity` marker and every column from the base. The extractor records
 * EVERY class with its `extends` clause; `lookupEntityAnnotation` walks the
 * chain (subclass prop wins — matching the decorator-merge semantics).
 *
 * `typescript` is loaded lazily — consumers that never run the schema
 * pipeline never pay for it.
 */
import path from "node:path";
import type * as ts from "typescript";

/** Per-property type facts extracted from source. */
export type EntityAnnotationInfo = {
  /** Property name as declared. */
  prop: string;
  /** Raw annotation text (`"UUID"`, `"number[]"`, `"Date | null"`, `"(none)"` if missing). */
  annotation: string;
  /** Checker-resolved display type — aliases preserved (`"UUID"`, `"CustomerStatus"`, `"string"`). */
  typeName: string;
  /** `prop?: T`. */
  optional: boolean;
  /** `| null` present in a union annotation. */
  nullableUnion: boolean;
  /** `T[]` / `Array<T>` annotation. */
  isArray: boolean;
  /** Array element resolved name (when `isArray`). */
  elementTypeName?: string;
  /** Union of string-literal members (TS enum-style unions → `text` storage). */
  isStringLiteralUnion: boolean;
  /** Interface / object-literal / Record shapes — object-like types map to `jsonb`. */
  isObjectLike: boolean;
  /** Callable / function / enum / tuple / other non-columnar shapes — unmappable. */
  isUnmappable: boolean;
  /** Absolute source file of the declaring class. */
  file: string;
};

type ClassEntry = {
  props: Map<string, EntityAnnotationInfo>;
  /** Base class names, nearest-first, transitively resolved via the type
   *  checker — mixin compositions (`Deletable(Auditable(EntityBase))`) are
   *  call expressions and generic `extends Base` params, so only the
   *  resolved base-type symbols reveal the real ancestor classes. */
  extendsNames: string[];
};

/** Result of `extractEntityAnnotations` — keyed by class name. */
export type EntityAnnotationMap = {
  classes: Map<string, ClassEntry>;
};

const NON_COLUMN_DECORATOR_RE = /^IsNotColumn\b/;

/**
 * Walk the `extends` chain (subclass first — wins on conflicts, matching the
 * decorator-merge semantics of `getEntityPersistenceMeta`). Returns the
 * annotation info for `prop` on `className`, or `undefined` when the chain
 * declares no such property.
 */
export function lookupEntityAnnotation(
  map: EntityAnnotationMap,
  className: string,
  prop: string,
): EntityAnnotationInfo | undefined {
  const queue: string[] = [className];
  const seen = new Set<string>();
  while (queue.length) {
    const cursor = queue.shift()!;
    if (seen.has(cursor)) continue;
    seen.add(cursor);
    const entry = map.classes.get(cursor);
    const hit = entry?.props.get(prop);
    if (hit) return hit;
    if (entry) queue.push(...entry.extendsNames);
  }
  return undefined;
}

/**
 * Build the annotation map for every class reachable from `entryFile`
 * (usually the entity registry module). `compilerOptions` are taken from the
 * nearest `tsconfig.json` so path aliases resolve correctly.
 */
export async function extractEntityAnnotations(entryFile: string): Promise<EntityAnnotationMap> {
  const ts = await import("typescript");
  const abs = path.resolve(entryFile);
  const configPath = ts.findConfigFile(path.dirname(abs), ts.sys.fileExists, "tsconfig.json");
  let compilerOptions: import("typescript").CompilerOptions = {
    target: ts.ScriptTarget.ES2022,
    module: ts.ModuleKind.NodeNext,
    strict: true,
    skipLibCheck: true,
    noEmit: true,
    esModuleInterop: true,
  };
  if (configPath) {
    const cfg = ts.readConfigFile(configPath, ts.sys.readFile);
    if (!cfg.error) {
      const parsed = ts.parseJsonConfigFileContent(cfg.config, ts.sys, path.dirname(configPath));
      compilerOptions = { ...parsed.options, noEmit: true };
    }
  }
  const program = ts.createProgram([abs], compilerOptions);
  const checker = program.getTypeChecker();
  const classes = new Map<string, ClassEntry>();

  for (const sf of program.getSourceFiles()) {
    if (sf.isDeclarationFile || sf.fileName.includes("node_modules")) continue;
    ts.forEachChild(sf, function visit(node) {
      if (ts.isClassDeclaration(node) && node.name) {
        const className = node.name.getText(sf);
        // Resolve base classes transitively via the type checker — the
        // `extends` clause may be a plain identifier, a mixin call
        // expression (`Deletable(Auditable(EntityBase))`), or a generic
        // param (`extends Base`). getBaseTypes on the declared instance
        // type yields the real ancestor chain in declaration order.
        const extendsNames: string[] = [];
        const classSym = checker.getTypeAtLocation(node.name).getSymbol()
          ?? checker.getSymbolAtLocation(node.name);
        const instType = classSym ? checker.getDeclaredTypeOfSymbol(classSym) : undefined;
        if (classSym && instType) {
          const visitBase = (t: ts.Type) => {
            const bases = (t as ts.InterfaceType).getBaseTypes?.() ?? [];
            for (const b of bases) {
              for (const cand of (b.isIntersection?.() ? b.types : [b])) {
                const n = cand.getSymbol()?.getName()
                  ?? (cand as { aliasSymbol?: ts.Symbol }).aliasSymbol?.getName();
                if (n && n !== className && !extendsNames.includes(n)) extendsNames.push(n);
                visitBase(cand);
              }
            }
          };
          visitBase(instType);
        }
        const extractProp = (m: ts.PropertyDeclaration | ts.PropertySignature, mSf: ts.SourceFile): [string, EntityAnnotationInfo] | undefined => {
          if (!m.name || !ts.isIdentifier(m.name)) return undefined;
          const propDecos = ts.isPropertyDeclaration(m) ? (ts.getDecorators(m) ?? []) : [];
          if (propDecos.some((d) => NON_COLUMN_DECORATOR_RE.test(d.expression.getText(mSf)))) return undefined;
          const prop = m.name.getText(mSf);
          try {
            let t = checker.getTypeAtLocation(m.name);
            // strip null/undefined union members — nullability tracked separately
            const nullableUnion = m.type
              ? ts.isUnionTypeNode(m.type) &&
                m.type.types.some((n) => n.kind === ts.SyntaxKind.NullKeyword)
              : t.isUnion() && t.types.some((x) => x.flags & ts.TypeFlags.Null);
            let isStringLiteralUnion = false;
            if (t.isUnion()) {
              const rest = t.types.filter(
                (x) => !(x.flags & (ts.TypeFlags.Null | ts.TypeFlags.Undefined)),
              );
              if (rest.length === 1) t = rest[0]!;
              else if (rest.length > 0 && rest.every((x) => x.isStringLiteral()))
                isStringLiteralUnion = true;
            }
            // single string literal (`type T = "totp"`) — string storage too
            if (!isStringLiteralUnion && t.isStringLiteral()) isStringLiteralUnion = true;
            let isArray = false;
            let elementTypeName: string | undefined;
            if (m.type && ts.isArrayTypeNode(m.type)) {
              isArray = true;
              elementTypeName = checker.typeToString(
                checker.getTypeFromTypeNode(m.type.elementType),
              );
            } else if (
              m.type &&
              ts.isTypeReferenceNode(m.type) &&
              m.type.typeName.getText(mSf) === "Array"
            ) {
              isArray = true;
              const arg = m.type.typeArguments?.[0];
              if (arg) elementTypeName = checker.typeToString(checker.getTypeFromTypeNode(arg));
            }
            const isTuple = m.type ? ts.isTupleTypeNode(m.type) : false;
            const isObjectLike = !!(t.flags & ts.TypeFlags.Object) && !isTuple;
            // string literals carry EnumLiteral internally — they are NOT
            // unmappable (they store as `text`); unions/intersections of
            // literals already handled above.
            const enumLike = !!(t.flags & (ts.TypeFlags.Enum | ts.TypeFlags.EnumLiteral));
            const isUnmappable =
              isTuple ||
              t.getCallSignatures().length > 0 ||
              (enumLike && !isStringLiteralUnion) ||
              !!(t.flags & (ts.TypeFlags.ESSymbol | ts.TypeFlags.UniqueESSymbol)) ||
              (t.isUnion() && !isStringLiteralUnion) ||
              (t.isIntersection() && !isObjectLike);
            return [prop, {
              prop,
              annotation: m.type ? m.type.getText(mSf) : "(none)",
              typeName: checker.typeToString(t),
              optional: !!m.questionToken,
              nullableUnion,
              isArray,
              elementTypeName,
              isStringLiteralUnion,
              isObjectLike,
              isUnmappable,
              file: mSf.fileName,
            }];
          } catch {
            /* unresolvable type — prop skipped; typecheck surfaces the cause */
            return undefined;
          }
        };
        const props = new Map<string, EntityAnnotationInfo>();
        for (const m of node.members) {
          if (!ts.isPropertyDeclaration(m)) continue;
          const ex = extractProp(m, sf);
          if (ex) props.set(ex[0], ex[1]);
        }
        // Inherited members (base classes + mixin class expressions, possibly
        // anonymous and living in .d.ts): the checker's flattened property
        // list resolves every ancestor; subclass declarations always win.
        if (instType) {
          for (const sym of checker.getPropertiesOfType(instType)) {
            if (props.has(sym.name)) continue;
            const vd = sym.valueDeclaration ?? sym.declarations?.[0];
            if (!vd || !(ts.isPropertyDeclaration(vd) || ts.isPropertySignature(vd))) continue;
            const ex = extractProp(vd, vd.getSourceFile());
            if (ex) props.set(ex[0], ex[1]);
          }
        }
        const existing = classes.get(className);
        if (existing) {
          // First declaration wins for extends; merge props (later wins).
          for (const [k, v] of props) existing.props.set(k, v);
          for (const n of extendsNames) {
            if (!existing.extendsNames.includes(n)) existing.extendsNames.push(n);
          }
        } else {
          classes.set(className, { props, extendsNames });
        }
      }
      ts.forEachChild(node, visit);
    });
  }
  return { classes };
}
