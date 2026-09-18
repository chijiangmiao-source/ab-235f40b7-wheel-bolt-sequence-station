'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { chromium } = require('playwright');
const { api, createSession, idemKey, ORDER } = require('./helpers');

const WEB_BASE = process.env.WEB_BASE || 'http://127.0.0.1:8080';

const GOOD_TORQUES = [4200, 4500, 4500, 4500, 4500, 4800]; // 首尾打合格边界

async function newPage(browser) {
  const page = await browser.newPage({ viewport: { width: 900, height: 1100 } });
  page.on('pageerror', (err) => {
    throw new Error(`页面出现未捕获 JS 错误: ${err.message}`);
  });
  return page;
}

async function startSessionInUi(page) {
  await page.goto(WEB_BASE);
  await page.waitForSelector('#start-btn');
  await page.click('#start-btn');
  await page.waitForSelector('#current-bolt');
  const sid = await page.textContent('#session-id');
  assert.match(sid, /^S-/);
  return sid;
}

// 在页面上提交一颗螺栓：输入扭矩并点击提交，等待横幅出现。
async function submitOnPage(page, torque) {
  await page.fill('#torque-input', String(torque));
  await Promise.all([
    page.waitForResponse((r) => r.url().includes('/api/confirmations')),
    page.click('#submit-btn'),
  ]);
  await page.waitForTimeout(50); // 等待权威进度重读后的渲染
}

let browser;

test.before(async () => {
  // 默认使用 Playwright 预装的 Chromium（Docker 镜像内）；
  // CHROMIUM_EXECUTABLE 可在镜像外的联调环境指向已就绪的浏览器二进制。
  browser = await chromium.launch({
    ...(process.env.CHROMIUM_EXECUTABLE ? { executablePath: process.env.CHROMIUM_EXECUTABLE } : {}),
    args: ['--no-sandbox', '--disable-dev-shm-usage', '--disable-gpu'],
  });
});

test.after(async () => {
  if (browser) await browser.close();
});

test('页面展示固定顺序 A1→B2→A3→B1→A2→B3 与合格范围', async () => {
  const page = await newPage(browser);
  await page.goto(WEB_BASE);
  const bodyText = await page.textContent('body');
  assert.match(bodyText, /A1\s*→\s*B2\s*→\s*A3\s*→\s*B1\s*→\s*A2\s*→\s*B3/);
  assert.match(bodyText, /4200\s*[–-]\s*4800/);

  await page.click('#start-btn');
  await page.waitForSelector('#current-bolt');
  const progress = await page.$$eval('#bolt-progress .progress__item .pos', (nodes) =>
    nodes.map((n) => n.textContent),
  );
  assert.deepEqual(progress, ORDER);
  assert.equal(await page.textContent('#current-position'), 'A1');
  await page.close();
});

test('真实操作全流程：六次有效确认后才显示“轮毂复核完成”，且顺序正确', async () => {
  const page = await newPage(browser);
  const sid = await startSessionInUi(page);

  for (let i = 0; i < 6; i += 1) {
    // 未完成前绝不能出现完成面板
    assert.equal(await page.isVisible('#complete-panel'), false);
    assert.equal(await page.textContent('#current-position'), ORDER[i]);
    assert.equal(await page.textContent('#current-seq'), String(i + 1));
    await submitOnPage(page, GOOD_TORQUES[i]);
  }

  await page.waitForSelector('#complete-panel', { state: 'visible' });
  const completeText = await page.textContent('#complete-panel');
  assert.match(completeText, /轮毂复核完成/);
  assert.equal(await page.isVisible('#current-bolt'), false);

  const list = await page.$$eval('#complete-list li', (nodes) => nodes.map((n) => n.textContent));
  assert.deepEqual(
    list.map((x) => x.split('.')[0]),
    ['1', '2', '3', '4', '5', '6'],
  );
  assert.deepEqual(
    list.map((x) => x.split(' ')[1]),
    ORDER,
  );

  // 服务器侧同样是 completed
  const state = await api('GET', `/api/sessions/${sid}`);
  assert.equal(state.body.completed, true);
  assert.equal(state.body.progress.confirmed, 6);
  await page.close();
});

test('扭矩不合格：明确拒绝原因，稳定停留在当前螺栓，改正后才推进', async () => {
  const page = await newPage(browser);
  const sid = await startSessionInUi(page);

  await submitOnPage(page, 9000);
  await page.waitForSelector('.banner--error');
  const banner = await page.textContent('#banner');
  assert.match(banner, /torque_out_of_range/);
  assert.match(banner, /4200/); // 呈现范围
  assert.equal(await page.textContent('#current-position'), 'A1', '拒绝后仍停留 A1');
  assert.equal(await page.textContent('#current-seq'), '1');

  // 服务器确认未推进
  let state = await api('GET', `/api/sessions/${sid}`);
  assert.equal(state.body.expected_seq, 1);

  // 改正为合格值后正常推进
  await submitOnPage(page, 4200);
  assert.equal(await page.textContent('#current-position'), 'B2');
  state = await api('GET', `/api/sessions/${sid}`);
  assert.equal(state.body.expected_seq, 2);
  await page.close();
});

test('页面刷新后重新读取权威进度，停留在当前螺栓；完成态刷新仍为完成', async () => {
  const page = await newPage(browser);
  const sid = await startSessionInUi(page);

  await submitOnPage(page, 4200); // A1
  await submitOnPage(page, 4500); // B2
  assert.equal(await page.textContent('#current-position'), 'A3');

  // 刷新：必须从服务器重新读取，而不是本地猜测
  await page.reload();
  await page.waitForSelector('#current-bolt');
  assert.equal(await page.textContent('#session-id'), sid);
  assert.equal(await page.textContent('#current-position'), 'A3');
  assert.equal(await page.textContent('#current-seq'), '3');
  assert.equal(await page.isVisible('#complete-panel'), false);

  // 其余四颗做完
  for (let i = 2; i < 6; i += 1) {
    await submitOnPage(page, GOOD_TORQUES[i]);
  }
  await page.waitForSelector('#complete-panel', { state: 'visible' });

  // 完成态刷新后仍显示完成（不能回退到作业态）
  await page.reload();
  assert.equal(await page.isVisible('#complete-panel'), true);
  assert.match(await page.textContent('#complete-panel'), /轮毂复核完成/);
  await page.close();
});

test('网络失败后用“网络重试”发送相同载荷与幂等键：服务器只确认一次', async () => {
  const page = await newPage(browser);
  const sid = await startSessionInUi(page);

  // 第一次提交：请求实际送达服务器（route.fetch 转发），但让浏览器侧看到网络失败。
  let forwarded = false;
  await page.route('**/api/confirmations', async (route) => {
    if (!forwarded) {
      forwarded = true;
      await route.fetch(); // 真实送达并提交
      await route.abort('failed'); // 浏览器表现为网络错误
      return;
    }
    await route.continue();
  });

  await page.fill('#torque-input', '4500');
  await page.click('#submit-btn');
  await page.waitForSelector('#retry-btn', { state: 'visible' });
  const warn = await page.textContent('#banner');
  assert.match(warn, /网络异常/);

  const stateBeforeRetry = await api('GET', `/api/sessions/${sid}`);
  assert.equal(stateBeforeRetry.body.expected_seq, 2, '服务器其实已处理并推进');

  // 点击“网络重试”：相同载荷 + 相同幂等键
  const [retryResp] = await Promise.all([
    page.waitForResponse((r) => r.url().includes('/api/confirmations')),
    page.click('#retry-btn'),
  ]);
  assert.equal(retryResp.headers()['x-idempotent-replay'], 'true', '重试必须命中幂等回放');
  await page.waitForTimeout(50);

  const okBanner = await page.textContent('#banner');
  assert.match(okBanner, /重复提交已识别/);
  assert.equal(await page.textContent('#current-position'), 'B2', '恰好推进一格');

  const state = await api('GET', `/api/sessions/${sid}`);
  assert.equal(state.body.expected_seq, 2);
  assert.equal(state.body.events.length, 1, '重试不新增确认事件');
  assert.equal(state.body.events.filter((e) => e.accepted).length, 1);

  await page.unroute('**/api/confirmations');
  await page.close();
});

test('迟到旧响应与越序包通过页面同源 API 到达时被拒绝，页面停留当前螺栓', async () => {
  const page = await newPage(browser);
  const sid = await startSessionInUi(page);
  await submitOnPage(page, 4500); // A1 -> 期待 2/B2

  // 在页面上下文内用与页面一致的方式发出迟到包（seq=1）和越序包（seq=4）
  const late = await page.evaluate(async () => {
    const r = await fetch('/api/confirmations', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        session_id: localStorage.getItem('wheelStation.sessionId'),
        seq: 1, position: 'A1', torque: 4500,
        idempotency_key: `late-${crypto.randomUUID()}`,
      }),
    });
    return { status: r.status, body: await r.json() };
  });
  assert.equal(late.status, 409);
  assert.equal(late.body.reason, 'stale_seq');

  const jump = await page.evaluate(async () => {
    const r = await fetch('/api/confirmations', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        session_id: localStorage.getItem('wheelStation.sessionId'),
        seq: 4, position: 'B1', torque: 4500,
        idempotency_key: `jump-${crypto.randomUUID()}`,
      }),
    });
    return { status: r.status, body: await r.json() };
  });
  assert.equal(jump.status, 409);
  assert.equal(jump.body.reason, 'out_of_order_seq');

  // 刷新页面后仍稳定停留在 B2
  await page.reload();
  await page.waitForSelector('#current-bolt');
  assert.equal(await page.textContent('#current-position'), 'B2');
  assert.equal(await page.textContent('#current-seq'), '2');

  const state = await api('GET', `/api/sessions/${sid}`);
  assert.equal(state.body.expected_seq, 2);
  assert.equal(state.body.progress.confirmed, 1);
  await page.close();
});

test('事件日志在页面上呈现接受与拒绝记录', async () => {
  const page = await newPage(browser);
  const sid = await startSessionInUi(page);
  await submitOnPage(page, 500); // 拒绝
  await submitOnPage(page, 4500); // 接受
  const rows = await page.$$eval('#eventlog-body tr', (nodes) =>
    nodes.map((tr) => Array.from(tr.querySelectorAll('td')).map((td) => td.textContent.trim())),
  );
  assert.equal(rows.length, 2);
  assert.equal(rows[0][4], '拒绝');
  assert.equal(rows[0][5], 'torque_out_of_range');
  assert.equal(rows[1][4], '接受');

  const state = await api('GET', `/api/sessions/${sid}`);
  assert.equal(state.body.expected_seq, 2);
  await page.close();
});
