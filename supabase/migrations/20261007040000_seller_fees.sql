-- Per-seller Ledgerly fee, set by operators. Null = the platform default (PLATFORM_FEE_BPS).
-- Applies to new checkouts only: each order keeps the fee it was created with (orders.platform_fee).

alter table sellers
  add column if not exists fee_bps int check (fee_bps between 0 and 5000);

create table seller_fee_changes (
  id                  bigserial primary key,
  seller_external_id  text not null references sellers (external_id),
  from_bps            int,                                  -- null = platform default
  to_bps              int,                                  -- null = platform default
  changed_by          text not null,
  changed_at          timestamptz not null default now()
);
create index seller_fee_changes_seller on seller_fee_changes (seller_external_id, changed_at desc);

alter table seller_fee_changes enable row level security;
