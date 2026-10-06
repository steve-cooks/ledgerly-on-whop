alter table payouts add column status_detail text;
alter table payouts add column fee_amount numeric(18, 2);
alter table payouts add column net_amount numeric(18, 2);
alter table ledger_entries drop constraint ledger_entries_kind_check;
alter table ledger_entries add constraint ledger_entries_kind_check
  check (kind in ('sale', 'platform_fee', 'processing_fee', 'refund', 'transfer_in', 'payout', 'payout_reversal'));
