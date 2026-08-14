import { describe, expect, it } from "vitest";
import { validateAttemptRelativePath } from "../src/lib/attempts/paths";
import { newAttemptId } from "../src/lib/ids";

const PROBLEM = "erdos-1";

function expectOk(path: string): void {
  const id = newAttemptId();
  expect(() =>
    validateAttemptRelativePath(PROBLEM, id, `attempts/${PROBLEM}/${id}/${path}`),
  ).not.toThrow();
}

function expectRejected(path: string): void {
  const id = newAttemptId();
  expect(() =>
    validateAttemptRelativePath(PROBLEM, id, path),
  ).toThrowError(/INVALID|not allowed|never allowed|outside|unsafe|Reserved|too long|NUL|control/i);
}

describe("attempt path validation", () => {
  it("accepts files inside the attempt directory", () => {
    expectOk("README.md");
    expectOk("manifest.json");
    expectOk("artifacts/notes.md");
    expectOk("lean/Main.lean");
  });

  it("rejects path traversal", () => {
    expectRejected("attempts/erdos-1/x/../other/README.md");
    expectRejected("attempts/erdos-1/../../etc/passwd");
  });

  it("rejects absolute paths", () => {
    expectRejected("/etc/passwd");
    expectRejected("C:/windows/system32/x");
  });

  it("rejects .github paths", () => {
    expectRejected(".github/workflows/evil.yml");
    expectRejected("attempts/erdos-1/x/.github/workflows/evil.yml");
  });

  it("rejects files outside allowed roots", () => {
    const id = newAttemptId();
    expect(() =>
      validateAttemptRelativePath(
        PROBLEM,
        id,
        `attempts/${PROBLEM}/${id}/secrets.txt`,
      ),
    ).toThrow();
  });

  it("rejects non-lean files under lean/", () => {
    const id = newAttemptId();
    expect(() =>
      validateAttemptRelativePath(
        PROBLEM,
        id,
        `attempts/${PROBLEM}/${id}/lean/evil.sh`,
      ),
    ).toThrow();
  });

  it("rejects paths outside the attempt directory", () => {
    const id = newAttemptId();
    expect(() =>
      validateAttemptRelativePath(PROBLEM, id, "attempts/other/x/README.md"),
    ).toThrow();
  });

  it("rejects reserved Windows names", () => {
    const id = newAttemptId();
    expect(() =>
      validateAttemptRelativePath(
        PROBLEM,
        id,
        `attempts/${PROBLEM}/${id}/artifacts/CON.txt`,
      ),
    ).toThrow();
  });
});
