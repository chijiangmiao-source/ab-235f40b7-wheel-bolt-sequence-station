'use strict';

// 轮毂复核工位页面逻辑。
// 关键语义：
//  - 每次“新的提交”生成一个新幂等键；“网络重试”沿用同一幂等键与完全相同的载荷，
//    服务器会返回原确认（不会重复记账）。
//  - 页面状态在任何响应后都以 GET 会话返回的权威进度为准重新渲染。
//  - 只有服务器宣告六次有效确认（status=completed）才显示完成。

const STORAGE_KEY = 'wheelStation.sessionId';

const REASON_TEXT = {
  validation_error: '请求被拒绝：数据不符合协议',
  session_not_found: '会话不存在',
  stale_seq: '迟到的旧响应：该序号已处理，未重复推进',
  out_of_order_seq: '越序提交：只能确认当前期待的螺栓',
  position_mismatch: '位置码与当前期待位置不符',
  torque_out_of_range: '扭矩不合格：超出 4200–4800 cN·m（含边界）',
  idempotency_conflict: '幂等冲突：同一幂等键被用于不同载荷',
  session_already_exists: '会话编号已存在',
  api_unreachable: 'API 不可达',
};

const els = {
  startPanel: document.getElementById('start-panel'),
  workPanel: document.getElementById('work-panel'),
  startBtn: document.getElementById('start-btn'),
  newSessionBtn: document.getElementById('new-session-btn'),
  sessionLabel: document.getElementById('session-label'),
  sessionId: document.getElementById('session-id'),
  progress: document.getElementById('bolt-progress'),
  currentSeq: document.getElementById('current-seq'),
  currentPosition: document.getElementById('current-position'),
  torqueInput: document.getElementById('torque-input'),
  submitBtn: document.getElementById('submit-btn'),
  retryBtn: document.getElementById('retry-btn'),
  completePanel: document.getElementById('complete-panel'),
  currentBolt: document.getElementById('current-bolt'),
  completeList: document.getElementById('complete-list'),
  banner: document.getElementById('banner'),
  eventlogBody: document.getElementById('eventlog-body'),
};

let boltOrder = [];
let pendingSubmission = null; // { body, key }，用于网络重试时原样重放

function newIdempotencyKey() {
  if (window.crypto && crypto.randomUUID) return `idem-${crypto.randomUUID()}`;
  return `idem-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`;
}

async function apiFetch(path, options = {}) {
  const res = await fetch(path, {
    headers: { 'content-type': 'application/json' },
    ...options,
  });
  let body = null;
  try {
    body = await res.json();
  } catch {
    body = null;
  }
  return {
    status: res.status,
    ok: res.ok,
    replay: res.headers.get('x-idempotent-replay') === 'true',
    body,
  };
}

function showBanner(kind, text) {
  els.banner.hidden = false;
  els.banner.className = `banner banner--${kind}`;
  els.banner.textContent = text;
}

function hideBanner() {
  els.banner.hidden = true;
  els.banner.textContent = '';
}

function reasonText(reason, serverMessage) {
  return REASON_TEXT[reason] || serverMessage || '请求被服务器拒绝';
}

function renderProgress(state) {
  els.progress.innerHTML = '';
  const confirmedSeqs = new Set(
    (state.events || []).filter((e) => e.accepted).map((e) => e.seq),
  );
  boltOrder.forEach((bolt) => {
    const li = document.createElement('li');
    li.className = 'progress__item';
    if (confirmedSeqs.has(bolt.seq)) li.classList.add('progress__item--done');
    if (!state.completed && bolt.seq === state.expected_seq) li.classList.add('progress__item--current');
    const rejected = (state.events || []).some(
      (e) => !e.accepted && e.seq === bolt.seq && !confirmedSeqs.has(bolt.seq),
    );
    if (rejected) li.classList.add('progress__item--rejected');
    li.innerHTML = `<span class="pos">${bolt.position}</span><span class="state">#${bolt.seq}</span>`;
    els.progress.appendChild(li);
  });
}

function renderEventLog(state) {
  els.eventlogBody.innerHTML = '';
  (state.events || []).forEach((e, idx) => {
    const tr = document.createElement('tr');
    tr.innerHTML =
      `<td>${idx + 1}</td>` +
      `<td>${e.seq}</td>` +
      `<td>${e.position}</td>` +
      `<td>${e.torque}</td>` +
      `<td class="${e.accepted ? 'accepted' : 'rejected'}">${e.accepted ? '接受' : '拒绝'}</td>` +
      `<td>${e.accepted ? '—' : (e.reason_code || '')}</td>`;
    els.eventlogBody.appendChild(tr);
  });
}

function renderWork(state) {
  els.startPanel.hidden = true;
  els.workPanel.hidden = false;
  els.sessionLabel.hidden = false;
  els.newSessionBtn.hidden = false;
  els.sessionId.textContent = state.session_id;
  renderProgress(state);
  renderEventLog(state);

  if (state.completed) {
    // 仅当服务器权威状态为 completed（六次有效确认）时才显示完成。
    els.currentBolt.hidden = true;
    els.completePanel.hidden = false;
    els.completeList.innerHTML = '';
    (state.events || [])
      .filter((e) => e.accepted)
      .forEach((e) => {
        const li = document.createElement('li');
        li.textContent = `${e.seq}. ${e.position} — ${e.torque} cN·m`;
        els.completeList.appendChild(li);
      });
    hideBanner();
    return;
  }

  // 未完成：稳定停留在服务器期待的当前螺栓。
  els.completePanel.hidden = true;
  els.currentBolt.hidden = false;
  els.currentSeq.textContent = String(state.expected_seq);
  els.currentPosition.textContent = state.expected_position;
}

// 以服务器为权威重新读取进度（提交后、页面加载/刷新后都走这里）。
async function refreshState() {
  const sessionId = localStorage.getItem(STORAGE_KEY);
  if (!sessionId) {
    els.startPanel.hidden = false;
    els.workPanel.hidden = true;
    els.sessionLabel.hidden = true;
    els.newSessionBtn.hidden = true;
    return;
  }
  const { ok, body } = await apiFetch(`/api/sessions/${encodeURIComponent(sessionId)}`);
  if (!ok) {
    localStorage.removeItem(STORAGE_KEY);
    els.startPanel.hidden = false;
    els.workPanel.hidden = true;
    showBanner('error', '无法恢复会话，请重新开始');
    return;
  }
  renderWork(body);
}

async function startSession() {
  els.startBtn.disabled = true;
  try {
    const { status, body } = await apiFetch('/api/sessions', {
      method: 'POST',
      body: '{}',
    });
    if (status !== 201) {
      showBanner('error', `创建会话失败：${body && body.message ? body.message : status}`);
      return;
    }
    localStorage.setItem(STORAGE_KEY, body.session_id);
    pendingSubmission = null;
    hideBanner();
    await refreshState();
    els.torqueInput.focus();
  } catch {
    showBanner('error', '网络错误，会话未创建，请重试');
  } finally {
    els.startBtn.disabled = false;
  }
}

async function submitConfirmation(isRetry) {
  const sessionId = localStorage.getItem(STORAGE_KEY);
  if (!sessionId) return;

  let body;
  if (isRetry && pendingSubmission) {
    // 网络重试：逐字节重复上次的载荷与幂等键，绝不变造新键。
    body = pendingSubmission.body;
  } else {
    const raw = els.torqueInput.value.trim();
    if (!/^-?\d+$/.test(raw)) {
      showBanner('warn', '请输入整数扭矩（cN·m）');
      return;
    }
    const torque = Number(raw);
    const seq = Number(els.currentSeq.textContent);
    const position = els.currentPosition.textContent;
    body = {
      session_id: sessionId,
      seq,
      position,
      torque,
      idempotency_key: newIdempotencyKey(),
    };
    pendingSubmission = { body };
  }

  els.submitBtn.disabled = true;
  els.retryBtn.hidden = true;
  try {
    const result = await apiFetch('/api/confirmations', {
      method: 'POST',
      body: JSON.stringify(body),
    });

    if (result.body && result.body.accepted) {
      showBanner(
        'ok',
        result.replay
          ? `重复提交已识别：返回 ${body.seq} 号螺栓（${body.position}）的原确认，未重复推进`
          : `${body.position} 确认有效`,
      );
      els.torqueInput.value = '';
      pendingSubmission = null;
    } else if (result.body) {
      // 所有失败（迟到/越序/位置不符/扭矩不合格/幂等冲突）均停留当前螺栓并给出原因。
      showBanner('error', `已拒绝（${result.body.reason}）：${result.body.message || reasonText(result.body.reason)}`);
      // 被业务拒绝的载荷换键重提才有意义，清掉待重试状态。
      if (!result.replay) pendingSubmission = null;
    } else {
      showBanner('error', `服务器返回异常状态码 ${result.status}`);
    }

    // 无论成功失败，都重新读取权威进度，杜绝用本地猜测推进。
    await refreshState();
    if (result.body && result.body.accepted && !result.body.completed) {
      els.torqueInput.focus();
    }
  } catch {
    // 网络层失败：请求可能已到达服务器。显示同载荷重试按钮，依赖幂等键去重。
    showBanner('warn', '网络异常，请求可能已送达。请点击“网络重试”，将以相同载荷与幂等键重发，不会重复记账。');
    els.retryBtn.hidden = false;
  } finally {
    els.submitBtn.disabled = false;
  }
}

async function loadProtocol() {
  // 顺序与范围始终取自服务端；取不到不使用本地假数据兜底，直接报错停用。
  const { ok, body } = await apiFetch('/api/protocol');
  if (!ok || !body || !Array.isArray(body.bolt_order)) {
    throw new Error('protocol_unavailable');
  }
  boltOrder = body.bolt_order;
}

els.startBtn.addEventListener('click', startSession);
els.newSessionBtn.addEventListener('click', () => {
  localStorage.removeItem(STORAGE_KEY);
  pendingSubmission = null;
  els.torqueInput.value = '';
  hideBanner();
  refreshState();
});
els.submitBtn.addEventListener('click', () => submitConfirmation(false));
els.retryBtn.addEventListener('click', () => submitConfirmation(true));
els.torqueInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') submitConfirmation(false);
});

(async function init() {
  try {
    await loadProtocol();
  } catch {
    els.startBtn.disabled = true;
    showBanner('error', '无法从服务器获取复核协议（螺栓顺序/合格范围），请联系维修');
    return;
  }
  await refreshState();
})();
