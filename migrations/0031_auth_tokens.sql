-- 0031_auth_tokens.sql
-- Persist HTTP bearer-token sessions so a host reboot — routine under Ghana's
-- load-shedding — doesn't sign every LAN device out mid-shift. The in-memory
-- token store in src/main/ipc/session.ts stays the hot path; this table is its
-- durable backing, reloaded on boot. The idle (2h) and absolute (12h) caps
-- still apply and are enforced in session.ts. Desktop IPC sessions do not use
-- this table.

CREATE TABLE auth_tokens (
  token      TEXT    PRIMARY KEY,                 -- opaque (randomUUID), server-side lookup
  worker_id  TEXT    NOT NULL REFERENCES workers(id),
  full_name  TEXT    NOT NULL,
  role       TEXT    NOT NULL,
  device_id  TEXT    NOT NULL,                    -- remote device the token was issued to
  created_at INTEGER NOT NULL,                    -- epoch ms; absolute-age cap
  last_seen  INTEGER NOT NULL                     -- epoch ms; idle cap
);
CREATE INDEX idx_auth_tokens_lastseen ON auth_tokens(last_seen);
