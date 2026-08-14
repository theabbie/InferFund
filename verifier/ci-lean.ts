import { execFileSync } from "node:child_process";
import {
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import {
  checkAxiomsAgainstPolicy,
  scanLeanSourceForAdmissions,
  verificationResultSchema,
  type VerificationResult,
} from "./lean-check";

interface VerifierConfig {
  leanToolchain: string;
  formalConjecturesRef: string;
  allowedAxioms: string[];
  timeoutMinutes: number;
}

interface CatalogEntry {
  problemKey: string;
  upstreamModule: string;
  upstreamDeclaration: string;
  statementText: string;
}

function main(): void {
  const attemptDir = process.env.ATTEMPT_DIR ?? "";
  const attemptId = process.env.ATTEMPT_ID ?? "";
  const problemKey = process.env.PROBLEM_KEY ?? "";
  const headSha = process.env.HEAD_SHA ?? "";
  const solvesTarget = process.env.SOLVES_TARGET === "true";

  const config = JSON.parse(
    readFileSync("verifier/config.json", "utf8"),
  ) as VerifierConfig;

  const result: VerificationResult = {
    status: "failed",
    attempt_id: attemptId,
    source_sha: headSha,
    declarations_checked: [],
    axioms: [],
    lean_version: config.leanToolchain,
    formal_conjectures_ref: config.formalConjecturesRef,
    target_match: null,
    failure_reason: null,
  };

  const writeResult = (): void => {
    mkdirSync("../out", { recursive: true });
    verificationResultSchema.parse(result);
    writeFileSync(
      "../out/verification-result.json",
      JSON.stringify(result, null, 2),
    );
  };

  const leanDir = path.join("../contribution", attemptDir, "lean");
  if (!existsSync(leanDir)) {
    result.status = "not_applicable";
    writeResult();
    return;
  }
  const leanFiles = readdirSync(leanDir).filter((f) => f.endsWith(".lean"));
  if (leanFiles.length === 0) {
    result.status = "not_applicable";
    writeResult();
    return;
  }

  const manifest = JSON.parse(
    readFileSync(path.join("../contribution", attemptDir, "manifest.json"), "utf8"),
  ) as {
    declared_lean_theorems: Array<{
      name: string;
      file: string;
      is_target_proof: boolean;
    }>;
  };

  for (const file of leanFiles) {
    const source = readFileSync(path.join(leanDir, file), "utf8");
    const admissions = scanLeanSourceForAdmissions(source);
    if (admissions.length > 0) {
      result.failure_reason = `Lean source contains admitted-proof constructs (${admissions.join(", ")}) in ${file}.`;
      writeResult();
      return;
    }
  }

  const fcDir = "../fc-workspace";
  const checkDir = path.join(fcDir, "InferFundCheck");
  mkdirSync(checkDir, { recursive: true });
  const moduleNames: string[] = [];
  for (const file of leanFiles) {
    const flat = file.replace(/\//g, "_");
    cpSync(path.join(leanDir, file), path.join(checkDir, flat));
    moduleNames.push(
      `InferFundCheck.${flat.replace(/\.lean$/, "").replace(/_/g, ".")}`,
    );
  }

  const timeoutMs = config.timeoutMinutes * 60 * 1000;

  try {
    for (let i = 0; i < leanFiles.length; i++) {
      const flat = leanFiles[i]!.replace(/\//g, "_");
      execFileSync(
        "lake",
        ["env", "lean", path.join("InferFundCheck", flat)],
        { cwd: fcDir, timeout: timeoutMs, stdio: ["ignore", "pipe", "pipe"] },
      );
    }
  } catch (error) {
    const stderr =
      error && typeof error === "object" && "stderr" in error
        ? String((error as { stderr: unknown }).stderr).slice(0, 4000)
        : "";
    result.failure_reason = `Lean compilation failed: ${stderr || "timeout or crash"}`;
    writeResult();
    return;
  }

  const declared = manifest.declared_lean_theorems;
  const checkLines: string[] = moduleNames.map((m) => `import ${m}`);
  const catalog = JSON.parse(
    readFileSync("data/problems.json", "utf8"),
  ) as { problems: CatalogEntry[] };
  const catalogEntry = catalog.problems.find(
    (p) => p.problemKey === problemKey,
  );

  for (const decl of declared) {
    checkLines.push(`#print axioms ${decl.name}`);
  }

  let targetCheckIndex = -1;
  if (solvesTarget && catalogEntry) {
    const targetProof = declared.find((d) => d.is_target_proof);
    if (targetProof) {
      checkLines.push(`import ${catalogEntry.upstreamModule}`);
      const statement = catalogEntry.statementText.replace(
        new RegExp(
          `^(?:noncomputable )?(?:theorem|conjecture) ${escapeRegExp(catalogEntry.upstreamDeclaration)}\\s*`,
        ),
        "",
      );
      checkLines.push(
        `theorem inferfund_target_check : ${statement.trim()} := by exact ${targetProof.name}`,
      );
      targetCheckIndex = checkLines.length - 1;
    }
  }

  const checkFile = path.join(checkDir, "Check.lean");
  writeFileSync(checkFile, checkLines.join("\n") + "\n");

  let checkOutput = "";
  try {
    checkOutput = execFileSync(
      "lake",
      ["env", "lean", path.join("InferFundCheck", "Check.lean")],
      { cwd: fcDir, timeout: timeoutMs, encoding: "utf8" },
    );
  } catch (error) {
    const stdout =
      error && typeof error === "object" && "stdout" in error
        ? String((error as { stdout: unknown }).stdout)
        : "";
    const stderr =
      error && typeof error === "object" && "stderr" in error
        ? String((error as { stderr: unknown }).stderr).slice(0, 3000)
        : "";
    if (targetCheckIndex !== -1) {
      result.target_match = false;
      result.failure_reason = `Exact-target proof check failed: ${stderr || "no output"}`;
    } else {
      result.failure_reason = `Axiom inspection failed: ${stderr || stdout.slice(0, 3000)}`;
    }
    writeResult();
    return;
  }

  const declStatus = new Map<string, "verified" | "missing">();
  const axioms = new Set<string>();
  const axiomRe =
    /'?([A-Za-z0-9_.']+)'? depends on axioms: \[([^\]]*)\]|depends on axioms: \[([^\]]*)\]/g;
  const lines = checkOutput.split("\n");
  let currentDecl: string | null = null;
  for (const line of lines) {
    const infoMatch = /info:\s*'?([A-Za-z0-9_.']+)'?/.exec(line);
    const directMatch =
      /'?([A-Za-z0-9_.']+)'?\s+depends on axioms:\s*\[([^\]]*)\]/.exec(line);
    if (directMatch) {
      currentDecl = directMatch[1] ?? null;
      const list = (directMatch[2] ?? "")
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean);
      for (const ax of list) axioms.add(ax);
      if (currentDecl) declStatus.set(currentDecl, "verified");
      continue;
    }
    const noneMatch =
      /'?([A-Za-z0-9_.']+)'?\s+does not depend on any axioms/.exec(line);
    if (noneMatch) {
      const name = noneMatch[1] ?? null;
      if (name) declStatus.set(name, "verified");
      continue;
    }
    void infoMatch;
    void axiomRe;
  }

  result.declarations_checked = declared.map((d) => ({
    name: d.name,
    status: declStatus.get(d.name) ?? "missing",
  }));
  result.axioms = [...axioms];

  const missing = result.declarations_checked.filter(
    (d) => d.status === "missing",
  );
  if (missing.length > 0) {
    result.failure_reason = `Declared theorems not found in compiled output: ${missing
      .map((d) => d.name)
      .join(", ")}.`;
    writeResult();
    return;
  }

  const axiomCheck = checkAxiomsAgainstPolicy(
    result.axioms,
    config.allowedAxioms,
  );
  if (!axiomCheck.ok) {
    result.failure_reason = `Unexpected or forbidden axioms: ${axiomCheck.unexpected.join(", ")}.`;
    writeResult();
    return;
  }

  if (solvesTarget) {
    result.target_match = targetCheckIndex !== -1;
    if (result.target_match !== true) {
      result.failure_reason =
        "solves_target was claimed but no exact-target proof check could be performed.";
      writeResult();
      return;
    }
  }

  result.status = "verified";
  writeResult();
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

try {
  main();
} catch (error) {
  const fallback: VerificationResult = {
    status: "failed",
    attempt_id: process.env.ATTEMPT_ID ?? "",
    source_sha: process.env.HEAD_SHA ?? "",
    declarations_checked: [],
    axioms: [],
    lean_version: "unknown",
    formal_conjectures_ref: "unknown",
    target_match: null,
    failure_reason: `Verifier crashed: ${error instanceof Error ? error.message.slice(0, 1000) : "unknown"}`,
  };
  mkdirSync("../out", { recursive: true });
  writeFileSync(
    "../out/verification-result.json",
    JSON.stringify(fallback, null, 2),
  );
}
