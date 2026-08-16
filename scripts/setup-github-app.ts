import { createServer } from "node:http";
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";

const PORT = 4820;
const BASE_URL = process.env.INFERFUND_BASE_URL ?? "https://inferfund.vercel.app";

interface AppCredentials {
  id: number;
  slug: string;
  client_id: string;
  client_secret: string;
  pem: string;
  webhook_secret: string;
  html_url: string;
}

function manifest(): Record<string, unknown> {
  return {
    name: `inferfund-${process.env.GITHUB_REPO_NAME ?? "app"}`.toLowerCase().slice(0, 32),
    url: BASE_URL,
    description:
      "InferFund service identity: creates attempt branches, pull requests, " +
      "checks, and attestations for the append-only mathematical record.",
    public: false,
    redirect_url: `http://localhost:${PORT}/callback`,
    setup_url: `http://localhost:${PORT}/installed`,
    callback_urls: [
      `${BASE_URL}/auth/github/callback`,
      "http://localhost:3000/auth/github/callback",
    ],
    hook_attributes: {
      url: `${BASE_URL}/api/github/webhook`,
      active: true,
    },
    default_permissions: {
      contents: "write",
      pull_requests: "write",
      checks: "write",
      issues: "write",
      administration: "write",
      metadata: "read",
    },
    default_events: ["pull_request"],
  };
}

function page(body: string): string {
  return `<!doctype html><html><head><meta charset="utf-8"><title>InferFund setup</title>
<style>body{background:#09090b;color:#e4e4e7;font-family:system-ui;margin:0}
main{max-width:640px;margin:10vh auto;padding:32px;border:1px solid #27272a;border-radius:12px}
code{background:#27272a;padding:1px 6px;border-radius:4px;font-size:12px}
a{color:#7dd3fc}</style></head><body><main>${body}</main></body></html>`;
}

async function convertCode(code: string): Promise<AppCredentials> {
  const res = await fetch(
    `https://api.github.com/app-manifests/${code}/conversions`,
    {
      method: "POST",
      headers: {
        accept: "application/vnd.github+json",
        "user-agent": "inferfund-setup",
      },
    },
  );
  if (!res.ok) {
    throw new Error(`manifest conversion failed: ${res.status} ${await res.text()}`);
  }
  return (await res.json()) as AppCredentials;
}

function upsertEnv(entries: Record<string, string>): void {
  const path = ".env";
  let current = existsSync(path) ? readFileSync(path, "utf8") : "";
  for (const [key, value] of Object.entries(entries)) {
    const line = `${key}=${value}`;
    const re = new RegExp(`^${key}=.*$`, "m");
    current = re.test(current) ? current.replace(re, line) : current + line + "\n";
  }
  writeFileSync(path, current);
}

async function main(): Promise<void> {
  const state = randomBytes(16).toString("hex");
  const manifestJson = JSON.stringify(manifest());
  let installationId: string | null = null;

  const credentialsPromise = new Promise<AppCredentials>((resolve, reject) => {
    const server = createServer((req, res) => {
      const url = new URL(req.url ?? "/", `http://localhost:${PORT}`);
      if (url.pathname === "/") {
        res.writeHead(200, { "content-type": "text/html" });
        res.end(
          page(`
<h1>InferFund GitHub App setup</h1>
<p>Clicking below creates the InferFund GitHub App in <em>your</em> GitHub
account (nothing exists until you confirm on GitHub).</p>
<form id="f" method="post" action="https://github.com/settings/apps/new?state=${state}">
  <input type="hidden" name="manifest" id="m" />
  <noscript><button type="submit">Create the GitHub App</button></noscript>
</form>
<script>
  document.getElementById("m").value = ${JSON.stringify(manifestJson)};
  document.getElementById("f").submit();
</script>
<p>After creating it, GitHub will ask you to <strong>install</strong> the app
on the repository — accept that too.</p>`),
        );
        return;
      }
      if (url.pathname === "/callback") {
        const code = url.searchParams.get("code");
        const returnedState = url.searchParams.get("state");
        if (!code || returnedState !== state) {
          res.writeHead(400, { "content-type": "text/html" });
          res.end(page("<h1>Invalid setup callback</h1>"));
          return;
        }
        convertCode(code)
          .then((creds) => {
            res.writeHead(200, { "content-type": "text/html" });
            res.end(
              page(`<h1>App created: ${creds.slug}</h1>
<p>Now <strong>install it on your repository</strong>:</p>
<p><a href="https://github.com/apps/${creds.slug}/installations/new">
Install ${creds.slug}</a></p>
<p>Return here after installing; this page completes automatically.</p>`),
            );
            resolve(creds);
          })
          .catch(reject);
        return;
      }
      if (url.pathname === "/installed") {
        installationId = url.searchParams.get("installation_id");
        res.writeHead(200, { "content-type": "text/html" });
        res.end(
          page(`<h1>Installation recorded.</h1>
<p>You can close this tab. Check the terminal for the next steps.</p>`),
        );
        server.close();
        return;
      }
      res.writeHead(404);
      res.end();
    });
    server.listen(PORT, () => {
      console.log(`\nOpen this URL in the browser where you are logged into GitHub:\n`);
      console.log(`  http://localhost:${PORT}/\n`);
      try {
        execFileSync("open", [`http://localhost:${PORT}/`]);
      } catch {
        void 0;
      }
    });
  });

  const creds = await credentialsPromise;
  console.log(`App created: ${creds.slug} (id ${creds.id})`);
  console.log("Waiting for installation on the repository...");

  await new Promise<void>((resolve) => {
    const check = setInterval(() => {
      if (installationId !== null) {
        clearInterval(check);
        resolve();
      }
    }, 500);
    setTimeout(() => {
      clearInterval(check);
      resolve();
    }, 3 * 60 * 1000);
  });

  if (!installationId) {
    console.log(
      "No installation callback captured. Find the installation ID with:\n" +
        `  gh api repos/${process.env.GITHUB_REPO_OWNER ?? "<owner>"}/${process.env.GITHUB_REPO_NAME ?? "<repo>"}/installations --jq '.[] | select(.app_slug=="${creds.slug}") | .id'`,
    );
  }

  const envValues: Record<string, string> = {
    GITHUB_APP_ID: String(creds.id),
    GITHUB_APP_CLIENT_ID: creds.client_id,
    GITHUB_APP_CLIENT_SECRET: creds.client_secret,
    GITHUB_APP_PRIVATE_KEY: `"${creds.pem.replace(/\n/g, "\\n")}"`,
    GITHUB_APP_WEBHOOK_SECRET: creds.webhook_secret ?? "",
  };
  if (installationId) {
    envValues.GITHUB_APP_INSTALLATION_ID = installationId;
  }
  upsertEnv(envValues);
  console.log("\nWrote app credentials to .env:");
  for (const key of Object.keys(envValues)) console.log(`  ${key}`);

  console.log("\nTo configure the Vercel production project, run:");
  for (const [key, value] of Object.entries(envValues)) {
    const printable = value.replace(/"/g, "").replace(/\n/g, "\\n");
    console.log(
      `  printf '%s' '${printable.slice(0, 40)}…' | vercel env add ${key} production`,
    );
  }
  console.log(
    "\n(The printed values are truncated above; take the real values from .env.)",
  );
  console.log(
    "\nThen re-run rulesets so the App may write attempt branches:\n" +
      "  npm run configure:rulesets\n" +
      "and redeploy: vercel deploy --prod",
  );
  process.exit(0);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
