-- Second review: transfer rejections, dispute revisions, checkout SKU.

-- A transfer request Whop refused outright (no transfer was created) is 'failed' with no
-- whop_transfer_id; last_error says why. A failed transfer WITH an id may still succeed later.
alter table seller_transfers add column last_error text;

-- Disputes apply in source order: an older event never overwrites a newer one.
alter table disputes add column source_updated_at timestamptz;

-- The SKU is part of a checkout's intent: a retry under the same request key must match it.
alter table orders add column sku text;
