export default function PrivacyPage() {
  return (
    <main className="mx-auto w-full max-w-2xl flex-1 px-6 py-20">
      <h1 className="text-3xl font-semibold tracking-tight text-zinc-50">
        Data &amp; privacy
      </h1>
      <div className="mt-8 space-y-6 text-sm leading-7 text-zinc-400">
        <section>
          <h2 className="text-base font-semibold text-zinc-100">
            What InferFund stores
          </h2>
          <p className="mt-2">
            InferFund stores the minimum control-plane data needed to operate:
            your numeric GitHub user ID, login, avatar URL, authentication
            timestamps, and collaborator status; OAuth client registrations and
            hashed access/refresh tokens; attempt metadata (IDs, branches, pull
            requests, verification results); rate-limit counters; and an audit
            log of sensitive operations.
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
            <li>OAuth tokens and secrets are stored only as hashes.</li>
            <li>AI-agent conversations are not collected.</li>
            <li>Bearer tokens are never logged or accepted in query strings.</li>
          </ul>
        </section>
        <section>
          <h2 className="text-base font-semibold text-zinc-100">Deletion</h2>
          <p className="mt-2">
            Merged mathematical history is append-only by design. Account
            control-plane data (tokens, collaboration records) can be revoked
            and erased on request; content that violates law or safety policy
            may be quarantined or, where legally required, removed &mdash; both
            actions are audit-logged.
          </p>
        </section>
      </div>
    </main>
  );
}
