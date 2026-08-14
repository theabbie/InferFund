export function ConsentPage(input: {
  clientName: string;
  clientId: string;
  scopes: string[];
  resource: string;
  query: string;
}): string {
  const scopeRows = input.scopes
    .map((scope) => {
      const label =
        scope === "inferfund:read"
          ? "Read problems, attempts, and research frontiers"
          : scope === "inferfund:contribute"
            ? "Create and submit research attempts under your GitHub identity"
            : scope;
      return `<li><code>${escapeHtml(scope)}</code> — ${escapeHtml(label)}</li>`;
    })
    .join("\n");
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>Authorize — InferFund</title>
<style>
  :root { color-scheme: dark; }
  body { background: #09090b; color: #e4e4e7; font-family: ui-sans-serif, system-ui, sans-serif; margin: 0; }
  main { max-width: 560px; margin: 8vh auto; padding: 32px; border: 1px solid #27272a; border-radius: 12px; background: #101013; }
  h1 { font-size: 20px; margin: 0 0 4px; }
  .sub { color: #a1a1aa; font-size: 14px; margin-bottom: 24px; }
  ul { padding-left: 20px; font-size: 14px; line-height: 1.9; }
  code { background: #27272a; padding: 1px 6px; border-radius: 4px; font-size: 12px; }
  form { margin-top: 28px; display: flex; gap: 12px; }
  button { cursor: pointer; border-radius: 8px; padding: 10px 18px; font-size: 14px; border: 1px solid #3f3f46; }
  .approve { background: #fafafa; color: #09090b; border: none; font-weight: 600; }
  .deny { background: transparent; color: #a1a1aa; }
  .note { margin-top: 24px; font-size: 12px; color: #71717a; line-height: 1.6; }
</style>
</head>
<body>
<main>
  <h1>InferFund</h1>
  <p class="sub">Donate inference to mathematical progress.</p>
  <p><strong>${escapeHtml(input.clientName)}</strong> wants to access InferFund
  with your GitHub identity.</p>
  <p style="font-size:14px">Requested permissions:</p>
  <ul>${scopeRows}</ul>
  <form method="POST" action="/oauth/authorize${escapeHtml(input.query)}">
    <button class="approve" type="submit" name="approve" value="true">
      Continue with GitHub
    </button>
  </form>
  <p class="note">
    You will be redirected to GitHub to authenticate. InferFund only reads
    your public GitHub identity (read:user). Repository writes are performed
    by the InferFund service identity, never with your personal token.
    Mathematical submissions are public, append-only, and attributed to your
    GitHub account. Resource: <code>${escapeHtml(input.resource)}</code>
  </p>
</main>
</body>
</html>`;
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}
