import { test, expect } from '@playwright/test';

// 真实页面操作验收：通过 web 服务（nginx 同源代理）驱动浏览器
const API = (process.env.API_BASE || 'http://localhost:3000').replace(/\/$/, '');
const SESSION_KEY = 'hubRecheckSessionId';

test('完整流程：开始会话、逐颗确认、拒绝原因、刷新恢复、完成横幅', async ({ page }) => {
  await page.goto('/');
  await expect(page.locator('h1')).toHaveText('轮毂复核工位');

  // 开始新会话，第一颗为 A1
  await page.click('#start-btn');
  await expect(page.locator('#current-position')).toHaveText('A1');
  await expect(page.locator('#current-seq')).toHaveText('1');
  await expect(page.locator('#done-banner')).toHaveCount(0);

  // 第 1 颗：合格，推进到 B2
  await page.fill('#torque-input', '4500');
  await page.click('#submit-btn');
  await expect(page.locator('#current-position')).toHaveText('B2');
  await expect(page.locator('#progress-text')).toContainText('1 / 6');
  await expect(page.locator('#message')).toContainText('确认合格');

  // 第 2 颗：扭矩超范围，被拒绝并停留当前螺栓，展示明确原因
  await page.fill('#torque-input', '5000');
  await page.click('#submit-btn');
  await expect(page.locator('#message')).toContainText('超出合格范围');
  await expect(page.locator('#current-position')).toHaveText('B2');
  await expect(page.locator('#progress-text')).toContainText('1 / 6');

  // 刷新后重新读取权威进度：仍停在 B2，完成横幅不出现
  await page.reload();
  await expect(page.locator('#current-position')).toHaveText('B2');
  await expect(page.locator('#progress-text')).toContainText('1 / 6');
  await expect(page.locator('#done-banner')).toHaveCount(0);

  // 依次合格提交剩余五颗
  for (const pos of ['B2', 'A3', 'B1', 'A2', 'B3']) {
    await expect(page.locator('#current-position')).toHaveText(pos);
    await page.fill('#torque-input', '4600');
    await page.click('#submit-btn');
  }

  // 六次有效确认后才显示完成
  await expect(page.locator('#done-banner')).toHaveText('轮毂复核完成');
  await expect(page.locator('#done-list li')).toHaveCount(6);

  // 刷新后仍是完成状态（权威进度持久化）
  await page.reload();
  await expect(page.locator('#done-banner')).toHaveText('轮毂复核完成');
});

test('本地会话编号失效时回退到开始页', async ({ page }) => {
  await page.goto('/');
  await page.evaluate(
    (key) => localStorage.setItem(key, '00000000-0000-0000-0000-000000000000'),
    SESSION_KEY
  );
  await page.reload();
  await expect(page.locator('#start-btn')).toBeVisible();
});

test('响应丢失时页面以同一幂等键安全重试，不产生重复记录', async ({ page }) => {
  await page.goto('/');
  await page.click('#start-btn');
  await expect(page.locator('#current-position')).toHaveText('A1');
  const sessionId = await page.evaluate((key) => localStorage.getItem(key), SESSION_KEY);

  // 第一次提交：请求真实到达服务器并落库，但响应被丢弃（模拟网络延迟/丢包）
  let dropped = false;
  await page.route('**/api/sessions/*/confirmations', async (route) => {
    if (!dropped) {
      dropped = true;
      await route.fetch(); // 真实转发到 api，服务器已处理
      await route.abort(); // 但响应丢失
    } else {
      await route.continue();
    }
  });

  await page.fill('#torque-input', '4500');
  await page.click('#submit-btn');

  // 页面自动以同一幂等键重试，服务器返回原确认，界面推进到 B2
  await expect(page.locator('#current-position')).toHaveText('B2');
  await expect(page.locator('#progress-text')).toContainText('1 / 6');

  // 权威状态：只记录了一条确认事件
  const res = await page.request.get(`${API}/api/sessions/${sessionId}`);
  const st = await res.json();
  expect(st.events).toHaveLength(1);
  expect(st.events[0].torque).toBe(4500);
  expect(st.events[0].position).toBe('A1');
});

test('两个页面共用会话时，迟到提交被明确拒绝且不推进', async ({ browser }) => {
  const ctxA = await browser.newContext();
  const ctxB = await browser.newContext();
  const a = await ctxA.newPage();
  const b = await ctxB.newPage();

  try {
    await a.goto('/');
    await a.click('#start-btn');
    await expect(a.locator('#current-position')).toHaveText('A1');
    const sessionId = await a.evaluate((key) => localStorage.getItem(key), SESSION_KEY);

    // B 打开同一会话
    await b.goto('/');
    await b.evaluate(
      ([key, value]) => localStorage.setItem(key, value),
      [SESSION_KEY, sessionId]
    );
    await b.reload();
    await expect(b.locator('#current-position')).toHaveText('A1');

    // A 确认第 1 颗，服务器推进到第 2 颗
    await a.fill('#torque-input', '4500');
    await a.click('#submit-btn');
    await expect(a.locator('#current-position')).toHaveText('B2');

    // B 仍停留在旧界面，提交第 1 颗：属于迟到的旧请求，被明确拒绝
    await b.fill('#torque-input', '4500');
    await b.click('#submit-btn');
    await expect(b.locator('#message')).toContainText('迟到');

    // 拒绝后 B 重新读取权威进度，跳到当前螺栓，且服务器只记录了一条事件
    await expect(b.locator('#current-position')).toHaveText('B2');
    const res = await a.request.get(`${API}/api/sessions/${sessionId}`);
    const st = await res.json();
    expect(st.events).toHaveLength(1);
    expect(st.nextSeq).toBe(2);
  } finally {
    await ctxA.close();
    await ctxB.close();
  }
});
