'use strict';

// 轮毂复核工位页面逻辑
// - 会话编号保存在 localStorage，刷新后重新向服务器读取权威进度
// - 每次“用户提交”生成一个幂等键；网络失败导致结果未知时，保留同一键与同一载荷安全重试
// - 服务器明确拒绝后清除待重试状态，展示拒绝原因，并重新拉取权威进度
// - 只有服务器确认六颗全部合格（completed=true）才显示“轮毂复核完成”

const SESSION_KEY = 'hubRecheckSessionId';
const root = document.getElementById('root');

let state = null; // 服务器权威进度
let lastMessage = null; // { kind: 'ok' | 'error' | 'warn', text: string }
let loadError = null; // 读取进度失败时的提示
let inFlight = false; // 是否有请求进行中
let pending = null; // { key, payload } 结果未知的提交，重试必须原样重发
let draftTorque = ''; // 输入框草稿，渲染间保持

function uuid() {
  if (window.crypto && typeof window.crypto.randomUUID === 'function') {
    return window.crypto.randomUUID();
  }
  // 非安全上下文（如内网 http）下的降级实现
  const bytes = window.crypto.getRandomValues(new Uint8Array(16));
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = [...bytes].map((b) => b.toString(16).padStart(2, '0'));
  return `${hex.slice(0, 4).join('')}-${hex.slice(4, 6).join('')}-${hex
    .slice(6, 8)
    .join('')}-${hex.slice(8, 10).join('')}-${hex.slice(10).join('')}`;
}

function esc(s) {
  return String(s).replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])
  );
}

async function apiFetch(path, options = {}) {
  let res;
  try {
    res = await fetch(path, options);
  } catch (e) {
    const err = new Error('网络异常，请求结果未知');
    err.network = true;
    throw err;
  }
  let body = null;
  try {
    body = await res.json();
  } catch {
    // 忽略非 JSON 响应体
  }
  if (!res.ok) {
    const err = new Error(
      (body && body.error && body.error.message) || `请求失败（HTTP ${res.status}）`
    );
    err.status = res.status;
    err.code = body && body.error && body.error.code;
    throw err;
  }
  return body;
}

// 重新读取权威进度并渲染
async function refresh() {
  const sid = localStorage.getItem(SESSION_KEY);
  if (!sid) {
    state = null;
    loadError = null;
    render();
    return;
  }
  try {
    state = await apiFetch(`/api/sessions/${sid}`);
    loadError = null;
  } catch (e) {
    if (e.status === 404) {
      localStorage.removeItem(SESSION_KEY);
      state = null;
      loadError = null;
    } else {
      loadError = `无法读取服务器进度：${e.message}`;
    }
  }
  render();
}

async function startSession() {
  inFlight = true;
  render();
  try {
    const s = await apiFetch('/api/sessions', { method: 'POST' });
    localStorage.setItem(SESSION_KEY, s.sessionId);
    lastMessage = null;
    pending = null;
    draftTorque = '';
    state = await apiFetch(`/api/sessions/${s.sessionId}`);
    loadError = null;
  } catch (e) {
    lastMessage = { kind: 'error', text: `创建会话失败：${e.message}` };
  }
  inFlight = false;
  render();
}

// 网络失败时以同一载荷（含同一幂等键）自动重试，服务器明确拒绝则立即抛出
async function sendWithRetry(payload) {
  const sid = localStorage.getItem(SESSION_KEY);
  let lastErr = null;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      return await apiFetch(`/api/sessions/${sid}/confirmations`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
    } catch (e) {
      if (!e.network) throw e; // 服务器明确拒绝：不重试
      lastErr = e;
      await new Promise((r) => setTimeout(r, 600));
    }
  }
  throw lastErr;
}

async function submitConfirmation() {
  if (inFlight || !state || state.completed) return;

  if (!pending) {
    const input = document.getElementById('torque-input');
    const raw = input ? input.value.trim() : '';
    const torque = Number(raw);
    if (raw === '' || !Number.isInteger(torque)) {
      lastMessage = { kind: 'error', text: '请输入整数扭矩（cN·m）' };
      render();
      return;
    }
    draftTorque = String(torque);
    pending = {
      key: uuid(),
      payload: {
        seq: state.nextSeq,
        position: state.nextPosition,
        torque,
        idempotencyKey: null,
      },
    };
    pending.payload.idempotencyKey = pending.key;
  }

  inFlight = true;
  render();

  try {
    const result = await sendWithRetry(pending.payload);
    const p = pending.payload;
    pending = null;
    draftTorque = '';
    lastMessage = {
      kind: 'ok',
      text: result.replayed
        ? `第 ${p.seq} 颗（${p.position}）：重复提交已被幂等去重，返回原确认`
        : `第 ${p.seq} 颗（${p.position}）确认合格（${p.torque} cN·m）`,
    };
  } catch (e) {
    if (e.network) {
      // 结果未知：保留 pending，用户点“安全重试”时原样重发，不会重复记录
      lastMessage = {
        kind: 'warn',
        text: `网络异常，第 ${pending.payload.seq} 颗（${pending.payload.position}）提交结果未知。请点击“安全重试”，将以同一幂等键重发，不会重复记录。`,
      };
      inFlight = false;
      render();
      return;
    }
    const p = pending.payload;
    pending = null;
    lastMessage = {
      kind: 'error',
      text: `第 ${p.seq} 颗（${p.position}）被拒绝：${e.message}`,
    };
  }

  inFlight = false;
  await refresh(); // 无论成功还是被拒，都以服务器权威进度重新渲染
}

function messageHtml() {
  if (!lastMessage) return '<p id="message" class="warn" hidden></p>';
  return `<p id="message" class="${lastMessage.kind}">${esc(lastMessage.text)}</p>`;
}

function startView() {
  return `
    <section id="start-view">
      <p>本工位对每个轮毂按固定顺序复核六颗螺栓：</p>
      <p><strong>A1 → B2 → A3 → B1 → A2 → B3</strong></p>
      <p class="muted">每颗提交整数扭矩，合格范围 4200–4800 cN·m（含边界）。刷新页面不会丢失进度。</p>
      <button id="start-btn" ${inFlight ? 'disabled' : ''}>开始新的复核会话</button>
      ${messageHtml()}
    </section>`;
}

function workView() {
  const bySeq = new Map(state.events.map((e) => [e.seq, e]));
  const bolts = state.sequence
    .map((pos, i) => {
      const seq = i + 1;
      const ev = bySeq.get(seq);
      let cls = 'todo';
      let status = '待复核';
      if (ev) {
        cls = 'done';
        status = `✓ ${ev.torque} cN·m`;
      } else if (seq === state.nextSeq) {
        cls = 'current';
        status = '← 当前待复核';
      }
      return `<li class="bolt ${cls}" data-position="${pos}" data-seq="${seq}">
        <span class="bolt-pos">${pos}</span>
        <span class="bolt-status">${status}</span>
      </li>`;
    })
    .join('');

  const retrying = Boolean(pending);
  const buttonLabel = inFlight ? '提交中…' : retrying ? '安全重试' : '提交确认';

  return `
    <section id="work-view">
      <p>会话：<code id="session-id">${esc(state.sessionId)}</code></p>
      <p id="progress-text">进度：已确认 ${state.confirmed} / 6 颗</p>
      <ol id="bolt-list">${bolts}</ol>
      <div id="current-panel">
        <h2>当前螺栓：<span id="current-position">${esc(state.nextPosition)}</span>（第
          <span id="current-seq">${state.nextSeq}</span> / 6 颗）</h2>
        <label for="torque-input">扭矩（整数，合格范围 4200–4800 cN·m）</label>
        <input id="torque-input" type="number" step="1" inputmode="numeric"
               value="${esc(draftTorque)}" ${inFlight || retrying ? 'disabled' : ''} />
        <button id="submit-btn" ${inFlight ? 'disabled' : ''}>${buttonLabel}</button>
        ${retrying ? '<p class="muted">上次提交结果未知，将以同一幂等键原样重发。</p>' : ''}
      </div>
      ${messageHtml()}
    </section>`;
}

function doneView() {
  const items = state.events
    .map(
      (e) =>
        `<li data-position="${esc(e.position)}">第 ${e.seq} 颗 ${esc(e.position)}：${
          e.torque
        } cN·m ✓</li>`
    )
    .join('');
  return `
    <section id="done-view">
      <h2 id="done-banner">轮毂复核完成</h2>
      <p class="muted">六颗螺栓已按 A1 → B2 → A3 → B1 → A2 → B3 顺序全部确认合格。</p>
      <ol id="done-list">${items}</ol>
      <button id="restart-btn">开始新会话</button>
    </section>`;
}

function errorView() {
  return `
    <section id="error-view">
      <p id="load-error">${esc(loadError)}</p>
      <button id="reload-btn">重试</button>
    </section>`;
}

function render() {
  if (loadError) root.innerHTML = errorView();
  else if (!state) root.innerHTML = startView();
  else if (state.completed) root.innerHTML = doneView();
  else root.innerHTML = workView();
  bindEvents();
}

function bindEvents() {
  const startBtn = document.getElementById('start-btn');
  if (startBtn) startBtn.addEventListener('click', startSession);

  const submitBtn = document.getElementById('submit-btn');
  if (submitBtn) submitBtn.addEventListener('click', submitConfirmation);

  const input = document.getElementById('torque-input');
  if (input) {
    input.addEventListener('input', (e) => {
      draftTorque = e.target.value;
    });
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') submitConfirmation();
    });
    if (!inFlight && !pending) input.focus();
  }

  const restartBtn = document.getElementById('restart-btn');
  if (restartBtn) {
    restartBtn.addEventListener('click', async () => {
      localStorage.removeItem(SESSION_KEY);
      state = null;
      pending = null;
      lastMessage = null;
      draftTorque = '';
      await startSession();
    });
  }

  const reloadBtn = document.getElementById('reload-btn');
  if (reloadBtn) reloadBtn.addEventListener('click', refresh);
}

// 页面加载（含刷新）时重新读取权威进度
refresh();
