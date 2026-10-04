"use client";

import { useActionState, useState } from "react";
import { useFormStatus } from "react-dom";

import { createClient } from "@/lib/supabase/client";
import { sendMagicLink, type MagicLinkState } from "./actions";

function SubmitButton({ children }: { children: React.ReactNode }) {
  const { pending } = useFormStatus();
  return (
    <button
      type="submit"
      disabled={pending}
      className="w-full rounded-lg bg-brand px-4 py-2.5 text-sm font-medium text-white transition hover:opacity-90 disabled:opacity-50"
    >
      {pending ? "Working…" : children}
    </button>
  );
}

export function GoogleButton() {
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  async function signIn() {
    setPending(true);
    setError(null);
    const supabase = createClient();
    const { error } = await supabase.auth.signInWithOAuth({
      provider: "google",
      options: {
        redirectTo: `${window.location.origin}/auth/callback`,
        queryParams: { prompt: "select_account" },
      },
    });
    if (error) {
      setError(error.message);
      setPending(false);
    }
  }

  return (
    <div>
      <button
        onClick={signIn}
        disabled={pending}
        className="flex w-full items-center justify-center gap-3 rounded-lg border border-line bg-white px-4 py-2.5 text-sm font-medium text-ink transition hover:bg-stone-50 disabled:opacity-50"
      >
        <svg viewBox="0 0 24 24" aria-hidden className="h-4 w-4">
          <path fill="#4285F4" d="M23.5 12.3c0-.8-.1-1.6-.2-2.3H12v4.5h6.5a5.6 5.6 0 0 1-2.4 3.7v3h3.9c2.3-2.1 3.5-5.2 3.5-8.9Z" />
          <path fill="#34A853" d="M12 24c3.2 0 5.9-1.1 7.9-2.9l-3.9-3c-1.1.7-2.4 1.2-4 1.2-3.1 0-5.7-2.1-6.6-4.9H1.4v3.1A12 12 0 0 0 12 24Z" />
          <path fill="#FBBC05" d="M5.4 14.4a7.2 7.2 0 0 1 0-4.6V6.7H1.4a12 12 0 0 0 0 10.8l4-3.1Z" />
          <path fill="#EA4335" d="M12 4.8c1.8 0 3.3.6 4.6 1.8l3.4-3.4A12 12 0 0 0 1.4 6.7l4 3.1C6.3 7 8.9 4.8 12 4.8Z" />
        </svg>
        Continue with Google
      </button>
      {error ? <p className="mt-2 text-sm text-red-700">{error}</p> : null}
    </div>
  );
}

const INITIAL: MagicLinkState = { status: "idle", message: "" };

export function EmailLinkForm() {
  const [state, action] = useActionState(sendMagicLink, INITIAL);

  if (state.status === "sent") {
    return (
      <div className="rounded-lg border border-line bg-brand-soft px-4 py-3 text-sm text-ink">
        {state.message}
      </div>
    );
  }

  return (
    <form action={action} className="space-y-3">
      <div>
        <label
          htmlFor="email"
          className="mb-1.5 block text-sm font-medium text-ink"
        >
          Or get a one-time link by email
        </label>
        <input
          id="email"
          name="email"
          type="email"
          required
          autoComplete="email"
          placeholder="you@example.com"
          className="w-full rounded-lg border border-line bg-white px-3 py-2.5 text-sm outline-none focus:border-brand"
        />
      </div>
      <SubmitButton>Email me a link</SubmitButton>
      {state.status !== "idle" ? (
        <p
          className={
            state.status === "not-invited"
              ? "text-sm text-ink"
              : "text-sm text-red-700"
          }
        >
          {state.message}
        </p>
      ) : null}
    </form>
  );
}
