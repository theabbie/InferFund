import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { verificationResultSchema } from "./lean-check";

function gh(args: string[]): void {
  execFileSync("gh", args, { stdio: ["ignore", "inherit", "inherit"] });
}

function main(): void {
  const repo = process.env.REPO ?? "";
  const headSha = process.env.HEAD_SHA ?? "";
  const hasLean = process.env.HAS_LEAN === "true";
  const attemptId = process.env.ATTEMPT_ID ?? "";
  const solvesTarget = process.env.SOLVES_TARGET === "true";

  let conclusion = "success";
  let summary =
    "No Lean artifacts present. Contribution accepted as UNVERIFIED " +
    "mathematical material. This is structural acceptance only.";

  if (hasLean) {
    const resultPath = "result/verification-result.json";
    if (!existsSync(resultPath)) {
      conclusion = "failure";
      summary = "Lean verification produced no result artifact.";
    } else {
      let parsed: unknown;
      try {
        parsed = JSON.parse(readFileSync(resultPath, "utf8"));
      } catch {
        parsed = null;
      }
      const validated = verificationResultSchema.safeParse(parsed);
      if (!validated.success) {
        conclusion = "failure";
        summary = "Verification result artifact failed schema validation.";
      } else {
        const result = validated.data;
        if (result.attempt_id !== attemptId || result.source_sha !== headSha) {
          conclusion = "failure";
          summary =
            "Verification result binding mismatch (attempt id or source SHA). Refusing to trust it.";
        } else if (result.status === "verified") {
          if (solvesTarget && result.target_match !== true) {
            conclusion = "failure";
            summary =
              "Attempt claims solves_target but exact-target verification did not pass.";
          } else {
            conclusion = "success";
            summary = [
              "Lean verification PASSED for declared theorems: " +
                result.declarations_checked.map((d) => `\`${d.name}\``).join(", "),
              `Lean: ${result.lean_version}; FC ref: ${result.formal_conjectures_ref}`,
              `Axioms: ${result.axioms.join(", ") || "none"}`,
              result.target_match === true
                ? "Exact-target proof check PASSED."
                : "Relevance to the target remains UNREVIEWED.",
            ].join("\n");
          }
        } else if (result.status === "not_applicable") {
          conclusion = "success";
          summary =
            "Lean verification not applicable (no compilable Lean files found).";
        } else {
          conclusion = "failure";
          summary = `Lean verification FAILED: ${result.failure_reason ?? "unknown reason"}`;
        }
      }
    }
  }

  gh([
    "api",
    `repos/${repo}/check-runs`,
    "-f",
    "name=inferfund-verification",
    "-f",
    `head_sha=${headSha}`,
    "-f",
    "status=completed",
    "-f",
    `conclusion=${conclusion}`,
    "-f",
    `output[title]=InferFund verification: ${conclusion}`,
    "-f",
    `output[summary]=${summary.slice(0, 60000)}`,
  ]);
  console.log(`inferfund-verification: ${conclusion}`);
  if (conclusion !== "success") process.exit(1);
}

main();
