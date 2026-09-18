'use strict';

const http = require('node:http');
const {
  BOLT_ORDER,
  TOTAL,
  TORQUE_MIN,
  TORQUE_MAX,
  TORQUE_UNIT,
  expectedPosition,
} = require('./protocol');
const { createPool, initDatabase } = require('./db');
const {
  REASON,
  parseConfirmRequest,
  handleConfirm,
  payloadHash,
  IdempotencyRaceError,
} = require('./service');

const PORT = Number(process.env.PORT || 8080);
const MAX_BODY_BYTES = 64 * 1024;

function sendJson(res, statusCode, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(statusCode, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
    'cache-control': 'no-store',
  });
  res.end(body);
}

function sessionState(row, acceptedCount) {
  const completed = row.status === 'completed';
  const expectedSeq = completed ? null : row.expected_seq;
  return {
    session_id: row.id,
    status: row.status,
    expected_seq: expectedSeq,
    expected_position: expectedSeq == null ? null : expectedPosition(expectedSeq),
    completed,
    progress: { confirmed: acceptedCount, total: TOTAL },
  };
}

function createServer(pool) {
  async function readJsonBody(req) {
    return new Promise((resolve, reject) => {
      let size = 0;
      const chunks = [];
      req.on('data', (chunk) => {
        size += chunk.length;
        if (size > MAX_BODY_BYTES) {
          reject(new HttpError(413, REASON.VALIDATION_ERROR, '请求体过大'));
          req.destroy();
          return;
        }
        chunks.push(chunk);
      });
      req.on('end', () => {
        if (chunks.length === 0) {
          resolve({});
          return;
        }
        try {
          const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8'));
          resolve(parsed);
        } catch {
          reject(new HttpError(400, REASON.VALIDATION_ERROR, '请求体不是合法 JSON'));
        }
      });
      req.on('error', reject);
    });
  }

  async function createSession(body) {
    let sessionId;
    if (body && body.session_id !== undefined && body.session_id !== null) {
      sessionId = body.session_id;
      if (typeof sessionId !== 'string' || !/^[A-Za-z0-9_-]{1,64}$/.test(sessionId)) {
        throw new HttpError(400, REASON.VALIDATION_ERROR, '会话编号非法（1-64 位字母、数字、_、-）', 'session_id');
      }
    } else {
      sessionId = `S-${Date.now().toString(36).toUpperCase()}-${cryptoRandom()}`;
    }
    try {
      await pool.query('INSERT INTO sessions (id) VALUES ($1)', [sessionId]);
    } catch (err) {
      if (err.code === '23505') {
        throw new HttpError(409, 'session_already_exists', '会话编号已存在', 'session_id');
      }
      throw err;
    }
    const res = await pool.query('SELECT id, expected_seq, status FROM sessions WHERE id = $1', [sessionId]);
    return { statusCode: 201, body: { ...sessionState(res.rows[0], 0), bolt_order: BOLT_ORDER } };
  }

  async function getSession(sessionId) {
    if (!/^[A-Za-z0-9_-]{1,64}$/.test(sessionId)) {
      throw new HttpError(404, REASON.SESSION_NOT_FOUND, '会话不存在');
    }
    const sessionRes = await pool.query(
      'SELECT id, expected_seq, status FROM sessions WHERE id = $1',
      [sessionId],
    );
    if (sessionRes.rows.length === 0) {
      throw new HttpError(404, REASON.SESSION_NOT_FOUND, '会话不存在');
    }
    const countRes = await pool.query(
      'SELECT count(*)::int AS n FROM confirmation_events WHERE session_id = $1 AND accepted',
      [sessionId],
    );
    const eventsRes = await pool.query(
      `SELECT seq, position, torque, accepted, reason_code, created_at
         FROM confirmation_events
        WHERE session_id = $1
        ORDER BY id`,
      [sessionId],
    );
    return {
      statusCode: 200,
      body: {
        ...sessionState(sessionRes.rows[0], countRes.rows[0].n),
        bolt_order: BOLT_ORDER,
        events: eventsRes.rows,
      },
    };
  }

  async function confirm(body) {
    const parsed = parseConfirmRequest(body);
    if (parsed.error) {
      throw new HttpError(400, parsed.error, parsed.message, parsed.field || null);
    }
    // 整个判定过程在一个数据库事务内完成，杜绝并发下的重复推进。
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        const result = await handleConfirm(client, parsed.value);
        await client.query('COMMIT');
        return { statusCode: result.httpStatus, body: result.body, replay: result.replay === true };
      } catch (err) {
        await client.query('ROLLBACK').catch(() => {});
        if (err instanceof IdempotencyRaceError && attempt === 0) {
          // 并发同键请求抢先提交：改为回放其登记的原始确认。
          const replay = await replayIdempotentResult(pool, parsed.value);
          return replay;
        }
        throw err;
      } finally {
        client.release();
      }
    }
    throw new Error('unreachable');
  }

  async function replayIdempotentResult(usePool, payload) {
    const res = await usePool.query(
      'SELECT request_hash, response_json FROM idempotency_records WHERE session_id = $1 AND idempotency_key = $2',
      [payload.sessionId, payload.idemKey],
    );
    if (res.rows.length === 0) {
      throw new HttpError(409, REASON.IDEMPOTENCY_CONFLICT, '并发冲突，请重试');
    }
    const samePayload = res.rows[0].request_hash === payloadHash(payload);
    if (!samePayload) {
      return {
        statusCode: 409,
        body: {
          ok: false,
          reason: REASON.IDEMPOTENCY_CONFLICT,
          message: '同一幂等键已用于不同载荷，请求被拒绝',
          session_id: payload.sessionId,
          expected_seq: null,
        },
      };
    }
    return { statusCode: 200, body: res.rows[0].response_json, replay: true };
  }

  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url, 'http://localhost');
      const path = url.pathname;

      if (req.method === 'GET' && path === '/healthz') {
        await pool.query('SELECT 1');
        sendJson(res, 200, { ok: true });
        return;
      }

      if (req.method === 'GET' && path === '/api/protocol') {
        sendJson(res, 200, {
          bolt_order: BOLT_ORDER,
          total: TOTAL,
          torque: { min: TORQUE_MIN, max: TORQUE_MAX, unit: TORQUE_UNIT, inclusive: true },
        });
        return;
      }

      if (req.method === 'POST' && path === '/api/sessions') {
        const body = await readJsonBody(req);
        const result = await createSession(body);
        sendJson(res, result.statusCode, result.body);
        return;
      }

      const sessionMatch = path.match(/^\/api\/sessions\/([A-Za-z0-9_-]{1,64})$/);
      if (req.method === 'GET' && sessionMatch) {
        const result = await getSession(sessionMatch[1]);
        sendJson(res, result.statusCode, result.body);
        return;
      }

      if (req.method === 'POST' && path === '/api/confirmations') {
        const body = await readJsonBody(req);
        const result = await confirm(body);
        res.setHeader('x-idempotent-replay', result.replay ? 'true' : 'false');
        sendJson(res, result.statusCode, result.body);
        return;
      }

      sendJson(res, 404, { ok: false, reason: 'not_found', message: `未知接口：${req.method} ${path}` });
    } catch (err) {
      if (err instanceof HttpError) {
        sendJson(res, err.statusCode, {
          ok: false,
          reason: err.reason,
          message: err.message,
          ...(err.field ? { field: err.field } : {}),
        });
        return;
      }
      console.error('[api] 未预期错误：', err);
      sendJson(res, 500, { ok: false, reason: 'internal_error', message: '服务器内部错误' });
    }
  });

  return server;
}

class HttpError extends Error {
  constructor(statusCode, reason, message, field = null) {
    super(message);
    this.statusCode = statusCode;
    this.reason = reason;
    this.field = field;
  }
}

function cryptoRandom() {
  return require('node:crypto').randomBytes(6).toString('hex').toUpperCase();
}

async function main() {
  const pool = createPool();
  await initDatabase(pool);
  const server = createServer(pool);
  server.listen(PORT, () => {
    console.log(`[api] 轮毂复核服务已启动，监听 0.0.0.0:${PORT}`);
  });

  const shutdown = async (signal) => {
    console.log(`[api] 收到 ${signal}，正在关闭`);
    server.close(() => {});
    await pool.end().catch(() => {});
    process.exit(0);
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

if (require.main === module) {
  main().catch((err) => {
    console.error('[api] 启动失败：', err);
    process.exit(1);
  });
}

module.exports = { createServer };
