import { readFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";

export const catalogProblemSchema = z.object({
  problemKey: z.string(),
  source: z.string(),
  title: z.string(),
  category: z.string().nullable(),
  amsTags: z.array(z.string()),
  upstreamRepo: z.string(),
  upstreamPath: z.string(),
  upstreamModule: z.string(),
  upstreamDeclaration: z.string(),
  upstreamRef: z.string(),
  upstreamCommit: z.string(),
  statementText: z.string(),
  statementHash: z.string(),
  humanStatement: z.string().nullable(),
  sourceUrl: z.string().nullable(),
  openStatus: z.string(),
});

export const catalogSchema = z.object({
  generatedAt: z.string(),
  upstreamRepo: z.string(),
  upstreamRef: z.string(),
  upstreamCommit: z.string(),
  leanVersion: z.string(),
  problems: z.array(catalogProblemSchema),
});

export type Catalog = z.infer<typeof catalogSchema>;
export type CatalogProblem = z.infer<typeof catalogProblemSchema>;

let cachedCatalog: Catalog | undefined;

export async function loadCatalog(): Promise<Catalog> {
  if (cachedCatalog) return cachedCatalog;
  const raw = await readFile(
    path.join(process.cwd(), "data", "problems.json"),
    "utf8",
  );
  cachedCatalog = catalogSchema.parse(JSON.parse(raw));
  return cachedCatalog;
}

export function resetCatalogCacheForTests(): void {
  cachedCatalog = undefined;
}

export async function getCatalogProblem(
  problemKey: string,
): Promise<CatalogProblem | null> {
  const catalog = await loadCatalog();
  return catalog.problems.find((p) => p.problemKey === problemKey) ?? null;
}

export function problemVersionId(
  problemKey: string,
  upstreamCommit: string,
  statementHash: string,
): string {
  return `${problemKey}@${upstreamCommit.slice(0, 12)}#${statementHash.replace("sha256:", "").slice(0, 16)}`;
}

export interface ProblemSearchFilters {
  query?: string;
  category?: string;
  openOnly?: boolean;
  limit: number;
  cursor?: string;
}

export async function searchCatalogProblems(
  filters: ProblemSearchFilters,
): Promise<{ items: CatalogProblem[]; nextCursor: string | null }> {
  const catalog = await loadCatalog();
  const query = filters.query?.toLowerCase().trim();
  let items = catalog.problems;
  if (filters.category) {
    const category = filters.category.toLowerCase();
    items = items.filter((p) =>
      p.category?.toLowerCase().includes(category),
    );
  }
  if (filters.openOnly) {
    items = items.filter((p) => p.openStatus === "open");
  }
  if (query) {
    items = items.filter(
      (p) =>
        p.title.toLowerCase().includes(query) ||
        p.problemKey.includes(query) ||
        (p.humanStatement ?? "").toLowerCase().includes(query) ||
        p.upstreamDeclaration.toLowerCase().includes(query),
    );
  }
  const start = filters.cursor ? Number.parseInt(filters.cursor, 10) : 0;
  const page = items.slice(start, start + filters.limit);
  const nextCursor =
    start + filters.limit < items.length ? String(start + filters.limit) : null;
  return { items: page, nextCursor };
}
