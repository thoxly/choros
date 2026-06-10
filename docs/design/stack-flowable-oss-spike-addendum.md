# Addendum to stack-and-fleet-ops ADR — Flowable OSS-boundary spike (T-0117)

**Status: addendum, awaiting ratification (founder).**
Ratification is a founder gate (GT/RL-2); this document records the spike's measured
result and a recommendation — it does not itself change the ratified stack ADR.

- Spike: `docs/specs/T-0117-flowable-oss-spike.spec.md` (15 AC) +
  `docs/design/T-0117-flowable-oss-spike.adr.md`.
- Harness: `spikes/flowable-oss/` (isolated; nothing in Choros `src/` depends on it).
- Evidence (machine-readable): `spikes/flowable-oss/measurements.json` (per engine).
- Run date: 2026-06-10. Host: founder laptop, Docker 28.3.0 / Compose v2.38.1.
- Both stacks torn down with `down -v` after the run (no leftover containers/volumes).

---

## 1. Headline verdict

| Engine | Image (pinned, Apache 2.0) | History-cleanup in OSS | Deadletter REST in OSS | **Engine verdict** |
|--------|----------------------------|------------------------|-------------------------|--------------------|
| **Flowable 7.1.0** | `flowable/flowable-rest:7.1.0` | present, ~5.5–7.9k rec/s @300k | list + retry + **move** all present | **go** |
| **Operaton 1.0.0** | `operaton/operaton:1.0.0` | present, ~13,636 rec/s @300k | list + retry present; no dedicated *move* (parity note) | **go** |

**Both engines pass the blocking risk.** The Flowable-7 choice in the stack ADR is
**validated by experiment**: the two capabilities it depends on — history-cleanup on
our load and deadletter management via REST — are both present in the **OSS (Apache 2.0)
artifact, with no Enterprise key** (RL-3 honoured: no trials, no registrations).

**Recommendation: keep Flowable 7 as the primary engine.** Operaton is a **valid,
viable fallback** (it also passes; cleanup is actually faster), but Flowable is
recommended because its deadletter REST surface is a closer fit to the requirement (see §6).

---

## 2. Per-AC result (against `measurements.json`)

| AC | Capability / artifact | Flowable | Operaton | Source |
|----|------------------------|----------|----------|--------|
| AC-1 | Environment comes up | ✅ REST 200 from public image | ✅ REST 200 from public image | `run.sh up` |
| AC-2 / AC-11 | License = Apache 2.0, no enterprise key | ✅ `Bundle-License: apache.org/licenses/LICENSE-2.0` in engine jar | ✅ Apache 2.0 | `license_ok:true` |
| AC-3 | ≥300k completed instances seeded, count matches | ✅ 300000 / 300000 | ✅ 300000 / 300000 | `n_history_actual` |
| AC-4 | History-cleanup present in OSS (not enterprise) | ✅ scheduled timer-job, driven via public REST | ✅ `POST /history/cleanup` | `cleanup_present_in_oss:true` |
| AC-5 | Cleanup throughput → 70M/year fits with headroom | ✅ ~5.5–7.9k rec/s, headroom ~2,000–3,000× | ✅ ~13,636 rec/s, headroom ~5,119× | `cleanup_throughput_rps`, `extrapolation` |
| AC-6 | Cleanup without degradation | ✅ row count → plateau, deterministic finish | ✅ same | `degradation_ok:true` |
| AC-7 | Deadletter list via REST OSS | ✅ HTTP 200, count≥1 | ✅ HTTP 200 (`job?withException=true`), count≥1 | `deadletter.list` |
| AC-8 | Deadletter retry/set-retries via REST OSS | ✅ HTTP 204 (action=move / set-retries) | ✅ HTTP 204 (`PUT /job/{id}/retries`) | `deadletter.retry` |
| AC-9 | Deadletter move/return via REST OSS | ✅ HTTP 204 (`action=move` — dedicated deadletter-job move) | ⚠️ no dedicated *move*; return-to-active = set-retries (parity note) | `deadletter.move` |
| AC-10 | Operaton: same harness run | ✅ AC-1..AC-9 exercised on Operaton | — | `engines[operaton]` |
| AC-12 | Machine-readable measurements journal | ✅ both engines in `measurements.json` | ✅ | file present |
| AC-13 | Verdict addendum (this file) | ✅ | ✅ | this file |
| AC-14 | Isolation from prod code | ✅ diff only under `spikes/` + this addendum | ✅ | FF-ISOLATION |
| AC-15 | Idempotent up/down, disposable volumes | ✅ `down -v` removes volume; re-up clean | ✅ | FF-SMOKE-DOWN |

Summary verdict rule (spec §5): go for Flowable needs AC-2,4,7,8,9 = OSS **and** AC-5/6
in norm. **All satisfied for Flowable.** Operaton satisfies the same set (with the AC-9
parity nuance below, which does not block).

---

## 3. Measurement methodology (reproducible)

- **Seeding (FR-2/AC-3):** history is created by batch `INSERT … SELECT generate_series`
  directly into the engine history tables (`ACT_HI_PROCINST` + `ACT_HI_ACTINST`), in
  10,000-row batches — **not** by starting 300k real instances through REST (that takes
  hours on a laptop; ADR §3.1 / R2). 300k rows seed in ~14s. Rows are made immediately
  cleanup-eligible: Flowable `END_TIME_` set 400 days old (> `cleaningAfter=1d`);
  Operaton `REMOVAL_TIME_` set in the past (Camunda-7 removal-time strategy).
- **Cleanup trigger (AC-4):**
  - Flowable: history-cleanup is a **scheduled timer-job** (`enable-history-cleaning=true`),
    not a REST endpoint. The harness drives it deterministically by moving the
    `bpmn-/cmmn-history-cleanup` timer-job to the executable queue via the **public OSS
    management REST** (`POST /management/timer-jobs/{id}` action=move), then executing any
    resulting history-jobs. The auto-cron is set to yearly so it never fires mid-seed.
  - Operaton: `POST /engine-rest/history/cleanup?immediatelyDue=true&executeAtOnce=true`
    (public OSS REST) schedules and runs the cleanup job at once.
- **Throughput measure (AC-5/6):** record `count(ACT_HI_PROCINST)` and table size before;
  trigger cleanup; poll count every 5s until plateau; `throughput = deleted / duration`.
  Flowable: 300,000 deleted in ~38–55s (~5,454–7,895 rec/s across runs; the committed
  `measurements.json` records the last run at 5,454 rec/s — throughput varies with laptop
  load, both ends of the band pass with thousands-× headroom). Operaton: 300,000 in 22s
  (~13,636 rec/s).
  Both reached count=0 deterministically (no unbounded growth, no hang).
- **Deadletter (AC-7/8/9):** deploy a failing service-task BPMN (delegate class that does
  not exist), start an instance, set `retries=0` → the job lands in deadletter (Flowable
  `ACT_RU_DEADLETTER_JOB`) / becomes a failed job with an incident (Operaton). Then the
  three operations are exercised **only through the public OSS REST**, recording HTTP code
  and post-effect.

---

## 4. Extrapolation to 70M completed/year (explicit, refutable assumptions)

The 70M figure is the **fleet** annual volume (T-0117). Per spec §6 / ADR §3.3, the
spike measures throughput at N=300k and extrapolates with assumptions that are **part of
the verdict and may be overturned at ratification**:

- **`contour_fraction = 0.2`** — under silo deployment the 70M fleet history is split
  across contours; one contour clears a fraction. Conservative; tune to real fleet shape.
- **`dev_factor = 0.5`** — a contour Postgres on NVMe is assumed *at least* as fast as the
  dev laptop; we **halve** the measured dev throughput as a deliberately conservative floor
  (we do **not** assume prod is faster).
- **`window`** — cleanup is a **background nightly batch** (8h), not an online path; 365
  nights/year of capacity.
- **`linearity`** — single measured N point this run; throughput assumed linear in volume.
  *Refutable:* a second point (e.g. N and N/3) would confirm/deny; the row-count→0 curve
  observed here was steady (no per-batch slowdown), consistent with near-linear behaviour.

Result with these assumptions:
- **Flowable:** per-contour year = 14M rows; adjusted rate ≈ 2,700–3,950 rec/s; one 8h
  window clears ~78–114M; ×365 nights ≫ 14M → **headroom ≈ 2,000–3,000×** (committed run
  ≈ 2,048×). Fits with enormous margin.
- **Operaton:** **headroom ≈ 5,119×**.

Even collapsing every conservative assumption (single contour holds the full 70M, dev rate
not halved, one nightly window), both engines clear 70M in a single night with large margin.
**70M/year is not a cleanup-throughput risk for either engine.**

> **Assumption recorded for ratification (refutable):** seeded history is deleted by
> cleanup the same way engine-produced history is. The spike confirms cleanup *does* drop
> the seeded row count to zero deterministically, but a future integration task (§ next)
> should re-confirm against engine-produced history including child tables.

---

## 5. Caveats / honest notes (do not hide)

- **Disk reclaim ≠ row deletion.** `table_size_after_bytes == table_size_before_bytes` in
  both runs: Postgres frees rows logically on `DELETE` but does not shrink the heap without
  `VACUUM (FULL)`; autovacuum reclaims lazily. This is **expected** and **not** a degradation
  failure (the cleanup *capability* and *row-throughput* are what the spike tests). Fleet-ops
  should ensure autovacuum is tuned for the history tables (out of scope here, ADR §2).
- **Child-table cascade depth is modelled, not exhaustive.** The seed inserts
  `ACT_HI_PROCINST` (+1 `ACT_HI_ACTINST` per instance). Real instances spread across more
  history tables (variables, tasks, identitylinks). The integration task should validate
  cleanup throughput against fuller history; the per-row rate here is a sound lower bound
  for the dominant tables.
- **Flowable cleanup is config-/job-driven, not a one-shot REST call.** It is fully present
  in OSS, but operating it = enabling `history-cleaning` + a cron, or driving the timer-job.
  Fleet-ops runbook (ADR §2) owns the schedule.

---

## 6. Recommendation: Flowable vs Operaton

**Primary: Flowable 7 (as in the stack ADR). Fallback: Operaton — valid and ready.**

Both are Apache 2.0, both pass all blocking capabilities in OSS, both clear 70M/year with
massive headroom. Decision factors from the measurements:

- **Deadletter fit (decisive):** Flowable has a **first-class deadletter job concept** with
  a dedicated REST surface — `GET/POST /management/deadletter-jobs` and an explicit
  `action=move` to return a dead job to the executable/timer queue (AC-9 *dedicated* move).
  Operaton (Camunda-7 model) has **no separate deadletter queue**: a job that exhausts
  retries stays a failed job with an incident; "return to active" is `set-retries`. That
  covers list+retry (AC-7/8) cleanly, but there is **no dedicated move** semantic (AC-9 is
  satisfied only by parity via set-retries). For Choros' deadletter management story,
  Flowable's explicit model is the better fit.
- **Cleanup throughput:** Operaton was faster here (~13.6k vs ~7.9k rec/s), but both are so
  far above the requirement (thousands of × headroom) that throughput is **not** a
  differentiator.
- **License / lock-in:** equal (both Apache 2.0, no enterprise key needed).

→ **Keep Flowable 7 primary; retain Operaton as a de-risked fallback** that has now been
demonstrated to work under the same probes, should Flowable maturity/maintenance ever change.

---

## 7. Open questions for the founder (ratification)

1. Accept the extrapolation assumptions in §4 (`contour_fraction=0.2`, `dev_factor=0.5`,
   nightly 8h window)? They are conservative; both engines pass even if all are dropped.
2. Confirm: deadletter "move" semantics matter enough to keep Flowable primary over the
   (faster-cleanup) Operaton? The spike's recommendation says yes.
3. Ratify Flowable 7 (primary) / Operaton (fallback) for the integration task ("Порядок
   работ" п.5), unblocking it.
