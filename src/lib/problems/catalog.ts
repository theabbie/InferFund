import { readFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { and, eq, like, or, sql, desc } from "drizzle-orm";
import type { AnyDatabase } from "../db/client";
import { attempts, problems, problemVersions } from "../db/schema";

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
    items = items.filter((p) =>
      p.category?.toLowerCase().includes(filters.category!.toLowerCase()),
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
    start + filters.limit < items.length
      ? String(start + filters.limit)
      : null;
  return { items: page, nextCursor };
}

export async function getProblemStats(
  db: AnyDatabase,
  problemKey: string,
): Promise<{
  totalAttempts: number;
  mergedAttempts: number;
  verifiedAttempts: number;
}> {
  const rows = await db
    .select({
      total: sql<number>`count(*)::int`,
      merged: sql<number>`count(*) filter (where ${attempts.status} = 'merged')::int`,
      verified: sql<number>`count(*) filter (where ${attempts.verificationStatus} = 'lean_verified')::int`,
    })
    .from(attempts)
    .where(eq(attempts.problemKey, problemKey));
  return {
    totalAttempts: rows[0]?.total ?? 0,
    mergedAttempts: rows[0]?.merged ?? 0,
    verifiedAttempts: rows[0]?.verified ?? 0,
  };
}

export async function upsertCatalogIntoDb(
  db: AnyDatabase,
  catalog: Catalog,
): Promise<{ upserted: number; versions: number }> {
  let upserted = 0;
  let versions = 0;
  for (const p of catalog.problems) {
    await db
      .insert(problems)
      .values({
        problemKey: p.problemKey,
        source: p.source,
        title: p.title,
        category: p.category,
        amsTags: p.amsTags,
        upstreamRepo: p.upstreamRepo,
        upstreamPath: p.upstreamPath,
        upstreamModule: p.upstreamModule,
        upstreamDeclaration: p.upstreamDeclaration,
        status: p.openStatus,
        summary: p.humanStatement?.slice(0, 2000) ?? null,
        updatedAt: new Date(),
      })
      .onConflictDoUpdate({
        target: problems.problemKey,
        set: {
          title: p.title,
          category: p.category,
          amsTags: p.amsTags,
          upstreamPath: p.upstreamPath,
          upstreamModule: p.upstreamModule,
          upstreamDeclaration: p.upstreamDeclaration,
          status: p.openStatus,
          summary: p.humanStatement?.slice(0, 2000) ?? null,
          updatedAt: new Date(),
        },
      });
    upserted += 1;
    const versionId = problemVersionId(
      p.problemKey,
      catalog.upstreamCommit,
      p.statementHash,
    );
    const inserted = await db
      .insert(problemVersions)
      .values({
        id: versionId,
        problemKey: p.problemKey,
        upstreamRef: catalog.upstreamRef,
        upstreamCommit: catalog.upstreamCommit,
        statementText: p.statementText,
        statementHash: p.statementHash,
        humanStatement: p.humanStatement,
        sourceUrl: p.sourceUrl,
      })
      .onConflictDoNothing()
      .returning({ id: problemVersions.id });
    versions += inserted.length;
  }
  return { upserted, versions };
}

export async function searchProblemsInDb(
  db: AnyDatabase,
  filters: ProblemSearchFilters,
): Promise<{ items: Array<typeof problems.$inferSelect>; nextCursor: string | null }> {
  const conditions = [];
  if (filters.query) {
    const q = `%${filters.query}%`;
    conditions.push(
      or(
        like(problems.title, q),
        like(problems.problemKey, q),
        like(problems.summary, q),
      ),
    );
  }
  if (filters.category) {
    conditions.push(like(problems.category, `%${filters.category}%`));
  }
  if (filters.openOnly) {
    conditions.push(eq(problems.status, "open"));
  }
  const offset = filters.cursor ? Number.parseInt(filters.cursor, 10) : 0;
  const rows = await db
    .select()
    .from(problems)
    .where(conditions.length > 0 ? and(...conditions) : undefined)
    .orderBy(desc(problems.updatedAt))
    .limit(filters.limit + 1)
    .offset(offset);
  const hasMore = rows.length > filters.limit;
  return {
    items: rows.slice(0, filters.limit),
    nextCursor: hasMore ? String(offset + filters.limit) : null,
  };
}
