// Client-side unified-diff parser for the PR page. Tolerant: unknown header
// lines are skipped, a truncated trailing hunk still renders, and an empty or
// unparseable input yields [] (the page shows its empty state, never crashes).

export type DiffLineKind = "ctx" | "add" | "del" | "hunk";

export interface DiffLine {
  kind: DiffLineKind;
  oldNo: number | null;
  newNo: number | null;
  text: string; // prefix stripped for ctx/add/del; full "@@ …" for hunk
}

export interface DiffHunk {
  header: string; // "@@ -322,8 +322,13 @@"
  context: string; // trailing text after the second @@ ("class GPT…"), may be ""
  lines: DiffLine[];
}

export interface DiffFile {
  path: string; // new-side path; old path when deleted
  oldPath: string;
  adds: number;
  dels: number;
  hunks: DiffHunk[];
}

const HUNK_RE = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@ ?(.*)$/;

function stripSide(p: string): string {
  return p.replace(/^[ab]\//, "");
}

export function parseUnifiedDiff(text: string): DiffFile[] {
  const files: DiffFile[] = [];
  let file: DiffFile | null = null;
  let hunk: DiffHunk | null = null;
  let oldNo = 0;
  let newNo = 0;

  for (const raw of text.split("\n")) {
    if (raw.startsWith("diff --git ")) {
      const m = raw.match(/^diff --git a\/(.+) b\/(.+)$/);
      file = {
        path: m ? m[2] : raw.slice(11),
        oldPath: m ? m[1] : raw.slice(11),
        adds: 0,
        dels: 0,
        hunks: [],
      };
      files.push(file);
      hunk = null;
      continue;
    }
    if (!file) continue;
    if (raw.startsWith("--- ")) {
      const p = raw.slice(4).trim();
      if (p !== "/dev/null") file.oldPath = stripSide(p);
      continue;
    }
    if (raw.startsWith("+++ ")) {
      const p = raw.slice(4).trim();
      if (p !== "/dev/null") file.path = stripSide(p);
      continue;
    }
    const hm = raw.match(HUNK_RE);
    if (hm) {
      oldNo = parseInt(hm[1], 10);
      newNo = parseInt(hm[3], 10);
      hunk = {
        header: raw.slice(0, raw.indexOf("@@", 2) + 2),
        context: hm[5] ?? "",
        lines: [{ kind: "hunk", oldNo: null, newNo: null, text: raw }],
      };
      file.hunks.push(hunk);
      continue;
    }
    if (!hunk) continue; // index lines, mode lines, binary notices …
    if (raw.startsWith("+")) {
      hunk.lines.push({ kind: "add", oldNo: null, newNo: newNo++, text: raw.slice(1) });
      file.adds++;
    } else if (raw.startsWith("-")) {
      hunk.lines.push({ kind: "del", oldNo: oldNo++, newNo: null, text: raw.slice(1) });
      file.dels++;
    } else if (raw.startsWith(" ") || raw === "") {
      hunk.lines.push({ kind: "ctx", oldNo: oldNo++, newNo: newNo++, text: raw.slice(1) });
    }
    // "\ No newline at end of file" and anything else: skipped
  }
  return files;
}
