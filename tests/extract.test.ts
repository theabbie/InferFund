import { describe, expect, it } from "vitest";
import { extractProblemsFromLeanFile } from "../src/lib/problems/extract";
import {
  scanLeanSourceForAdmissions,
  checkAxiomsAgainstPolicy,
} from "../verifier/lean-check";

const SAMPLE = `import FormalConjecturesUtil

/-!
# Erdős Problem 42

*Reference:* [erdosproblems.com/42](https://www.erdosproblems.com/42)
-/

/--
Some human statement about the problem.
-/
@[category research open, AMS 5 11]
theorem erdos_42 : ∀ n : ℕ, n > 0 → n + 0 = n := by
  intro n _; simp

/--
A solved variant.
-/
@[category research solved, AMS 5]
theorem erdos_42.variant : True := by
  trivial
`;

describe("Formal Conjectures extraction", () => {
  it("extracts declarations with category attributes", () => {
    const problems = extractProblemsFromLeanFile({
      path: "FormalConjectures/ErdosProblems/42.lean",
      content: SAMPLE,
      source: "formal-conjectures",
    });
    expect(problems).toHaveLength(2);
    const main = problems.find((p) => p.upstreamDeclaration === "erdos_42");
    expect(main).toBeDefined();
    expect(main?.problemKey).toBe("erdos-42");
    expect(main?.openStatus).toBe("open");
    expect(main?.amsTags).toEqual(["5", "11"]);
    expect(main?.statementText).toContain("∀ n : ℕ");
    expect(main?.statementText).not.toContain(":=");
    expect(main?.statementHash).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(main?.humanStatement).toContain("human statement");
    expect(main?.sourceUrl).toBe("https://www.erdosproblems.com/42");
    expect(main?.upstreamModule).toBe("FormalConjectures.ErdosProblems.42");
  });

  it("marks solved problems", () => {
    const problems = extractProblemsFromLeanFile({
      path: "FormalConjectures/ErdosProblems/42.lean",
      content: SAMPLE,
      source: "formal-conjectures",
    });
    const variant = problems.find(
      (p) => p.upstreamDeclaration === "erdos_42.variant",
    );
    expect(variant?.openStatus).toBe("solved");
    expect(variant?.problemKey).toBe("erdos-42-variant");
  });

  it("ignores declarations without category attributes", () => {
    const problems = extractProblemsFromLeanFile({
      path: "FormalConjectures/Other/X.lean",
      content: "theorem helper : True := by trivial\n",
      source: "formal-conjectures",
    });
    expect(problems).toHaveLength(0);
  });
});

describe("Lean admission scanning", () => {
  it("rejects sorry", () => {
    expect(
      scanLeanSourceForAdmissions("theorem t : True := by\n  sorry"),
    ).toContain("sorry");
  });

  it("rejects admit", () => {
    expect(scanLeanSourceForAdmissions("theorem t : True := admit")).toContain(
      "admit",
    );
  });

  it("rejects sorryAx", () => {
    expect(
      scanLeanSourceForAdmissions("axiom cheat : True\n#check sorryAx"),
    ).toContain("sorryAx");
  });

  it("does not flag sorry in comments or strings", () => {
    expect(
      scanLeanSourceForAdmissions("-- this is not a sorry\n/- sorry -/\ntheorem t : True := by\n  trivial"),
    ).toEqual([]);
  });

  it("accepts clean proofs", () => {
    expect(
      scanLeanSourceForAdmissions("theorem t : True := by\n  trivial"),
    ).toEqual([]);
  });
});

describe("axiom policy", () => {
  it("accepts standard Mathlib axioms", () => {
    const result = checkAxiomsAgainstPolicy(
      ["propext", "Classical.choice", "Quot.sound"],
      ["propext", "Classical.choice", "Quot.sound"],
    );
    expect(result.ok).toBe(true);
  });

  it("rejects sorryAx even when allowlist is broad", () => {
    const result = checkAxiomsAgainstPolicy(
      ["sorryAx", "propext"],
      ["propext", "Classical.choice", "Quot.sound", "sorryAx"],
    );
    expect(result.ok).toBe(false);
    expect(result.unexpected).toContain("sorryAx");
  });

  it("rejects unexpected custom axioms", () => {
    const result = checkAxiomsAgainstPolicy(
      ["MyCustomAxiom"],
      ["propext", "Classical.choice", "Quot.sound"],
    );
    expect(result.ok).toBe(false);
    expect(result.unexpected).toEqual(["MyCustomAxiom"]);
  });
});
