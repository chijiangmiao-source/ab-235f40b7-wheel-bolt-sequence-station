'use strict';

const API_BASE = process.env.API_BASE || 'http://127.0.0.1:8081';

async function api(method, path, body) {
  const res = await fetch(`${API_BASE}${path}`, {
    method,
    headers: { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  let json = null;
  try {
    json = await res.json();
  } catch {
    json = null;
  }
  return { status: res.status, replay: res.headers.get('x-idempotent-replay') === 'true', body: json, res };
}

async function createSession(sessionId) {
  const body = sessionId ? { session_id: sessionId } : {};
  const r = await api('POST', '/api/sessions', body);
  if (r.status !== 201) throw new Error(`创建会话失败: ${r.status} ${JSON.stringify(r.body)}`);
  return r.body;
}

let counter = 0;
function idemKey(prefix = 'idem') {
  counter += 1;
  return `${prefix}-${Date.now().toString(36)}-${counter}-${Math.random().toString(36).slice(2, 10)}`;
}

const ORDER = ['A1', 'B2', 'A3', 'B1', 'A2', 'B3'];

module.exports = { api, createSession, idemKey, ORDER, API_BASE };
