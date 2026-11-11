# 014 项目进展与交接（2026-11-08）

> 这份文档的目的：**换会话、换机器、上下文清空之后，读它就能接上**。不依赖任何对话记忆。

## 仓库

- 工作副本：`E:\codes\dsh-superagent-prototype`
- 远端：`https://github.com/439436269-ctrl/dsh-superagent`（main）
- 推送需要 operator token：`git -c credential.helper= push "https://439436269-ctrl:$token@github.com/..."`（凭据管理器里那个 VFVrPQ 会被拒）
- 本地 git 身份：`vfvrpq <439436269@qq.com>`

## 这一轮做了什么（按时间）

| 提交 | 内容 |
|---|---|
| `5d7b62d` | `GET dispatcher` 接口（id / 可达 / 在跑） |
| `a0a869f` | 面板「调度者」tab |
| `eb05a3c` | 按 id 指定调度者 + kv 持久化 |
| `186cb1f` | 从会话列表选调度者 |
| `a87763e` | `orchestrator_claim` 工具（router 预设） |
| `b32e605` | 两个启动致命 bug（空串 kv、跨工作区 claim） |
| `b131940` | 回落原因上报 |
| `b00b1ad` | 列表 + 输入框并存 |
| `05f4d64` | 清空改为删除 kv 记录 |
| `7e0e9fd` | claim 工具单测 |
| `bb15470` | 提示词：被要求时才 claim |
| `17c4c8b` | 概览页显示调度者 |
| `33ee9ea` | **修 400**：延迟 15 秒再重启 |
| `0610dc1` | `orchestrator_notify`（任意会话 → 调度者） |
| `b9aab59` | 钉钉桥 + 测试 + 文档 |
| `aa10b77` | 提示词：如何读别会话的消息 |
| `63cdc0f` | session source 构造器 + 测试 |
| `dd63693` | **注册 session source**，delegate 入管道 |
| `46d30ff` | 修 delegate 返回值（trigger id） |
| `dad8a75`/`c34d876` | 钉钉桥真进程测试（验签） |
| `606f206` | request 与 delegate 统一走管道 |
| `1b4f088` | `docs/013` 多仓方案 |

## 已验证的（有实机证据）

1. **调度者**：面板显示/切换/恢复默认；claim 后重启保持；跨进程会话被拒时回落并报原因
2. **400 已修**：claim → 等 30 秒 → 第二轮回话正常，`INVALID_REQUEST=false`
3. **会话互通**：任意会话 `orchestrator_notify` → `session` 源 `received=1` → 进入判定记录
4. **钉钉公网链路**：cloudflared 隧道 POST → 200 `{"errcode":0}` → 输出标准 message 行

## 未完成 / 卡住的

| 项 | 状态 | 原因 |
|---|---|---|
| 钉钉真实联调 | 卡住 | 缺 `DINGTALK_APP_SECRET`、webhook `access_token`、加签 secret（只在钉钉后台） |
| 测试基线核对 | 未做 | 全量 62 failed / 1155 passed；`runtime` 8 / `docs` 3 / `commands` 4 是已知基线，`service-script` 15 看过是 Unix 进程语义；**未用 git stash 对跑**，其余组是推断不是结论 |
| PR 合并 CLI | 未配 | 工单卡在"PR 已过 CR，本部署没配合并 CLI" |
| 多仓支持（C） | 方案已定 | 见 `docs/013-multi-repository.md`，五阶段 |

## 环境事实（关键）

| 项 | 值 |
|---|---|
| 客户端编排器 | 端口每次启动变，探测方式见下；状态库 `C:/Users/Lenovo/.dsh/state/superagent` |
| 开发实例 | 固定 3082，状态库 `.../state/superagent-dev`，`python scripts\dsh-superagent start/stop/status` |
| 探测编排器 | 遍历监听端口 GET `http://127.0.0.1:<port>/orchestrator/api/state`，header `x-orchestrator-request: 1` |
| **禁止** | 在客户端跑着时启动独立服务会抢锁；面板/接口改配置优先，别直接写 sqlite |
| 面板 | 侧栏 **Superagent** → tab：概览/来源/触发/评估/执行/**调度者**/设置 |
| 浏览器验证 | Chrome `C:\Users\Lenovo\AppData\Local\Google\Chrome\Application\chrome.exe`，playwright-core 在 `~/.dsh-browser/node_modules` |
| 面板选择器 | 侧栏按钮文本 `Superagent`；tab 用 `getByRole('tab', {name:'调度者'})`；输入框 `[data-composer-input]`；发送 `button.uV2eYG_primary` 或 Enter |

## 踩过的坑（别再踩）

1. **kv 不能写裸空串**：`Store.get` 会 `JSON.parse`，空串让插件启动即崩 → 清空用 `store.delete`
2. **claim 到跨进程会话会起不来**：`ensure()` 无法把已有会话挪进 `masterDirectory` → 初始化回落到默认并记 `claimFallback`
3. **对话中途重启 = 400**：工具被标 `deferLoading`，全延迟加载被 API 拒 → `setTimeout(restart, 15s)`
4. **插件必须声明 `inject: ['orchestrator']`**，否则 `cannot get property "orchestrator" without inject`，日志表现为 `N entries did not activate`
5. **`ChannelRef` 必须有 `thread`**，只有 `source + address` 编译不过
6. **README 里的 PowerShell 坑**：中文全角引号会让解析失败；`.Replace()` 里嵌 `-replace` 会当成第三个参数报错，要先算成变量

## 下一件事

`docs/013` **阶段 1**：`Ticket` 加 `repository` 字段，缺省回落配置的默认仓，迁移既有工单。只加字段、不改行为，可单独回滚。
## 2026-11-08 晚：多仓五阶段 + 多源主体完成

**多仓**：五阶段全部落地（见 `docs/013` 的实施状态表）。单仓部署行为不变；缺双仓端到端实测。

**多源**：`settings.sources` 现在支持「实例 id ≠ kind」，实例在条目里声明 `kind`；`SourceContext` 绑定实例、`config()` 无参取绑定实例；`im` 与 `feishu` 都按实例起循环；每实例可用 `config.env` 携带自己的凭据；新建实例会自动重启使循环生效。

实机：开发实例 `im`（yoga-dsh机器人）与 `im-2`（yoga-dsh小钉）同时 ready，两个独立的桥进程。

**钉钉接入方式已变更**：不走 HTTP 回调与隧道，改为 **Stream 长连接**（`examples/im-bridges/dingtalk-stream.mjs`，`/v1.0/gateway/connections/open` 拿 endpoint+ticket，WebSocket 收 `CALLBACK`）。钉钉后台那个「重定向URL」不需要填。`dws`（官方 CLI）需要 OAuth 登录，本方案不依赖它。

**未验证**：两个钉钉机器人各收一条消息；两个仓库各跑一张工单。

## 多仓验证记录（2026-11-08 深夜）

**已实测**：
- 第二仓 `439436269-ctrl/superagent-second`（私有，agent 有 push）被列表轮询发现 → `received=1` → 进入判定
- 线程键带仓：`github:439436269-ctrl/superagent-second#6`
- 默认仓旧线程键 `github:5` 不受影响

**修掉的三连环 bug**：轮询读未填充的 `deployment.repositories`；把游标名当流 id 传（`id === 'issues'` 判断失败退化成 comments 分支）；304 提前 return 导致坏游标永远修不好。

**仍未验证**：多仓工单的 worktree 落点与 PR 归属——需要先给开发实例配评估模型（当前判定是 `unavailable`），否则工单根本出不来。

**多源仍未验证**：两个钉钉机器人各收一条消息（`im=1`、`im-2=0`）。

## 未结问题：第二仓的新 issue 被静默丢弃（2026-11-08 23:37）

现象：
- 第二仓 `439436269-ctrl/superagent-second` 的 issue #5 **成功**产生触发（`received` +1，判定 `github:…#5`）
- 之后的 #6/#7 产生判定但都是 `unavailable`（当时是我的测试数据中文写成 `?`，模型判断正确）
- 修好数据后新建的 #9、#10 **完全没有触发**：`received` 停在 3，判定记录不再增长

已排除：
- 游标 `since` 正常推进（14:32:15），新 issue 的 `updated_at` 晚于它
- `started.issues` = 14:13:59，新 issue 的 `created_at` 晚于它，`fresh()` 应当通过
- `filtered` / `dropped` 计数都是 0 —— 但这两个计数**不统计该丢弃路径**，属于可观测性缺陷

待查（`readStream`，`src/sources/github.ts:222-276`）：
1. `if (sameName(item.user.login, login)) continue` —— 若 `deployment.github.login` 是 operator 账号，operator 自己开的 issue 会被当作"自己的"跳过
2. `IssueSchema.safeParse(item)` 是否对新 issue 失败（失败也是静默 `continue`）
3. `validItems(ListedSchema, …)` 是否在进入循环前就把条目过滤掉

建议做法：在这三处 `continue` 前各记一次计数（写进 health detail 或临时 KV），跑一轮看落在哪，再修并删掉诊断。

## 未结问题二：两个游标长时间冻结（2026-11-08 22:52）

```
github-stream:issues                          since 13:59:02（默认仓 superagent-sandbox）
github-stream:…superagent-second:issues       since 14:36:02（第二仓）
```

此后近 50 分钟内反复重启、`observeIssues=true`、`repositories` 配置正确，两个游标**都没有前进**，`github-skipped` 计数记录也从未出现。

已排除：
- 配置：`repositories` 有第二仓，`observeIssues=true`，rev=3
- 服务：`/sources` 显示 github `ready`，health 文案正常
- 轮询范围：修复后 `served` = 默认仓 + 额外仓，两个游标键都在被读写
- 与 `dsh-schedule` 的 `unit 'schedule': stored version 2 != expected 1` 无直接关系（该错误只出现 2 次，来自另一个插件）

**未能解释**：为什么轮询没有把 `since` 之后的 issue（#9、#10）变成触发。

下一步建议（按代价从低到高）：
1. 在 `pollRepository` 入口记一次 KV（`github-poll:<repository>` = 时间戳），确认轮询是否真的按周期执行
2. 记录 `readStream` 的 HTTP 状态码（200/304）与返回条数
3. 若确认轮询在跑但接口一直 304，检查 `conditional`（`If-None-Match`）与 `since` 的配合是否让 GitHub 复用了旧 etag
4. 万不得已：重置 `C:/Users/Lenovo/.dsh/state/superagent-dev`（开发沙箱，无真实数据），从干净状态重跑

## 2026-11-08 23:30：多仓闭环

目标 1（多仓五阶段）**端到端实测通过**，详见 `docs/013` 的「端到端实测通过」一节。关键提交：

`bfc7a41` 工单记仓 · `38d0347`…`b43b84a` 多仓监听与 PR 归属 · `6af3800` `06a4db9` `78508c3` 环境与 worktree · `0c85f8b` `941f624` `f70e19c` 回复与读 PR 按仓 · `29fe6c8` 面板仓库字段 · `4634438` 线程键带仓 · `9f8113c` 线程回读按仓 · `c5aa44b` 列表轮询按仓 · `4cd01e2` 默认仓不被挤出 · `ccb22fc` 工单落库 repository · `22bbe35` 行展示 repository

多源（目标 2）能力完成，实机两个钉钉机器人各自跑独立桥进程；**缺**：两个机器人各收一条消息的实测。

遗留观察：
- PR #18 合并后工单仍显示 `working`（下轮确认是否推进到结束）
- `POST /tickets/:id/stop` 对空 id 返回 404；`GET /tickets` 曾在工单 ended 时返回 0 条，原因未确认

## 2026-11-08 23:45：多源最后一个代码缺陷未修

已修的关键 bug：`Runtime.context` 丢掉实例 id，导致**同一 kind 的每个实例都拿到第一个实例的配置**——三个 `im` 实例全跑第一个桥的脚本。修复后进程参数与配置一一对应（`im`/`im-2` = dingtalk-stream，`im-3` = wecom）。

未修：健康条目按实例区分（两次尝试，`sources.spec` 6→9 回归，已回滚）。改法与正确顺序见 `docs/013`。

其余状态：多仓闭环已实测；多源各实例独立运行已实测；缺「第二个机器人收到一条消息」的人工触发。

## 交接状态（2026-11-09 00:25，Round 101）

### 目标 1：多仓 —— 完成

端到端实测通过（第二个仓 `439436269-ctrl/superagent-second`）：issue #17 → 轮询发现 → accept → 工单 `repository` → 按仓 worktree → PR #18（该仓，已合并）→ issue 回帖 → 工单 ended/completed。

修复的 10 个 bug，全部提交可回滚：`bfc7a41` `38d0347`…`b43b84a` `6af3800` `06a4db9` `78508c3` `0c85f8b` `941f624` `f70e19c` `29fe6c8` `4634438` `9f8113c` `c5aa44b` `4cd01e2` `ccb22fc` `22bbe35` `4022851` `28ba1bc`。

单仓兼容：默认仓的线程键、游标键、worktree 路径、channel 地址逐字节不变；`sources.spec` 始终 6 failed 基线。

### 目标 2：多源 —— 代码完成，运行时未验

已修并提交：

| 提交 | 内容 |
|---|---|
| `78a92d6` `8397d08` | 实例可声明 `kind`，`instances()`/`instance()`/`validate()` 按 kind 解析 |
| `07ab9b5` `b28d55c` | `SourceContext` 绑定实例 id，`config()` 无参取绑定实例 |
| `09c8192` | 放开四处「id 必须等于 kind」的守卫，使第二实例可创建 |
| `8484f6c` `bf20b2f` | `im` 与 `feishu` 按实例起循环 |
| `6c19df8` | 新增实例自动重启生效 |
| `dc0b6c2` | 停用实例自动停止循环 |
| `e00966b` | **`Runtime.context` 转发实例 id**（此前所有实例都拿到第一个实例的配置） |
| `f3a0162` | 停用实例不再起循环、不写共享健康条目 |
| `a5770e4` `47a765f` | **准入按 channel 里的实例解析**（此前第二实例的群一律被判 `chat_not_allowed`）+ 回归测试 |

实机已证：三个实例（两钉钉 + 一企业微信）各跑各的进程、各自配置生效、启停互不影响。

**未证（需要一次重启）**：两个同类实例各收一条属于自己群的消息且互不串。3082 上的进程仍是修复前的代码；按用户 16:00 的提醒，本会话不得对独立服务执行 start/restart。

### 下一次接手的顺序

1. 重启一次让 `a5770e4` 生效（客户端或经用户授权的 3082）
2. 启用 `im-probe-a` / `im-probe-b`（`examples/im-bridges/probe.mjs`，配置已存在但为停用态），等一轮轮询
3. 断言：两者 `received` 各 1、判定里各一条 `im:probe-a` / `im:probe-b` 线程、无交叉
4. 再在钉钉群分别 @ 两个机器人，验证真机
5. 余下非阻塞项：健康条目按实例区分（危害已消除，纯展示）

## 2026-11-09 夜：任意仓库 + 发布

- 新增 `orchestrator_repo_add`、执行器按需克隆、`DSH_SUPERAGENT_REPOSITORY_DIR`
- 修 `github.ts` 的线程 id 解析（`owner/name#5` 曾让 PR 轮询连续失败 253 次）
- 全新仓库 `dsh-crew-demo` 端到端验证通过（克隆 → worktree → PR #2 已合并）
- npm 发布链：`0.1.0` → `0.1.1` → `0.2.0` → `0.2.1` → `0.2.2`（`latest=0.2.2`）
  注：npm registry 对新版本有数分钟索引延迟，期间 `npm view`/`install` 会 404，不是发布失败

## 2026-11-11 凌晨：派活入口与验收状态

代码（全部已提交、`tsc` 0）：

| 能力 | 入口 | 证据 |
|---|---|---|
| 监听仓干活 | issue/PR 轮询 | `dsh-crew-demo` 全链路，PR #2 已合并 |
| 非监听仓派活 | `orchestrator_dispatch(repository, request)` | 单测证明准入通过（`dispatch-admission.spec.ts`） |
| 无仓库先本地干 | `orchestrator_dispatch(request)` | 目录 `<root>/local/<name>`，未实测 |
| 新建仓库 | `orchestrator_repo_create(name)` | 默认 owner `439436269-ctrl`，未实测 |

未完成的实测（需要人操作，我这边没有入口）：

1. 桌面客户端重启后在飞书上真正触发一次 dispatch —— 验证工单生成与本地/worktree 目录
2. 「多源验证B」群里 `@多源助手` —— 验证两个飞书实例各管各群（同一应用双实例会互抢的结论已由文档记录，当前用两个应用规避）
3. 企业微信多实例：无凭据，从未连过真实群

已知限制与坑（详见 013）：`lark-cli` 的 strict 模式在多 app 配置下需要两个 app 都设 `strictMode: "bot"`；同一 app 两个消费者会静默丢事件，代码里已有防护并明确报错。

## 2026-11-11 凌晨：验收现状（第 127 轮）

已自证：

- 面板仓库列表：`tickets?state=all` 返回 5 条，多仓工单带 `repository`（`dsh-crew-demo` / `superagent-second`），改造前的工单该字段为空——向后兼容
- `state=all` 之前被 `.catch('open')` 静默降级成空列表，已修（`ddccf55`）
- 钉钉两机器人：各收各的（`receive="stored"` ×2），探针各成独立线程
- 桥的自检：`wecom.test.mjs` 5 项、`dingtalk.test.mjs` 6 项全过

仍缺（需人操作）：

1. 飞书两实例的**真实消息**验证。我试过三条自助路径都不行：
   - 用户身份发消息：缺 `im:message:send` 用户授权（`99991679`），补授权要扫码
   - bot 身份发消息：飞书只在被 @ 时推给 bot，且 bot 消息本身不会触发
   - 用 `member_id_type=app_id` 把多源助手拉进群：成功，但进群 ≠ 能收到非 @ 消息
   结论：必须在「多源验证B」群里由人 `@多源助手` 发一条
2. 企业微信：无凭据，桥虽自检通过但从未连真实群
3. 客户端实跑 dispatch / repo_create：需重启客户端后由人在飞书触发

## 2026-11-11 上午：范围调整与最终阻塞

用户决定：**企业微信凭据先不做**。因此目标 2 的范围收敛为「飞书 + 钉钉」：

| 渠道 | 结论 |
|---|---|
| 钉钉 | 已验证：两个机器人各收各的（`receive="stored"` ×2），探针各成独立线程 |
| 飞书 | 两应用两实例均 ready，配置与准入均就绪，**缺一条真实消息** |
| 企业微信 | 按用户决定搁置；桥自检 5 项通过，从未连过真实群 |

飞书这条的阻塞是结构性的，不是代码：开发实例 3082 重启后不会自启，而飞书事件**不补发**，所以消息到达时必须有人在跑。三条自助路径已试尽（用户身份缺 `im:message:send` 授权、bot 消息不触发另一个 bot、拉进群不等于能收非 @ 消息）。需要用户在群里 `@多源助手` 或直接私聊多源助手发一句话。

## 2026-11-11 上午：飞书第二实例的事件投递仍未打通（证据链）

排查过程与判据：

| 检查 | 结果 |
|---|---|
| 多源助手在「多源验证B」群 | ✅ 用它自己的 `GET /im/v1/chats` 能列出该群 |
| 能读群消息 | ✅ `GET /im/v1/messages?container_id_type=chat` 读到了含 @ 的记录 |
| @ 的目标 | ✅ mention `open_id = ou_4d2e5f82…`（多源助手本人），sender 为 user |
| 权限 | ✅ `im:message.group_at_msg:readonly`、`im:message.group_msg` 均「已开通」 |
| 事件订阅 | ✅ `im.message.receive_v1`，订阅方式「使用长连接」 |
| 版本 | ✅ 1.0.1 已发布 |
| 消费者 | ✅ 独立探测消费者 `[event] ready`，`consuming as duoyuan` |
| **事件送达** | ❌ 探测期间 0 条；`feishu-2.received` 始终 0 |

同时本机网络在该时段不稳定：

```
bus.log: get conn url failed: Post https://open.feishu.cn/callback/ws/endpoint: EOF
         lookup open.feishu.cn: no such host
```

同一群的另一条消息被**团队助手**（默认应用）收到（`feishu.received` 从 10 涨到 14），说明群与消息本身正常，差异在第二个应用的事件投递。

尚未验证完的一条假设：该应用可能需要在「应用能力 → 机器人」里显式开启消息接收，或事件订阅需要随版本重新生效（1.0.1 的「权限变更」显示「暂无」）。下一次需要在网络稳定的窗口里再跑一次独立探测消费者。

## @ 提及是「按应用」的（2026-11-11 夜，决定性发现）

`feishu-2` 改用默认应用后，群里 @多源助手 的消息**仍不产生判定**。原因不是收不到，而是：

> 消息里的 mention 指向 `ou_4d2e5f82…`（**多源助手**那个机器人的 open_id）。对**团队助手**这个应用来说，这条消息没有 @ 它，于是按未提及消息处理。

这解释了两件事：

1. 历史补收里同样的消息也被判为「未提及」而丢弃
2. 之前几次「收不到」混杂了两种原因：应用事件没投递（第二个应用）+ @ 指向别的应用（共享应用时）

**结论**：

| 想要的形态 | 需要什么 |
|---|---|
| 一个 bot、多个群、按群分实例 | **一个应用** + 共享消费者 + 按 chat 分发（已实现，`6ff5602`），测试时 @ **这个应用自己的 bot** |
| 每个机器人 @ 自己 | **每个实例一个应用**（第二个应用的事件投递问题未解决，见上节） |

两者不能混用：共享应用时，@ 别的应用机器人不会触发本应用。
