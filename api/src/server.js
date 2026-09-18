import express from 'express';
import crypto from 'node:crypto';
import { pool } from './db.js';

// 固定复核顺序：每个新会话都按此顺序复核六颗螺栓
const SEQUENCE = ['A1', 'B2', 'A3', 'B1', 'A2', 'B3'];
const MIN_TORQUE = 4200; // 合格范围含边界
const MAX_TORQUE = 4800;
const PORT = Number(process.env.PORT || 3000);
const UUID_RE =
  /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;

const app = express();
app.use(express.json({ limit: '16kb' }));

function fail(res, status, code, message, extra = {}) {
  return res.status(status).json({ ok: false, error: { code, message, ...extra } });
}

function progressOf(state) {
  return {
    confirmed: state.confirmed,
    nextSeq: state.nextSeq,
    nextPosition: state.nextPosition,
    completed: state.completed,
  };
}

// 读取会话的权威进度（会话行 + 全部不可变确认事件）
async function loadState(db, sessionId) {
  const sres = await db.query(
    'SELECT id, created_at, completed_at, next_seq FROM sessions WHERE id = $1',
    [sessionId]
  );
  if (sres.rowCount === 0) return null;
  const session = sres.rows[0];
  const evres = await db.query(
    `SELECT seq, position, torque,
            idempotency_key AS "idempotencyKey",
            created_at      AS "confirmedAt"
       FROM confirmation_events
      WHERE session_id = $1
      ORDER BY seq`,
    [sessionId]
  );
  const completed = session.next_seq > SEQUENCE.length;
  return {
    sessionId: session.id,
    sequence: [...SEQUENCE],
    events: evres.rows,
    confirmed: evres.rowCount,
    nextSeq: completed ? null : session.next_seq,
    nextPosition: completed ? null : SEQUENCE[session.next_seq - 1],
    completed,
    createdAt: session.created_at,
    completedAt: session.completed_at,
  };
}

app.get('/api/health', async (req, res) => {
  try {
    await pool.query('SELECT 1');
    res.json({ ok: true, db: 'up' });
  } catch {
    res.status(503).json({ ok: false, db: 'down' });
  }
});

// 开始一个新的复核会话
app.post('/api/sessions', async (req, res, next) => {
  try {
    const { rows } = await pool.query('INSERT INTO sessions DEFAULT VALUES RETURNING id');
    const state = await loadState(pool, rows[0].id);
    res.status(201).json({ ok: true, ...state });
  } catch (err) {
    next(err);
  }
});

// 查询会话权威进度（页面刷新后以此为准）
app.get('/api/sessions/:id', async (req, res, next) => {
  try {
    if (!UUID_RE.test(req.params.id)) {
      return fail(res, 404, 'session_not_found', '会话不存在或已过期');
    }
    const state = await loadState(pool, req.params.id);
    if (!state) return fail(res, 404, 'session_not_found', '会话不存在或已过期');
    res.json({ ok: true, ...state });
  } catch (err) {
    next(err);
  }
});

// 提交一颗螺栓的确认（幂等、按序、失败不推进）
app.post('/api/sessions/:id/confirmations', async (req, res, next) => {
  const sessionId = req.params.id;
  if (!UUID_RE.test(sessionId)) {
    return fail(res, 404, 'session_not_found', '会话不存在或已过期');
  }
  const body = req.body && typeof req.body === 'object' ? req.body : {};
  const { seq, position, torque, idempotencyKey } = body;

  // 载荷形状校验（不触碰状态，失败同样不推进）
  if (!Number.isInteger(seq) || seq < 1) {
    return fail(res, 400, 'invalid_seq', '序号必须为从 1 开始的整数');
  }
  if (typeof position !== 'string' || !SEQUENCE.includes(position)) {
    return fail(res, 400, 'invalid_position', `位置码无效，合法值为 ${SEQUENCE.join('、')}`);
  }
  if (!Number.isInteger(torque)) {
    return fail(res, 400, 'invalid_torque', '扭矩必须为整数（cN·m）');
  }
  if (
    typeof idempotencyKey !== 'string' ||
    idempotencyKey.length === 0 ||
    idempotencyKey.length > 128
  ) {
    return fail(res, 400, 'invalid_idempotency_key', '幂等键缺失或非法');
  }

  const payloadHash = crypto
    .createHash('sha256')
    .update(`${seq}|${position}|${torque}`)
    .digest('hex');

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    // 会话行级锁：串行化同一会话的并发提交，保证序号唯一推进
    const sres = await client.query(
      'SELECT next_seq FROM sessions WHERE id = $1 FOR UPDATE',
      [sessionId]
    );
    if (sres.rowCount === 0) {
      await client.query('ROLLBACK');
      return fail(res, 404, 'session_not_found', '会话不存在或已过期');
    }
    const expected = sres.rows[0].next_seq;
    const expectedPosition = expected <= SEQUENCE.length ? SEQUENCE[expected - 1] : null;

    // 幂等优先：同一幂等键 + 完全相同载荷 → 返回原确认；同键不同载荷 → 冲突
    const dup = await client.query(
      'SELECT payload_hash FROM confirmation_events WHERE session_id = $1 AND idempotency_key = $2',
      [sessionId, idempotencyKey]
    );
    if (dup.rowCount > 0) {
      if (dup.rows[0].payload_hash === payloadHash) {
        const state = await loadState(client, sessionId);
        await client.query('COMMIT');
        return res.status(200).json({
          ok: true,
          replayed: true,
          message: '相同幂等键与载荷的重复提交：返回原确认，未重复推进',
          event: state.events.find((e) => e.idempotencyKey === idempotencyKey),
          progress: progressOf(state),
        });
      }
      await client.query('ROLLBACK');
      return fail(res, 409, 'idempotency_conflict', '同一幂等键对应了不同的载荷，已拒绝，未推进', {
        expectedSeq: expectedPosition ? expected : null,
        expectedPosition,
      });
    }

    if (expected > SEQUENCE.length) {
      await client.query('ROLLBACK');
      return fail(res, 409, 'session_completed', '六颗螺栓均已确认，会话已完成，不再接受新的提交');
    }

    // 只接受当前期待序号：较小为迟到，较大为越序
    if (seq < expected) {
      await client.query('ROLLBACK');
      return fail(
        res,
        409,
        'late_sequence',
        `序号 ${seq} 早于当前期待序号 ${expected}，属迟到的旧请求，已忽略，未推进`,
        { expectedSeq: expected, expectedPosition }
      );
    }
    if (seq > expected) {
      await client.query('ROLLBACK');
      return fail(
        res,
        409,
        'out_of_order',
        `序号 ${seq} 晚于当前期待序号 ${expected}，属越序提交，已拒绝，未推进`,
        { expectedSeq: expected, expectedPosition }
      );
    }
    // 位置必须与当前序号对应
    if (position !== expectedPosition) {
      await client.query('ROLLBACK');
      return fail(
        res,
        422,
        'position_mismatch',
        `第 ${seq} 颗应复核 ${expectedPosition}，收到 ${position}，已拒绝，未推进`,
        { expectedSeq: expected, expectedPosition }
      );
    }
    // 扭矩合格范围（含边界）
    if (torque < MIN_TORQUE || torque > MAX_TORQUE) {
      await client.query('ROLLBACK');
      return fail(
        res,
        422,
        'torque_out_of_range',
        `扭矩 ${torque} cN·m 超出合格范围 ${MIN_TORQUE}–${MAX_TORQUE} cN·m（含边界），已拒绝，未推进`,
        { expectedSeq: expected, expectedPosition }
      );
    }

    // 全部校验通过：追加不可变事件并推进序号（同一事务）
    await client.query(
      `INSERT INTO confirmation_events (session_id, seq, position, torque, idempotency_key, payload_hash)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [sessionId, seq, position, torque, idempotencyKey, payloadHash]
    );
    await client.query(
      `UPDATE sessions
          SET next_seq = next_seq + 1,
              completed_at = CASE WHEN next_seq + 1 > ${SEQUENCE.length} THEN now() ELSE completed_at END
        WHERE id = $1`,
      [sessionId]
    );
    const state = await loadState(client, sessionId);
    await client.query('COMMIT');
    return res.status(201).json({
      ok: true,
      replayed: false,
      message: `第 ${seq} 颗（${position}）确认合格`,
      event: state.events[state.events.length - 1],
      progress: progressOf(state),
    });
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    next(err);
  } finally {
    client.release();
  }
});

app.use((req, res) => fail(res, 404, 'not_found', '接口不存在'));

// 统一错误处理：JSON 解析失败返回 400，其余为 500
app.use((err, req, res, next) => {
  if (err && err.type === 'entity.parse.failed') {
    return fail(res, 400, 'invalid_json', '请求体不是合法 JSON');
  }
  console.error(err);
  if (res.headersSent) return;
  fail(res, 500, 'internal_error', '服务器内部错误');
});

const server = app.listen(PORT, () => {
  console.log(`hub-recheck api listening on port ${PORT}`);
});

for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, async () => {
    server.close();
    await pool.end().catch(() => {});
    process.exit(0);
  });
}
