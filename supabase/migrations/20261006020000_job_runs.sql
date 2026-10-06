-- History of scheduled operations runs (reconcile + settle), newest first on the console.
create table job_runs (
  id           bigserial primary key,
  job          text not null,
  started_at   timestamptz not null default now(),
  finished_at  timestamptz,
  ok           boolean,
  summary      jsonb
);
create index job_runs_job_started_idx on job_runs (job, started_at desc);
alter table job_runs enable row level security;
