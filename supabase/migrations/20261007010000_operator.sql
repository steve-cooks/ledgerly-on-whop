-- Operator console: a local mirror of each seller's Whop verification (so the seller list never
-- calls Whop per row), verification reminders (in-app: shown on the seller's status page), and an
-- audit of payment-mode changes.

alter table sellers
  add column if not exists title text,                                     -- Whop account title
  add column if not exists verification_status text,                       -- verification.individual / business status
  add column if not exists outstanding_actions int not null default 0,     -- required_actions not completed
  add column if not exists verification_synced_at timestamptz;             -- as-of time of the mirrored fields

create table seller_reminders (
  id                  bigserial primary key,
  seller_external_id  text not null references sellers (external_id),
  sent_at             timestamptz not null default now(),
  sent_by             text not null,
  ok                  boolean not null,
  error               text
);
create index seller_reminders_seller_sent_at on seller_reminders (seller_external_id, sent_at desc);

create table seller_mode_changes (
  id                  bigserial primary key,
  seller_external_id  text not null references sellers (external_id),
  from_mode           text,
  to_mode             text not null,
  changed_by          text not null,
  changed_at          timestamptz not null default now()
);
create index seller_mode_changes_seller on seller_mode_changes (seller_external_id, changed_at desc);

alter table seller_reminders enable row level security;
alter table seller_mode_changes enable row level security;
