"use client";

import { useActionState } from "react";
import { btnPrimary, input, label } from "@/components/styles";
import { flag } from "@/components/ui";
import { openStoreAction, type FormState } from "../actions";

export function OpenStoreForm({ countries, email }: { countries: Record<string, string>; email: string | null }) {
  const [state, action, pending] = useActionState<FormState, FormData>(openStoreAction, null);
  return (
    <form action={action} className="space-y-4">
      <div>
        <label htmlFor="storeName" className={label}>
          Store name
        </label>
        <input id="storeName" name="storeName" required minLength={2} maxLength={60} className={input} placeholder="Golden Hour Presets" />
      </div>
      <div>
        <label htmlFor="country" className={label}>
          Country
        </label>
        <select id="country" name="country" required defaultValue="" className={input}>
          <option value="" disabled>
            Where you live or your business is registered
          </option>
          {Object.entries(countries).map(([code, name]) => (
            <option key={code} value={code}>
              {flag(code)} {name}
            </option>
          ))}
        </select>
      </div>
      {email && (
        <p className="text-xs text-muted">
          Payouts and receipts go to <span className="font-medium text-ink">{email}</span>.
        </p>
      )}
      {state?.error && (
        <p role="alert" className="text-sm text-danger">
          {state.error}
        </p>
      )}
      <button disabled={pending} className={`${btnPrimary} w-full`}>
        {pending ? "Setting up your store…" : "Continue to verification"}
      </button>
    </form>
  );
}
