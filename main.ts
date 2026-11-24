// mend: one patch tool for every AI edit format.
//
// mend applies an edit that an AI model wrote to a tree of text files. The
// edit arrives in one of four formats — a unified diff, SEARCH/REPLACE
// blocks, a V4A patch, or text-editor tool calls as JSON — and mend reads
// each of them as SPEC.md says: the whole patch is parsed before any file is
// looked at, the edits then apply in the patch's order to a virtual copy of
// the tree, and either every change is written (exit 0), or some edits failed
// and nothing is written (exit 1), or the invocation or the patch itself is
// unusable (exit 2, one error line). Lines an edit names are found at the
// first of three matching tiers: exact, trailing blanks ignored, then all
// surrounding blanks ignored; at the loosest tier the replacement is
// re-indented to the file's own indentation, and a context line is always
// written as the file's own line, never the patch's.
//
// Node 22, the standard library alone. Run as `node main.ts [options] [PATCH]`
// with the working directory as the root of the tree. In a trial the grader
// runs this file with MAKEFUN_ENV_URL set; the last lines then hand over to
// runner.ts, which drives this same CLI once per check.

import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync, writeSync } from 'node:fs';
import { dirname } from 'node:path';

/** An exit-2 failure: the single line to print, nothing written. */
class Exit2 {
  readonly line: string;
  constructor(line: string) {
    this.line = line;
  }
}

/** One edit failed: its code and the path the failure concerns. */
class Fail {
  readonly code: string;
  readonly path: string;
  constructor(code: string, path: string) {
    this.code = code;
    this.path = path;
  }
}

const parseError = (line: number): Exit2 => new Exit2(`error: parse ${line}`);

/* ------------------------------------------------------------------ */
/* Text helpers                                                        */
/* ------------------------------------------------------------------ */

/** A blank line is empty or only whitespace. */
const isBlank = (s: string): boolean => s.trim() === '';

/** Remove trailing spaces and tabs. */
const rstripBlanks = (s: string): string => s.replace(/[ \t]+$/, '');

/** Remove leading spaces and tabs. */
const lstripBlanks = (s: string): string => s.replace(/^[ \t]+/, '');

/** Remove leading and trailing spaces and tabs. */
const stripBlanks = (s: string): string => lstripBlanks(rstripBlanks(s));

/** The leading spaces and tabs of a line. */
const indentOf = (s: string): string => /^[ \t]*/.exec(s)![0];

/** Remove surrounding spaces (the path rules say spaces, and a tab cannot lead or trail after the tab cut). */
const trimSpaces = (s: string): string => s.replace(/^[ \t]+/, '').replace(/[ \t]+$/, '');

/** A patch's lines: its text split at \n, one trailing \r removed from each, no empty piece after a final \n. */
function patchLines(text: string): string[] {
  if (text === '') return [];
  const parts = text.split('\n');
  if (text.endsWith('\n')) parts.pop();
  return parts.map((l) => (l.endsWith('\r') ? l.slice(0, -1) : l));
}

/** A safe path: not empty, not absolute, no backslash, no empty, `.` or `..` segment. */
function isSafePath(p: string): boolean {
  if (p === '' || p.startsWith('/') || p.includes('\\')) return false;
  return p.split('/').every((seg) => seg !== '' && seg !== '.' && seg !== '..');
}

/** Byte order of paths (UTF-8), for the exit-0 listing. */
const byBytes = (a: string, b: string): number => Buffer.compare(Buffer.from(a, 'utf8'), Buffer.from(b, 'utf8'));

/* ------------------------------------------------------------------ */
/* Files as lines                                                      */
/* ------------------------------------------------------------------ */

/** A file held as its lines, its own line break, and whether it ends with one. */
interface FileModel {
  lines: string[];
  brk: string;
  finalBreak: boolean;
}

/** Split a file's text the way section 3 says: the break is CRLF when the first line feed follows a carriage return. */
function parseFileText(text: string): FileModel {
  let brk = '\n';
  const nl = text.indexOf('\n');
  if (nl > 0 && text[nl - 1] === '\r') brk = '\r\n';
  if (text === '') return { lines: [], brk, finalBreak: false };
  const parts = text.split(brk);
  let finalBreak = false;
  if (text.endsWith(brk)) {
    finalBreak = true;
    parts.pop();
  }
  return { lines: parts, brk, finalBreak };
}

/** Join a model back to text: a file of no lines is written empty. */
function serializeFile(m: FileModel): string {
  if (m.lines.length === 0) return '';
  return m.lines.join(m.brk) + (m.finalBreak ? m.brk : '');
}

/** A file an edit creates: LF breaks, ending with a line break unless the format says otherwise. */
function createdModel(lines: string[], finalBreak = true): FileModel {
  return { lines: [...lines], brk: '\n', finalBreak };
}

/* ------------------------------------------------------------------ */
/* The virtual tree                                                    */
/* ------------------------------------------------------------------ */

/**
 * The tree as the edits leave it. `now` holds the paths the patch has touched
 * (a string for present, null for deleted); anything else is read from disk
 * once and remembered, so the exit-0 listing can compare before and after.
 * Successful move edits are remembered for the `R` lines.
 */
class Tree {
  private readonly orig = new Map<string, string | null>();
  readonly now = new Map<string, string | null>();
  readonly moves: Array<{ from: string; to: string }> = [];

  /** The file's bytes before the patch, or null when it did not exist. */
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

  /** The file's bytes as the edits have left them, or null. */
  get(p: string): string | null {
    return this.now.has(p) ? this.now.get(p)! : this.original(p);
  }

  /** Throw the edit's `unsafe` failure when a path it names is not safe. */
  needSafe(p: string): void {
    if (!isSafePath(p)) throw new Fail('unsafe', p);
  }

  /** The current model of a file that must exist, or the edit's `missing` failure. */
  needFile(p: string): FileModel {
    const text = this.get(p);
    if (text === null) throw new Fail('missing', p);
    return parseFileText(text);
  }
}

/** One edit of a patch: apply it to the tree, or throw Fail. */
type Edit = (tree: Tree) => void;

/* ------------------------------------------------------------------ */
/* Matching lines (section 5)                                          */
/* ------------------------------------------------------------------ */

/** How a line is compared at a tier: 0 exact, 1 trailing blanks off, 2 all surrounding blanks off. */
const tierNorm = (tier: number): ((s: string) => string) =>
  tier === 0 ? (s) => s : tier === 1 ? rstripBlanks : stripBlanks;

/** Every start position where O matches the file's lines at one tier; occurrences may overlap. */
function matchPositions(lines: string[], old: string[], tier: number): number[] {
  const norm = tierNorm(tier);
  const want = old.map(norm);
  const found: number[] = [];
  for (let i = 0; i + old.length <= lines.length; i += 1) {
    let ok = true;
    for (let j = 0; j < old.length; j += 1) {
      if (norm(lines[i + j]!) !== want[j]) {
        ok = false;
        break;
      }
    }
    if (ok) found.push(i);
  }
  return found;
}

/** The first tier at which O occurs at least once, with every occurrence there, or null when it occurs nowhere. */
function findOccurrences(lines: string[], old: string[], strict: boolean): { tier: number; positions: number[] } | null {
  for (const tier of strict ? [0] : [0, 1, 2]) {
    const positions = matchPositions(lines, old, tier);
    if (positions.length > 0) return { tier, positions };
  }
  return null;
}

/** One line of a replacement: a context line (ctx: its index in O) or a new line (ctx: null). */
interface NewLine {
  text: string;
  ctx: number | null;
}

/**
 * The lines to write in place of the matched ones: a context line is written
 * as the file's own matched line, and at tier 2 every other line is
 * re-indented — the old block's first-line indent P is replaced by the file's
 * first matched line's indent F, on lines that are not blank and start with P.
 */
function buildWritten(lines: string[], pos: number, old: string[], news: NewLine[], tier: number): string[] {
  const fileIndent = tier === 2 ? indentOf(lines[pos]!) : '';
  const patchIndent = tier === 2 ? indentOf(old[0]!) : '';
  return news.map((e) => {
    if (e.ctx !== null) return lines[pos + e.ctx]!;
    if (tier !== 2) return e.text;
    if (e.text.trim() === '') return e.text;
    return e.text.startsWith(patchIndent) ? fileIndent + e.text.slice(patchIndent.length) : e.text;
  });
}

/* ------------------------------------------------------------------ */
/* Format detection (section 4)                                        */
/* ------------------------------------------------------------------ */

/** The format `--format=auto` sees, the first of the section's tests that holds, or null. */
function detectFormat(lines: string[]): string | null {
  const first = lines.findIndex((l) => !isBlank(l));
  if (first < 0) return null;
  if (lines[first]!.trim() === '*** Begin Patch') return 'v4a';
  const c = lines[first]!.trimStart()[0];
  if (c === '[' || c === '{') return 'json';
  if (lines.some((l) => l.trimEnd() === '<<<<<<< SEARCH')) return 'search-replace';
  const unified = lines.some(
    (l, i) => l.startsWith('diff --git ') || (l.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')),
  );
  return unified ? 'unified' : null;
}

/* ------------------------------------------------------------------ */
/* JSON edits (section 9)                                              */
/* ------------------------------------------------------------------ */

/** One JSON edit object as an Edit, or null when it is not a valid edit object. */
function jsonEdit(v: unknown): Edit | null {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return null;
  const o = v as Record<string, unknown>;
  const p = o.path;
  if (typeof p !== 'string') return null;

  if (o.command === 'create') {
    if (typeof o.file_text !== 'string') return null;
    const text = o.file_text;
    return (tree) => {
      tree.needSafe(p);
      if (tree.get(p) !== null) throw new Fail('exists', p);
      tree.now.set(p, text); // written byte for byte
    };
  }

  if (o.command === 'str_replace') {
    if (typeof o.old_str !== 'string' || o.old_str === '') return null;
    if (o.new_str !== undefined && typeof o.new_str !== 'string') return null;
    const oldStr = o.old_str;
    const newStr = (o.new_str as string | undefined) ?? '';
    return (tree) => {
      tree.needSafe(p);
      const before = tree.get(p);
      if (before === null) throw new Fail('missing', p);
      // In a CRLF file the text and both strings are read with every \r\n as
      // \n, and the result is written back with \r\n. The match is exact.
      const nl = before.indexOf('\n');
      const crlf = nl > 0 && before[nl - 1] === '\r';
      const toLf = (s: string): string => (crlf ? s.replaceAll('\r\n', '\n') : s);
      const text = toLf(before);
      const old = toLf(oldStr);
      let count = 0;
      for (let k = text.indexOf(old); k >= 0; k = text.indexOf(old, k + 1)) count += 1;
      if (count === 0) throw new Fail('no-match', p);
      if (count > 1) throw new Fail('ambiguous', p);
      const at = text.indexOf(old);
      const out = text.slice(0, at) + toLf(newStr) + text.slice(at + old.length);
      tree.now.set(p, crlf ? out.replaceAll('\n', '\r\n') : out);
    };
  }

  if (o.command === 'insert') {
    if (typeof o.insert_line !== 'number' || !Number.isInteger(o.insert_line)) return null;
    if (typeof o.new_str !== 'string') return null;
    const at = o.insert_line;
    const added = patchLines(o.new_str);
    return (tree) => {
      tree.needSafe(p);
      const model = tree.needFile(p);
      if (at < 0 || at > model.lines.length) throw new Fail('no-match', p);
      model.lines.splice(at, 0, ...added); // after line `at`; 0 is the top; the final break stays as it was
      tree.now.set(p, serializeFile(model));
    };
  }

  return null;
}

/** Read the patch as JSON: one array of edit objects, or JSON Lines, one object a line. */
function parseJsonEdits(text: string, lines: string[]): Edit[] {
  const first = lines.findIndex((l) => !isBlank(l));
  if (first < 0) throw parseError(1);
  const edits: Edit[] = [];
  if (lines[first]!.trimStart().startsWith('[')) {
    let value: unknown;
    try {
      value = JSON.parse(text);
    } catch {
      throw parseError(first + 1);
    }
    if (!Array.isArray(value)) throw parseError(first + 1);
    for (const item of value) {
      const e = jsonEdit(item);
      if (e === null) throw parseError(first + 1); // in array form any fault is the array's line
      edits.push(e);
    }
    return edits;
  }
  lines.forEach((line, i) => {
    if (isBlank(line)) return;
    let e: Edit | null = null;
    try {
      e = jsonEdit(JSON.parse(line));
    } catch {
      e = null;
    }
    if (e === null) throw parseError(i + 1);
    edits.push(e);
  });
  return edits;
}

/* ------------------------------------------------------------------ */
/* Hunk bodies (sections 6 and 8 share the shape)                      */
/* ------------------------------------------------------------------ */

/** A parsed hunk or chunk body: its old lines O, its replacement lines N, and the `\` flags. */
interface HunkBody {
  old: string[];
  news: NewLine[];
  /** A `\` line follows the body's last context or `+` line. */
  lastNewNoEol: boolean;
  /** The `+` lines in order, each with whether a `\` line follows it. */
  plusLines: Array<{ text: string; noEol: boolean }>;
}

/**
 * Read body lines (each starting with ` `, `-` or `+`, or empty for an empty
 * context line) into O and N. A `\` line refers to the body line before it.
 */
function buildBody(raws: string[]): HunkBody {
  const old: string[] = [];
  const news: NewLine[] = [];
  const noEol: boolean[] = [];
  const plusLines: Array<{ text: string; noEol: boolean }> = [];
  let prevNews = -1;
  let prevPlus = -1;
  for (const raw of raws) {
    if (raw.startsWith('\\')) {
      if (prevNews >= 0) noEol[prevNews] = true;
      if (prevPlus >= 0) plusLines[prevPlus]!.noEol = true;
      continue;
    }
    if (raw.startsWith('-')) {
      old.push(raw.slice(1));
      prevNews = -1;
      prevPlus = -1;
    } else if (raw.startsWith('+')) {
      const text = raw.slice(1);
      news.push({ text, ctx: null });
      noEol.push(false);
      plusLines.push({ text, noEol: false });
      prevNews = news.length - 1;
      prevPlus = plusLines.length - 1;
    } else {
      const text = raw === '' ? '' : raw.slice(1);
      old.push(text);
      news.push({ text, ctx: old.length - 1 });
      noEol.push(false);
      prevNews = news.length - 1;
      prevPlus = -1;
    }
  }
  return { old, news, lastNewNoEol: news.length > 0 ? noEol[news.length - 1]! : false, plusLines };
}

interface Hunk {
  /** The A of the `@@ -A[,B] +C[,D] @@` header. */
  a: number;
  body: HunkBody;
}

/**
 * Apply one section's hunks in order, each to the result of the ones before
 * it. d is the running sum of (N's length − O's length) over the hunks
 * applied so far: a hunk with old lines takes the occurrence nearest to
 * A − 1 + d, and one without inserts after the first A + d lines. When a
 * hunk's matched lines run to the end of the file, the result ends with a
 * line break unless a `\` line follows the hunk's last context or `+` line;
 * otherwise the file's final break stays as it was.
 */
function applyHunks(model: FileModel, hunks: Hunk[], strict: boolean, path: string): void {
  let d = 0;
  for (const h of hunks) {
    const { old, news } = h.body;
    if (old.length === 0) {
      if (news.length === 0) continue;
      const pos = Math.max(0, Math.min(h.a + d, model.lines.length));
      const atEnd = pos === model.lines.length;
      model.lines.splice(pos, 0, ...news.map((e) => e.text));
      if (atEnd) model.finalBreak = !h.body.lastNewNoEol;
      d += news.length;
      continue;
    }
    const occ = findOccurrences(model.lines, old, strict);
    if (occ === null) throw new Fail('no-match', path);
    const target = h.a - 1 + d;
    let pos = occ.positions[0]!;
    for (const p of occ.positions) {
      if (Math.abs(p - target) < Math.abs(pos - target)) pos = p; // ascending: a tie keeps the earlier
    }
    const reachesEnd = pos + old.length === model.lines.length;
    const written = buildWritten(model.lines, pos, old, news, occ.tier);
    model.lines.splice(pos, old.length, ...written);
    if (reachesEnd) model.finalBreak = !h.body.lastNewNoEol;
    d += news.length - old.length;
  }
}

/* ------------------------------------------------------------------ */
/* Unified diffs (section 6)                                           */
/* ------------------------------------------------------------------ */

interface Section {
  gitOld: string | null;
  gitNew: string | null;
  hdrOld: string | null;
  hdrNew: string | null;
  renFrom: string | null;
  renTo: string | null;
  isNew: boolean;
  isDel: boolean;
  hunks: Hunk[];
}

/** The path a `--- ` or `+++ ` line names: after the four characters, up to the first tab, spaces removed, prefix removed. */
function headerPath(line: string): string {
  let t = line.slice(4);
  const tab = t.indexOf('\t');
  if (tab >= 0) t = t.slice(0, tab);
  t = trimSpaces(t);
  if (t.startsWith('a/') || t.startsWith('b/')) t = t.slice(2);
  return t;
}

/** The section one parsed section describes, as an Edit. */
function sectionEdit(sec: Section, strict: boolean): Edit {
  const oldPath = sec.hdrOld ?? sec.renFrom ?? sec.gitOld;
  const newPath = sec.hdrNew ?? sec.renTo ?? sec.gitNew;
  if (sec.isNew || sec.hdrOld === '/dev/null') {
    // a creation: the file is the `+` lines of all its hunks, in order
    return (tree) => {
      if (newPath === null) throw new Fail('exists', '');
      tree.needSafe(newPath);
      if (tree.get(newPath) !== null) throw new Fail('exists', newPath);
      const texts: string[] = [];
      let lastNoEol = false;
      for (const h of sec.hunks) {
        for (const pl of h.body.plusLines) {
          texts.push(pl.text);
          lastNoEol = pl.noEol;
        }
      }
      tree.now.set(newPath, serializeFile(createdModel(texts, !lastNoEol)));
    };
  }
  if (sec.isDel || sec.hdrNew === '/dev/null') {
    // a deletion: the file is deleted, and its hunks are not read
    return (tree) => {
      if (oldPath === null) throw new Fail('missing', '');
      tree.needSafe(oldPath);
      if (tree.get(oldPath) === null) throw new Fail('missing', oldPath);
      tree.now.set(oldPath, null);
    };
  }
  if (oldPath !== null && newPath !== null && oldPath !== newPath) {
    // a move: the hunks apply to the old file, the result is written at the new path
    return (tree) => {
      tree.needSafe(oldPath);
      tree.needSafe(newPath);
      const model = tree.needFile(oldPath);
      if (tree.get(newPath) !== null) throw new Fail('exists', newPath);
      applyHunks(model, sec.hunks, strict, oldPath);
      tree.now.set(newPath, serializeFile(model));
      tree.now.set(oldPath, null);
      tree.moves.push({ from: oldPath, to: newPath });
    };
  }
  const path = oldPath ?? newPath;
  return (tree) => {
    if (path === null) throw new Fail('missing', '');
    tree.needSafe(path);
    const model = tree.needFile(path);
    applyHunks(model, sec.hunks, strict, path);
    tree.now.set(path, serializeFile(model));
  };
}

/** Read the patch as a unified diff: sections, their headers and their hunks. */
function parseUnified(lines: string[], strict: boolean): Edit[] {
  const sections: Section[] = [];
  let sec: Section | null = null;
  const fresh = (): Section => ({
    gitOld: null, gitNew: null, hdrOld: null, hdrNew: null,
    renFrom: null, renTo: null, isNew: false, isDel: false, hunks: [],
  });
  let i = 0;
  const n = lines.length;
  while (i < n) {
    const line = lines[i]!;
    if (line.startsWith('diff --git ')) {
      const m = /^a\/(.+?) b\/(.+)$/.exec(line.slice('diff --git '.length).trimEnd());
      if (m === null) throw parseError(i + 1); // a diff --git line not of the form `diff --git a/<X> b/<Y>`
      sec = fresh();
      sec.gitOld = m[1]!;
      sec.gitNew = m[2]!;
      sections.push(sec);
      i += 1;
      continue;
    }
    if (line.startsWith('--- ')) {
      const followed = i + 1 < n && lines[i + 1]!.startsWith('+++ ');
      if (!followed) {
        // inside a section's header that is a parse error at the line after it; anywhere else it is prose
        if (sec !== null && sec.hunks.length === 0) throw parseError(i + 2);
        i += 1;
        continue;
      }
      if (sec === null || sec.hdrOld !== null || sec.hunks.length > 0) {
        sec = fresh();
        sections.push(sec);
      }
      sec.hdrOld = headerPath(line);
      sec.hdrNew = headerPath(lines[i + 1]!);
      i += 2;
      continue;
    }
    if (line.startsWith('@@')) {
      if (sec === null) throw parseError(i + 1); // a hunk before any section
      const m = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(line);
      if (m === null) throw parseError(i + 1);
      const raws: string[] = [];
      let j = i + 1;
      while (j < n) {
        const b = lines[j]!;
        if (b.startsWith('diff --git ')) break;
        if (b.startsWith('--- ') && j + 1 < n && lines[j + 1]!.startsWith('+++ ')) break;
        if (b === '' || b[0] === ' ' || b[0] === '-' || b[0] === '+' || b[0] === '\\') {
          raws.push(b);
          j += 1;
          continue;
        }
        break;
      }
      while (raws.length > 0 && raws[raws.length - 1] === '') raws.pop(); // empty lines at the end of a body are not part of it
      sec.hunks.push({ a: Number(m[1]), body: buildBody(raws) });
      i = j;
      continue;
    }
    if (sec !== null && sec.hunks.length === 0) {
      // a header line of the current section; everything unlisted is ignored
      if (line.startsWith('+++ ')) {
        if (sec.hdrNew === null) sec.hdrNew = headerPath(line);
      } else if (line.startsWith('rename from ')) {
        sec.renFrom = trimSpaces(line.slice('rename from '.length));
      } else if (line.startsWith('rename to ')) {
        sec.renTo = trimSpaces(line.slice('rename to '.length));
      } else if (line.startsWith('new file mode')) {
        sec.isNew = true;
      } else if (line.startsWith('deleted file mode')) {
        sec.isDel = true;
      }
    }
    i += 1;
  }
  if (sections.length === 0) throw parseError(1);
  return sections.map((s) => sectionEdit(s, strict));
}

/* ------------------------------------------------------------------ */
/* SEARCH/REPLACE blocks (section 7)                                   */
/* ------------------------------------------------------------------ */

function searchReplaceEdit(path: string, oldLines: string[], newLines: string[], strict: boolean): Edit {
  return (tree) => {
    tree.needSafe(path);
    if (oldLines.length === 0) {
      // an empty old side creates the file with the new lines
      if (tree.get(path) !== null) throw new Fail('exists', path);
      tree.now.set(path, serializeFile(createdModel(newLines)));
      return;
    }
    const model = tree.needFile(path);
    const occ = findOccurrences(model.lines, oldLines, strict);
    if (occ === null) throw new Fail('no-match', path);
    if (occ.positions.length > 1) throw new Fail('ambiguous', path);
    const pos = occ.positions[0]!;
    const news: NewLine[] = newLines.map((t) => ({ text: t, ctx: null }));
    const written = buildWritten(model.lines, pos, oldLines, news, occ.tier);
    model.lines.splice(pos, oldLines.length, ...written);
    tree.now.set(path, serializeFile(model));
  };
}

/** Read the patch as SEARCH/REPLACE blocks; lines outside blocks are ignored. */
function parseSearchReplace(lines: string[], strict: boolean): Edit[] {
  const edits: Edit[] = [];
  let prevPath: string | null = null;
  let regionStart = 0; // the path line is searched after the previous block's REPLACE line
  let i = 0;
  const n = lines.length;
  while (i < n) {
    if (lines[i]!.trimEnd() !== '<<<<<<< SEARCH') {
      i += 1;
      continue;
    }
    const searchLine = i;
    let path: string | null = null;
    for (let k = searchLine - 1; k >= regionStart; k -= 1) {
      const t = lines[k]!.trim();
      if (t !== '' && !t.startsWith('```')) {
        path = t;
        break;
      }
    }
    if (path === null) {
      if (prevPath === null) throw parseError(searchLine + 1);
      path = prevPath; // a block with no path line of its own takes the previous block's path
    }
    let eq = -1;
    for (let k = searchLine + 1; k < n; k += 1) {
      if (lines[k]!.trimEnd() === '=======') {
        eq = k;
        break;
      }
    }
    if (eq < 0) throw parseError(searchLine + 1);
    let rep = -1;
    for (let k = eq + 1; k < n; k += 1) {
      if (lines[k]!.trimEnd() === '>>>>>>> REPLACE') {
        rep = k;
        break;
      }
    }
    if (rep < 0) throw parseError(searchLine + 1);
    edits.push(searchReplaceEdit(path, lines.slice(searchLine + 1, eq), lines.slice(eq + 1, rep), strict));
    prevPath = path;
    regionStart = rep + 1;
    i = rep + 1;
  }
  if (edits.length === 0) throw parseError(1);
  return edits;
}

/* ------------------------------------------------------------------ */
/* V4A patches (section 8)                                             */
/* ------------------------------------------------------------------ */

interface V4aChunk {
  anchor: string | null;
  eof: boolean;
  body: HunkBody;
}

const isV4aSectionStart = (l: string): boolean =>
  l.startsWith('*** Add File: ') || l.startsWith('*** Delete File: ') || l.startsWith('*** Update File: ');

const isEofLine = (l: string): boolean => l.trimEnd() === '*** End of File';

/** The first line at or after the cursor equal to the anchor, at the first tier where one is, or -1. */
function findAnchor(lines: string[], anchor: string, cursor: number, strict: boolean): number {
  for (const tier of strict ? [0] : [0, 1, 2]) {
    const norm = tierNorm(tier);
    const want = norm(anchor);
    for (let i = cursor; i < lines.length; i += 1) {
      if (norm(lines[i]!) === want) return i;
    }
  }
  return -1;
}

/** The first occurrence of O at or after the cursor, at the first tier with one; an end-of-file chunk takes only one ending at the last line. */
function findChunkOccurrence(
  lines: string[],
  old: string[],
  cursor: number,
  strict: boolean,
  eof: boolean,
): { tier: number; pos: number } | null {
  for (const tier of strict ? [0] : [0, 1, 2]) {
    const positions = matchPositions(lines, old, tier).filter(
      (p) => p >= cursor && (!eof || p + old.length === lines.length),
    );
    if (positions.length > 0) return { tier, pos: positions[0]! };
  }
  return null;
}

function v4aUpdateEdit(path: string, moveTo: string | null, chunks: V4aChunk[], strict: boolean): Edit {
  return (tree) => {
    tree.needSafe(path);
    if (moveTo !== null) tree.needSafe(moveTo);
    const model = tree.needFile(path);
    if (moveTo !== null && tree.get(moveTo) !== null) throw new Fail('exists', moveTo);
    let cursor = 0;
    for (const chunk of chunks) {
      if (chunk.anchor !== null) {
        const at = findAnchor(model.lines, chunk.anchor, cursor, strict);
        if (at < 0) throw new Fail('no-match', path);
        cursor = at + 1; // the cursor moves past the anchor line
      }
      const { old, news } = chunk.body;
      if (old.length === 0) {
        const pos = chunk.eof ? model.lines.length : Math.min(cursor, model.lines.length);
        model.lines.splice(pos, 0, ...news.map((e) => e.text));
        cursor = pos + news.length;
        continue;
      }
      const occ = findChunkOccurrence(model.lines, old, cursor, strict, chunk.eof);
      if (occ === null) throw new Fail('no-match', path);
      const written = buildWritten(model.lines, occ.pos, old, news, occ.tier);
      model.lines.splice(occ.pos, old.length, ...written);
      cursor = occ.pos + written.length; // just after the lines written
    }
    if (moveTo !== null) {
      tree.now.set(moveTo, serializeFile(model));
      tree.now.set(path, null);
      tree.moves.push({ from: path, to: moveTo });
    } else {
      tree.now.set(path, serializeFile(model));
    }
  };
}

/** Read the patch as a V4A patch, section by section between Begin Patch and End Patch. */
function parseV4a(lines: string[], strict: boolean): Edit[] {
  const n = lines.length;
  const first = lines.findIndex((l) => !isBlank(l));
  if (first < 0) throw parseError(1);
  if (lines[first]!.trim() !== '*** Begin Patch') throw parseError(first + 1);
  let last = -1;
  for (let k = n - 1; k >= 0; k -= 1) {
    if (!isBlank(lines[k]!)) {
      last = k;
      break;
    }
  }
  if (lines[last]!.trim() !== '*** End Patch') throw parseError(n + 1);
  const edits: Edit[] = [];
  let i = first + 1;
  while (i < last) {
    const line = lines[i]!;
    if (isBlank(line)) {
      i += 1;
      continue;
    }
    if (line.startsWith('*** Add File: ')) {
      const path = trimSpaces(line.slice('*** Add File: '.length));
      i += 1;
      const content: string[] = [];
      while (i < last) {
        const l = lines[i]!;
        if (isV4aSectionStart(l)) break;
        if (l.startsWith('+')) {
          content.push(l.slice(1));
          i += 1;
          continue;
        }
        if (l === '') {
          content.push('');
          i += 1;
          continue;
        }
        throw parseError(i + 1);
      }
      while (content.length > 0 && content[content.length - 1] === '') content.pop(); // blank lines at a section's end are not part of it
      edits.push((tree) => {
        tree.needSafe(path);
        if (tree.get(path) !== null) throw new Fail('exists', path);
        tree.now.set(path, serializeFile(createdModel(content))); // an Add File's lines are ended by a line break
      });
      continue;
    }
    if (line.startsWith('*** Delete File: ')) {
      const path = trimSpaces(line.slice('*** Delete File: '.length));
      edits.push((tree) => {
        tree.needSafe(path);
        if (tree.get(path) === null) throw new Fail('missing', path);
        tree.now.set(path, null);
      });
      i += 1;
      continue;
    }
    if (line.startsWith('*** Update File: ')) {
      const startLine = i + 1;
      const path = trimSpaces(line.slice('*** Update File: '.length));
      i += 1;
      let moveTo: string | null = null;
      if (i < last && lines[i]!.startsWith('*** Move to: ')) {
        moveTo = trimSpaces(lines[i]!.slice('*** Move to: '.length));
        i += 1;
      }
      const chunks: V4aChunk[] = [];
      for (;;) {
        if (i >= last || isV4aSectionStart(lines[i]!)) break;
        if (isEofLine(lines[i]!)) throw parseError(i + 1); // End of File ends a chunk; here there is none open
        let anchor: string | null = null;
        if (lines[i]!.startsWith('@@')) {
          const t = trimSpaces(lines[i]!.slice(2));
          anchor = t === '' ? null : t;
          i += 1;
        } else if (chunks.length > 0) {
          throw parseError(i + 1); // only the first chunk may start at a body line
        }
        const raws: string[] = [];
        while (i < last) {
          const b = lines[i]!;
          if (b === '' || b[0] === ' ' || b[0] === '-' || b[0] === '+') {
            raws.push(b);
            i += 1;
            continue;
          }
          break;
        }
        let eof = false;
        if (i < last && isEofLine(lines[i]!)) {
          eof = true;
          i += 1;
        } else if (i >= last || isV4aSectionStart(lines[i]!)) {
          // blank lines at the end of a section are not part of it: an empty
          // line, or a context line whose text is empty
          while (raws.length > 0 && (raws[raws.length - 1] === '' || raws[raws.length - 1] === ' ')) raws.pop();
        }
        chunks.push({ anchor, eof, body: buildBody(raws) });
      }
      if (chunks.length === 0 && moveTo === null) throw parseError(startLine);
      edits.push(v4aUpdateEdit(path, moveTo, chunks, strict));
      continue;
    }
    throw parseError(i + 1);
  }
  if (edits.length === 0) throw parseError(1);
  return edits;
}

/* ------------------------------------------------------------------ */
/* The command line (sections 1, 2 and 10)                             */
/* ------------------------------------------------------------------ */

const FORMAT_NAMES = ['auto', 'unified', 'search-replace', 'v4a', 'json'];

function run(args: string[]): { code: number; out: string[] } {
  let format: string | null = null;
  let checkOnly = false;
  let strict = false;
  const positional: string[] = [];
  let optionsEnded = false;
  for (const a of args) {
    if (!optionsEnded && a === '--') {
      optionsEnded = true;
      continue;
    }
    if (!optionsEnded && a.startsWith('-') && a !== '-') {
      if (a.startsWith('--format=') && format === null && FORMAT_NAMES.includes(a.slice('--format='.length))) {
        format = a.slice('--format='.length);
      } else if (a === '--check' && !checkOnly) {
        checkOnly = true;
      } else if (a === '--strict' && !strict) {
        strict = true;
      } else {
        return { code: 2, out: ['error: usage'] };
      }
      continue;
    }
    positional.push(a);
  }
  if (positional.length > 1) return { code: 2, out: ['error: usage'] };
  const patchArg = positional.length === 0 || positional[0] === '-' ? null : positional[0]!;
  let text: string;
  if (patchArg === null) {
    try {
      text = readFileSync(0, 'utf8');
    } catch {
      text = '';
    }
  } else {
    try {
      text = readFileSync(patchArg, 'utf8');
    } catch {
      return { code: 2, out: ['error: no-patch'] };
    }
  }
  const lines = patchLines(text);
  const kind = format === null || format === 'auto' ? detectFormat(lines) : format;
  if (kind === null) return { code: 2, out: ['error: format'] };
  let edits: Edit[];
  try {
    if (kind === 'json') edits = parseJsonEdits(text, lines);
    else if (kind === 'unified') edits = parseUnified(lines, strict);
    else if (kind === 'search-replace') edits = parseSearchReplace(lines, strict);
    else edits = parseV4a(lines, strict);
  } catch (e) {
    if (e instanceof Exit2) return { code: 2, out: [e.line] };
    throw e;
  }
  // Edits apply in the patch's order; a failed edit changes nothing, and the
  // edits after it still run, so every failure is reported.
  const tree = new Tree();
  const fails: Fail[] = [];
  for (const edit of edits) {
    const snapshot = new Map(tree.now);
    const moveCount = tree.moves.length;
    try {
      edit(tree);
    } catch (e) {
      if (!(e instanceof Fail)) throw e;
      tree.now.clear();
      for (const [k, v] of snapshot) tree.now.set(k, v);
      tree.moves.length = moveCount;
      fails.push(e);
    }
  }
  if (fails.length > 0) {
    return {
      code: 1,
      out: [...fails.map((f) => `error: ${f.code} ${f.path}`), `failed: ${fails.length} of ${edits.length} edits`],
    };
  }
  // Exit 0: one line per path whose state changed, in byte order; a move
  // edit's pair is one `R` line, sorting by the new path.
  const consumed = new Set<string>();
  const rows: Array<{ key: string; line: string }> = [];
  for (const mv of tree.moves) {
    if (consumed.has(mv.from) || consumed.has(mv.to)) continue;
    if (
      tree.original(mv.from) !== null &&
      tree.get(mv.from) === null &&
      tree.original(mv.to) === null &&
      tree.get(mv.to) !== null
    ) {
      rows.push({ key: mv.to, line: `R ${mv.from} -> ${mv.to}` });
      consumed.add(mv.from);
      consumed.add(mv.to);
    }
  }
  for (const p of tree.now.keys()) {
    if (consumed.has(p)) continue;
    const was = tree.original(p);
    const now = tree.now.get(p)!;
    if (was === now) continue;
    rows.push({ key: p, line: `${was === null ? 'A' : now === null ? 'D' : 'M'} ${p}` });
  }
  rows.sort((x, y) => byBytes(x.key, y.key));
  if (!checkOnly) {
    for (const p of [...tree.now.keys()].sort(byBytes)) {
      const was = tree.original(p);
      const now = tree.now.get(p)!;
      if (was === now) continue;
      if (now === null) {
        rmSync(p, { force: true });
      } else {
        mkdirSync(dirname(p), { recursive: true });
        writeFileSync(p, now);
      }
    }
  }
  return { code: 0, out: [...rows.map((r) => r.line), `ok: ${rows.length} ${rows.length === 1 ? 'file' : 'files'}`] };
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



