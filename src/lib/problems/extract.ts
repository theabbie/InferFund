import { contentHash } from "../ids";

export interface ExtractedProblem {
  problemKey: string;
  source: string;
  title: string;
  category: string | null;
  amsTags: string[];
  upstreamPath: string;
  upstreamModule: string;
  upstreamDeclaration: string;
  statementText: string;
  statementHash: string;
  humanStatement: string | null;
  sourceUrl: string | null;
  openStatus: string;
}

const CATEGORY_RE = /^\s*@\[category\s+([^\],]+)(?:,\s*AMS\s+([0-9 ]+))?\]\s*$/;
const DECL_RE =
  /^(?:noncomputable\s+)?(?:theorem|conjecture|abbrev|def|lemma)\s+([A-Za-z0-9_.']+)\s*/;

function normalizeStatement(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

function extractModuleDoc(lines: string[]): {
  title: string | null;
  sourceUrl: string | null;
} {
  const docStart = lines.findIndex((l) => l.trim().startsWith("/-!"));
  if (docStart === -1) return { title: null, sourceUrl: null };
  const body: string[] = [];
  for (let i = docStart; i < lines.length; i++) {
    const line = lines[i] ?? "";
    body.push(line);
    if (i > docStart && line.includes("-/")) break;
  }
  const text = body.join("\n");
  const titleMatch = /^#!\s*(.+)$/m.exec(text) ?? /^#\s+(.+)$/m.exec(text);
  const refMatch =
    /\*?(?:Reference|reference)\s*:?\*?\s*\[?[^\]]*\]?\((https?:\/\/[^)\s]+)\)/.exec(
      text,
    ) ?? /(https?:\/\/[^\s)]+)/.exec(text);
  return {
    title: titleMatch?.[1]?.trim() ?? null,
    sourceUrl: refMatch?.[1] ?? null,
  };
}

function readDocComment(lines: string[], attrLineIdx: number): string | null {
  let i = attrLineIdx - 1;
  while (i >= 0 && lines[i]?.trim() === "") {
    i -= 1;
  }
  if (i < 0 || lines[i]?.trim() !== "-/") return null;
  i -= 1;
  const doc: string[] = [];
  while (i >= 0) {
    const line = lines[i] ?? "";
    if (line.trim().startsWith("/--")) break;
    doc.unshift(line);
    i -= 1;
  }
  if (i < 0) return null;
  const text = doc.join("\n").trim();
  return text.length > 0 ? text : null;
}

function parenBalance(s: string): number {
  let bal = 0;
  for (const ch of s) {
    if (ch === "(" || ch === "[" || ch === "{") bal += 1;
    if (ch === ")" || ch === "]" || ch === "}") bal -= 1;
  }
  return bal;
}

export function extractProblemsFromLeanFile(input: {
  path: string;
  content: string;
  source: string;
}): ExtractedProblem[] {
  const { path, content, source } = input;
  const lines = content.split("\n");
  const moduleName = path.replace(/\.lean$/, "").split("/").join(".");
  const { title: fileTitle, sourceUrl } = extractModuleDoc(lines);
  const results: ExtractedProblem[] = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? "";
    const catMatch = CATEGORY_RE.exec(line);
    if (!catMatch) continue;
    const category = catMatch[1]?.trim() ?? null;
    const amsTags = (catMatch[2] ?? "").split(/\s+/).filter((t) => t.length > 0);

    let j = i + 1;
    while (j < lines.length && (lines[j] ?? "").trim() === "") j += 1;
    if (j >= lines.length) continue;

    let declText = lines[j] ?? "";
    let k = j + 1;
    let balance = parenBalance(declText);
    let foundAssign = declText.includes(":=");
    while ((!foundAssign || balance > 0) && k < lines.length && k - j < 200) {
      const next = lines[k] ?? "";
      declText += "\n" + next;
      balance += parenBalance(next);
      if (next.includes(":=")) foundAssign = true;
      if (foundAssign && balance <= 0) break;
      k += 1;
    }

    const trimmed = declText.trim();
    const declMatch = DECL_RE.exec(trimmed);
    if (!declMatch) continue;
    const declName = declMatch[1] ?? "";
    if (!declName) continue;

    let statement = trimmed;
    const assignIdx = statement.indexOf(":=");
    if (assignIdx !== -1) {
      statement = statement.slice(0, assignIdx).trim();
    }

    const docComment = readDocComment(lines, i);
    const baseTitle = fileTitle ?? declName;
    const openStatus =
      category !== null && category.includes("open")
        ? "open"
        : category !== null && category.includes("solved")
          ? "solved"
          : (category ?? "unknown");

    const keySlug = declName
      .toLowerCase()
      .replace(/_/g, "-")
      .replace(/\./g, "-")
      .replace(/[^a-z0-9-]+/g, "-")
      .replace(/-{2,}/g, "-")
      .replace(/^-+|-+$/g, "");
    const problemKey = keySlug.slice(0, 128);
    const normalized = normalizeStatement(statement);
    results.push({
      problemKey,
      source,
      title: `${baseTitle} (${declName})`,
      category,
      amsTags,
      upstreamPath: path,
      upstreamModule: moduleName,
      upstreamDeclaration: declName,
      statementText: normalized,
      statementHash: contentHash(normalized),
      humanStatement: docComment,
      sourceUrl,
      openStatus,
    });
  }
  return results;
}
