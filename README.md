# 轮毂复核工位（Wheel Re-verify Station）

真实联调的工位页面与 API：每个新会话按固定顺序 **A1 → B2 → A3 → B1 → A2 → B3**
复核六颗螺栓，扭矩合格范围 **4200 – 4800 cN·m（含边界）**。会话与确认事件保存在
PostgreSQL，确认事件与幂等记录为只追加（append-only）的不可变记录。

- `api/`：Node.js（无框架，内置 `http`）+ `pg` 驱动，事务化提交协议
- `web/`：工位触屏页面（原生 HTML/CSS/JS）+ 到 API 的同源反向代理
- `verify/`：一次性验收服务，Node test 跑协议用例 + Playwright/Chromium 真实页面操作
- `db`：PostgreSQL 16，承担全部跨请求状态持久化

## 快速开始（Docker Compose）

```bash
docker compose up --build
```

- 页面：http://localhost:8080
- API：http://localhost:8081

宿主端口可用环境变量覆盖：

```bash
WEB_PORT=18080 API_PORT=18081 docker compose up --build
```

## 一次性验收

```bash
docker compose up --build --abort-on-container-exit --exit-code-from verify
```

`verify` 服务会等 `db/api/web` 健康后，对**真实运行中的整套服务**执行：

1. 协议级用例（直接打 API）：固定顺序、边界扭矩、迟到/越序/位置不符/幂等回放/幂等冲突/并发重复；
2. 真实页面用例（无头 Chromium）：开新会话、逐颗录入、拒绝提示、刷新重读权威进度、
   模拟网络失败后的“同载荷同幂等键重试”、完成态展示；
3. 数据库用例：跨连接持久化、`UPDATE/DELETE` 不可变事件被数据库拒绝。

退出码 `0` 即验收通过（非 0 时输出失败用例）。`restart: "no"` 保证它只运行一次。

## 提交流程与 API

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| `POST` | `/api/sessions` | 创建新会话，顺序固定为 A1、B2、A3、B1、A2、B3 |
| `GET`  | `/api/sessions/{id}` | **权威进度**：当前期待序号/位置、完成态、全部确认事件 |
| `POST` | `/api/confirmations` | 提交一次确认（见下） |
| `GET`  | `/api/protocol` | 顺序与合格范围常量 |
| `GET`  | `/healthz` | 健康检查 |

确认请求体：

```json
{
  "session_id": "S-xxxx",
  "seq": 1,
  "position": "A1",
  "torque": 4500,
  "idempotency_key": "idem-5d31b7f8-..."
}
```

服务端只接受 **当前期待序号 + 对应位置码**，判定全部在单个数据库事务内完成
（`SELECT … FOR UPDATE` 锁定会话行）：

| 情形 | 状态码 | `reason` | 是否推进 |
| --- | --- | --- | --- |
| 序号、位置、扭矩全部正确 | 200 | `ok` | 推进一格 |
| 序号 < 期待序号（迟到旧响应） | 409 | `stale_seq` | 否 |
| 序号 > 期待序号（越序） | 409 | `out_of_order_seq` | 否 |
| 位置码与期待位置不符 | 422 | `position_mismatch` | 否 |
| 扭矩不在 4200–4800（含边界） | 422 | `torque_out_of_range` | 否 |
| 同幂等键、载荷完全相同的重试 | 原状态码 | 返回**原确认**（含原始状态码与响应体，拒绝请求也原样回放），响应头 `x-idempotent-replay: true` | 否（不重复推进） |
| 同幂等键但载荷不同 | 409 | `idempotency_conflict` | 否 |
| 会话不存在 | 404 | `session_not_found` | — |
| 字段缺失/类型错误 | 400 | `validation_error` | 否 |

六次**有效**确认后会话变为 `completed`，页面才显示“轮毂复核完成”。

## 重试语义（重点）

现场问题：触屏重复点击 / 网络延迟会让同一颗螺栓被提交两次；迟到的旧响应还可能错误推进下一步。

处理方式：

1. **每次新提交生成一个新幂等键**（页面用 `crypto.randomUUID()`），随载荷一起发送。
2. **网络层失败时请求可能已经送达**。页面弹出“网络重试”按钮，重试时**逐字节重复
   同一载荷与同一幂等键**（绝不生成新键）：
   - 服务端按 `(session_id, idempotency_key)` 查到原记录，载荷哈希一致 → 直接回放
     首次的原始确认响应，不新增事件、不二次推进；
   - 因此无论第一次请求实际执行了 0 次还是 1 次，任意次数重试的结果都恰好确认一次。
3. **键相同而载荷不同**（例如重放时偷偷改了扭矩）判定为冲突并 409 拒绝，
   防止“借旧键写新值”。
4. **迟到 / 越序与幂等是两条独立防线**：即使旧包带着全新的幂等键到来，序号不等于
   当前期待序号仍会被拒绝（`stale_seq` / `out_of_order_seq`），不会推进。
5. 页面在每次收到响应（成功或失败）以及**每次刷新后**都调用
   `GET /api/sessions/{id}` 重新读取权威进度，本地不做任何乐观推进；
   失败时稳定停留在当前螺栓并展示明确拒绝原因。

## 数据模型与不可变性

```
sessions(id, expected_seq, status, ...)
confirmation_events(id, session_id, seq, position, torque,
                    idempotency_key, accepted, reason_code, created_at)
idempotency_records((session_id, idempotency_key) PK, request_hash, event_id, http_status, response_json)
```

- 每次提交（接受或拒绝）都向 `confirmation_events` 追加一行；被拒绝事件带 `reason_code`。
- 部分唯一索引保证每个会话每个序号至多一条 `accepted` 事件，数据库层面杜绝重复确认。
- 触发器禁止对 `confirmation_events` 与 `idempotency_records` 执行 `UPDATE/DELETE`
  （验收用例会实际尝试并断言失败）。
- 幂等记录保存首次响应的 JSON 原文，重试时原样回放。

## 本地非容器开发

需要可访问的 PostgreSQL 14+：

```bash
createdb wheel_station
cd api && PGUSER=$USER npm install && npm start        # :8081
cd web && API_ORIGIN=http://127.0.0.1:8081 PORT=8080 node server.js
```

运行验收（`API_BASE`/`WEB_BASE`/`PG*` 可覆盖，另需 `npx playwright install chromium`）：

```bash
cd verify && npm install && npm test
```
