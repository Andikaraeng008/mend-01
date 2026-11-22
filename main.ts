// mend: one patch tool for every AI edit format (SPEC.md version 1).
// Reads a patch in one of four formats (unified diff, SEARCH/REPLACE blocks,
// V4A, JSON tool calls), finds the lines each edit names at the first of
// three matching tiers, and writes every change or none. Node 22, the
// standard library alone; run it as `node main.ts [options] [PATCH]`.
//
// In a trial the grader runs `node /bot/main.ts` with MAKEFUN_ENV_URL set,
// and then this file hands over to runner.ts (the last lines below).

import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync, writeSync } from 'node:fs';
import { dirname } from 'node:path';

const FORMATS = ['auto', 'unified', 'search-replace', 'v4a', 'json'];

class Exit2 {
  readonly line: string;
  constructor(line: string) {
    this.line = line;
  }
}
class Fail {
  readonly code: string;
  readonly path: string;
  constructor(code: string, path: string) {
    this.code = code;
    this.path = path;
  }
}

const blank = (s: string): boolean => s.trim() === '';

function patchLines(text: string): string[] {
  if (text === '') return [];
  const lines = text.split('\n');
  if (text.endsWith('\n')) lines.pop();
  return lines.map((l) => (l.endsWith('\r') ? l.slice(0, -1) : l));
}

function safe(p: string): boolean {
  return p !== '' && !p.startsWith('/') && !p.includes('\\') && p.split('/').every((s) => s !== '' && s !== '.' && s !== '..');
}

/** A file's text as lines, its line break, and whether it ends with one. */
interface FileText {
  br: string;
  lines: string[];
  final: boolean;
}

function splitFile(text: string): FileText {
  if (text === '') return { br: '\n', lines: [], final: false };
  const nl = text.indexOf('\n');
  const br = nl > 0 && text[nl - 1] === '\r' ? '\r\n' : '\n';
  const parts = text.split(br);
  const final = text.endsWith(br);
  if (final) parts.pop();
  return { br, lines: parts, final };
}

function joinFile(f: FileText): string {
  if (f.lines.length === 0) return '';
  return f.lines.join(f.br) + (f.final ? f.br : '');
}

/** The leading spaces and tabs of a line. */
function lead(s: string): string {
  const m = /^[ \t]*/.exec(s);
  return m === null ? '' : m[0];
}

/** A line's key at a matching tier: 0 exact, 1 trailing whitespace off, 2 both ends off. */
function tierKey(s: string, tier: number): string {
  if (tier === 0) return s;
  if (tier === 1) return s.replace(/[ \t]+$/, '');
  return s.replace(/^[ \t]+/, '').replace(/[ \t]+$/, '');
}

/** Positions at or after `from` where O occurs in lines at tier. */
function occurrences(O: string[], lines: string[], tier: number, from: number): number[] {
  const out: number[] = [];
  if (O.length === 0) return out;
  const keys = O.map((l) => tierKey(l, tier));
  for (let i = Math.max(0, from); i + O.length <= lines.length; i++) {
    let ok = true;
    for (let j = 0; j < O.length; j++) {
      if (tierKey(lines[i + j]!, tier) !== keys[j]) {
        ok = false;
        break;
      }
    }
    if (ok) out.push(i);
  }
  return out;
}

/** The first tier at which O occurs at or after `from`, with its positions. */
function firstTier(O: string[], lines: string[], from: number, strict: boolean): { tier: number; pos: number[] } | null {
  const tiers = strict ? [0] : [0, 1, 2];
  for (const t of tiers) {
    const pos = occurrences(O, lines, t, from);
    if (pos.length > 0) return { tier: t, pos };
  }
  return null;
}

/** One line of a hunk or chunk body. `slash` is true when a `\` line follows it. */
interface BodyEntry {
  kind: 'ctx' | 'old' | 'new';
  text: string;
  slash: boolean;
}

/**
 * The lines that replace O at position `pos`: context lines are the file's
 * own matched lines, and at tier 2 every other line is re-indented from O's
 * first line's leading whitespace to the file's first matched line's.
 */
function buildReplacement(body: BodyEntry[], O: string[], fileLines: string[], pos: number, tier: number): string[] {
  const oIndex = new Map<number, number>();
  let oi = 0;
  for (let bi = 0; bi < body.length; bi++) {
    const e = body[bi]!;
    if (e.kind === 'ctx' || e.kind === 'old') {
      oIndex.set(bi, oi);
      oi++;
    }
  }
  const F = lead(fileLines[pos] ?? '');
  const P = lead(O[0] ?? '');
  const out: string[] = [];
  for (let bi = 0; bi < body.length; bi++) {
    const e = body[bi]!;
    if (e.kind === 'new') {
      let line = e.text;
      if (tier === 2 && line !== '' && line.trim() !== '' && line.startsWith(P)) line = F + line.slice(P.length);
      out.push(line);
    } else if (e.kind === 'ctx') {
      out.push(fileLines[pos + oIndex.get(bi)!]!);
    }
  }
  return out;
}

/** The tree as the edits leave it: changed paths in `now` (null: deleted), the rest read from disk. */
class Tree {
  private readonly orig = new Map<string, string | null>();
  readonly now = new Map<string, string | null>();
  /** Successful moves, as [old, new] pairs, in the order the edits made them. */
  readonly moves: Array<[string, string]> = [];
  original(p: string): string | null {
    if (!this.orig.has(p)) {
      let v: string | null = null;
      try {
        if (statSync(p).isFile()) v = readFileSync(p, 'utf8');
      } catch {
        v = null;
      }
      this.orig.set(p, v);
    }
    return this.orig.get(p)!;
  }
  get(p: string): string | null {
    return this.now.has(p) ? this.now.get(p)! : this.original(p);
  }
}

type Edit = (tree: Tree) => void;

function detect(lines: string[]): string | null {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) return null;
  if (lines[first]!.trim() === '*** Begin Patch') return 'v4a';
  const c = lines[first]!.trimStart()[0];
  if (c === '[' || c === '{') return 'json';
  if (lines.some((l) => l.trimEnd() === '<<<<<<< SEARCH')) return 'search-replace';
  if (lines.some((l, i) => l.startsWith('diff --git ') || (l.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')))) return 'unified';
  return null;
}

/** One JSON edit object (SPEC.md section 9), or null when it is not one. */
function jsonEdit(v: unknown): Edit | null {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return null;
  const o = v as Record<string, unknown>;
  const p = o.path;
  if (typeof p !== 'string') return null;
  const exists = (tree: Tree): string => {
    if (!safe(p)) throw new Fail('unsafe', p);
    const t = tree.get(p);
    if (t === null) throw new Fail('missing', p);
    return t;
  };
  if (o.command === 'create' && typeof o.file_text === 'string') {
    const text = o.file_text;
    return (tree) => {
      if (!safe(p)) throw new Fail('unsafe', p);
      if (tree.get(p) !== null) throw new Fail('exists', p);
      tree.now.set(p, text);
    };
  }
  if (o.command === 'str_replace' && typeof o.old_str === 'string' && o.old_str !== '' && (o.new_str === undefined || typeof o.new_str === 'string')) {
    const oldStr = o.old_str;
    const newStr = (o.new_str as string | undefined) ?? '';
    return (tree) => {
      const before = exists(tree);
      const nl = before.indexOf('\n');
      const crlf = nl > 0 && before[nl - 1] === '\r';
      const lf = (s: string): string => (crlf ? s.replaceAll('\r\n', '\n') : s);
      const t = lf(before);
      const old = lf(oldStr);
      let count = 0;
      for (let k = t.indexOf(old); k >= 0; k = t.indexOf(old, k + 1)) count += 1;
      if (count === 0) throw new Fail('no-match', p);
      if (count > 1) throw new Fail('ambiguous', p);
      const at = t.indexOf(old);
      const out = t.slice(0, at) + lf(newStr) + t.slice(at + old.length);
      tree.now.set(p, crlf ? out.replaceAll('\n', '\r\n') : out);
    };
  }
  if (o.command === 'insert' && typeof o.insert_line === 'number' && Number.isInteger(o.insert_line) && typeof o.new_str === 'string') {
    const line = o.insert_line;
    const add = patchLines(o.new_str);
    return (tree) => {
      const before = exists(tree);
      const nl = before.indexOf('\n');
      const br = nl > 0 && before[nl - 1] === '\r' ? '\r\n' : '\n';
      const lines = before === '' ? [] : before.split(br);
      const final = before !== '' && before.endsWith(br);
      if (final) lines.pop();
      if (line < 0 || line > lines.length) throw new Fail('no-match', p);
      lines.splice(line, 0, ...add);
      tree.now.set(p, lines.length === 0 ? '' : lines.join(br) + (final ? br : ''));
    };
  }
  return null;
}

function jsonEdits(text: string, lines: string[]): Edit[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  const edits: Edit[] = [];
  if (lines[first]!.trimStart().startsWith('[')) {
    let v: unknown;
    try {
      v = JSON.parse(text);
    } catch {
      throw new Exit2(`error: parse ${first + 1}`);
    }
    if (!Array.isArray(v)) throw new Exit2(`error: parse ${first + 1}`);
    for (const x of v) {
      const e = jsonEdit(x);
      if (e === null) throw new Exit2(`error: parse ${first + 1}`);
      edits.push(e);
    }
    return edits;
  }
  lines.forEach((l, i) => {
    if (blank(l)) return;
    let e: Edit | null = null;
    try {
      e = jsonEdit(JSON.parse(l));
    } catch {
      e = null;
    }
    if (e === null) throw new Exit2(`error: parse ${i + 1}`);
    edits.push(e);
  });
  return edits;
}

/* ---- Unified diffs (SPEC.md section 6) ---- */

const HUNK_RE = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;
const DIFF_GIT_RE = /^diff --git a\/(\S+) b\/(\S+)$/;

/** One hunk: its old start line A (1-based) and its body. */
interface Hunk {
  a: number;
  body: BodyEntry[];
}

/** A section's header: the paths each source named, and its hunks. */
interface Section {
  diffOld: string | null;
  diffNew: string | null;
  pairOld: string | null;
  pairNew: string | null;
  hasPair: boolean;
  renameFrom: string | null;
  renameTo: string | null;
  isNew: boolean;
  isDeleted: boolean;
  hunks: Hunk[];
}

function stripAB(p: string): string {
  if (p.startsWith('a/') || p.startsWith('b/')) return p.slice(2);
  return p;
}

/** A `---`/`+++` path: the text after the four characters, up to the first tab, spaces removed. */
function hdrPath(line: string): string {
  return line.slice(4).split('\t')[0]!.trim();
}

/** The body of the hunk starting at header line `h`; returns the hunk and the next line index. */
function parseHunk(lines: string[], h: number): { hunk: Hunk; next: number } {
  const m = HUNK_RE.exec(lines[h]!);
  const a = Number(m![1]);
  const body: BodyEntry[] = [];
  const raw: string[] = [];
  let j = h + 1;
  const n = lines.length;
  while (j < n) {
    const l = lines[j]!;
    if (l.startsWith('diff --git ')) break;
    if (l.startsWith('--- ') && (lines[j + 1] ?? '').startsWith('+++ ')) break;
    if (l === '' || l.startsWith(' ') || l.startsWith('-') || l.startsWith('+') || l.startsWith('\\')) {
      raw.push(l);
      j++;
    } else {
      break;
    }
  }
  // Empty lines at the end of a body are not part of it.
  while (raw.length > 0 && raw[raw.length - 1] === '') raw.pop();
  for (const l of raw) {
    if (l.startsWith('\\')) {
      if (body.length > 0) body[body.length - 1]!.slash = true;
      continue;
    }
    if (l === '') {
      body.push({ kind: 'ctx', text: '', slash: false });
    } else if (l[0] === ' ') {
      body.push({ kind: 'ctx', text: l.slice(1), slash: false });
    } else if (l[0] === '-') {
      body.push({ kind: 'old', text: l.slice(1), slash: false });
    } else {
      body.push({ kind: 'new', text: l.slice(1), slash: false });
    }
  }
  return { hunk: { a, body }, next: j };
}

/**
 * Parse one section from line `start` (after its `diff --git` line, or after
 * its opening `---`/`+++` pair). Returns the next line index, at the next
 * section or the end of the patch.
 */
function parseSection(lines: string[], start: number, sec: Section): number {
  const n = lines.length;
  let i = start;
  let inBody = false;
  while (i < n) {
    const l = lines[i]!;
    if (l.startsWith('diff --git ')) return i;
    if (!inBody && l.startsWith('--- ')) {
      if ((lines[i + 1] ?? '').startsWith('+++ ')) {
        sec.pairOld = stripAB(hdrPath(l));
        sec.pairNew = stripAB(hdrPath(lines[i + 1]!));
        sec.hasPair = true;
        i += 2;
        continue;
      }
      throw new Exit2(`error: parse ${i + 2}`);
    }
    if (inBody && l.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')) return i;
    if (l.startsWith('@@')) {
      const m = HUNK_RE.exec(l);
      if (m === null) throw new Exit2(`error: parse ${i + 1}`);
      const { hunk, next } = parseHunk(lines, i);
      sec.hunks.push(hunk);
      inBody = true;
      i = next;
      continue;
    }
    if (!inBody) {
      if (l.startsWith('rename from ')) sec.renameFrom = l.slice('rename from '.length).trim();
      else if (l.startsWith('rename to ')) sec.renameTo = l.slice('rename to '.length).trim();
      else if (l.startsWith('new file mode')) sec.isNew = true;
      else if (l.startsWith('deleted file mode')) sec.isDeleted = true;
      i++;
      continue;
    }
    i++;
  }
  return i;
}

function parseUnified(lines: string[], strict: boolean): Edit[] {
  const edits: Edit[] = [];
  const n = lines.length;
  let i = 0;
  while (i < n) {
    const line = lines[i]!;
    if (line.startsWith('diff --git ')) {
      const m = DIFF_GIT_RE.exec(line);
      if (m === null) throw new Exit2(`error: parse ${i + 1}`);
      const sec: Section = {
        diffOld: m[1]!,
        diffNew: m[2]!,
        pairOld: null,
        pairNew: null,
        hasPair: false,
        renameFrom: null,
        renameTo: null,
        isNew: false,
        isDeleted: false,
        hunks: [],
      };
      i = parseSection(lines, i + 1, sec);
      edits.push(unifiedEdit(sec, strict));
    } else if (line.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')) {
      const sec: Section = {
        diffOld: null,
        diffNew: null,
        pairOld: stripAB(hdrPath(line)),
        pairNew: stripAB(hdrPath(lines[i + 1]!)),
        hasPair: true,
        renameFrom: null,
        renameTo: null,
        isNew: false,
        isDeleted: false,
        hunks: [],
      };
      i = parseSection(lines, i + 2, sec);
      edits.push(unifiedEdit(sec, strict));
    } else if (line.startsWith('@@')) {
      throw new Exit2(`error: parse ${i + 1}`);
    } else {
      i++;
    }
  }
  return edits;
}

/** Apply a section's hunks in order to a file; throws Fail on the first failure. */
function applyHunks(f: FileText, hunks: Hunk[], strict: boolean, path: string): FileText {
  let lines = f.lines.slice();
  let final = f.final;
  let d = 0;
  for (const h of hunks) {
    const O = h.body.filter((e) => e.kind === 'ctx' || e.kind === 'old').map((e) => e.text);
    let lastCN: BodyEntry | null = null;
    for (const e of h.body) if (e.kind === 'ctx' || e.kind === 'new') lastCN = e;
    if (O.length === 0) {
      const at = Math.min(h.a + d, lines.length);
      const ins = h.body.filter((e) => e.kind === 'new').map((e) => e.text);
      const atEnd = at === lines.length;
      lines = [...lines.slice(0, at), ...ins, ...lines.slice(at)];
      if (atEnd) final = lastCN === null ? true : !lastCN.slash;
      d += ins.length;
    } else {
      const found = firstTier(O, lines, 0, strict);
      if (found === null) throw new Fail('no-match', path);
      const target = h.a - 1 + d;
      let best = found.pos[0]!;
      let bestDist = Math.abs(best - target);
      for (const p of found.pos) {
        const dist = Math.abs(p - target);
        if (dist < bestDist) {
          best = p;
          bestDist = dist;
        }
      }
      const pos = best;
      const rep = buildReplacement(h.body, O, lines, pos, found.tier);
      const runsToEnd = pos + O.length === lines.length;
      lines = [...lines.slice(0, pos), ...rep, ...lines.slice(pos + O.length)];
      if (runsToEnd) final = lastCN === null ? true : !lastCN.slash;
      d += rep.length - O.length;
    }
  }
  return { br: f.br, lines, final };
}

/** One unified section as an edit. */
function unifiedEdit(sec: Section, strict: boolean): Edit {
  const rawOld = sec.hasPair ? sec.pairOld : sec.renameFrom !== null ? sec.renameFrom : sec.diffOld;
  const rawNew = sec.hasPair ? sec.pairNew : sec.renameTo !== null ? sec.renameTo : sec.diffNew;
  const oldPath = rawOld === null || rawOld === '/dev/null' ? null : rawOld;
  const newPath = rawNew === null || rawNew === '/dev/null' ? null : rawNew;
  const isCreate = oldPath === null || sec.isNew;
  const isDelete = !isCreate && (newPath === null || sec.isDeleted);
  return (tree) => {
    if (isCreate) {
      const np = newPath;
      if (np === null) return;
      if (!safe(np)) throw new Fail('unsafe', np);
      if (tree.get(np) !== null) throw new Fail('exists', np);
      const out: string[] = [];
      let lastPlusSlash = false;
      let hasPlus = false;
      for (const h of sec.hunks) {
        for (const e of h.body) {
          if (e.kind === 'new') {
            out.push(e.text);
            hasPlus = true;
            lastPlusSlash = e.slash;
          }
        }
      }
      const text = !hasPlus ? '' : out.join('\n') + (lastPlusSlash ? '' : '\n');
      tree.now.set(np, text);
      return;
    }
    if (isDelete) {
      const op = oldPath;
      if (op === null) return;
      if (!safe(op)) throw new Fail('unsafe', op);
      if (tree.get(op) === null) throw new Fail('missing', op);
      tree.now.set(op, null);
      return;
    }
    const op = oldPath!;
    const np = newPath!;
    if (!safe(op)) throw new Fail('unsafe', op);
    if (!safe(np)) throw new Fail('unsafe', np);
    const text = tree.get(op);
    if (text === null) throw new Fail('missing', op);
    if (op !== np && tree.get(np) !== null) throw new Fail('exists', np);
    const result = applyHunks(splitFile(text), sec.hunks, strict, op);
    if (op !== np) {
      tree.now.set(op, null);
      tree.now.set(np, joinFile(result));
      tree.moves.push([op, np]);
    } else {
      tree.now.set(op, joinFile(result));
    }
  };
}

/* ---- SEARCH/REPLACE blocks (SPEC.md section 7) ---- */

/** One SEARCH/REPLACE block as an edit. */
function srEdit(path: string, oldLines: string[], newLines: string[], strict: boolean): Edit {
  return (tree) => {
    if (!safe(path)) throw new Fail('unsafe', path);
    if (oldLines.length === 0) {
      if (tree.get(path) !== null) throw new Fail('exists', path);
      tree.now.set(path, newLines.length === 0 ? '' : newLines.join('\n') + '\n');
      return;
    }
    const cur = tree.get(path);
    if (cur === null) throw new Fail('missing', path);
    const f = splitFile(cur);
    const found = firstTier(oldLines, f.lines, 0, strict);
    if (found === null) throw new Fail('no-match', path);
    if (found.pos.length > 1) throw new Fail('ambiguous', path);
    const pos = found.pos[0]!;
    const body: BodyEntry[] = newLines.map((t) => ({ kind: 'new' as const, text: t, slash: false }));
    const rep = buildReplacement(body, oldLines, f.lines, pos, found.tier);
    const out = [...f.lines.slice(0, pos), ...rep, ...f.lines.slice(pos + oldLines.length)];
    tree.now.set(path, joinFile({ br: f.br, lines: out, final: f.final }));
  };
}

function parseSR(lines: string[], strict: boolean): Edit[] {
  const edits: Edit[] = [];
  const n = lines.length;
  let i = 0;
  let prevReplaceEnd = -1;
  let prevPath: string | null = null;
  while (i < n) {
    if (lines[i]!.trimEnd() !== '<<<<<<< SEARCH') {
      i++;
      continue;
    }
    const s = i;
    let path: string | null = null;
    for (let j = s - 1; j > prevReplaceEnd; j--) {
      const l = lines[j]!;
      if (blank(l)) continue;
      if (l.trim().startsWith('```')) continue;
      path = l.trim();
      break;
    }
    if (path === null) {
      if (prevPath === null) throw new Exit2(`error: parse ${s + 1}`);
      path = prevPath;
    }
    let eq = -1;
    for (let j = s + 1; j < n; j++) {
      if (lines[j]!.trimEnd() === '=======') {
        eq = j;
        break;
      }
    }
    if (eq === -1) throw new Exit2(`error: parse ${s + 1}`);
    let rep = -1;
    for (let j = eq + 1; j < n; j++) {
      if (lines[j]!.trimEnd() === '>>>>>>> REPLACE') {
        rep = j;
        break;
      }
    }
    if (rep === -1) throw new Exit2(`error: parse ${s + 1}`);
    edits.push(srEdit(path, lines.slice(s + 1, eq), lines.slice(eq + 1, rep), strict));
    prevPath = path;
    prevReplaceEnd = rep;
    i = rep + 1;
  }
  return edits;
}

/* ---- V4A patches (SPEC.md section 8) ---- */

/** One V4A chunk: its anchor (null: none), its body, and whether it is end-of-file. */
interface Chunk {
  anchor: string | null;
  body: BodyEntry[];
  eof: boolean;
}

function v4aAddEdit(path: string, fileLines: string[]): Edit {
  return (tree) => {
    if (!safe(path)) throw new Fail('unsafe', path);
    if (tree.get(path) !== null) throw new Fail('exists', path);
    tree.now.set(path, fileLines.length === 0 ? '' : fileLines.join('\n') + '\n');
  };
}

function v4aDeleteEdit(path: string): Edit {
  return (tree) => {
    if (!safe(path)) throw new Fail('unsafe', path);
    if (tree.get(path) === null) throw new Fail('missing', path);
    tree.now.set(path, null);
  };
}

function v4aUpdateEdit(path: string, moveTo: string | null, chunks: Chunk[], strict: boolean): Edit {
  return (tree) => {
    if (!safe(path)) throw new Fail('unsafe', path);
    if (moveTo !== null && !safe(moveTo)) throw new Fail('unsafe', moveTo);
    const cur = tree.get(path);
    if (cur === null) throw new Fail('missing', path);
    if (moveTo !== null && tree.get(moveTo) !== null) throw new Fail('exists', moveTo);
    const f = splitFile(cur);
    let lines = f.lines.slice();
    let cursor = 0;
    const tiers = strict ? [0] : [0, 1, 2];
    for (const ch of chunks) {
      if (ch.anchor !== null) {
        let foundAt: number | null = null;
        for (const t of tiers) {
          const key = tierKey(ch.anchor, t);
          for (let k = cursor; k < lines.length; k++) {
            if (tierKey(lines[k]!, t) === key) {
              foundAt = k;
              break;
            }
          }
          if (foundAt !== null) break;
        }
        if (foundAt === null) throw new Fail('no-match', path);
        cursor = foundAt + 1;
      }
      const O = ch.body.filter((e) => e.kind === 'ctx' || e.kind === 'old').map((e) => e.text);
      if (O.length === 0) {
        const ins = ch.body.filter((e) => e.kind === 'new').map((e) => e.text);
        const at = ch.eof ? lines.length : cursor;
        lines = [...lines.slice(0, at), ...ins, ...lines.slice(at)];
        cursor = at + ins.length;
        continue;
      }
      let matched: { tier: number; pos: number } | null = null;
      for (const t of tiers) {
        let occ = occurrences(O, lines, t, cursor);
        if (ch.eof) occ = occ.filter((p) => p + O.length === lines.length);
        if (occ.length > 0) {
          matched = { tier: t, pos: occ[0]! };
          break;
        }
      }
      if (matched === null) throw new Fail('no-match', path);
      const rep = buildReplacement(ch.body, O, lines, matched.pos, matched.tier);
      lines = [...lines.slice(0, matched.pos), ...rep, ...lines.slice(matched.pos + O.length)];
      cursor = matched.pos + rep.length;
    }
    const result = joinFile({ br: f.br, lines, final: f.final });
    if (moveTo !== null) {
      tree.now.set(path, null);
      tree.now.set(moveTo, result);
      tree.moves.push([path, moveTo]);
    } else {
      tree.now.set(path, result);
    }
  };
}

function parseV4A(lines: string[], strict: boolean): Edit[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  if (lines[first]!.trim() !== '*** Begin Patch') throw new Exit2(`error: parse ${first + 1}`);
  let last = -1;
  for (let i = lines.length - 1; i >= 0; i--) {
    if (!blank(lines[i]!)) {
      last = i;
      break;
    }
  }
  if (lines[last]!.trim() !== '*** End Patch') throw new Exit2(`error: parse ${lines.length + 1}`);
  const edits: Edit[] = [];
  const end = last;
  let i = first + 1;
  const isHeader = (l: string): boolean =>
    l.startsWith('*** Add File: ') || l.startsWith('*** Delete File: ') || l.startsWith('*** Update File: ');
  while (i < end) {
    const line = lines[i]!;
    if (blank(line)) {
      i++;
      continue;
    }
    if (!isHeader(line)) throw new Exit2(`error: parse ${i + 1}`);
    const headerLine = i + 1;
    let kind: 'add' | 'delete' | 'update';
    let path: string;
    if (line.startsWith('*** Add File: ')) {
      kind = 'add';
      path = line.slice('*** Add File: '.length).trim();
    } else if (line.startsWith('*** Delete File: ')) {
      kind = 'delete';
      path = line.slice('*** Delete File: '.length).trim();
    } else {
      kind = 'update';
      path = line.slice('*** Update File: '.length).trim();
    }
    i++;
    const secLines: Array<{ n: number; l: string }> = [];
    while (i < end) {
      const l = lines[i]!;
      if (isHeader(l)) break;
      secLines.push({ n: i + 1, l });
      i++;
    }
    while (secLines.length > 0 && blank(secLines[secLines.length - 1]!.l)) secLines.pop();
    if (kind === 'add') {
      const fileLines: string[] = [];
      for (const { n, l } of secLines) {
        if (l.startsWith('+')) fileLines.push(l.slice(1));
        else if (l === '') fileLines.push('');
        else throw new Exit2(`error: parse ${n}`);
      }
      edits.push(v4aAddEdit(path, fileLines));
    } else if (kind === 'delete') {
      if (secLines.length > 0) throw new Exit2(`error: parse ${secLines[0]!.n}`);
      edits.push(v4aDeleteEdit(path));
    } else {
      let moveTo: string | null = null;
      let idx = 0;
      if (secLines.length > 0 && secLines[0]!.l.startsWith('*** Move to: ')) {
        moveTo = secLines[0]!.l.slice('*** Move to: '.length).trim();
        idx = 1;
      }
      const chunks: Chunk[] = [];
      let cur: BodyEntry[] | null = null;
      let curAnchor: string | null = null;
      let curEof = false;
      const finishChunk = (): void => {
        if (cur !== null) {
          chunks.push({ anchor: curAnchor, body: cur, eof: curEof });
          cur = null;
          curAnchor = null;
          curEof = false;
        }
      };
      for (; idx < secLines.length; idx++) {
        const { n, l } = secLines[idx]!;
        if (l.startsWith('@@')) {
          finishChunk();
          const anchor = l.slice(2).trim();
          cur = [];
          curAnchor = anchor === '' ? null : anchor;
          curEof = false;
        } else if (l === '*** End of File') {
          if (cur === null) throw new Exit2(`error: parse ${n}`);
          curEof = true;
          finishChunk();
        } else if (l.startsWith(' ') || l.startsWith('-') || l.startsWith('+') || l === '') {
          if (cur === null) {
            if (chunks.length > 0) throw new Exit2(`error: parse ${n}`);
            cur = [];
            curAnchor = null;
            curEof = false;
          }
          const k = l === '' ? 'ctx' : l[0] === ' ' ? 'ctx' : l[0] === '-' ? 'old' : 'new';
          cur.push({ kind: k, text: l === '' ? '' : l.slice(1), slash: false });
        } else {
          throw new Exit2(`error: parse ${n}`);
        }
      }
      finishChunk();
      if (chunks.length === 0 && moveTo === null) throw new Exit2(`error: parse ${headerLine}`);
      edits.push(v4aUpdateEdit(path, moveTo, chunks, strict));
    }
  }
  return edits;
}

/* ---- Driver (SPEC.md sections 1, 2 and 10) ---- */

function run(args: string[]): { code: number; out: string[] } {
  let format: string | null = null;
  let check = false;
  let strict = false;
  const pos: string[] = [];
  let ended = false;
  for (const a of args) {
    if (!ended && a === '--') ended = true;
    else if (!ended && a.startsWith('-') && a !== '-') {
      if (a.startsWith('--format=') && format === null && FORMATS.includes(a.slice(9))) format = a.slice(9);
      else if (a === '--check' && !check) check = true;
      else if (a === '--strict' && !strict) strict = true;
      else return { code: 2, out: ['error: usage'] };
    } else pos.push(a);
  }
  if (pos.length > 1) return { code: 2, out: ['error: usage'] };
  const file = pos.length === 0 || pos[0] === '-' ? null : pos[0]!;
  let text = '';
  try {
    text = readFileSync(file ?? 0, 'utf8');
  } catch {
    if (file !== null) return { code: 2, out: ['error: no-patch'] };
  }
  const lines = patchLines(text);
  const kind = format === null || format === 'auto' ? detect(lines) : format;
  if (kind === null) return { code: 2, out: ['error: format'] };
  let edits: Edit[];
  try {
    if (kind === 'json') edits = jsonEdits(text, lines);
    else if (kind === 'unified') edits = parseUnified(lines, strict);
    else if (kind === 'search-replace') edits = parseSR(lines, strict);
    else edits = parseV4A(lines, strict);
    if (edits.length === 0) throw new Exit2('error: parse 1');
  } catch (e) {
    if (e instanceof Exit2) return { code: 2, out: [e.line] };
    throw e;
  }
  const tree = new Tree();
  const fails: Fail[] = [];
  for (const edit of edits) {
    const before = new Map(tree.now);
    const movesBefore = tree.moves.length;
    try {
      edit(tree);
    } catch (e) {
      if (!(e instanceof Fail)) throw e;
      tree.now.clear();
      for (const [k, v] of before) tree.now.set(k, v);
      tree.moves.length = movesBefore;
      fails.push(e);
    }
  }
  if (fails.length > 0) {
    return { code: 1, out: [...fails.map((f) => `error: ${f.code} ${f.path}`), `failed: ${fails.length} of ${edits.length} edits`] };
  }
  const changed = new Map<string, { was: string | null; now: string | null }>();
  for (const p of tree.now.keys()) {
    const was = tree.original(p);
    const now = tree.now.get(p)!;
    if (was !== now) changed.set(p, { was, now });
  }
  const rows: Array<{ key: string; line: string }> = [];
  for (const [old, nw] of tree.moves) {
    const o = changed.get(old);
    const n = changed.get(nw);
    if (o !== undefined && o.was !== null && o.now === null && n !== undefined && n.was === null && n.now !== null) {
      rows.push({ key: nw, line: `R ${old} -> ${nw}` });
      changed.delete(old);
      changed.delete(nw);
    }
  }
  for (const [p, c] of changed) {
    rows.push({ key: p, line: `${c.was === null ? 'A' : c.now === null ? 'D' : 'M'} ${p}` });
  }
  rows.sort((a, b) => Buffer.compare(Buffer.from(a.key), Buffer.from(b.key)));
  const out = rows.map((r) => r.line);
  if (!check) {
    for (const p of [...tree.now.keys()].sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b)))) {
      const was = tree.original(p);
      const now = tree.now.get(p)!;
      if (was === now) continue;
      if (now === null) rmSync(p, { force: true });
      else {
        mkdirSync(dirname(p), { recursive: true });
        writeFileSync(p, now);
      }
    }
  }
  return { code: 0, out: [...out, `ok: ${out.length} ${out.length === 1 ? 'file' : 'files'}`] };
}

const trialEnv = process.env.MAKEFUN_ENV_URL;
if (trialEnv !== undefined && trialEnv !== '') {
  // A trial: the kit's runner reads the checks from the env and runs this file on each one, without this variable.
  const { runTrial } = await import('./runner.ts');
  await runTrial(trialEnv);
} else {
  const r = run(process.argv.slice(2));
  writeSync(1, r.out.map((l) => `${l}\n`).join(''));
  process.exitCode = r.code;
}
