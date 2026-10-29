/** A line in a comparison of two texts: in both, only in the newer one, or only in the older one. */
export interface DiffLine {
  kind: "same" | "add" | "del";
  text: string;
}

const lines = (s: string) => (s === "" ? [] : s.replace(/\n$/, "").split("\n"));

/** Past this many edits the comparison stops looking for the shortest one and shows a rewrite. */
const MAX_EDITS = 4000;

/**
 * Line diff from `a` (older) to `b` (newer), by Myers' algorithm: the fewest added and removed
 * lines. Common lines at both ends are taken off first, which is most of a typical edit.
 */
export function diffLines(a: string, b: string): DiffLine[] {
  const A = lines(a);
  const B = lines(b);
  let s = 0;
  while (s < A.length && s < B.length && A[s] === B[s]) s++;
  let ea = A.length;
  let eb = B.length;
  while (ea > s && eb > s && A[ea - 1] === B[eb - 1]) ea--, eb--;
  const same = (t: string): DiffLine => ({ kind: "same", text: t });
  return [...A.slice(0, s).map(same), ...middle(A.slice(s, ea), B.slice(s, eb)), ...A.slice(ea).map(same)];
}

function middle(A: string[], B: string[]): DiffLine[] {
  const N = A.length;
  const M = B.length;
  const rewrite = (): DiffLine[] => [...A.map((text) => ({ kind: "del" as const, text })), ...B.map((text) => ({ kind: "add" as const, text }))];
  if (!N || !M) return rewrite();
  const max = Math.min(N + M, MAX_EDITS);
  const off = max + 1;
  const v = new Int32Array(2 * max + 3);
  // v as it was before each round d, kept only over the diagonals that round can reach.
  const trace: Int32Array[] = [];
  const pick = (vv: (k: number) => number, k: number, d: number) => (k === -d || (k !== d && vv(k - 1) < vv(k + 1)) ? k + 1 : k - 1);
  for (let d = 0; d <= max; d++) {
    trace.push(v.slice(off - d - 1, off + d + 2));
    for (let k = -d; k <= d; k += 2) {
      const from = pick((i) => v[off + i], k, d);
      let x = from === k + 1 ? v[off + k + 1] : v[off + k - 1] + 1;
      let y = x - k;
      while (x < N && y < M && A[x] === B[y]) x++, y++;
      v[off + k] = x;
      if (x >= N && y >= M) return backtrack(A, B, trace);
    }
  }
  return rewrite();
}

function backtrack(A: string[], B: string[], trace: Int32Array[]): DiffLine[] {
  const out: DiffLine[] = [];
  let x = A.length;
  let y = B.length;
  for (let d = trace.length - 1; d >= 0; d--) {
    const t = trace[d];
    const at = (k: number) => t[k + d + 1];
    const k = x - y;
    const prevK = k === -d || (k !== d && at(k - 1) < at(k + 1)) ? k + 1 : k - 1;
    const prevX = at(prevK);
    const prevY = prevX - prevK;
    while (x > prevX && y > prevY) out.push({ kind: "same", text: A[--x] }), y--;
    if (d === 0) break;
    if (x === prevX) out.push({ kind: "add", text: B[--y] });
    else out.push({ kind: "del", text: A[--x] });
  }
  return out.reverse();
}

/** Lines added and removed between two texts. */
export function diffStat(a: string, b: string): { added: number; removed: number } {
  let added = 0;
  let removed = 0;
  for (const l of diffLines(a, b)) {
    if (l.kind === "add") added++;
    else if (l.kind === "del") removed++;
  }
  return { added, removed };
}

/** A diff with long unchanged stretches folded into a count, keeping `context` lines around each change. */
export type DiffRow = DiffLine | { kind: "gap"; count: number };

export function foldUnchanged(diff: DiffLine[], context = 3): DiffRow[] {
  const keep = new Uint8Array(diff.length);
  diff.forEach((l, i) => {
    if (l.kind === "same") return;
    for (let j = Math.max(0, i - context); j <= Math.min(diff.length - 1, i + context); j++) keep[j] = 1;
  });
  const out: DiffRow[] = [];
  for (let i = 0; i < diff.length; ) {
    if (keep[i]) out.push(diff[i++]);
    else {
      let j = i;
      while (j < diff.length && !keep[j]) j++;
      // Folding one line saves nothing over showing it.
      if (j - i === 1) out.push(diff[i]);
      else out.push({ kind: "gap", count: j - i });
      i = j;
    }
  }
  return out;
}
