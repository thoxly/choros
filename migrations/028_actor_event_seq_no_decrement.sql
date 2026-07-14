-- 028 · actor_event_seq no-decrement guard (T-0032 E4.2) — closes FO-T0019-1.
--
-- T-0032 owns the guarded-transition writer (appendActorEvent), so it inherits
-- the T-0019 forward debt F-T0019-1 / FO-T0019-1: choros_app holds
-- GRANT UPDATE ON actor_event_seq (needed to advance next_seq under
-- SELECT … FOR UPDATE). As-is a caller could roll next_seq *backward* into an
-- unused lower slot and backfill a forged row that sorts ORDER BY seq before a
-- committed row — inverting apparent SoD order (e.g. an `approve` made to sort
-- before the `submit`) without ever violating UNIQUE(tenant_id, seq).
--
-- The structural fix (spec §3.4 option A, the preferred fix): a BEFORE UPDATE
-- trigger on actor_event_seq that REJECTS any decrement of next_seq, for ALL
-- roles including the owner choros_migrator (defence in depth — exactly the
-- actor_event_immutable pattern in 018). The forward `+1` advance (the real
-- writer path) passes unchanged. Always-on, role-agnostic, and CI-visible to
-- defeat (the DDL diff is the only way to remove it).
--
-- NOTE: the trigger targets actor_event_seq, NOT actor_event — it grants no new
-- privilege and adds no DELETE grant, so the append-only fitness checks
-- (actor_event_append_only.sh / actor_event_no_global_seq.sh) stay green.

CREATE OR REPLACE FUNCTION choros.actor_event_seq_no_decrement()
  RETURNS trigger
  LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.next_seq < OLD.next_seq THEN
    RAISE EXCEPTION 'actor_event_seq.next_seq must not decrement: % -> %',
      OLD.next_seq, NEW.next_seq
      USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END
$$;

CREATE TRIGGER actor_event_seq_no_decrement_trg
  BEFORE UPDATE ON choros.actor_event_seq
  FOR EACH ROW EXECUTE FUNCTION choros.actor_event_seq_no_decrement();
