import { test, expect } from '@playwright/test';
import { randomUUID } from 'node:crypto';

// API 协议验收：直接对话真实 api 服务与 PostgreSQL
const API = (process.env.API_BASE || 'http://localhost:3000').replace(/\/$/, '');
const SEQUENCE = ['A1', 'B2', 'A3', 'B1', 'A2', 'B3'];

async function createSession() {
  const res = await fetch(`${API}/api/sessions`, { method: 'POST' });
  expect(res.status).toBe(201);
  const body = await res.json();
  expect(body.ok).toBe(true);
  return body;
}

async function getState(id) {
  const res = await fetch(`${API}/api/sessions/${id}`);
  expect(res.status).toBe(200);
  return res.json();
}

async function confirm(id, payload) {
  const res = await fetch(`${API}/api/sessions/${id}/confirmations`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  return { status: res.status, body: await res.json() };
}

// 生成合法载荷：默认当前序号对应位置、合格扭矩、随机幂等键
function okPayload(seq, overrides = {}) {
  return {
    seq,
    position: SEQUENCE[seq - 1],
    torque: 4500,
    idempotencyKey: randomUUID(),
    ...overrides,
  };
}

test('健康检查与新会话从 A1 开始', async () => {
  const health = await fetch(`${API}/api/health`);
  expect(health.status).toBe(200);
  expect((await health.json()).ok).toBe(true);

  const s = await createSession();
  expect(s.sequence).toEqual(SEQUENCE);
  expect(s.nextSeq).toBe(1);
  expect(s.nextPosition).toBe('A1');
  expect(s.completed).toBe(false);
  expect(s.events).toEqual([]);
});

test('按序确认六颗后完成，完成后拒绝新提交', async () => {
  const s = await createSession();
  for (let seq = 1; seq <= 6; seq += 1) {
    const r = await confirm(s.sessionId, okPayload(seq));
    expect(r.status).toBe(201);
    expect(r.body.ok).toBe(true);
    expect(r.body.replayed).toBe(false);
    expect(r.body.progress.confirmed).toBe(seq);
    expect(r.body.progress.completed).toBe(seq === 6);
  }
  const st = await getState(s.sessionId);
  expect(st.completed).toBe(true);
  expect(st.nextSeq).toBeNull();
  expect(st.events.map((e) => e.seq)).toEqual([1, 2, 3, 4, 5, 6]);
  expect(st.events.map((e) => e.position)).toEqual(SEQUENCE);

  const after = await confirm(s.sessionId, okPayload(6));
  expect(after.status).toBe(409);
  expect(after.body.error.code).toBe('session_completed');
});

test('同一幂等键与完全相同载荷重试：返回原确认且不重复推进', async () => {
  const s = await createSession();
  const payload = okPayload(1, { torque: 4300 });
  const first = await confirm(s.sessionId, payload);
  expect(first.status).toBe(201);

  const again = await confirm(s.sessionId, payload);
  expect(again.status).toBe(200);
  expect(again.body.ok).toBe(true);
  expect(again.body.replayed).toBe(true);
  expect(again.body.event.torque).toBe(4300);
  expect(again.body.event.idempotencyKey).toBe(payload.idempotencyKey);

  const st = await getState(s.sessionId);
  expect(st.events).toHaveLength(1);
  expect(st.nextSeq).toBe(2);
});

test('幂等键相同但载荷不同：返回冲突且不推进', async () => {
  const s = await createSession();
  const key = randomUUID();
  const first = await confirm(s.sessionId, okPayload(1, { idempotencyKey: key, torque: 4400 }));
  expect(first.status).toBe(201);

  const conflict = await confirm(s.sessionId, okPayload(1, { idempotencyKey: key, torque: 4600 }));
  expect(conflict.status).toBe(409);
  expect(conflict.body.error.code).toBe('idempotency_conflict');

  const st = await getState(s.sessionId);
  expect(st.events).toHaveLength(1);
  expect(st.events[0].torque).toBe(4400);
  expect(st.nextSeq).toBe(2);
});

test('较小序号视为迟到：拒绝且不推进', async () => {
  const s = await createSession();
  expect((await confirm(s.sessionId, okPayload(1))).status).toBe(201);
  expect((await confirm(s.sessionId, okPayload(2))).status).toBe(201);

  // 新幂等键 + 旧序号：模拟迟到的旧请求
  const late = await confirm(s.sessionId, okPayload(1));
  expect(late.status).toBe(409);
  expect(late.body.error.code).toBe('late_sequence');

  const st = await getState(s.sessionId);
  expect(st.nextSeq).toBe(3);
  expect(st.events).toHaveLength(2);
});

test('较大序号视为越序：拒绝且不推进', async () => {
  const s = await createSession();
  const r = await confirm(s.sessionId, okPayload(3));
  expect(r.status).toBe(409);
  expect(r.body.error.code).toBe('out_of_order');

  const st = await getState(s.sessionId);
  expect(st.nextSeq).toBe(1);
  expect(st.events).toHaveLength(0);
});

test('位置与当前序号不符：拒绝且不推进', async () => {
  const s = await createSession();
  const r = await confirm(s.sessionId, okPayload(1, { position: 'B2' }));
  expect(r.status).toBe(422);
  expect(r.body.error.code).toBe('position_mismatch');

  const st = await getState(s.sessionId);
  expect(st.events).toHaveLength(0);
  expect(st.nextSeq).toBe(1);
});

test('扭矩合格范围含边界 4200–4800，越界拒绝且不推进', async () => {
  const s = await createSession();

  const low = await confirm(s.sessionId, okPayload(1, { torque: 4199 }));
  expect(low.status).toBe(422);
  expect(low.body.error.code).toBe('torque_out_of_range');
  const high = await confirm(s.sessionId, okPayload(1, { torque: 4801 }));
  expect(high.status).toBe(422);
  expect(high.body.error.code).toBe('torque_out_of_range');

  let st = await getState(s.sessionId);
  expect(st.events).toHaveLength(0);
  expect(st.nextSeq).toBe(1);

  // 边界值合格
  expect((await confirm(s.sessionId, okPayload(1, { torque: 4200 }))).status).toBe(201);
  expect((await confirm(s.sessionId, okPayload(2, { torque: 4800 }))).status).toBe(201);
  st = await getState(s.sessionId);
  expect(st.events).toHaveLength(2);
  expect(st.nextSeq).toBe(3);
});

test('非法载荷形状：拒绝且不推进', async () => {
  const s = await createSession();
  expect((await confirm(s.sessionId, okPayload(1, { torque: 4500.5 }))).status).toBe(400);
  expect((await confirm(s.sessionId, okPayload(1, { torque: '4500' }))).status).toBe(400);
  expect((await confirm(s.sessionId, okPayload(1, { idempotencyKey: '' }))).status).toBe(400);
  expect((await confirm(s.sessionId, okPayload(1, { seq: 0 }))).status).toBe(400);
  expect((await confirm(s.sessionId, okPayload(1, { position: 'Z9' }))).status).toBe(400);

  const st = await getState(s.sessionId);
  expect(st.events).toHaveLength(0);
  expect(st.nextSeq).toBe(1);
});

test('未知会话返回 404', async () => {
  const res = await fetch(`${API}/api/sessions/${randomUUID()}`);
  expect(res.status).toBe(404);
  const r = await confirm(randomUUID(), okPayload(1));
  expect(r.status).toBe(404);
  expect(r.body.error.code).toBe('session_not_found');
});

test('并发相同请求（触屏重试场景）：只记录一次，其余返回原确认', async () => {
  const s = await createSession();
  const payload = okPayload(1);
  const results = await Promise.all(
    Array.from({ length: 5 }, () => confirm(s.sessionId, payload))
  );
  const created = results.filter((r) => r.status === 201);
  const replayed = results.filter((r) => r.status === 200 && r.body.replayed === true);
  expect(created).toHaveLength(1);
  expect(replayed).toHaveLength(4);

  const st = await getState(s.sessionId);
  expect(st.events).toHaveLength(1);
  expect(st.nextSeq).toBe(2);
});

test('并发不同幂等键同一序号：只有一个能推进，其余按迟到拒绝', async () => {
  const s = await createSession();
  const results = await Promise.all(
    Array.from({ length: 3 }, () => confirm(s.sessionId, okPayload(1)))
  );
  const created = results.filter((r) => r.status === 201);
  const late = results.filter((r) => r.status === 409 && r.body.error.code === 'late_sequence');
  expect(created).toHaveLength(1);
  expect(late).toHaveLength(2);

  const st = await getState(s.sessionId);
  expect(st.events).toHaveLength(1);
  expect(st.nextSeq).toBe(2);
});

test('连续失败后会话仍可正常推进（失败不破坏状态）', async () => {
  const s = await createSession();
  await confirm(s.sessionId, okPayload(4)); // 越序
  await confirm(s.sessionId, okPayload(1, { torque: 9999 })); // 扭矩越界
  await confirm(s.sessionId, okPayload(1, { position: 'B3' })); // 位置不符
  await confirm(s.sessionId, okPayload(1, { torque: 4100 })); // 扭矩越界

  let st = await getState(s.sessionId);
  expect(st.nextSeq).toBe(1);
  expect(st.events).toHaveLength(0);

  for (let seq = 1; seq <= 6; seq += 1) {
    expect((await confirm(s.sessionId, okPayload(seq))).status).toBe(201);
  }
  st = await getState(s.sessionId);
  expect(st.completed).toBe(true);
});
