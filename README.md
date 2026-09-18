# 轮毂复核工位

产线轮毂复核工位的页面与 API：每个轮毂（会话）按固定顺序 **A1 → B2 → A3 → B1 → A2 → B3**
复核六颗螺栓，逐颗提交整数扭矩（合格范围 **4200–4800 cN·m**，含边界）。
针对触屏重试、网络延迟、迟到旧响应等现场问题，服务端提供严格的幂等与按序语义，
**所有失败均不推进进度**，页面刷新后重新读取数据库中的权威进度。

## 架构

| 服务 | 说明 | 宿主端口 |
| --- | --- | --- |
| `web` | nginx：托管工位页面，并把 `/api/*` 同源反向代理到 `api` | `WEB_PORT`（默认 8080） |
| `api` | Node.js (Express)：会话与确认接口，事务化状态机 | `API_PORT`（默认 3000） |
| `db` | PostgreSQL 16：跨请求状态持久化（会话 + 不可变确认事件） | 仅内部网络 |
| `verify` | 一次性验收服务：Playwright 跑 API 协议用例与真实页面操作用例，跑完退出 | — |

页面与 API 真实联调：浏览器只访问 `web`，由 nginx 代理到 `api`，`api` 读写 PostgreSQL；
`verify` 在 compose 网络内同时打 `api`（协议用例）和 `web`（浏览器用例）。无任何假接口或占位实现。

## 启动

```bash
docker compose up --build
# 打开 http://localhost:8080
```

覆盖宿主端口：

```bash
WEB_PORT=9000 API_PORT=9001 docker compose up --build
```

## 验收（verify 一次性服务）

```bash
docker compose up --build --exit-code-from verify
```

`verify` 等待 `api`、`web` 健康后执行全部用例并退出，命令以其退出码结束
（0 = 全部通过）。用例包括：

- **协议用例**（`verify/tests/protocol.spec.js`）：会话创建、按序完成、幂等重放、
  键冲突、迟到、越序、位置不符、扭矩边界（4199/4200/4800/4801）、非法载荷、
  未知会话、并发重复提交只记录一次、并发同序号只有一个推进、连续失败后可正常完成。
- **页面用例**（`verify/tests/page.spec.js`）：真实浏览器走完六颗确认；扭矩越界时
  页面停留当前螺栓并展示拒绝原因；刷新后恢复权威进度；响应丢失时页面以同一幂等键
  安全重试且只记录一次；两个页面共用会话时迟到提交被明确拒绝；六次有效确认后才出现
  “轮毂复核完成”。

日常开发只想起应用本身：`docker compose up --build db api web`。
清空数据重来：`docker compose down -v`。

## API 协议

基础路径：`/api`（经 `web` 同源代理，或直连 `API_PORT`）。

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| `GET` | `/api/health` | 健康检查（含数据库连通性） |
| `POST` | `/api/sessions` | 创建会话，返回 `sessionId` 与初始进度 |
| `GET` | `/api/sessions/{id}` | 读取会话权威进度（页面刷新后以此为准） |
| `POST` | `/api/sessions/{id}/confirmations` | 提交一颗螺栓的确认 |

确认请求体（页面逐次提交）：

```json
{
  "seq": 1,
  "position": "A1",
  "torque": 4500,
  "idempotencyKey": "9b1d…-…-…-…-…"
}
```

- `seq`：从 1 开始的整数序号；`position`：该序号对应的位置码；
  `torque`：整数（cN·m）；`idempotencyKey`：本次提交的幂等键（≤128 字符）。
- 成功：`201`，返回 `event` 与最新 `progress`。
- 会话进度响应含 `events`（已确认事件列表）、`confirmed`、`nextSeq`、
  `nextPosition`、`completed`；`completed=true` 仅在六颗全部有效确认后出现。

## 重试语义（核心）

服务端在**同一事务**内完成全部校验、追加不可变事件、推进序号，并对会话行加
`SELECT … FOR UPDATE` 锁串行化并发提交；任何一步失败都整体回滚——**所有失败均不得推进**。

判定顺序与语义：

1. **幂等优先**：以 `(会话, 幂等键)` 查找已落库事件。
   - 键相同且载荷（序号+位置+扭矩）完全相同 → `200` 返回**原确认**（`replayed: true`），
     不重复记录、不再推进。触屏重试、超时重发、响应丢失后的重发都走这条路。
   - 键相同但载荷不同 → `409 idempotency_conflict`，拒绝。
2. **会话已完成** → `409 session_completed`。
3. **序号必须等于当前期待值**：
   - `seq < 期待值` → `409 late_sequence`（迟到的旧请求，忽略）；
   - `seq > 期待值` → `409 out_of_order`（越序，拒绝）。
4. **位置必须与序号对应**（A1/B2/A3/B1/A2/B3 固定映射）→ 否则 `422 position_mismatch`。
5. **扭矩须在 4200–4800（含边界）** → 否则 `422 torque_out_of_range`。
6. 载荷形状非法（非整数扭矩、缺幂等键等）→ `400`；未知会话 → `404`。

因此迟到的旧响应永远无法“错误推进下一步”：它要么命中幂等重放（返回原确认），
要么按迟到被拒绝；推进只发生在“当前期待序号 + 对应位置 + 合格扭矩”首次落库时。

客户端（页面）配套约定：

- 每次“用户提交”生成一个幂等键；网络异常导致**结果未知**时，保留同一键与同一载荷
  自动重试，仍失败则提供“安全重试”按钮原样重发——服务器保证不会重复记录。
- 收到服务器**明确拒绝**后，清除待重试状态，展示拒绝原因，并重新拉取权威进度。
- 页面刷新（或会话失效）时重新 `GET` 权威进度；只有服务器返回 `completed=true`
  （六次有效确认）才显示“轮毂复核完成”，否则稳定停留在当前螺栓。

## 数据模型（PostgreSQL）

- `sessions`：会话行。`next_seq` 为下一个期待序号（1–6，7 表示完成），
  `completed_at` 在完成时写入。
- `confirmation_events`：**不可变**确认事件。触发器禁止 `UPDATE`/`DELETE`；
  `UNIQUE(session_id, seq)` 与 `UNIQUE(session_id, idempotency_key)` 兜底并发；
  `CHECK` 约束固化“序号↔位置”映射与扭矩合格区间，数据库层再兜一层。

## 目录结构

```
├── docker-compose.yml      # web / api / db / verify 编排，WEB_PORT、API_PORT 覆盖宿主端口
├── db/init.sql             # 表结构、不可变触发器、约束
├── api/                    # Express API（会话状态机 + 幂等）
├── web/                    # nginx + 工位页面（原生 JS，无构建步骤）
└── verify/                 # 一次性验收：Playwright 协议用例 + 真实页面用例
```
