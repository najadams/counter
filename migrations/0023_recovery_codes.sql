-- 0023_recovery_codes.sql
-- One-time recovery code per OWNER for PIN reset.
--
-- A short alphanumeric code generated at first-run setup AND when an OWNER
-- regenerates from Settings. Stored as bcrypt hash. Used once: consumed at
-- PIN reset, then a new code is generated and shown to the OWNER.
--
-- Only relevant for OWNER role today (others can have their PIN reset by
-- an OWNER, so they don't need a self-service path). The schema doesn't
-- enforce role — service does.

ALTER TABLE workers ADD COLUMN recovery_code_hash TEXT;
ALTER TABLE workers ADD COLUMN recovery_code_set_at TEXT;
