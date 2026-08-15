import { execFileSync } from "node:child_process";

const owner = process.env.GITHUB_REPO_OWNER ?? "";
const repo = process.env.GITHUB_REPO_NAME ?? "";
const appId = process.env.GITHUB_APP_ID ?? "";

if (!owner || !repo) {
  console.error("Set GITHUB_REPO_OWNER and GITHUB_REPO_NAME.");
  process.exit(1);
}

interface RulesetRule {
  type: string;
  parameters?: Record<string, unknown>;
}

interface Ruleset {
  name: string;
  target: string;
  enforcement: string;
  conditions: Record<string, unknown>;
  rules: RulesetRule[];
  bypass_actors?: Array<Record<string, unknown>>;
}

function gh(args: string[], input?: string): string {
  return execFileSync("gh", args, {
    encoding: "utf8",
    input,
    maxBuffer: 16 * 1024 * 1024,
  });
}

function ghJson<T>(args: string[], input?: string): T {
  return JSON.parse(gh(args, input)) as T;
}

function desiredRulesets(): Ruleset[] {
  const appBypass = [
    ...(appId
      ? [
          {
            actor_id: Number(appId),
            actor_type: "Integration",
            bypass_mode: "always",
          },
        ]
      : []),
    { actor_id: 5, actor_type: "RepositoryRole", bypass_mode: "always" },
  ];
  return [
    {
      name: "inferfund-main",
      target: "branch",
      enforcement: "active",
      conditions: { ref_name: { include: ["refs/heads/main"], exclude: [] } },
      rules: [{ type: "deletion" }, { type: "non_fast_forward" }],
      bypass_actors: [],
    },
    {
      name: "inferfund-progress",
      target: "branch",
      enforcement: "active",
      conditions: {
        ref_name: { include: ["refs/heads/progress"], exclude: [] },
      },
      rules: [
        { type: "deletion" },
        { type: "non_fast_forward" },
        {
          type: "pull_request",
          parameters: {
            dismiss_stale_reviews_on_push: false,
            require_code_owner_review: false,
            require_last_push_approval: false,
            required_approving_review_count: 0,
            required_review_thread_resolution: false,
          },
        },
        {
          type: "required_status_checks",
          parameters: {
            required_status_checks: [
              { context: "inferfund-policy" },
              { context: "inferfund-verification" },
            ],
            strict_required_status_checks_policy: false,
          },
        },
      ],
      bypass_actors: [],
    },
    {
      name: "inferfund-attempt-branches",
      target: "branch",
      enforcement: "active",
      conditions: {
        ref_name: {
          include: ["refs/heads/attempt/**"],
          exclude: [],
        },
      },
      rules: [
        { type: "creation" },
        { type: "update" },
        { type: "deletion" },
        { type: "non_fast_forward" },
      ],
      bypass_actors: appBypass,
    },
  ];
}

function main(): void {
  console.log(`Configuring rulesets for ${owner}/${repo}`);
  let existing: Array<{ id: number; name: string }> = [];
  try {
    existing = ghJson<Array<{ id: number; name: string }>>([
      "api",
      `repos/${owner}/${repo}/rulesets`,
    ]);
  } catch (error) {
    console.error(
      "Cannot list rulesets. This capability may be unavailable for this " +
        "repository plan (private personal repositories on the free tier do " +
        "not support rulesets). Error:",
      error instanceof Error ? error.message.slice(0, 400) : error,
    );
    process.exit(2);
  }

  for (const desired of desiredRulesets()) {
    const found = existing.find((r) => r.name === desired.name);
    try {
      if (found) {
        ghJson(
          ["api", "-X", "PUT", `repos/${owner}/${repo}/rulesets/${found.id}`, "--input", "-"],
          JSON.stringify(desired),
        );
        console.log(`updated ruleset: ${desired.name}`);
      } else {
        ghJson(
          ["api", "-X", "POST", `repos/${owner}/${repo}/rulesets`, "--input", "-"],
          JSON.stringify(desired),
        );
        console.log(`created ruleset: ${desired.name}`);
      }
    } catch (error) {
      console.error(
        `FAILED to configure ruleset "${desired.name}":`,
        error instanceof Error ? error.message.slice(0, 600) : error,
      );
      console.error(
        "Apply the equivalent protection manually (see docs/github-security.md).",
      );
    }
  }
  console.log("Done.");
}

main();
