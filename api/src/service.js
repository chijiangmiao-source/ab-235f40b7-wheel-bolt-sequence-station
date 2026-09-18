'use strict';

const crypto = require('node:crypto');
const {
  TOTAL,
  TORQUE_MIN,
  TORQUE_MAX,
  TORQUE_UNIT,
  expectedPosition,
} = require('./protocol');

// 失败原因码（错误响应中 reason 字段，页面据此呈现明确拒绝原因）。
const REASON = Object.freeze({
  VALIDATION_ERROR: 'validation_error',         // 请求体不符合协议
  SESSION_NOT_FOUND: 'session_not_found',       // 会话不存在
  STALE_SEQ: 'stale_seq',                       // 序号小于当前期待序号：迟到的旧响应
  OUT_OF_ORDER_SEQ: 'out_of_order_seq',         // 序号大于当前期待序号：越序
  POSITION_MISMATCH: 'position_mismatch',       // 位置码与期待位置不符
  TORQUE_OUT_OF_RANGE: 'torque_out_of_range',   // 扭矩不在 4200–4800 cN·m
  IDEMPOTENCY_CONFLICT: 'idempotency_conflict', // 同幂等键但载荷不同
});

const ACCEPT_REASON = Object.freeze({
  OK: 'ok',
  TORQUE_OUT_OF_RANGE: REASON.TORQUE_OUT_OF_RANGE,
});

function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

// 幂等载荷指纹：字段顺序无关；仅纳入受协议保护的字段。
function payloadHash(payload) {
  const canonical = JSON.stringify({
    seq: payload.seq,
    position: payload.position,
    torque: payload.torque,
  });
  return sha256(canonical);
}

function isValidSessionId(value) {
  return typeof value === 'string' && /^[A-Za-z0-9_-]{1,64}$/.test(value);
}

function isValidIdempotencyKey(value) {
  return typeof value === 'string' && value.length >= 8 && value.length <= 128;
}

function isValidPosition(value) {
  return typeof value === 'string' && /^[AB][123]$/.test(value);
}

// 校验并归一化请求体；返回 { error, value }。
function parseConfirmRequest(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return { error: REASON.VALIDATION_ERROR, message: '请求体必须是 JSON 对象' };
  }
  const { session_id: sessionId, seq, position, torque, idempotency_key: idemKey } = body;

  if (!isValidSessionId(sessionId)) {
    return { error: REASON.VALIDATION_ERROR, field: 'session_id', message: '会话编号缺失或非法（1-64 位字母、数字、_、-）' };
  }
  if (!Number.isInteger(seq) || seq < 1 || seq > TOTAL) {
    return { error: REASON.VALIDATION_ERROR, field: 'seq', message: `序号必须是 1-${TOTAL} 的整数` };
  }
  if (!isValidPosition(position)) {
    return { error: REASON.VALIDATION_ERROR, field: 'position', message: '位置码格式非法，应为 A1/A2/A3/B1/B2/B3' };
  }
  if (!Number.isInteger(torque)) {
    return { error: REASON.VALIDATION_ERROR, field: 'torque', message: '扭矩必须是整数，单位 cN·m' };
  }
  if (!isValidIdempotencyKey(idemKey)) {
    return { error: REASON.VALIDATION_ERROR, field: 'idempotency_key', message: '幂等键缺失或非法（8-128 个字符）' };
  }

  return {
    value: { sessionId, seq, position, torque, idemKey },
  };
}

// 在调用方事务内执行，保证读-判-写原子性。返回要回给客户端的响应对象。
async function handleConfirm(client, payload) {
  const { sessionId, seq, position, torque, idemKey } = payload;
  const hash = payloadHash(payload);

  // 1) 幂等命中：键相同且载荷完全相同 -> 返回原确认；键相同载荷不同 -> 冲突。
  const existing = await client.query(
    `SELECT request_hash, response_json
       FROM idempotency_records
      WHERE session_id = $1 AND idempotency_key = $2`,
    [sessionId, idemKey],
  );
  if (existing.rows.length > 0) {
    const rec = existing.rows[0];
    if (rec.request_hash !== hash) {
      return {
        httpStatus: 409,
        body: {
          ok: false,
          reason: REASON.IDEMPOTENCY_CONFLICT,
          message: '同一幂等键已用于不同载荷，请求被拒绝',
          session_id: sessionId,
          expected_seq: null,
        },
        persistEvent: false,
      };
    }
    return { httpStatus: 200, body: rec.response_json, replay: true, persistEvent: false };
  }

  // 2) 锁定会话行并读取权威期待序号（SELECT FOR UPDATE 串行化并发提交）。
  const sessionRes = await client.query(
    'SELECT expected_seq, status FROM sessions WHERE id = $1 FOR UPDATE',
    [sessionId],
  );
  if (sessionRes.rows.length === 0) {
    return {
      httpStatus: 404,
      body: {
        ok: false,
        reason: REASON.SESSION_NOT_FOUND,
        message: '会话不存在，请先创建会话',
        session_id: sessionId,
        expected_seq: null,
      },
      persistEvent: false,
    };
  }

  const expectedSeq = sessionRes.rows[0].expected_seq;
  let statusCode;
  let accepted;
  let reasonCode;
  let message;

  // 3) 协议判定。任何失败都只追加一条被拒绝事件，绝不推进 expected_seq。
  if (seq < expectedSeq) {
    accepted = false;
    reasonCode = REASON.STALE_SEQ;
    statusCode = 409;
    message = `迟到的旧响应：序号 ${seq} 已处理过，当前期待序号 ${expectedSeq}`;
  } else if (seq > expectedSeq) {
    accepted = false;
    reasonCode = REASON.OUT_OF_ORDER_SEQ;
    statusCode = 409;
    message = `越序提交：期待序号 ${expectedSeq}，收到序号 ${seq}`;
  } else {
    const wantPosition = expectedPosition(expectedSeq);
    if (position !== wantPosition) {
      accepted = false;
      reasonCode = REASON.POSITION_MISMATCH;
      statusCode = 422;
      message = `位置码不符：序号 ${expectedSeq} 对应位置应为 ${wantPosition}，收到 ${position}`;
    } else if (torque < TORQUE_MIN || torque > TORQUE_MAX) {
      accepted = false;
      reasonCode = REASON.TORQUE_OUT_OF_RANGE;
      statusCode = 422;
      message = `扭矩 ${torque} ${TORQUE_UNIT} 不在合格范围 ${TORQUE_MIN}-${TORQUE_MAX} ${TORQUE_UNIT}（含边界）`;
    } else {
      accepted = true;
      reasonCode = null;
      statusCode = 200;
    }
  }

  // 4) 追加不可变事件（accepted / rejected 都留痕）。
  const eventRes = await client.query(
    `INSERT INTO confirmation_events
       (session_id, seq, position, torque, idempotency_key, accepted, reason_code)
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     RETURNING id, created_at`,
    [sessionId, seq, position, torque, idemKey, accepted, reasonCode],
  );
  const eventId = eventRes.rows[0].id;

  let body;
  if (accepted) {
    const nextSeq = expectedSeq + 1;
    const completed = nextSeq > TOTAL;
    if (completed) {
      await client.query(
        "UPDATE sessions SET expected_seq = $2, status = 'completed', updated_at = now() WHERE id = $1",
        [sessionId, nextSeq],
      );
    } else {
      await client.query(
        'UPDATE sessions SET expected_seq = $2, updated_at = now() WHERE id = $1',
        [sessionId, nextSeq],
      );
    }
    body = {
      ok: true,
      accepted: true,
      reason: ACCEPT_REASON.OK,
      session_id: sessionId,
      confirmed_seq: seq,
      confirmed_position: position,
      expected_seq: completed ? null : nextSeq,
      expected_position: completed ? null : expectedPosition(nextSeq),
      completed,
      progress: { confirmed: seq, total: TOTAL },
      torque_unit: TORQUE_UNIT,
      valid_range: { min: TORQUE_MIN, max: TORQUE_MAX, inclusive: true },
    };
  } else {
    body = {
      ok: false,
      accepted: false,
      reason: reasonCode,
      message,
      session_id: sessionId,
      received_seq: seq,
      received_position: position,
      expected_seq: expectedSeq,
      expected_position: expectedPosition(expectedSeq),
      completed: false,
      progress: { confirmed: expectedSeq - 1, total: TOTAL },
      torque_unit: TORQUE_UNIT,
      valid_range: { min: TORQUE_MIN, max: TORQUE_MAX, inclusive: true },
    };
  }

  // 5) 登记幂等记录（响应原文回放）。冲突行的缺失由唯一约束兜底并发竞态。
  try {
    await client.query(
      `INSERT INTO idempotency_records (session_id, idempotency_key, request_hash, event_id, response_json)
       VALUES ($1, $2, $3, $4, $5)`,
      [sessionId, idemKey, hash, eventId, JSON.stringify(body)],
    );
  } catch (err) {
    if (err.code === '23505') {
      // 并发同键请求已抢先登记：本事务回滚后由重试方读到原记录回放。
      throw new IdempotencyRaceError();
    }
    throw err;
  }

  return { httpStatus: statusCode, body, persistedEventId: eventId };
}

class IdempotencyRaceError extends Error {
  constructor() {
    super('idempotency record inserted by concurrent request');
    this.code = 'IDEMPOTENCY_RACE';
  }
}

module.exports = {
  REASON,
  parseConfirmRequest,
  handleConfirm,
  payloadHash,
  IdempotencyRaceError,
};
