export type PatchSegment = { kind: "tx" | "notx"; sql: string };

/**
 * Split a patch file into execution segments. Default content is transactional
 * (`tx`); statements inside `-- pb:begin-no-transaction` … `-- pb:end-no-transaction`
 * run per-statement in autocommit (for CREATE INDEX CONCURRENTLY & friends).
 * Whole-file `-- pb:no-transaction` is equivalent to wrapping everything.
 */
export function parsePatchSegments(raw: string): PatchSegment[] {
  const pragma = /^\s*--\s*pb:no-transaction\s*$/m.test(raw);
  const hasMarkers = /--\s*pb:begin-no-transaction/.test(raw);
  if (pragma && !hasMarkers) return [{ kind: "notx", sql: raw }];
  if (!hasMarkers) return [{ kind: "tx", sql: raw }];

  const segments: PatchSegment[] = [];
  const lines = raw.split("\n");
  let cur: string[] = [];
  let kind: "tx" | "notx" = "tx";
  const flush = () => {
    const sql = cur.join("\n").trim();
    if (sql) segments.push({ kind, sql });
    cur = [];
  };
  for (const line of lines) {
    if (/^\s*--\s*pb:begin-no-transaction\s*$/.test(line)) {
      flush();
      kind = "notx";
      continue;
    }
    if (/^\s*--\s*pb:end-no-transaction\s*$/.test(line)) {
      flush();
      kind = "tx";
      continue;
    }
    cur.push(line);
  }
  flush();
  return segments;
}

const TX_CONTROL_RE =
  /^\s*(BEGIN|START\s+TRANSACTION|COMMIT|END|ROLLBACK|ABORT)(\s+(WORK|TRANSACTION|AND\s+(NO\s+)?CHAIN))?\s*;?\s*$/i;

/**
 * True when a top-level statement is bare transaction control
 * (BEGIN/COMMIT/ROLLBACK/START TRANSACTION/END/ABORT). A `CASE … END`
 * inside a larger statement is NOT matched — the whole statement must
 * be exactly the keyword.
 */
export function isTxControlStatement(stmt: string): boolean {
  const s = stmt.replace(/--[^\n]*/g, "").replace(/\/\*[\s\S]*?\*\//g, "").trim();
  return TX_CONTROL_RE.test(s);
}

/**
 * Remove top-level transaction-control statements. The engine owns the
 * transaction — a patch file that wraps itself in BEGIN/COMMIT (legacy
 * style) would break atomicity: an inner COMMIT commits the engine's
 * transaction early, letting the registry insert land unguarded. Stripping
 * preserves semantics under the engine's own BEGIN/COMMIT and refuses
 * nothing else. sha256 is computed on the RAW file — stripping is an
 * execution-time concern only.
 */
export function stripTxControl(sql: string): string {
  return splitSqlStatements(sql)
    .filter((s) => !isTxControlStatement(s))
    .join(";\n");
}

/**
 * Top-level SQL statement splitter for `-- pb:no-transaction` segments.
 *
 * Needed because node-pg's simple query protocol executes a multi-statement
 * string in a single implicit transaction — to get per-statement autocommit
 * (required for CREATE INDEX CONCURRENTLY etc.) statements must be sent
 * separately. Handles: single/double-quoted strings, dollar-quoted bodies
 * ($$…$$, $tag$…$tag$), line comments, block comments.
 */
export function splitSqlStatements(sql: string): string[] {
  const stmts: string[] = [];
  let cur = "";
  let i = 0;
  const n = sql.length;

  const flush = () => {
    const s = cur.trim();
    if (s && !/^(--[^\n]*\n?|\s)*$/.test(s) && /[^-\s]/.test(s.replace(/--[^\n]*/g, ""))) {
      // drop pure-comment segments
      const codeOnly = s.replace(/--[^\n]*/g, "").replace(/\/\*[\s\S]*?\*\//g, "").trim();
      if (codeOnly) stmts.push(s);
    }
    cur = "";
  };

  while (i < n) {
    const ch = sql[i]!;
    const next = sql[i + 1];

    if (ch === "-" && next === "-") {
      const e = sql.indexOf("\n", i);
      i = e === -1 ? n : e;
      continue; // line comments are stripped (they'd be empty statements anyway)
    }
    if (ch === "/" && next === "*") {
      const e = sql.indexOf("*/", i + 2);
      cur += sql.slice(i, e === -1 ? n : e + 2);
      i = e === -1 ? n : e + 2;
      continue;
    }
    if (ch === "'") {
      let j = i + 1;
      while (j < n && (sql[j] !== "'" || sql[j + 1] === "'")) {
        if (sql[j] === "'" && sql[j + 1] === "'") j += 2;
        else j++;
      }
      cur += sql.slice(i, j + 1);
      i = j + 1;
      continue;
    }
    if (ch === '"') {
      let j = i + 1;
      while (j < n && (sql[j] !== '"' || sql[j + 1] === '"')) {
        if (sql[j] === '"' && sql[j + 1] === '"') j += 2;
        else j++;
      }
      cur += sql.slice(i, j + 1);
      i = j + 1;
      continue;
    }
    if (ch === "$") {
      const m = /^\$([a-zA-Z_][a-zA-Z0-9_]*)?\$/.exec(sql.slice(i));
      if (m) {
        const tag = m[0];
        const end = sql.indexOf(tag, i + tag.length);
        const j = end === -1 ? n : end + tag.length;
        cur += sql.slice(i, j);
        i = j;
        continue;
      }
      cur += ch;
      i++;
      continue;
    }
    if (ch === ";") {
      flush();
      i++;
      continue;
    }
    cur += ch;
    i++;
  }
  flush();
  return stmts;
}
