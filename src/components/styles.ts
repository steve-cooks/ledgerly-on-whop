// Shared styles for the marketplace's buttons and form fields.
export const btn =
  "inline-flex h-10 items-center justify-center gap-2 rounded-xl px-4 text-sm font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-60";
export const btnPrimary = `${btn} bg-ink text-white hover:bg-ink/85`;
export const btnAccent = `${btn} bg-accent text-white hover:bg-accent-ink`;
export const btnGhost = `${btn} border border-line bg-surface text-ink hover:bg-bg`;
export const input =
  "block h-10 w-full rounded-xl border border-line bg-surface px-3 text-sm text-ink outline-none placeholder:text-subtle focus:border-accent focus:ring-2 focus:ring-accent/20";
export const label = "mb-1.5 block text-sm font-medium text-ink";
