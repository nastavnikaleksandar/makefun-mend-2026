// main.ts is mend, the CLI SPEC.md specifies (MIT). Node 22, standard library only: `node main.ts [options] [PATCH]`.
// Implements sections 1–10: CLI, output, paths, format detection, tier matching, unified / SEARCH-REPLACE / V4A / JSON,
// and all-or-nothing writes. Trial hand-over to runner.ts (last lines) is unchanged.

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

function leadingWs(s: string): string {
  let i = 0;
  while (i < s.length && (s[i] === ' ' || s[i] === '\t')) i += 1;
  return s.slice(0, i);
}

function trimEndWs(s: string): string {
  let i = s.length;
  while (i > 0 && (s[i - 1] === ' ' || s[i - 1] === '\t')) i -= 1;
  return s.slice(0, i);
}

function trimBothWs(s: string): string {
  return trimEndWs(s.slice(leadingWs(s).length));
}

function normLine(s: string, tier: number): string {
  if (tier === 0) return s;
  if (tier === 1) return trimEndWs(s);
  return trimBothWs(s);
}

/** Split a file's text into lines and its line-break style (SPEC.md §3). */
function splitFile(text: string): { lines: string[]; br: string; final: boolean } {
  if (text === '') return { lines: [], br: '\n', final: false };
  const nl = text.indexOf('\n');
  const br = nl > 0 && text[nl - 1] === '\r' ? '\r\n' : '\n';
  const parts = text.split(br);
  const final = text.endsWith(br);
  if (final) parts.pop();
  return { lines: parts, br, final };
}

function joinFile(lines: string[], br: string, final: boolean): string {
  if (lines.length === 0) return '';
  return lines.join(br) + (final ? br : '');
}

function findOccurrences(file: string[], O: string[], tier: number): number[] {
  if (O.length === 0) return [];
  const want = O.map((l) => normLine(l, tier));
  const out: number[] = [];
  for (let i = 0; i <= file.length - O.length; i += 1) {
    let ok = true;
    for (let j = 0; j < O.length; j += 1) {
      if (normLine(file[i + j]!, tier) !== want[j]) {
        ok = false;
        break;
      }
    }
    if (ok) out.push(i);
  }
  return out;
}

function findTier(file: string[], O: string[], strict: boolean): { tier: number; positions: number[] } | null {
  const max = strict ? 0 : 2;
  for (let t = 0; t <= max; t += 1) {
    const positions = findOccurrences(file, O, t);
    if (positions.length > 0) return { tier: t, positions };
  }
  return null;
}

function findAnchor(file: string[], anchor: string, from: number, strict: boolean): number {
  const max = strict ? 0 : 2;
  for (let t = 0; t <= max; t += 1) {
    const want = normLine(anchor, t);
    for (let i = from; i < file.length; i += 1) {
      if (normLine(file[i]!, t) === want) return i;
    }
  }
  return -1;
}

function reindentLine(text: string, P: string, F: string, tier: number): string {
  if (tier !== 2) return text;
  if (text.trim() === '') return text;
  if (text.startsWith(P)) return F + text.slice(P.length);
  return text;
}

type NPart = { kind: 'ctx'; oOff: number } | { kind: 'add'; text: string };

function materializeN(file: string[], start: number, O: string[], parts: NPart[], tier: number): string[] {
  const F = O.length > 0 ? leadingWs(file[start]!) : '';
  const P = O.length > 0 ? leadingWs(O[0]!) : '';
  return parts.map((p) => {
    if (p.kind === 'ctx') return file[start + p.oOff]!;
    return reindentLine(p.text, P, F, tier);
  });
}

function reindentAll(N: string[], O: string[], file: string[], start: number, tier: number): string[] {
  const F = leadingWs(file[start]!);
  const P = leadingWs(O[0]!);
  return N.map((t) => reindentLine(t, P, F, tier));
}

/** The tree as the edits leave it: changed paths in `now` (null: deleted), the rest read from disk. */
class Tree {
  private readonly orig = new Map<string, string | null>();
  readonly now = new Map<string, string | null>();
  /** Successful move edits: old path → new path (patch order). */
  readonly moves: { from: string; to: string }[] = [];
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
  if (lines.some((l, i) => l.startsWith('diff --git ') || (l.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')))) {
    return 'unified';
  }
  return null;
}

function stripAb(p: string): string {
  if (p.startsWith('a/') || p.startsWith('b/')) return p.slice(2);
  return p;
}

function parseUnifiedPath(raw: string): string {
  const tab = raw.indexOf('\t');
  const s = (tab < 0 ? raw : raw.slice(0, tab)).trim();
  return s === '/dev/null' ? '/dev/null' : stripAb(s);
}

type HunkBodyLine =
  | { kind: 'ctx' | 'old' | 'new'; text: string }
  | { kind: 'meta' };

interface UnifiedHunk {
  a: number;
  body: HunkBodyLine[];
  /** True when a `\` line follows the hunk's last context or `+` line. */
  noNlAfterLastNew: boolean;
}

interface UnifiedSection {
  gitOld: string | null;
  gitNew: string | null;
  headerOld: string | null;
  headerNew: string | null;
  renameOld: string | null;
  renameNew: string | null;
  create: boolean;
  del: boolean;
  hunks: UnifiedHunk[];
}

function parseHunkHeader(line: string): { a: number } | null {
  const m = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line);
  if (!m) return null;
  return { a: Number(m[1]) };
}

function isHunkBodyLine(line: string): boolean {
  return line === '' || line.startsWith(' ') || line.startsWith('-') || line.startsWith('+') || line.startsWith('\\');
}

function parseUnifiedHunkBody(lines: string[], start: number): { body: HunkBodyLine[]; noNl: boolean; next: number } {
  const body: HunkBodyLine[] = [];
  let i = start;
  while (i < lines.length) {
    const line = lines[i]!;
    if (line.startsWith('diff --git ')) break;
    if (line.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')) break;
    if (!isHunkBodyLine(line)) break;
    if (line.startsWith('\\')) body.push({ kind: 'meta' });
    else if (line.startsWith('-')) body.push({ kind: 'old', text: line.slice(1) });
    else if (line.startsWith('+')) body.push({ kind: 'new', text: line.slice(1) });
    else body.push({ kind: 'ctx', text: line === '' ? '' : line.slice(1) });
    i += 1;
  }
  while (body.length > 0) {
    const last = body[body.length - 1]!;
    if (last.kind === 'ctx' && last.text === '') body.pop();
    else break;
  }
  let noNl = false;
  let lastNewOrCtx = -1;
  for (let j = 0; j < body.length; j += 1) {
    const b = body[j]!;
    if (b.kind === 'ctx' || b.kind === 'new') lastNewOrCtx = j;
  }
  if (lastNewOrCtx >= 0 && lastNewOrCtx + 1 < body.length && body[lastNewOrCtx + 1]!.kind === 'meta') noNl = true;
  return { body, noNl, next: i };
}

function resolveUnifiedPaths(sec: UnifiedSection): { oldPath: string; newPath: string } {
  let oldPath: string | null = null;
  let newPath: string | null = null;
  if (sec.headerOld !== null || sec.headerNew !== null) {
    oldPath = sec.headerOld;
    newPath = sec.headerNew;
  } else if (sec.renameOld !== null || sec.renameNew !== null) {
    oldPath = sec.renameOld;
    newPath = sec.renameNew;
  } else {
    oldPath = sec.gitOld;
    newPath = sec.gitNew;
  }
  return { oldPath: oldPath ?? '/dev/null', newPath: newPath ?? '/dev/null' };
}

function unifiedEdits(lines: string[], strict: boolean): Edit[] {
  const sections: UnifiedSection[] = [];
  let i = 0;
  let cur: UnifiedSection | null = null;
  let inHeader = false;

  const startSection = (): UnifiedSection => {
    const s: UnifiedSection = {
      gitOld: null,
      gitNew: null,
      headerOld: null,
      headerNew: null,
      renameOld: null,
      renameNew: null,
      create: false,
      del: false,
      hunks: [],
    };
    sections.push(s);
    cur = s;
    inHeader = true;
    return s;
  };

  while (i < lines.length) {
    const line = lines[i]!;

    if (line.startsWith('diff --git ')) {
      const m = /^diff --git a\/(.*) b\/(.*)$/.exec(line);
      if (!m) throw new Exit2(`error: parse ${i + 1}`);
      const s = startSection();
      s.gitOld = m[1]!;
      s.gitNew = m[2]!;
      i += 1;
      continue;
    }

    if (line.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')) {
      if (!cur || !inHeader) startSection();
      const s = cur!;
      s.headerOld = parseUnifiedPath(line.slice(4));
      s.headerNew = parseUnifiedPath(lines[i + 1]!.slice(4));
      i += 2;
      continue;
    }

    if (cur && inHeader && line.startsWith('--- ')) {
      throw new Exit2(`error: parse ${i + 2}`);
    }

    if (cur && inHeader && line.startsWith('rename from ')) {
      cur.renameOld = line.slice('rename from '.length);
      i += 1;
      continue;
    }
    if (cur && inHeader && line.startsWith('rename to ')) {
      cur.renameNew = line.slice('rename to '.length);
      i += 1;
      continue;
    }
    if (cur && inHeader && line.startsWith('new file mode')) {
      cur.create = true;
      i += 1;
      continue;
    }
    if (cur && inHeader && line.startsWith('deleted file mode')) {
      cur.del = true;
      i += 1;
      continue;
    }

    if (line.startsWith('@@')) {
      if (!cur) throw new Exit2(`error: parse ${i + 1}`);
      const hdr = parseHunkHeader(line);
      if (!hdr) throw new Exit2(`error: parse ${i + 1}`);
      inHeader = false;
      const { body, noNl, next } = parseUnifiedHunkBody(lines, i + 1);
      cur.hunks.push({ a: hdr.a, body, noNlAfterLastNew: noNl });
      i = next;
      continue;
    }

    i += 1;
  }

  if (sections.length === 0) throw new Exit2('error: parse 1');
  return sections.map((sec) => unifiedEdit(sec, strict));
}

function hunkON(hunk: UnifiedHunk): { O: string[]; parts: NPart[] } {
  const O: string[] = [];
  const parts: NPart[] = [];
  let oOff = 0;
  for (const b of hunk.body) {
    if (b.kind === 'meta') continue;
    if (b.kind === 'ctx') {
      O.push(b.text);
      parts.push({ kind: 'ctx', oOff });
      oOff += 1;
    } else if (b.kind === 'old') {
      O.push(b.text);
      oOff += 1;
    } else {
      parts.push({ kind: 'add', text: b.text });
    }
  }
  return { O, parts };
}

function applyUnifiedHunks(
  lines: string[],
  final: boolean,
  hunks: UnifiedHunk[],
  strict: boolean,
  path: string,
): { lines: string[]; final: boolean } {
  let cur = lines.slice();
  let curFinal = final;
  let d = 0;
  for (const hunk of hunks) {
    const { O, parts } = hunkON(hunk);
    const Nlen = parts.length;
    if (O.length === 0) {
      const after = Math.min(hunk.a + d, cur.length);
      const N = parts.map((p) => (p.kind === 'add' ? p.text : ''));
      cur.splice(after, 0, ...N);
      if (after + N.length === cur.length) curFinal = !hunk.noNlAfterLastNew;
      d += Nlen;
      continue;
    }
    const found = findTier(cur, O, strict);
    if (!found) throw new Fail('no-match', path);
    const target = hunk.a - 1 + d;
    let best = found.positions[0]!;
    let bestDist = Math.abs(best - target);
    for (const p of found.positions) {
      const dist = Math.abs(p - target);
      if (dist < bestDist || (dist === bestDist && p < best)) {
        best = p;
        bestDist = dist;
      }
    }
    const written = materializeN(cur, best, O, parts, found.tier);
    const reachedEnd = best + O.length === cur.length;
    cur.splice(best, O.length, ...written);
    if (reachedEnd) curFinal = !hunk.noNlAfterLastNew;
    d += Nlen - O.length;
  }
  return { lines: cur, final: curFinal };
}

function unifiedEdit(sec: UnifiedSection, strict: boolean): Edit {
  return (tree) => {
    const { oldPath, newPath } = resolveUnifiedPaths(sec);
    const isCreate = sec.create || oldPath === '/dev/null';
    const isDelete = sec.del || newPath === '/dev/null';

    if (isCreate) {
      const p = newPath;
      if (!safe(p)) throw new Fail('unsafe', p);
      if (tree.get(p) !== null) throw new Fail('exists', p);
      // Created file: all `+` lines; ends with a break unless `\` follows the last `+`.
      const plus: string[] = [];
      let noNl = false;
      for (const h of sec.hunks) {
        for (let j = 0; j < h.body.length; j += 1) {
          const b = h.body[j]!;
          if (b.kind === 'new') {
            plus.push(b.text);
            noNl = j + 1 < h.body.length && h.body[j + 1]!.kind === 'meta';
          }
        }
      }
      tree.now.set(p, plus.join('\n') + (noNl ? '' : '\n'));
      return;
    }

    if (isDelete) {
      const p = oldPath;
      if (!safe(p)) throw new Fail('unsafe', p);
      if (tree.get(p) === null) throw new Fail('missing', p);
      tree.now.set(p, null);
      return;
    }

    const from = oldPath;
    const to = newPath;
    if (!safe(from)) throw new Fail('unsafe', from);
    if (from !== to && !safe(to)) throw new Fail('unsafe', to);
    if (tree.get(from) === null) throw new Fail('missing', from);
    if (from !== to && tree.get(to) !== null) throw new Fail('exists', to);

    const before = tree.get(from)!;
    const split = splitFile(before);
    const applied = applyUnifiedHunks(split.lines, split.final, sec.hunks, strict, from);
    const text = joinFile(applied.lines, split.br, applied.final);
    if (from !== to) {
      tree.now.set(from, null);
      tree.now.set(to, text);
      tree.moves.push({ from, to });
    } else {
      tree.now.set(from, text);
    }
  };
}

function searchReplaceEdits(lines: string[], strict: boolean): Edit[] {
  const edits: Edit[] = [];
  let prevPath: string | null = null;
  let i = 0;
  let prevReplace = -1;
  while (i < lines.length) {
    if (lines[i]!.trimEnd() !== '<<<<<<< SEARCH') {
      i += 1;
      continue;
    }
    const searchLine = i + 1;
    let path: string | null = null;
    for (let j = i - 1; j > prevReplace; j -= 1) {
      const l = lines[j]!;
      if (blank(l)) continue;
      const t = l.trim();
      if (t.startsWith('```')) continue;
      path = t;
      break;
    }
    if (path === null) path = prevPath;
    if (path === null) throw new Exit2(`error: parse ${searchLine}`);

    let eq = -1;
    let rep = -1;
    for (let j = i + 1; j < lines.length; j += 1) {
      if (eq < 0 && lines[j]!.trimEnd() === '=======') {
        eq = j;
        continue;
      }
      if (eq >= 0 && lines[j]!.trimEnd() === '>>>>>>> REPLACE') {
        rep = j;
        break;
      }
    }
    if (eq < 0 || rep < 0) throw new Exit2(`error: parse ${searchLine}`);

    const oldLines = lines.slice(i + 1, eq);
    const newLines = lines.slice(eq + 1, rep);
    const p = path;
    prevPath = p;
    prevReplace = rep;
    edits.push((tree) => {
      if (!safe(p)) throw new Fail('unsafe', p);
      if (oldLines.length === 0) {
        if (tree.get(p) !== null) throw new Fail('exists', p);
        tree.now.set(p, newLines.length === 0 ? '\n' : newLines.join('\n') + '\n');
        return;
      }
      const before = tree.get(p);
      if (before === null) throw new Fail('missing', p);
      const split = splitFile(before);
      const found = findTier(split.lines, oldLines, strict);
      if (!found) throw new Fail('no-match', p);
      if (found.positions.length !== 1) throw new Fail('ambiguous', p);
      const at = found.positions[0]!;
      const written = reindentAll(newLines, oldLines, split.lines, at, found.tier);
      const next = split.lines.slice();
      next.splice(at, oldLines.length, ...written);
      tree.now.set(p, joinFile(next, split.br, split.final));
    });
    i = rep + 1;
  }
  return edits;
}

type V4aChunk = {
  anchor: string | null;
  eof: boolean;
  O: string[];
  parts: NPart[];
};

function restAfterMarker(line: string, marker: string): string {
  const at = line.indexOf(marker);
  return line.slice(at + marker.length).replace(/^\s+|\s+$/g, '');
}

function v4aEdits(lines: string[], strict: boolean): Edit[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  if (lines[first]!.trim() !== '*** Begin Patch') throw new Exit2(`error: parse ${first + 1}`);
  let last = -1;
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    if (!blank(lines[i]!)) {
      last = i;
      break;
    }
  }
  if (lines[last]!.trim() !== '*** End Patch') throw new Exit2(`error: parse ${lines.length + 1}`);

  type Sec =
    | { kind: 'add'; path: string; fileLines: string[] }
    | { kind: 'delete'; path: string }
    | { kind: 'update'; path: string; moveTo: string | null; chunks: V4aChunk[]; headerLine: number };

  const sections: Sec[] = [];
  let i = first + 1;

  const isSectionStart = (l: string): boolean => {
    const t = l.trim();
    return t.startsWith('*** Add File: ') || t.startsWith('*** Delete File: ') || t.startsWith('*** Update File: ');
  };

  while (i < last) {
    if (blank(lines[i]!)) {
      i += 1;
      continue;
    }
    const raw = lines[i]!;

    if (raw.trim().startsWith('*** Add File: ')) {
      const addPath = restAfterMarker(raw, '*** Add File: ');
      i += 1;
      const body: string[] = [];
      const bodyIdx: number[] = [];
      while (i < last && !isSectionStart(lines[i]!)) {
        body.push(lines[i]!);
        bodyIdx.push(i);
        i += 1;
      }
      while (body.length > 0 && blank(body[body.length - 1]!)) {
        body.pop();
        bodyIdx.pop();
      }
      const fileLines: string[] = [];
      for (let bi = 0; bi < body.length; bi += 1) {
        const b = body[bi]!;
        if (b === '') fileLines.push('');
        else if (b.startsWith('+')) fileLines.push(b.slice(1));
        else throw new Exit2(`error: parse ${bodyIdx[bi]! + 1}`);
      }
      sections.push({ kind: 'add', path: addPath, fileLines });
      continue;
    }

    if (raw.trim().startsWith('*** Delete File: ')) {
      const delPath = restAfterMarker(raw, '*** Delete File: ');
      i += 1;
      const bodyIdx: number[] = [];
      const body: string[] = [];
      while (i < last && !isSectionStart(lines[i]!)) {
        body.push(lines[i]!);
        bodyIdx.push(i);
        i += 1;
      }
      while (body.length > 0 && blank(body[body.length - 1]!)) {
        body.pop();
        bodyIdx.pop();
      }
      if (body.length > 0) throw new Exit2(`error: parse ${bodyIdx[0]! + 1}`);
      sections.push({ kind: 'delete', path: delPath });
      continue;
    }

    if (raw.trim().startsWith('*** Update File: ')) {
      const headerLine = i + 1;
      const updPath = restAfterMarker(raw, '*** Update File: ');
      i += 1;
      let moveTo: string | null = null;
      if (i < last && lines[i]!.trim().startsWith('*** Move to: ')) {
        moveTo = restAfterMarker(lines[i]!, '*** Move to: ');
        i += 1;
      }
      const bodyStart = i;
      while (i < last && !isSectionStart(lines[i]!)) i += 1;
      let bodyEnd = i;
      while (bodyEnd > bodyStart && blank(lines[bodyEnd - 1]!)) bodyEnd -= 1;

      const chunks: V4aChunk[] = [];
      let j = bodyStart;
      while (j < bodyEnd) {
        let anchor: string | null = null;
        if (lines[j]!.startsWith('@@')) {
          anchor = lines[j]!.slice(2).replace(/^\s+|\s+$/g, '');
          if (anchor === '') anchor = null;
          j += 1;
        } else if (chunks.length > 0) {
          throw new Exit2(`error: parse ${j + 1}`);
        }

        const O: string[] = [];
        const parts: NPart[] = [];
        let oOff = 0;
        let eof = false;
        while (j < bodyEnd) {
          const l = lines[j]!;
          if (l.trim() === '*** End of File') {
            eof = true;
            j += 1;
            break;
          }
          if (l.startsWith('@@')) break;
          if (l.trim().startsWith('*** ')) throw new Exit2(`error: parse ${j + 1}`);
          if (l === '') {
            O.push('');
            parts.push({ kind: 'ctx', oOff });
            oOff += 1;
          } else if (l.startsWith(' ')) {
            O.push(l.slice(1));
            parts.push({ kind: 'ctx', oOff });
            oOff += 1;
          } else if (l.startsWith('-')) {
            O.push(l.slice(1));
            oOff += 1;
          } else if (l.startsWith('+')) {
            parts.push({ kind: 'add', text: l.slice(1) });
          } else {
            throw new Exit2(`error: parse ${j + 1}`);
          }
          j += 1;
        }
        chunks.push({ anchor, eof, O, parts });
      }

      if (chunks.length === 0 && moveTo === null) throw new Exit2(`error: parse ${headerLine}`);
      sections.push({ kind: 'update', path: updPath, moveTo, chunks, headerLine });
      continue;
    }

    throw new Exit2(`error: parse ${i + 1}`);
  }

  if (sections.length === 0) throw new Exit2('error: parse 1');

  return sections.map((sec) => {
    if (sec.kind === 'add') {
      const p = sec.path;
      const content = sec.fileLines;
      return (tree: Tree) => {
        if (!safe(p)) throw new Fail('unsafe', p);
        if (tree.get(p) !== null) throw new Fail('exists', p);
        tree.now.set(p, content.join('\n') + '\n');
      };
    }
    if (sec.kind === 'delete') {
      const p = sec.path;
      return (tree: Tree) => {
        if (!safe(p)) throw new Fail('unsafe', p);
        if (tree.get(p) === null) throw new Fail('missing', p);
        tree.now.set(p, null);
      };
    }
    const p = sec.path;
    const moveTo = sec.moveTo;
    const chunks = sec.chunks;
    return (tree: Tree) => {
      if (!safe(p)) throw new Fail('unsafe', p);
      if (moveTo !== null && !safe(moveTo)) throw new Fail('unsafe', moveTo);
      if (tree.get(p) === null) throw new Fail('missing', p);
      if (moveTo !== null && tree.get(moveTo) !== null) throw new Fail('exists', moveTo);
      const before = tree.get(p)!;
      const split = splitFile(before);
      let cur = split.lines.slice();
      let cursor = 0;
      for (const ch of chunks) {
        if (ch.anchor !== null) {
          const ai = findAnchor(cur, ch.anchor, cursor, strict);
          if (ai < 0) throw new Fail('no-match', p);
          cursor = ai + 1;
        }
        if (ch.O.length === 0) {
          const at = ch.eof ? cur.length : cursor;
          const written = ch.parts.map((x) => (x.kind === 'add' ? x.text : ''));
          cur.splice(at, 0, ...written);
          cursor = at + written.length;
          continue;
        }
        const maxTier = strict ? 0 : 2;
        let foundTier = -1;
        let foundPos = -1;
        for (let t = 0; t <= maxTier; t += 1) {
          const positions = findOccurrences(cur, ch.O, t).filter((pos) => {
            if (pos < cursor) return false;
            if (ch.eof && pos + ch.O.length !== cur.length) return false;
            return true;
          });
          if (positions.length > 0) {
            foundTier = t;
            foundPos = positions[0]!;
            break;
          }
        }
        if (foundPos < 0) throw new Fail('no-match', p);
        const written = materializeN(cur, foundPos, ch.O, ch.parts, foundTier);
        cur.splice(foundPos, ch.O.length, ...written);
        cursor = foundPos + written.length;
      }
      const text = joinFile(cur, split.br, split.final);
      if (moveTo !== null) {
        tree.now.set(p, null);
        tree.now.set(moveTo, text);
        tree.moves.push({ from: p, to: moveTo });
      } else {
        tree.now.set(p, text);
      }
    };
  });
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
  if (
    o.command === 'str_replace' &&
    typeof o.old_str === 'string' &&
    o.old_str !== '' &&
    (o.new_str === undefined || typeof o.new_str === 'string')
  ) {
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
  if (
    o.command === 'insert' &&
    typeof o.insert_line === 'number' &&
    Number.isInteger(o.insert_line) &&
    typeof o.new_str === 'string'
  ) {
    const line = o.insert_line;
    const add = patchLines(o.new_str);
    return (tree) => {
      const before = exists(tree);
      const nl = before.indexOf('\n');
      const br = nl > 0 && before[nl - 1] === '\r' ? '\r\n' : '\n';
      const fileLines = before === '' ? [] : before.split(br);
      const final = before !== '' && before.endsWith(br);
      if (final) fileLines.pop();
      if (line < 0 || line > fileLines.length) throw new Fail('no-match', p);
      fileLines.splice(line, 0, ...add);
      tree.now.set(p, fileLines.length === 0 ? '' : fileLines.join(br) + (final ? br : ''));
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

function parseEdits(kind: string, text: string, lines: string[], strict: boolean): Edit[] {
  if (kind === 'json') return jsonEdits(text, lines);
  if (kind === 'unified') return unifiedEdits(lines, strict);
  if (kind === 'search-replace') return searchReplaceEdits(lines, strict);
  if (kind === 'v4a') return v4aEdits(lines, strict);
  return [];
}

function reportRows(tree: Tree): string[] {
  const moveNew = new Map<string, string>();
  for (const m of tree.moves) {
    const wasOld = tree.original(m.from);
    const wasNew = tree.original(m.to);
    const nowOld = tree.get(m.from);
    const nowNew = tree.get(m.to);
    if (wasOld !== null && nowOld === null && wasNew === null && nowNew !== null) {
      moveNew.set(m.to, m.from);
    }
  }
  const skip = new Set<string>();
  for (const [, from] of moveNew) skip.add(from);

  const rows: { key: string; line: string }[] = [];
  for (const p of tree.now.keys()) {
    if (skip.has(p)) continue;
    const was = tree.original(p);
    const now = tree.now.get(p)!;
    if (was === now) continue;
    if (moveNew.has(p)) rows.push({ key: p, line: `R ${moveNew.get(p)} -> ${p}` });
    else rows.push({ key: p, line: `${was === null ? 'A' : now === null ? 'D' : 'M'} ${p}` });
  }
  rows.sort((a, b) => Buffer.compare(Buffer.from(a.key), Buffer.from(b.key)));
  return rows.map((r) => r.line);
}

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
    edits = parseEdits(kind, text, lines, strict);
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
    return {
      code: 1,
      out: [...fails.map((f) => `error: ${f.code} ${f.path}`), `failed: ${fails.length} of ${edits.length} edits`],
    };
  }
  const rows = reportRows(tree);
  for (const p of [...tree.now.keys()].sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b)))) {
    const was = tree.original(p);
    const now = tree.now.get(p)!;
    if (was === now) continue;
    if (check) continue;
    if (now === null) rmSync(p, { force: true });
    else {
      const dir = dirname(p);
      if (dir !== '.' && dir !== '') mkdirSync(dir, { recursive: true });
      writeFileSync(p, now);
    }
  }
  return { code: 0, out: [...rows, `ok: ${rows.length} ${rows.length === 1 ? 'file' : 'files'}`] };
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
