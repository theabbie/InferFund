import { InferFundError } from "../errors";
import { attemptDirectory, isUuidV7 } from "../ids";

const CONTROL_CHARS = /[\u0000-\u001f\u007f]/;
const WINDOWS_RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i;

export function validateAttemptRelativePath(
  problemKey: string,
  attemptId: string,
  fullPath: string,
): void {
  const base = attemptDirectory(problemKey, attemptId);
  if (fullPath.includes("\u0000")) {
    throw new InferFundError(
      "INVALID_ARTIFACT_PATH",
      "Path contains a NUL byte.",
    );
  }
  if (CONTROL_CHARS.test(fullPath)) {
    throw new InferFundError(
      "INVALID_ARTIFACT_PATH",
      "Path contains control characters.",
    );
  }
  if (fullPath.startsWith("/") || /^[A-Za-z]:/.test(fullPath)) {
    throw new InferFundError(
      "INVALID_ARTIFACT_PATH",
      `Absolute paths are not allowed: "${fullPath}".`,
    );
  }
  const segments = fullPath.split("/");
  if (segments.some((s) => s === ".." || s === "." || s === "")) {
    throw new InferFundError(
      "INVALID_ARTIFACT_PATH",
      `Path traversal or empty segments are not allowed: "${fullPath}".`,
    );
  }
  if (segments.some((s) => WINDOWS_RESERVED.test(s.split(".")[0] ?? s))) {
    throw new InferFundError(
      "INVALID_ARTIFACT_PATH",
      `Reserved file name in path: "${fullPath}".`,
    );
  }
  if (segments.some((s) => s.length > 128) || fullPath.length > 512) {
    throw new InferFundError(
      "INVALID_ARTIFACT_PATH",
      `Path too long: "${fullPath}".`,
    );
  }
  if (segments[0] === ".github" || fullPath.includes("/.git/")) {
    throw new InferFundError(
      "INVALID_ARTIFACT_PATH",
      "Paths under .github or .git are never allowed.",
    );
  }
  if (fullPath !== base && !fullPath.startsWith(`${base}/`)) {
    throw new InferFundError(
      "INVALID_ARTIFACT_PATH",
      `Path "${fullPath}" is outside this attempt's directory.`,
    );
  }
  const rest = fullPath.slice(base.length + 1);
  if (rest === "" ) return;
  const first = rest.split("/")[0];
  const allowedRoots = new Set([
    "README.md",
    "manifest.json",
    "artifacts",
    "lean",
  ]);
  if (!allowedRoots.has(first)) {
    throw new InferFundError(
      "INVALID_ARTIFACT_PATH",
      `Only README.md, manifest.json, artifacts/ and lean/ are allowed inside an attempt; got "${first}".`,
    );
  }
  if (first === "lean" && !rest.endsWith(".lean")) {
    throw new InferFundError(
      "INVALID_ARTIFACT_PATH",
      `Only .lean files may be placed under lean/: "${rest}".`,
    );
  }
}

export function assertLeanFileName(file: string): void {
  if (!/^[A-Za-z0-9_./-]+\.lean$/.test(file) || file.includes("..")) {
    throw new InferFundError(
      "INVALID_ARTIFACT_PATH",
      `Invalid Lean file name: "${file}".`,
    );
  }
}

export function isValidAttemptId(value: string): boolean {
  return isUuidV7(value);
}
