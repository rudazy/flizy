/**
 * Derive, from source, which database objects the running code depends on.
 *
 * Nothing here is hand-maintained. There are two derivations:
 *
 *   1. What the code REQUIRES  - scan .from('t') / .rpc('f') across a surface's
 *      own source. Add a table to the code and the requirement appears, because
 *      the requirement is read out of the code that has it.
 *   2. What the migrations PROVIDE - replay supabase/migrations/*.sql in
 *      filename order, applying creates, renames and drops in sequence. This is
 *      what lets a failure name the exact file that supplies a missing object.
 *
 * Triggers and functions are never named by JS, so they are attached instead:
 * a trigger is required when it sits on a required table, and a function is
 * required when a required trigger executes it, when code calls it over .rpc(),
 * or when a required function's body calls it.
 *
 * Anything this file cannot parse is an error, never a silent skip. A guard that
 * quietly checks less than it claims is worse than no guard.
 *
 * No network, no env, no side effects - so the whole thing is unit testable.
 */

const fs = require('fs');
const path = require('path');

const CODE_EXTENSIONS = new Set(['.js', '.mjs', '.cjs', '.ts', '.tsx']);
const SKIP_DIRS = new Set(['node_modules', '.next', 'dist', 'out', 'generated']);

/**
 * `create` statements that declare nothing this guard tracks. Anything else
 * starting with `create` throws, so a new DDL shape cannot slip past unnoticed.
 */
const IGNORED_CREATE = /^create\s+(extension|schema|policy|type|domain|sequence|publication|role|cast|operator)\b/i;

// ---------------------------------------------------------------------------
// SQL splitting
// ---------------------------------------------------------------------------

/**
 * Split SQL into top-level statements.
 *
 * Walks character by character so that line comments, block comments and single
 * quoted literals cannot be mistaken for structure. Dollar quoted blocks are
 * lifted out into `bodies` and replaced by a NUL-delimited index, which is what
 * keeps a `;` inside a function body from splitting the statement.
 *
 * @param {string} sql
 * @returns {{ text: string, bodies: string[] }[]}
 */
function splitStatements(sql) {
  const statements = [];
  let text = '';
  let bodies = [];
  let i = 0;

  const push = () => {
    if (text.trim()) statements.push({ text, bodies });
    text = '';
    bodies = [];
  };

  while (i < sql.length) {
    const two = sql.slice(i, i + 2);

    if (two === '--') {
      const nl = sql.indexOf('\n', i);
      i = nl === -1 ? sql.length : nl;
      continue;
    }

    if (two === '/*') {
      const end = sql.indexOf('*/', i + 2);
      if (end === -1) throw new Error('unterminated block comment');
      i = end + 2;
      continue;
    }

    const ch = sql[i];

    if (ch === "'") {
      let j = i + 1;
      while (j < sql.length) {
        if (sql[j] === "'" && sql[j + 1] === "'") {
          j += 2;
          continue;
        }
        if (sql[j] === "'") break;
        j += 1;
      }
      if (j >= sql.length) throw new Error('unterminated string literal');
      text += sql.slice(i, j + 1);
      i = j + 1;
      continue;
    }

    if (ch === '$') {
      const open = /^\$([A-Za-z_]\w*)?\$/.exec(sql.slice(i));
      if (open) {
        const tag = open[0];
        const close = sql.indexOf(tag, i + tag.length);
        if (close === -1) throw new Error(`unterminated dollar quoted block ${tag}`);
        bodies.push(sql.slice(i + tag.length, close));
        text += ` %%BODY${bodies.length - 1}%% `;
        i = close + tag.length;
        continue;
      }
    }

    if (ch === ';') {
      push();
      i += 1;
      continue;
    }

    text += ch;
    i += 1;
  }

  push();
  return statements;
}

/** Resolve the dollar-quoted body a statement placeholder points at. */
function bodyOf(statement) {
  const m = /%%BODY(\d+)%%/.exec(statement.text);
  if (!m) return null;
  return statement.bodies[Number(m[1])] ?? null;
}

// ---------------------------------------------------------------------------
// Migration replay
// ---------------------------------------------------------------------------

const RE = {
  createTable: /^create\s+table\s+(?:if\s+not\s+exists\s+)?(?:public\.)?([a-z0-9_]+)/i,
  createView: /^create\s+(?:or\s+replace\s+)?(?:materialized\s+)?view\s+(?:if\s+not\s+exists\s+)?(?:public\.)?([a-z0-9_]+)/i,
  createFunction: /^create\s+(?:or\s+replace\s+)?function\s+(?:public\.)?([a-z0-9_]+)/i,
  createTrigger: /^create\s+(?:or\s+replace\s+)?(?:constraint\s+)?trigger\s+([a-z0-9_]+)/i,
  createIndex: /^create\s+(?:unique\s+)?index\s+(?:concurrently\s+)?(?:if\s+not\s+exists\s+)?([a-z0-9_]+)/i,
  rename: /^alter\s+table\s+(?:if\s+exists\s+)?(?:public\.)?([a-z0-9_]+)\s+rename\s+to\s+(?:public\.)?([a-z0-9_]+)/i,
  enableRls: /^alter\s+table\s+(?:if\s+exists\s+)?(?:public\.)?([a-z0-9_]+)\s+enable\s+row\s+level\s+security/i,
  drop: /^drop\s+(table|view|function|trigger|index)\s+(?:if\s+exists\s+)?(?:public\.)?([a-z0-9_]+)/i,
  triggerOn: /\bon\s+(?:public\.)?([a-z0-9_]+)/i,
  triggerExec: /\bexecute\s+(?:function|procedure)\s+(?:public\.)?([a-z0-9_]+)/i,
};

/**
 * plpgsql control keywords that can sit in front of real DDL inside a `do`
 * block. Statements there arrive as "begin if ... then alter table ...", so the
 * DDL patterns above would not anchor without stripping these first. Matching
 * is still anchored afterwards, which keeps DDL-looking text inside a string
 * literal from being read as a statement.
 */
const CONTROL_PREFIX =
  /^(?:begin|declare[^;]*?|if[^;]*?\bthen|elsif[^;]*?\bthen|else|while[^;]*?\bloop|for[^;]*?\bloop|loop|end\s+if|end\s+loop|end)\s+/i;

/** Strip any run of leading plpgsql control keywords. */
function stripControl(text) {
  let out = text;
  for (;;) {
    const next = out.replace(CONTROL_PREFIX, '');
    if (next === out) return out;
    out = next;
  }
}

function key(kind, name) {
  return `${kind}:${name}`;
}

/**
 * Replay every migration in filename order and record the surviving objects.
 *
 * @param {string} migrationsDir
 * @returns {{
 *   files: string[],
 *   objects: Map<string, { kind: string, name: string, file: string }>,
 *   triggers: Map<string, { table: string, fn: string|null, file: string }>,
 *   functionBodies: Map<string, string>,
 *   rlsEnabled: Set<string>,
 * }}
 */
function parseMigrations(migrationsDir) {
  const files = fs
    .readdirSync(migrationsDir)
    .filter((f) => f.endsWith('.sql'))
    .sort();

  const objects = new Map();
  const triggers = new Map();
  const functionBodies = new Map();
  const rlsEnabled = new Set();

  const add = (kind, name, file) => {
    objects.set(key(kind, name), { kind, name, file });
  };

  /** @param {{text: string, bodies: string[]}[]} statements */
  const apply = (statements, file) => {
    for (const statement of statements) {
      const raw = statement.text.trim().replace(/\s+/g, ' ');
      if (!raw) continue;
      const text = stripControl(raw);
      if (!text) continue;

      // `do $$ ... $$` runs immediately, so its contents are real DDL.
      if (/^do\b/i.test(text)) {
        const body = bodyOf(statement);
        if (body) apply(splitStatements(body), file);
        continue;
      }

      let m;

      if ((m = RE.createTable.exec(text))) {
        add('table', m[1].toLowerCase(), file);
        continue;
      }

      if ((m = RE.createView.exec(text))) {
        add('view', m[1].toLowerCase(), file);
        continue;
      }

      if ((m = RE.createFunction.exec(text))) {
        const name = m[1].toLowerCase();
        add('function', name, file);
        const body = bodyOf(statement);
        if (body) functionBodies.set(name, body);
        continue;
      }

      if ((m = RE.createTrigger.exec(text))) {
        const name = m[1].toLowerCase();
        const onMatch = RE.triggerOn.exec(text);
        const execMatch = RE.triggerExec.exec(text);
        if (!onMatch) {
          throw new Error(`${file}: cannot read the table for trigger ${name}`);
        }
        add('trigger', name, file);
        triggers.set(name, {
          table: onMatch[1].toLowerCase(),
          fn: execMatch ? execMatch[1].toLowerCase() : null,
          file,
        });
        continue;
      }

      if ((m = RE.createIndex.exec(text))) {
        add('index', m[1].toLowerCase(), file);
        continue;
      }

      if ((m = RE.rename.exec(text))) {
        const from = m[1].toLowerCase();
        const to = m[2].toLowerCase();
        const prior = objects.get(key('table', from));
        objects.delete(key('table', from));
        // Provenance stays with the file that created it, not the rename.
        add('table', to, prior ? prior.file : file);
        // A rename carries row level security with the table. Without this the
        // setting would be attributed to a name that no longer exists.
        if (rlsEnabled.delete(from)) rlsEnabled.add(to);
        continue;
      }

      if ((m = RE.enableRls.exec(text))) {
        rlsEnabled.add(m[1].toLowerCase());
        continue;
      }

      if ((m = RE.drop.exec(text))) {
        const kind = m[1].toLowerCase();
        const name = m[2].toLowerCase();
        objects.delete(key(kind, name));
        if (kind === 'trigger') triggers.delete(name);
        if (kind === 'function') functionBodies.delete(name);
        continue;
      }

      if (/^create\b/i.test(text) && !IGNORED_CREATE.test(text)) {
        throw new Error(
          `${file}: unrecognised create statement, refusing to guess: ` +
            `${text.slice(0, 90)}`
        );
      }
    }
  };

  for (const file of files) {
    const sql = fs.readFileSync(path.join(migrationsDir, file), 'utf8');
    apply(splitStatements(sql), file);
  }

  return { files, objects, triggers, functionBodies, rlsEnabled };
}

// ---------------------------------------------------------------------------
// Code scan
// ---------------------------------------------------------------------------

function walk(target, out = []) {
  const stat = fs.statSync(target);
  if (stat.isFile()) {
    if (CODE_EXTENSIONS.has(path.extname(target))) out.push(target);
    return out;
  }
  for (const entry of fs.readdirSync(target, { withFileTypes: true })) {
    if (entry.name.startsWith('.') || SKIP_DIRS.has(entry.name)) continue;
    walk(path.join(target, entry.name), out);
  }
  return out;
}

/**
 * Blank out JS comments so a `.from('x')` written in prose is not read as a
 * dependency (this file's own doc comment is exactly that case).
 *
 * Quote aware, and `'`/`"` literals are only followed to the end of their own
 * line, because a JS string cannot span a raw newline. That bounds any
 * mis-lex to a single line instead of letting it cascade through the file.
 * Under-detection is the dangerous direction here, so the scan of this repo is
 * pinned by a test that asserts the exact table list.
 */
function stripJsComments(src) {
  let out = '';
  let i = 0;
  while (i < src.length) {
    const two = src.slice(i, i + 2);

    if (two === '//') {
      const nl = src.indexOf('\n', i);
      i = nl === -1 ? src.length : nl;
      continue;
    }

    if (two === '/*') {
      const end = src.indexOf('*/', i + 2);
      i = end === -1 ? src.length : end + 2;
      continue;
    }

    const ch = src[i];

    if (ch === "'" || ch === '"') {
      const nl = src.indexOf('\n', i);
      const limit = nl === -1 ? src.length : nl;
      let j = i + 1;
      while (j < limit && src[j] !== ch) j += src[j] === '\\' ? 2 : 1;
      if (j >= limit) {
        // No closing quote on this line, so it was not a string. Skip the char.
        out += ch;
        i += 1;
        continue;
      }
      out += src.slice(i, j + 1);
      i = j + 1;
      continue;
    }

    if (ch === '`') {
      let j = i + 1;
      while (j < src.length && src[j] !== '`') j += src[j] === '\\' ? 2 : 1;
      out += src.slice(i, Math.min(j + 1, src.length));
      i = j + 1;
      continue;
    }

    out += ch;
    i += 1;
  }
  return out;
}

// Buffer.from / Array.from are not database calls. Excluded by receiver so that
// an unresolved argument elsewhere stays a hard error rather than noise.
const FROM_CALL =
  /(?<!\bBuffer)(?<!\bArray)(?<!\bObject)\.from\(\s*(?:'([a-z0-9_]+)'|"([a-z0-9_]+)"|([A-Za-z_$][\w$]*))\s*\)/g;
const RPC_CALL =
  /\.rpc\(\s*(?:'([a-z0-9_]+)'|"([a-z0-9_]+)"|([A-Za-z_$][\w$]*))\s*[,)]/g;
const MODULE_CONST =
  /^[ \t]*(?:export\s+)?const\s+([A-Za-z_$][\w$]*)\s*(?::[^=]*)?=\s*['"]([a-z0-9_]+)['"]\s*;/gm;

/**
 * Find every table and rpc the given source roots depend on.
 *
 * Table names reached through a module-scope `const T = 'name'` are resolved
 * per file. An identifier that cannot be resolved throws: four call sites in
 * this repo reach tables that way, so silently dropping them would hide a
 * quarter of the schema.
 *
 * @param {string[]} roots absolute paths, files or directories
 * @param {string} [relativeTo] for readable provenance in messages
 */
function scanCode(roots, relativeTo) {
  const tables = new Map();
  const rpcs = new Map();

  const note = (map, name, file) => {
    const rel = relativeTo ? path.relative(relativeTo, file).replace(/\\/g, '/') : file;
    if (!map.has(name)) map.set(name, new Set());
    map.get(name).add(rel);
  };

  const files = roots.filter((r) => fs.existsSync(r)).flatMap((r) => walk(r));

  for (const file of files) {
    const src = stripJsComments(fs.readFileSync(file, 'utf8'));

    const consts = new Map();
    let c;
    MODULE_CONST.lastIndex = 0;
    while ((c = MODULE_CONST.exec(src))) consts.set(c[1], c[2]);

    let m;
    FROM_CALL.lastIndex = 0;
    while ((m = FROM_CALL.exec(src))) {
      const literal = m[1] || m[2];
      if (literal) {
        note(tables, literal, file);
        continue;
      }
      const identifier = m[3];
      if (consts.has(identifier)) {
        note(tables, consts.get(identifier), file);
        continue;
      }
      const rel = relativeTo ? path.relative(relativeTo, file).replace(/\\/g, '/') : file;
      throw new Error(
        `${rel}: .from(${identifier}) does not resolve to a table name. ` +
          `Use a string literal or a module-scope const so the schema guard can see it.`
      );
    }

    RPC_CALL.lastIndex = 0;
    while ((m = RPC_CALL.exec(src))) {
      const literal = m[1] || m[2];
      if (literal) {
        note(rpcs, literal, file);
        continue;
      }
      const identifier = m[3];
      if (consts.has(identifier)) {
        note(rpcs, consts.get(identifier), file);
        continue;
      }
      const rel = relativeTo ? path.relative(relativeTo, file).replace(/\\/g, '/') : file;
      throw new Error(
        `${rel}: .rpc(${identifier}) does not resolve to a function name. ` +
          `Use a string literal or a module-scope const so the schema guard can see it.`
      );
    }
  }

  return { tables, rpcs, files };
}

// ---------------------------------------------------------------------------
// Requirements
// ---------------------------------------------------------------------------

/**
 * Combine both derivations into the object list one surface must have present.
 *
 * @param {{ codeRoots: string[], migrationsDir: string, relativeTo?: string, surface: string }} opts
 * @returns {{
 *   surface: string,
 *   objects: { kind: string, name: string, providedBy: string, requiredBy: string }[],
 * }}
 */
function deriveRequirements({ codeRoots, migrationsDir, relativeTo, surface }) {
  const mig = parseMigrations(migrationsDir);
  const code = scanCode(codeRoots, relativeTo);

  /** @type {Map<string, { kind: string, name: string, providedBy: string, requiredBy: string }>} */
  const required = new Map();

  const require_ = (kind, name, requiredBy) => {
    const k = key(kind, name);
    if (required.has(k)) return;
    const declared = mig.objects.get(k) || (kind === 'table' ? mig.objects.get(key('view', name)) : null);
    if (!declared) {
      throw new Error(
        `code requires ${kind} "${name}" (${requiredBy}) but no migration creates it. ` +
          `Either the migration is missing from the repo or the name is wrong.`
      );
    }
    required.set(k, { kind, name, providedBy: declared.file, requiredBy });
  };

  for (const [table, files] of code.tables) {
    require_('table', table, [...files].sort().join(', '));
  }
  for (const [fn, files] of code.rpcs) {
    require_('function', fn, [...files].sort().join(', '));
  }

  // A trigger is required when it guards a table this surface writes.
  for (const [name, trigger] of mig.triggers) {
    if (!required.has(key('table', trigger.table))) continue;
    require_('trigger', name, `trigger on ${trigger.table}`);
    if (trigger.fn) require_('function', trigger.fn, `executed by trigger ${name}`);
  }

  // Functions a required function calls are required too (transitive).
  let grew = true;
  while (grew) {
    grew = false;
    for (const entry of [...required.values()]) {
      if (entry.kind !== 'function') continue;
      const body = mig.functionBodies.get(entry.name);
      if (!body) continue;
      for (const candidate of mig.functionBodies.keys()) {
        if (candidate === entry.name) continue;
        if (required.has(key('function', candidate))) continue;
        const called = new RegExp(`(?:public\\.)?\\b${candidate}\\s*\\(`, 'i');
        if (!called.test(body)) continue;
        require_('function', candidate, `called by ${entry.name}`);
        grew = true;
      }
    }
  }

  const objects = [...required.values()].sort(
    (a, b) => a.kind.localeCompare(b.kind) || a.name.localeCompare(b.name)
  );

  return { surface, objects };
}

/** Everything the migration stack declares, for the full-stack dev verifier. */
function declaredObjects(migrationsDir) {
  const mig = parseMigrations(migrationsDir);
  const byKind = (kind) =>
    [...mig.objects.values()]
      .filter((o) => o.kind === kind)
      .map((o) => o.name)
      .sort();

  return {
    files: mig.files,
    tables: byKind('table'),
    views: byKind('view'),
    functions: byKind('function'),
    triggers: byKind('trigger'),
    indexes: byKind('index'),
    rlsEnabled: [...mig.rlsEnabled].sort(),
    providedBy: (kind, name) => {
      const found = mig.objects.get(key(kind, name));
      return found ? found.file : null;
    },
  };
}

module.exports = {
  splitStatements,
  parseMigrations,
  scanCode,
  deriveRequirements,
  declaredObjects,
};
