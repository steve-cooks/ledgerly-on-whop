"use client";

import Link from "next/link";
import { useActionState } from "react";
import { btnPrimary, input, label } from "@/components/styles";
import { logInAction, signUpAction, type FormState } from "./actions";

/** Email + password sign up or log in. */
export function AuthForm({ mode }: { mode: "signup" | "login" }) {
  const [state, action, pending] = useActionState<FormState, FormData>(mode === "signup" ? signUpAction : logInAction, null);

  if (state?.checkEmail) {
    return (
      <div className="space-y-2 text-sm" role="status">
        <p className="font-medium text-ink">Check your email</p>
        <p className="text-muted">
          We sent a confirmation link to <span className="font-medium text-ink">{state.checkEmail}</span>. Open it on this device to
          finish signing up.
        </p>
        <p className="text-muted">
          No email? If you already have an account with this address, <a href="/sell/login" className="font-medium text-accent-ink hover:underline">log in</a> instead
          (with Google or Whop if you signed up that way).
        </p>
      </div>
    );
  }

  return (
    <form action={action} className="space-y-4">
      <div>
        <label htmlFor="email" className={label}>
          Email
        </label>
        <input id="email" name="email" type="email" autoComplete="email" required className={input} placeholder="you@studio.com" />
      </div>
      <div>
        <label htmlFor="password" className={label}>
          Password
        </label>
        <input
          id="password"
          name="password"
          type="password"
          autoComplete={mode === "signup" ? "new-password" : "current-password"}
          minLength={8}
          required
          className={input}
          placeholder={mode === "signup" ? "At least 8 characters" : ""}
        />
      </div>
      {state?.error && (
        <p role="alert" className="text-sm text-danger">
          {state.error}
        </p>
      )}
      <button disabled={pending} className={`${btnPrimary} w-full`}>
        {pending ? "One moment…" : mode === "signup" ? "Create account" : "Log in"}
      </button>
      <p className="text-center text-sm text-muted">
        {mode === "signup" ? (
          <>
            Already selling?{" "}
            <Link href="/sell/login" className="font-medium text-accent-ink hover:underline">
              Log in
            </Link>
          </>
        ) : (
          <>
            New to Ledgerly?{" "}
            <Link href="/sell/signup" className="font-medium text-accent-ink hover:underline">
              Create an account
            </Link>
          </>
        )}
      </p>
    </form>
  );
}
