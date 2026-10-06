import { env } from "@/lib/env";
import { MAX_FEE_BPS, REMINDER_COOLDOWN_MS, lastReminder, sellerDisplayName, sellerFeeSetting } from "@/lib/operator";

/** Operator-only controls shared by the console's seller list and a seller's status page. */

export function timeAgo(date: Date, now: number) {
  const s = Math.max(0, Math.round((now - date.getTime()) / 1000));
  if (s < 60) return "just now";
  const m = Math.round(s / 60);
  if (m < 60) return `${m} min ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.round(h / 24);
  return d === 1 ? "yesterday" : `${d} days ago`;
}

export function formatDate(date: Date) {
  return date.toLocaleDateString("en-US", { month: "long", day: "numeric", year: "numeric", timeZone: "UTC" });
}

function hoursUntil(date: Date, now: number) {
  return Math.max(1, Math.ceil((date.getTime() - now) / 3_600_000));
}

/** "Send reminder", or why it can't be sent right now. `now` is the request time. */
export function ReminderButton({ externalId, back, lastSentAt, now }: { externalId: string; back: string; lastSentAt: Date | null; now: number }) {
  const nextAt = lastSentAt ? new Date(lastSentAt.getTime() + REMINDER_COOLDOWN_MS) : null;
  if (nextAt && nextAt.getTime() > now) {
    return (
      <span
        className="inline-flex cursor-not-allowed items-center rounded-lg border border-line px-3 py-1.5 text-xs font-medium text-subtle"
        title={`One reminder per day. Available again in ${hoursUntil(nextAt, now)}h.`}
      >
        Reminded
      </span>
    );
  }
  return (
    <form action={`/api/operator/sellers/${encodeURIComponent(externalId)}/reminder`} method="post">
      <input type="hidden" name="back" value={back} />
      <button
        type="submit"
        className="inline-flex items-center whitespace-nowrap rounded-lg bg-ink px-3 py-1.5 text-xs font-medium text-white transition hover:opacity-90"
      >
        Send reminder
      </button>
    </form>
  );
}

const MODES = [
  { value: "direct", label: "Direct" },
  { value: "platform", label: "Platform" },
] as const;

/** "8%", "7.5%": a fee in basis points as a percentage. */
export function feePercent(bps: number) {
  return `${bps / 100}%`;
}

/** A seller's fee setting in words: "10%" or "8% (platform default)". */
export function feeLabel(feeBps: number | null) {
  return feeBps == null ? `${feePercent(env().PLATFORM_FEE_BPS)} (platform default)` : feePercent(feeBps);
}

/** What each payment mode means. Pass the seller's fee rate to name it; omit for the console legend. */
export function modeExplainer(feeBps?: number) {
  const fee = feeBps == null ? "its fee" : feePercent(feeBps);
  return {
    direct: `Buyers pay the seller's Whop account; Ledgerly keeps ${fee} as an application fee.`,
    platform: `Ledgerly collects the payment and transfers the seller's share.`,
  };
}

/** Two-option payment-mode switch. The current mode is shown pressed; the other submits. */
export function ModeToggle({ externalId, mode, back }: { externalId: string; mode: "direct" | "platform"; back: string }) {
  const explain = modeExplainer();
  return (
    <form
      action={`/api/operator/sellers/${encodeURIComponent(externalId)}/mode`}
      method="post"
      className="inline-flex rounded-lg border border-line bg-bg p-0.5 text-xs font-medium"
      aria-label="Payment mode for new purchases"
    >
      <input type="hidden" name="back" value={back} />
      {MODES.map((m) =>
        m.value === mode ? (
          <span key={m.value} aria-current="true" className="rounded-md bg-surface px-2.5 py-1 text-ink shadow-[0_1px_2px_rgba(15,26,23,0.08)]" title={explain[m.value]}>
            {m.label}
          </span>
        ) : (
          <button
            key={m.value}
            type="submit"
            name="mode"
            value={m.value}
            title={`Switch to ${m.label.toLowerCase()} for new purchases. ${explain[m.value]}`}
            className="rounded-md px-2.5 py-1 text-muted transition hover:text-ink"
          >
            {m.label}
          </button>
        ),
      )}
    </form>
  );
}

/** Set a seller's Ledgerly fee, or put them back on the platform default. */
export function FeeControl({ externalId, feeBps, back }: { externalId: string; feeBps: number | null; back: string }) {
  const action = `/api/operator/sellers/${encodeURIComponent(externalId)}/fee`;
  return (
    <div className="flex items-center gap-3">
      {feeBps != null && (
        <form action={action} method="post">
          <input type="hidden" name="back" value={back} />
          <input type="hidden" name="fee" value="default" />
          <button type="submit" className="whitespace-nowrap text-xs font-medium text-accent-ink hover:underline">
            Use default
          </button>
        </form>
      )}
      <form action={action} method="post" className="flex items-center gap-2">
        <input type="hidden" name="back" value={back} />
        <label className="flex items-center gap-1 text-sm text-muted">
          <span className="sr-only">Ledgerly fee in percent</span>
          <input
            type="text"
            name="fee"
            inputMode="decimal"
            autoComplete="off"
            maxLength={6}
            defaultValue={feeBps == null ? "" : String(feeBps / 100)}
            placeholder={String(env().PLATFORM_FEE_BPS / 100)}
            title={`0 to ${MAX_FEE_BPS / 100}%, up to 2 decimals. Leave empty for the platform default.`}
            className="w-16 rounded-lg border border-line bg-surface px-2 py-1.5 text-right text-sm tabular text-ink outline-none placeholder:text-subtle focus:border-accent"
          />
          %
        </label>
        <button
          type="submit"
          className="inline-flex items-center whitespace-nowrap rounded-lg bg-ink px-3 py-1.5 text-xs font-medium text-white transition hover:opacity-90"
        >
          Save
        </button>
      </form>
    </div>
  );
}

const MODE_NAMES = { direct: "direct charges", platform: "platform collection" };

/** The outcome of an operator action, from the redirect's query string. */
export async function OperatorNotice({ notice, seller, now }: { notice?: string; seller?: string; now: number }) {
  if (!notice) return null;
  const who = seller ? await sellerDisplayName(seller) : "The seller";
  let tone: "good" | "warn" | "bad" = "good";
  let text: string;
  switch (notice) {
    case "reminder_sent":
      text = `Reminder sent: ${who} will see it on their Ledgerly status page.`;
      break;
    case "reminder_cooldown": {
      tone = "warn";
      const last = seller ? await lastReminder(seller) : null;
      text = last
        ? `${who} was already reminded ${timeAgo(last.sent_at, now)}. You can send another in ${hoursUntil(new Date(last.sent_at.getTime() + REMINDER_COOLDOWN_MS), now)}h.`
        : `${who} was reminded in the last 24 hours.`;
      break;
    }
    case "mode_direct":
    case "mode_platform":
      text = `${who} now uses ${MODE_NAMES[notice === "mode_direct" ? "direct" : "platform"]} for new purchases. Existing orders keep their original flow.`;
      break;
    case "mode_unchanged":
      tone = "warn";
      text = `${who} was already on that payment mode. Nothing changed.`;
      break;
    case "fee_changed": {
      const fee = seller ? await sellerFeeSetting(seller) : undefined;
      text =
        fee === undefined
          ? `${who}'s Ledgerly fee was updated for new purchases. Existing orders keep their original fee.`
          : `${who}'s Ledgerly fee is now ${feeLabel(fee)} on new purchases. Existing orders keep their original fee.`;
      break;
    }
    case "fee_unchanged":
      tone = "warn";
      text = `${who} already had that Ledgerly fee. Nothing changed.`;
      break;
    case "fee_invalid":
      tone = "bad";
      text = `Enter a Ledgerly fee between 0 and ${MAX_FEE_BPS / 100}% with up to 2 decimals (like 8 or 7.5), or leave it empty for the platform default. Nothing changed.`;
      break;
    case "reminder_not_found":
    case "mode_not_found":
    case "fee_not_found":
      tone = "bad";
      text = `Seller ${who} wasn't found.`;
      break;
    default:
      tone = "bad";
      text = "Something went wrong and nothing was changed. Please try again.";
  }
  const cls = { good: "bg-accent-soft text-accent-ink", warn: "bg-warn-soft text-warn", bad: "bg-danger-soft text-danger" }[tone];
  return (
    <p role="status" className={`rounded-xl px-4 py-3 text-sm ${cls}`}>
      {text}
    </p>
  );
}

/** The time this request is rendered at (dynamic pages render once per request). */
export function requestTime() {
  return Date.now();
}
