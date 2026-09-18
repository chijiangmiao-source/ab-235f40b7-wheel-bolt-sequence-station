-- 轮毂复核工位：会话与不可变确认事件
-- 幂等记录与确认事件均只追加（append-only），由触发器禁止 UPDATE/DELETE。

CREATE TABLE IF NOT EXISTS sessions (
  id           TEXT PRIMARY KEY,
  expected_seq INTEGER NOT NULL DEFAULT 1 CHECK (expected_seq BETWEEN 1 AND 7),
  status       TEXT NOT NULL DEFAULT 'in_progress'
                 CHECK (status IN ('in_progress', 'completed')),
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS confirmation_events (
  id              BIGSERIAL PRIMARY KEY,
  session_id      TEXT NOT NULL REFERENCES sessions(id),
  seq             INTEGER NOT NULL CHECK (seq BETWEEN 1 AND 6),
  position        TEXT NOT NULL,
  torque          INTEGER NOT NULL,
  idempotency_key TEXT NOT NULL,
  accepted        BOOLEAN NOT NULL,
  reason_code     TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT reason_code_set_iff_rejected CHECK (
    (accepted AND reason_code IS NULL) OR
    (NOT accepted AND reason_code IS NOT NULL)
  )
);

-- 每个序号至多存在一条被接受的事件，从数据库层面杜绝重复推进。
CREATE UNIQUE INDEX IF NOT EXISTS confirmation_events_one_accepted_per_seq
  ON confirmation_events (session_id, seq) WHERE accepted;
CREATE INDEX IF NOT EXISTS confirmation_events_session_idx
  ON confirmation_events (session_id, id);

CREATE TABLE IF NOT EXISTS idempotency_records (
  session_id      TEXT NOT NULL REFERENCES sessions(id),
  idempotency_key TEXT NOT NULL,
  request_hash    TEXT NOT NULL,
  event_id        BIGINT NOT NULL REFERENCES confirmation_events(id),
  response_json   JSONB NOT NULL,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (session_id, idempotency_key)
);

CREATE OR REPLACE FUNCTION forbid_append_only_mutation()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'table % is append-only: % is forbidden', TG_TABLE_NAME, TG_OP
    USING ERRCODE = 'insufficient_privilege';
END;
$$;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'confirmation_events_immutable') THEN
    CREATE TRIGGER confirmation_events_immutable
      BEFORE UPDATE OR DELETE ON confirmation_events
      FOR EACH ROW EXECUTE FUNCTION forbid_append_only_mutation();
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'idempotency_records_immutable') THEN
    CREATE TRIGGER idempotency_records_immutable
      BEFORE UPDATE OR DELETE ON idempotency_records
      FOR EACH ROW EXECUTE FUNCTION forbid_append_only_mutation();
  END IF;
END $$;
