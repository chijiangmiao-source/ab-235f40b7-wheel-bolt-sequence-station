-- 轮毂复核工位：会话与不可变确认事件
-- 固定复核顺序：A1 -> B2 -> A3 -> B1 -> A2 -> B3（序号从 1 开始）

CREATE TABLE IF NOT EXISTS sessions (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  completed_at TIMESTAMPTZ,
  -- 下一个期待确认的序号，1..6；等于 7 表示六颗全部确认、会话完成
  next_seq     INTEGER NOT NULL DEFAULT 1 CHECK (next_seq BETWEEN 1 AND 7)
);

-- 不可变确认事件：只允许 INSERT，触发器禁止 UPDATE / DELETE
CREATE TABLE IF NOT EXISTS confirmation_events (
  id              BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  session_id      UUID NOT NULL REFERENCES sessions (id),
  seq             INTEGER NOT NULL CHECK (seq BETWEEN 1 AND 6),
  position        TEXT NOT NULL,
  torque          INTEGER NOT NULL CHECK (torque BETWEEN 4200 AND 4800),
  idempotency_key TEXT NOT NULL,
  payload_hash    TEXT NOT NULL,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  -- 序号与位置的固定对应关系，数据库层兜底
  CONSTRAINT confirmation_events_seq_position_chk CHECK (
    (seq = 1 AND position = 'A1') OR
    (seq = 2 AND position = 'B2') OR
    (seq = 3 AND position = 'A3') OR
    (seq = 4 AND position = 'B1') OR
    (seq = 5 AND position = 'A2') OR
    (seq = 6 AND position = 'B3')
  ),
  -- 每个会话每个序号只记录一次
  CONSTRAINT confirmation_events_session_seq_key UNIQUE (session_id, seq),
  -- 每个会话每个幂等键只记录一次
  CONSTRAINT confirmation_events_session_idem_key UNIQUE (session_id, idempotency_key)
);

CREATE OR REPLACE FUNCTION reject_event_mutation() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'confirmation_events 为不可变事件表，禁止 % 操作', TG_OP;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS confirmation_events_no_update ON confirmation_events;
CREATE TRIGGER confirmation_events_no_update
  BEFORE UPDATE ON confirmation_events
  FOR EACH ROW EXECUTE FUNCTION reject_event_mutation();

DROP TRIGGER IF EXISTS confirmation_events_no_delete ON confirmation_events;
CREATE TRIGGER confirmation_events_no_delete
  BEFORE DELETE ON confirmation_events
  FOR EACH ROW EXECUTE FUNCTION reject_event_mutation();
