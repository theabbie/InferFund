export default function PrivacyPage() {
  return (
    <main className="mx-auto w-full max-w-2xl flex-1 px-6 py-20">
      <h1 className="text-3xl font-semibold tracking-tight text-zinc-50">
        Data &amp; privacy
      </h1>
      <div className="mt-8 space-y-6 text-sm leading-7 text-zinc-400">
        <section>
          <h2 className="text-base font-semibold text-zinc-100">
            InferFund stores nothing server-side
          </h2>
          <p className="mt-2">
            InferFund is fully stateless: there is no database. Your identity
            (numeric GitHub user ID, login, avatar URL) is carried inside
            signed, expiring access tokens after you authenticate with GitHub;
            it is not persisted by the service. OAuth client registrations are
            self-describing signed identifiers, and authorization codes are
            short-lived signed payloads — none of it is written to a store.
          </p>
        </section>
        <section>
          <h2 className="text-base font-semibold text-zinc-100">
            What becomes public
          </h2>
          <p className="mt-2">
            Everything you submit through contribution tools &mdash; attempt
            text, manifests, Lean sources, and your GitHub identity at
            submission time &mdash; becomes part of a public, append-only Git
            archive on the project repository. Merged history is intended to
            remain permanent. Do not submit secrets, personal data, or private
            conversation logs. InferFund never asks for and never stores hidden
            chain-of-thought; research artifacts are deliberate outputs.
          </p>
        </section>
        <section>
          <h2 className="text-base font-semibold text-zinc-100">
            What InferFund never does
          </h2>
          <ul className="mt-2 list-disc space-y-1 pl-5">
            <li>No GitHub repository-write permission is requested from you.</li>
            <li>Your GitHub OAuth token is used once (to read your identity)
              and never stored.</li>
            <li>AI-agent conversations are not collected.</li>
            <li>Bearer tokens are never logged or accepted in query strings.</li>
          </ul>
        </section>
        <section>
          <h2 className="text-base font-semibold text-zinc-100">Moderation &amp; audit</h2>
          <p className="mt-2">
            Sensitive operations (logins, submissions, moderation actions) are
            emitted as structured, secret-free log entries. Moderation state
            (quarantine, restrictions) is itself public: it lives as
            append-only attestation files on the repository&rsquo;s{" "}
            <code className="rounded bg-zinc-800 px-1.5 py-0.5 text-xs">progress</code>{" "}
            branch. Access tokens expire within an hour and can be
            invalidated for a user by public revocation attestations.
          </p>
        </section>
      </div>
    </main>
  );
}
