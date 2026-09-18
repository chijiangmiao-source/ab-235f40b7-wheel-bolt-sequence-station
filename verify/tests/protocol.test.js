'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { Pool } = require('pg');
const { api, createSession, idemKey, ORDER, API_BASE } = require('./helpers');

const GOOD = 4500;

function pgPool() {
  return new Pool({
    host: process.env.PGHOST || '127.0.0.1',
    port: Number(process.env.PGPORT || 5432),
    user: process.env.PGUSER || 'station',
    password: process.env.PGPASSWORD || 'station',
    database: process.env.PGDATABASE || 'wheel_station',
    max: 4,
  });
}

async function confirm(sid, seq, position, torque, key) {
  return api('POST', '/api/confirmations', {
    session_id: sid,
    seq,
    position,
    torque,
    idempotency_key: key,
  });
}

test('协议常量：螺栓顺序固定为 A1 B2 A3 B1 A2 B3，扭矩范围 4200-4800 含边界', async () => {
  const r = await api('GET', '/api/protocol');
  assert.equal(r.status, 200);
  assert.deepEqual(r.body.bolt_order.map((b) => b.position), ORDER);
  assert.deepEqual(
    r.body.bolt_order.map((b) => b.seq),
    [1, 2, 3, 4, 5, 6],
  );
  assert.equal(r.body.torque.min, 4200);
  assert.equal(r.body.torque.max, 4800);
  assert.equal(r.body.torque.inclusive, true);
});

test('正常流程：六次有效确认后才完成，GET 始终是权威进度', async () => {
  const sid = (await createSession()).session_id;
  let state = await api('GET', `/api/sessions/${sid}`);
  assert.equal(state.body.expected_seq, 1);
  assert.equal(state.body.expected_position, 'A1');
  assert.equal(state.body.completed, false);

  for (let seq = 1; seq <= 6; seq += 1) {
    const torque = seq === 1 ? 4200 : seq === 6 ? 4800 : 4500; // 首尾打边界
    const r = await confirm(sid, seq, ORDER[seq - 1], torque, idemKey());
    assert.equal(r.status, 200, `seq=${seq} 应被接受: ${JSON.stringify(r.body)}`);
    assert.equal(r.body.accepted, true);
    assert.equal(r.body.completed, seq === 6);
    assert.equal(r.body.expected_seq, seq === 6 ? null : seq + 1);

    state = await api('GET', `/api/sessions/${sid}`);
    assert.equal(state.body.progress.confirmed, seq);
    assert.equal(state.body.status, seq === 6 ? 'completed' : 'in_progress');
    assert.equal(state.body.completed, seq === 6);
  }

  const final = await api('GET', `/api/sessions/${sid}`);
  assert.deepEqual(
    final.body.events.filter((e) => e.accepted).map((e) => [e.seq, e.position]),
    ORDER.map((p, i) => [i + 1, p]),
  );
});

test('扭矩边界：4199 拒绝、4200 接受、4800 接受、4801 拒绝，拒绝不推进', async () => {
  const cases = [
    { torque: 4199, accept: false },
    { torque: 4200, accept: true },
  ];
  for (const c of cases) {
    const sid = (await createSession()).session_id;
    const r = await confirm(sid, 1, 'A1', c.torque, idemKey());
    assert.equal(r.body.accepted, c.accept, `${c.torque}: ${JSON.stringify(r.body)}`);
    assert.equal(r.status, c.accept ? 200 : 422);
    const s = await api('GET', `/api/sessions/${sid}`);
    assert.equal(s.body.expected_seq, c.accept ? 2 : 1);
  }

  // 4800/4801 在最后一颗上验证
  for (const torque of [4800, 4801]) {
    const sid = (await createSession()).session_id;
    for (let seq = 1; seq <= 5; seq += 1) {
      await confirm(sid, seq, ORDER[seq - 1], GOOD, idemKey());
    }
    const r = await confirm(sid, 6, 'B3', torque, idemKey());
    assert.equal(r.body.accepted, torque === 4800, `${torque}: ${JSON.stringify(r.body)}`);
    const s = await api('GET', `/api/sessions/${sid}`);
    assert.equal(s.body.completed, torque === 4800);
    assert.equal(s.body.expected_seq, torque === 4800 ? null : 6);
  }
});

test('位置码与期待位置不符：拒绝且不推进', async () => {
  const sid = (await createSession()).session_id;
  const r = await confirm(sid, 1, 'B2', GOOD, idemKey()); // seq1 必须是 A1
  assert.equal(r.status, 422);
  assert.equal(r.body.reason, 'position_mismatch');
  assert.equal(r.body.expected_seq, 1);
  const s = await api('GET', `/api/sessions/${sid}`);
  assert.equal(s.body.expected_seq, 1);
  assert.equal(s.body.progress.confirmed, 0);

  // 正确位置补提后正常推进
  const ok = await confirm(sid, 1, 'A1', GOOD, idemKey());
  assert.equal(ok.status, 200);
  const s2 = await api('GET', `/api/sessions/${sid}`);
  assert.equal(s2.body.expected_seq, 2);
});

test('较小序号视为迟到：409 stale_seq，不推进', async () => {
  const sid = (await createSession()).session_id;
  await confirm(sid, 1, 'A1', GOOD, idemKey());
  await confirm(sid, 2, 'B2', GOOD, idemKey());

  // 迟到的旧响应（新幂等键、旧序号）
  const late = await confirm(sid, 1, 'A1', GOOD, idemKey('late'));
  assert.equal(late.status, 409);
  assert.equal(late.body.reason, 'stale_seq');
  assert.equal(late.body.expected_seq, 3);
  const s = await api('GET', `/api/sessions/${sid}`);
  assert.equal(s.body.expected_seq, 3);
  assert.equal(s.body.progress.confirmed, 2);
});

test('较大序号视为越序：409 out_of_order_seq，不推进', async () => {
  const sid = (await createSession()).session_id;
  const jump = await confirm(sid, 2, 'B2', GOOD, idemKey());
  assert.equal(jump.status, 409);
  assert.equal(jump.body.reason, 'out_of_order_seq');
  assert.equal(jump.body.expected_seq, 1);
  const s = await api('GET', `/api/sessions/${sid}`);
  assert.equal(s.body.expected_seq, 1);

  // 越序到不存在的序号属于协议校验错误
  const big = await confirm(sid, 7, 'A1', GOOD, idemKey());
  assert.equal(big.status, 400);
  assert.equal(big.body.reason, 'validation_error');
});

test('同一幂等键与完全相同载荷重试：返回原确认，不新增事件、不二次推进', async () => {
  const sid = (await createSession()).session_id;
  const key = idemKey('same');
  const payload = { session_id: sid, seq: 1, position: 'A1', torque: GOOD, idempotency_key: key };

  const first = await api('POST', '/api/confirmations', payload);
  assert.equal(first.status, 200);
  assert.equal(first.replay, false);
  assert.equal(first.body.confirmed_seq, 1);

  const before = await api('GET', `/api/sessions/${sid}`);

  // 多次重试（模拟触屏重复点击 + 迟到旧响应）
  for (let i = 0; i < 3; i += 1) {
    const again = await api('POST', '/api/confirmations', payload);
    assert.equal(again.status, 200);
    assert.equal(again.replay, true, '重试必须带 x-idempotent-replay: true');
    assert.deepEqual(again.body, first.body, '重试必须返回与原确认完全一致的响应');
  }

  const after = await api('GET', `/api/sessions/${sid}`);
  assert.equal(after.body.expected_seq, 2);
  assert.equal(after.body.events.length, before.body.events.length, '重试不得新增事件');
  assert.equal(after.body.events.filter((e) => e.accepted).length, 1);
});

test('同一幂等键但载荷不同：409 冲突，不推进；换新键后可正常提交', async () => {
  const sid = (await createSession()).session_id;
  const key = idemKey('conflict');
  const first = await confirm(sid, 1, 'A1', GOOD, key);
  assert.equal(first.status, 200);

  // 同键、不同扭矩
  const diffTorque = await confirm(sid, 1, 'A1', 4201, key);
  assert.equal(diffTorque.status, 409);
  assert.equal(diffTorque.body.reason, 'idempotency_conflict');

  // 同键、不同载荷（下一序号）
  const diffSeq = await confirm(sid, 2, 'B2', GOOD, key);
  assert.equal(diffSeq.status, 409);
  assert.equal(diffSeq.body.reason, 'idempotency_conflict');

  const s = await api('GET', `/api/sessions/${sid}`);
  assert.equal(s.body.expected_seq, 2, '冲突绝不推进');

  const ok = await confirm(sid, 2, 'B2', GOOD, idemKey());
  assert.equal(ok.status, 200);
  assert.equal(ok.body.expected_seq, 3);
});

test('并发：同键同载荷的并发重复提交恰好确认一次', async () => {
  const sid = (await createSession()).session_id;
  const key = idemKey('race');
  const payload = { session_id: sid, seq: 1, position: 'A1', torque: GOOD, idempotency_key: key };

  const results = await Promise.all(
    Array.from({ length: 10 }, () => api('POST', '/api/confirmations', payload)),
  );
  for (const r of results) {
    assert.equal(r.status, 200, `并发请求都应成功: ${JSON.stringify(r.body)}`);
    assert.equal(r.body.accepted, true);
    assert.equal(r.body.confirmed_seq, 1);
  }
  const s = await api('GET', `/api/sessions/${sid}`);
  assert.equal(s.body.expected_seq, 2, '只推进一格');
  const acceptedAt1 = s.body.events.filter((e) => e.accepted && e.seq === 1);
  assert.equal(acceptedAt1.length, 1, 'seq=1 只能有一条接受事件');
  assert.equal(s.body.events.length, 1, '回放不产生新事件');
});

test('失败组合不会推进：扭矩不合格后迟到包再到，仍停留当前螺栓', async () => {
  const sid = (await createSession()).session_id;
  await confirm(sid, 1, 'A1', GOOD, idemKey());
  await confirm(sid, 2, 'B2', GOOD, idemKey());

  // 当前期待 3：扭矩不合格
  const bad = await confirm(sid, 3, 'A3', 9000, idemKey());
  assert.equal(bad.status, 422);
  assert.equal(bad.body.reason, 'torque_out_of_range');

  // 迟到的旧响应（seq=1，新键）
  const late = await confirm(sid, 1, 'A1', GOOD, idemKey('late'));
  assert.equal(late.status, 409);
  assert.equal(late.body.reason, 'stale_seq');

  // 越序包（seq=5）也不能推进
  const jump = await confirm(sid, 5, 'A2', GOOD, idemKey());
  assert.equal(jump.status, 409);
  assert.equal(jump.body.reason, 'out_of_order_seq');

  const s = await api('GET', `/api/sessions/${sid}`);
  assert.equal(s.body.expected_seq, 3);
  assert.equal(s.body.progress.confirmed, 2);
  assert.ok(s.body.events.some((e) => !e.accepted && e.reason_code === 'torque_out_of_range'));
});

test('不存在的会话：确认 404、查询 404', async () => {
  const r = await confirm('NO-SUCH-SESSION', 1, 'A1', GOOD, idemKey());
  assert.equal(r.status, 404);
  assert.equal(r.body.reason, 'session_not_found');
  const g = await api('GET', '/api/sessions/NO-SUCH-SESSION');
  assert.equal(g.status, 404);
});

test('请求校验：非整数扭矩、缺字段、非法位置码一律 400', async () => {
  const sid = (await createSession()).session_id;
  const badBodies = [
    { session_id: sid, seq: 1, position: 'A1', torque: 4200.5, idempotency_key: idemKey() },
    { session_id: sid, seq: 1, position: 'A1', torque: '4200', idempotency_key: idemKey() },
    { session_id: sid, seq: 1, position: 'C9', torque: GOOD, idempotency_key: idemKey() },
    { session_id: sid, seq: 1, position: 'A1', torque: GOOD },
    { session_id: sid, seq: '1', position: 'A1', torque: GOOD, idempotency_key: idemKey() },
    {},
  ];
  for (const body of badBodies) {
    const r = await api('POST', '/api/confirmations', body);
    assert.equal(r.status, 400, `应拒绝: ${JSON.stringify(body)} -> ${JSON.stringify(r.body)}`);
    assert.equal(r.body.ok, false);
  }
  const s = await api('GET', `/api/sessions/${sid}`);
  assert.equal(s.body.expected_seq, 1, '校验失败不产生任何推进');
});

test('数据库：确认事件与幂等记录不可变（禁止 UPDATE/DELETE），且跨连接持久化', async () => {
  const sid = (await createSession(`persist-${Date.now().toString(36)}`)).session_id;
  await confirm(sid, 1, 'A1', GOOD, idemKey());

  const pool = pgPool();
  try {
    const readPool = pgPool(); // 独立连接：验证跨请求持久化
    try {
      const { rows } = await readPool.query(
        'SELECT expected_seq, status FROM sessions WHERE id = $1',
        [sid],
      );
      assert.equal(rows[0].expected_seq, 2);
      assert.equal(rows[0].status, 'in_progress');
      const ev = await readPool.query(
        'SELECT seq, position, torque, accepted FROM confirmation_events WHERE session_id = $1',
        [sid],
      );
      assert.equal(ev.rows.length, 1);
      assert.deepEqual(ev.rows[0], { seq: 1, position: 'A1', torque: GOOD, accepted: true });
    } finally {
      await readPool.end();
    }

    await assert.rejects(
      () => pool.query('UPDATE confirmation_events SET torque = 4800 WHERE session_id = $1', [sid]),
      /append-only/,
    );
    await assert.rejects(
      () => pool.query('DELETE FROM confirmation_events WHERE session_id = $1', [sid]),
      /append-only/,
    );
    await assert.rejects(
      () => pool.query('UPDATE idempotency_records SET request_hash = $1 WHERE session_id = $2', ['x', sid]),
      /append-only/,
    );
    await assert.rejects(
      () => pool.query('DELETE FROM idempotency_records WHERE session_id = $1', [sid]),
      /append-only/,
    );

    // 被拒尝试后数据原样
    const { rows } = await pool.query('SELECT torque FROM confirmation_events WHERE session_id = $1', [sid]);
    assert.equal(rows[0].torque, GOOD);
  } finally {
    await pool.end();
  }
});

test('健康检查通过且 API_BASE 可达', async () => {
  const h = await api('GET', '/healthz');
  assert.equal(h.status, 200);
  assert.equal(h.body.ok, true);
  assert.ok(API_BASE);
});
