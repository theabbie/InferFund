function shell(title: string, body: string): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>${title} — InferFund</title>
<style>
  :root { color-scheme: dark; }
  body { background: #09090b; color: #e4e4e7; font-family: ui-sans-serif, system-ui, sans-serif; margin: 0; }
  main { max-width: 560px; margin: 10vh auto; padding: 32px; border: 1px solid #27272a; border-radius: 12px; background: #101013; }
  h1 { font-size: 20px; margin: 0 0 16px; }
  p { font-size: 14px; line-height: 1.7; color: #a1a1aa; }
  code { background: #27272a; padding: 1px 6px; border-radius: 4px; font-size: 12px; }
  a { color: #7dd3fc; }
  .ok { color: #4ade80; font-size: 28px; }
  .err { color: #f87171; font-size: 28px; }
</style>
</head>
<body><main>${body}</main></body>
</html>`;
}

export function SuccessPage(input: {
  redirectUrl: string;
  githubLogin: string;
  collaborationStatus: string;
}): string {
  const collaborationNote =
    input.collaborationStatus === "invited"
      ? "A collaborator invitation has been sent to your GitHub account. " +
        "Accept it to clone the repository, push your own attempt branches " +
        "(attempt/u<your-id>/<problem>/<id>), and open pull requests " +
        "targeting the progress branch."
      : input.collaborationStatus === "active"
        ? "Your GitHub account is a repository collaborator: you can push " +
          "your own attempt branches and open pull requests targeting " +
          "progress."
        : "Collaborator setup is pending (the service identity is not " +
          "configured for invitations yet); read-only tools already work.";
  return shell(
    "Connected",
    `<div class="ok">✓</div>
<h1>InferFund connected</h1>
<p>GitHub authentication succeeded for <code>${escapeHtml(input.githubLogin)}</code>,
and InferFund access was granted.</p>
<p>${collaborationNote}</p>
<p>Your mathematical submissions are public, attributed to your GitHub
account, and append-only: history is never rewritten.</p>
<p><a href="${escapeHtml(input.redirectUrl)}">Return to your MCP client</a>
(you will be asked to approve the connection there).</p>
<script>setTimeout(function(){ location.href = ${JSON.stringify(input.redirectUrl)}; }, 1500);</script>`,
  );
}

export function ErrorPage(input: { title: string; detail: string }): string {
  return shell(
    "Error",
    `<div class="err">✕</div>
<h1>${escapeHtml(input.title)}</h1>
<p>${escapeHtml(input.detail)}</p>`,
  );
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}
