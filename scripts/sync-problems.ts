import { execFile } from "node:child_process";
import { mkdtemp, readFile, readdir, writeFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { extractProblemsFromLeanFile } from "../src/lib/problems/extract";
import type { Catalog } from "../src/lib/problems/catalog";

const execFileAsync = promisify(execFile);

interface SyncConfig {
  upstreamRepo: string;
  upstreamUrl: string;
  ref: string;
  pinnedCommit: string;
  leanVersion: string;
}

async function readConfig(): Promise<SyncConfig> {
  const raw = await readFile(
    path.join(process.cwd(), "config", "formal-conjectures.json"),
    "utf8",
  );
  return JSON.parse(raw) as SyncConfig;
}

async function collectLeanFiles(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await collectLeanFiles(full)));
    } else if (entry.name.endsWith(".lean")) {
      files.push(full);
    }
  }
  return files;
}

async function main(): Promise<void> {
  const config = await readConfig();
  const overrideRef = process.env.FORMAL_CONJECTURES_REF;
  const targetRef = overrideRef ?? config.pinnedCommit ?? config.ref;
  console.log(
    `Syncing problems from ${config.upstreamRepo} at ${targetRef}...`,
  );

  const workDir = await mkdtemp(path.join(tmpdir(), "inferfund-fc-"));
  const cloneArgs = [
    "clone",
    "--depth",
    "1",
    "--filter=blob:none",
    `https://github.com/${config.upstreamRepo}.git`,
    workDir,
  ];
  if (!overrideRef && !config.pinnedCommit) {
    cloneArgs.splice(4, 0, "--branch", config.ref);
  }
  await execFileAsync("git", cloneArgs, { maxBuffer: 64 * 1024 * 1024 });
  if (overrideRef || config.pinnedCommit) {
    const ref = overrideRef ?? config.pinnedCommit;
    await execFileAsync("git", ["-C", workDir, "fetch", "--depth", "1", "origin", ref], {
      maxBuffer: 64 * 1024 * 1024,
    });
    await execFileAsync("git", ["-C", workDir, "checkout", "FETCH_HEAD"], {
      maxBuffer: 64 * 1024 * 1024,
    });
  }
  const { stdout: commitOut } = await execFileAsync("git", [
    "-C",
    workDir,
    "rev-parse",
    "HEAD",
  ]);
  const commit = commitOut.trim();
  console.log(`Upstream commit: ${commit}`);

  let leanVersion = config.leanVersion;
  try {
    leanVersion = (
      await readFile(path.join(workDir, "lean-toolchain"), "utf8")
    ).trim();
  } catch {
    console.warn("lean-toolchain not found; using configured value.");
  }

  const roots = ["FormalConjectures"];
  const allProblems = [];
  for (const root of roots) {
    const rootDir = path.join(workDir, root);
    try {
      await stat(rootDir);
    } catch {
      continue;
    }
    const files = await collectLeanFiles(rootDir);
    for (const file of files) {
      const relPath = path.relative(workDir, file);
      const content = await readFile(file, "utf8");
      const extracted = extractProblemsFromLeanFile({
        path: relPath,
        content,
        source: "formal-conjectures",
      });
      allProblems.push(...extracted);
    }
  }

  const seen = new Map<string, number>();
  for (const p of allProblems) {
    const count = seen.get(p.problemKey) ?? 0;
    seen.set(p.problemKey, count + 1);
    if (count > 0) {
      p.problemKey = `${p.problemKey}-${count + 1}`.slice(0, 128);
    }
  }

  const catalog: Catalog = {
    generatedAt: new Date().toISOString(),
    upstreamRepo: config.upstreamRepo,
    upstreamRef: config.pinnedCommit || config.ref,
    upstreamCommit: commit,
    leanVersion,
    problems: allProblems
      .map((p) => ({
        ...p,
        upstreamRepo: config.upstreamRepo,
        upstreamRef: config.pinnedCommit || config.ref,
        upstreamCommit: commit,
      }))
      .sort((a, b) => a.problemKey.localeCompare(b.problemKey)),
  };

  const outPath = path.join(process.cwd(), "data", "problems.json");
  await writeFile(outPath, JSON.stringify(catalog, null, 2) + "\n");
  console.log(
    `Wrote ${catalog.problems.length} problems to data/problems.json`,
  );

  if (process.argv.includes("--db")) {
    const { getDb } = await import("../src/lib/db/client");
    const { upsertCatalogIntoDb } = await import(
      "../src/lib/problems/catalog"
    );
    const result = await upsertCatalogIntoDb(getDb(), catalog);
    console.log(
      `Upserted ${result.upserted} problems, ${result.versions} new versions into DB.`,
    );
  }
}

main().catch((error) => {
  console.error("sync:problems failed:", error);
  process.exit(1);
});
