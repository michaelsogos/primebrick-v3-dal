/**
 * `Vector` — runtime-identifiable `number[]` for pgvector `vector(N)` columns.
 *
 * A real class (not a brand) so the DAL can detect it with `instanceof` —
 * array subclasses ARE `number[]`-assignable but carry runtime identity.
 * That identity is load-bearing: `vector` params bind as the `'[v1,v2,…]'`
 * literal, while plain `number[]` binds as a Postgres array `'{v1,v2,…}'`.
 *
 * In entities, `embedding: Vector` maps to `vector`; `@Column({ length: N })`
 * sets the dimension (`vector(N)`).
 */
export class Vector extends Array<number> {
  /** `'[1,2,3]'` — the pgvector text input/output literal. */
  override toString(): string {
    return `[${this.join(",")}]`;
  }

  /** Parse the pgvector literal `'[v1,v2,…]'` (or a plain number array). */
  static from(v: Vector | readonly number[] | string): Vector {
    if (v instanceof Vector) return v;
    if (typeof v !== "string") return Vector.fromNumbers(v);
    const s = v.trim();
    const inner = s.startsWith("[") && s.endsWith("]") ? s.slice(1, -1) : s;
    return Vector.fromNumbers(
      inner === "" ? [] : inner.split(",").map((t: string) => Number(t.trim())),
    );
  }

  static fromNumbers(v: readonly number[]): Vector {
    for (const n of v) {
      if (!Number.isFinite(n)) throw new Error(`Vector components must be finite numbers, got ${n}`);
    }
    // Array species: a plain Array constructor call produces Vector-typed results.
    const out = new Vector(v.length);
    for (let i = 0; i < v.length; i++) out[i] = v[i]!;
    return out;
  }
}
