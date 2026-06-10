# `spikes/flowable-oss/` — Flowable OSS-boundary spike harness (T-0117)

> **SPIKE, NOT PRODUCTION.** This directory exists only to answer a blocking
> go/no-go question for the stack ADR. Nothing here is imported by Choros `src/`,
> the production `docker-compose`, or production CI. See
> `docs/design/T-0117-flowable-oss-spike.adr.md`.

## What it proves

Two capabilities the Flowable-7 stack choice depends on, verified to be present in
the **OSS (Apache 2.0) artifact without any Enterprise key** (RL-3 — no trials):

1. **history-cleanup on our load** — throughput + degradation, extrapolated to 70M/year.
2. **deadletter management via REST** — list / retry / move.

The same harness runs against the fallback engine **Operaton** (Camunda 7 fork).
Output = `measurements.json` (per engine) + verdict addendum
`docs/design/stack-flowable-oss-spike-addendum.md` (ratified by founder, out of scope here).

## Artifacts (pinned, Apache 2.0, no enterprise keys)

| Role | Image |
|------|-------|
| Flowable REST | `flowable/flowable-rest:7.1.0` (host :8080) |
| Operaton | `operaton/operaton:1.0.0` (host :8081) |
| DB (both) | `postgres:16` (disposable named volume per stack) |

## Usage

```bash
# single-engine full run (seed N completed instances, default 300000)
./run.sh all flowable 300000
./run.sh all operaton 300000

# or step by step
./run.sh up        <engine>     # bring stack up, wait healthcheck (AC-1)
./run.sh license   <engine>     # record image+digest+license (AC-2/11)
./run.sh seed      <engine> [N] # batch-insert >=N completed instances (AC-3)
./run.sh cleanup   <engine>     # history-cleanup throughput + degradation (AC-4/5/6)
./run.sh deadletter<engine>     # deadletter list/retry/move via REST (AC-7/8/9)
./run.sh measure   <engine>     # assemble EngineResult into measurements.json (AC-12)
./run.sh down      <engine>     # tear down stack + disposable volume (AC-15)

# fast BUILD-fitness smoke (small N, minutes)
./run.sh smoke flowable
./run.sh smoke operaton
```

Tunables via env: `N_HISTORY` (default 300000), `BATCH` (10000), `POLL` (5s).

### Always clean up

This runs on the founder's laptop. After any run:

```bash
./run.sh down flowable
./run.sh down operaton
```

`down` removes containers **and** the disposable Postgres volume (FF-SMOKE-DOWN).

## How seeding works (and its assumption)

History is created by **batch `INSERT ... SELECT generate_series` into the engine
history tables** (`ACT_HI_*`), not by starting 300k real instances through REST
(that would take hours on a laptop — ADR §3.1, R2). Rows are made immediately
cleanup-eligible (Flowable `END_TIME_` 400 days old; Operaton `REMOVAL_TIME_` in the
past). **Assumption** (recorded in the addendum, refutable): inserted history is
deleted by cleanup the same way engine-produced history is — the harness verifies
this by confirming cleanup actually drops the row count.
