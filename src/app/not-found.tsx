import Link from "next/link";

export default function NotFound() {
  return (
    <main className="mx-auto flex w-full max-w-2xl flex-1 flex-col items-start justify-center px-6 py-24">
      <p className="font-mono text-xs tracking-widest text-zinc-500 uppercase">
        404
      </p>
      <h1 className="mt-3 text-3xl font-semibold tracking-tight text-zinc-50">
        This page could not be found.
      </h1>
      <p className="mt-4 text-sm leading-7 text-zinc-400">
        The MCP endpoint lives at{" "}
        <code className="rounded bg-zinc-800 px-1.5 py-0.5 text-xs">
          /api/mcp
        </code>
        . Everything else starts from{" "}
        <Link href="/" className="text-zinc-200 underline underline-offset-4">
          the landing page
        </Link>
        .
      </p>
    </main>
  );
}
