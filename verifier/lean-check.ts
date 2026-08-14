import { execFile } from "node:child_process";
import { mkdir, readFile, writeFile, cp, rm } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { z } from "zod";

const execFileAsync = promisify(execFile);

export const verificationResultSchema = z.object({
  status: z.enum(["verified", "failed", "not_applicable"]),
  attempt_id: z.string(),
  source_sha: z.string(),
  declarations_checked: z.array(
    z.object({
      name: z.string(),
      type: z.string().optional(),
      axioms: z.array(z.string()).optional(),
      status: z.enum(["verified", "failed", "missing"]),
    }),
  ),
  axioms: z.array(z.string()),
  lean_version: z.string(),
  formal_conjectures_ref: z.string(),
  target_match: z.boolean().nullable(),
  failure_reason: z.string().nullable(),
});

export type VerificationResult = z.infer<typeof verificationResultSchema>;

interface VerifierConfig {
  leanToolchain: string;
  formalConjecturesRepo: string;
  formalConjecturesRef: string;
  allowedAxioms: string[];
  timeoutMinutes: number;
}

export function scanLeanSourceForAdmissions(source: string): string[] {
  const findings: string[] = [];
  const withoutComments = source
    .replace(/\/-[\s\S]*?-\//g, "")
    .replace(/--[^\n]*/g, "");
  if (/\bsorry\b/.test(withoutComments)) findings.push("sorry");
  if (/\badmit\b/.test(withoutComments)) findings.push("admit");
  if (/\bsorryAx\b/.test(withoutComments)) findings.push("sorryAx");
  return findings;
}

export function checkAxiomsAgainstPolicy(
  axioms: string[],
  allowed: string[],
): { ok: boolean; unexpected: string[] } {
  const unexpected = axioms.filter(
    (a) =>
      a === "sorryAx" || !allowed.includes(a),
  );
  return { ok: unexpected.length === 0, unexpected };
}

const CHECK_LEAN_TEMPLATE = `import $MODULE$

open Lean Elab Command

#eval show CoreM Unit from do
  let env ← getEnv
  let names : Array Name := #[$NAMES$]
  for n in names do
    match env.find? n with
    | none => IO.println s!"DECL-MISSING {n}"
    | some info =>
      let axioms := CollectAxioms.collect n |>.axioms
      IO.println s!"DECL {n}"
      IO.println s!"TYPE {info.type}"
      IO.println s!"AXIOMS {String.intercalate "," (axioms.toList.map toString)}"
`;

export async function runLeanVerification(input: {
  workDir: string;
  leanFiles: Array<{ name: string; absPath: string }>;
  declaredTheorems: Array<{ name: string; file: string }>;
  attemptId: string;
  sourceSha: string;
  config: VerifierConfig;
  targetModule?: string;
  targetDeclaration?: string;
}): Promise<VerificationResult> {
  const { workDir, config } = input;
  const base: VerificationResult = {
    status: "failed",
    attempt_id: input.attemptId,
    source_sha: input.sourceSha,
    declarations_checked: [],
    axioms: [],
    lean_version: config.leanToolchain,
    formal_conjectures_ref: config.formalConjecturesRef,
    target_match: null,
    failure_reason: null,
  };

  const moduleDir = path.join(workDir, "InferFundCheck");
  await mkdir(moduleDir, { recursive: true });

  const moduleNames: string[] = [];
  for (const file of input.leanFiles) {
    const source = await readFile(file.absPath, "utf8");
    const admissions = scanLeanSourceForAdmissions(source);
    if (admissions.length > 0) {
      return {
        ...base,
        failure_reason: `Lean source contains admitted-proof constructs: ${admissions.join(", ")} in ${file.name}.`,
      };
    }
    const moduleName = file.name.replace(/\.lean$/, "").replace(/\//g, ".");
    const dest = path.join(moduleDir, file.name.replace(/\//g, "_"));
    await cp(file.absPath, dest);
    moduleNames.push(`InferFundCheck.${file.name.replace(/\.lean$/, "").replace(/\//g, ".")}`);
    void moduleName;
  }

  const importedModule = moduleNames[0];
  if (!importedModule) {
    return { ...base, status: "not_applicable", failure_reason: null };
  }

  const declNames = input.declaredTheorems.map((d) => `\`${d.name}`).join(" ");
  const checkSource = CHECK_LEAN_TEMPLATE.replace(
    "$MODULE$",
    importedModule,
  ).replace("$NAMES$", declNames);
  const checkPath = path.join(moduleDir, "Check.lean");
  await writeFile(checkPath, checkSource);

  const lakeEnv = process.env.LEAN_ENV_PATH ?? workDir;
  const timeoutMs = config.timeoutMinutes * 60 * 1000;

  try {
    const leanPath = process.env.LEAN_BIN ?? "lean";
    const env = {
      ...process.env,
      LEAN_PATH: path.join(workDir, ".lake", "build", "lib"),
    };
    const compile = await execFileAsync(
      leanPath,
      [
        "--root=" + workDir,
        path.join(moduleDir, path.basename(input.leanFiles[0]!.absPath)),
      ],
      { timeout: timeoutMs, maxBuffer: 16 * 1024 * 1024, env },
    );
    void compile;
    const checkRun = await execFileAsync(
      leanPath,
      ["--root=" + workDir, checkPath],
      { timeout: timeoutMs, maxBuffer: 16 * 1024 * 1024, env },
    );
    const out = checkRun.stdout;
    const declarations: VerificationResult["declarations_checked"] = [];
    const allAxioms = new Set<string>();
    for (const rawLine of out.split("\n")) {
      const line = rawLine.trimEnd();
      if (line.startsWith("DECL-MISSING ")) {
        declarations.push({
          name: line.slice("DECL-MISSING ".length),
          status: "missing",
        });
      } else if (line.startsWith("DECL ")) {
        declarations.push({
          name: line.slice(5),
          status: "verified",
        });
      } else if (line.startsWith("AXIOMS ")) {
        for (const ax of line.slice(7).split(",").map((s) => s.trim())) {
          if (ax) allAxioms.add(ax);
        }
      }
    }
    const missing = declarations.filter((d) => d.status === "missing");
    if (missing.length > 0) {
      return {
        ...base,
        declarations_checked: declarations,
        failure_reason: `Declared theorems not found: ${missing
          .map((d) => d.name)
          .join(", ")}.`,
      };
    }
    const axiomCheck = checkAxiomsAgainstPolicy(
      [...allAxioms],
      config.allowedAxioms,
    );
    if (!axiomCheck.ok) {
      return {
        ...base,
        declarations_checked: declarations,
        axioms: [...allAxioms],
        failure_reason: `Unexpected or forbidden axioms: ${axiomCheck.unexpected.join(", ")}.`,
      };
    }
    return {
      ...base,
      status: "verified",
      declarations_checked: declarations,
      axioms: [...allAxioms],
      target_match: null,
    };
  } catch (error) {
    const message =
      error instanceof Error ? error.message.slice(0, 2000) : "unknown error";
    return {
      ...base,
      failure_reason: `Lean execution failed or timed out: ${message}`,
    };
  } finally {
    await rm(moduleDir, { recursive: true, force: true }).catch(() => {});
    void lakeEnv;
  }
}
