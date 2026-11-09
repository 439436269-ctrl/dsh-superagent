# 013 多仓库支持

目标：一个 dsh-superagent 实例同时服务多个仓库，每张工单绑定它自己的仓库。

## 现状（单仓）

`machine.repository` 一处配置，被以下环节直接读取：

| 环节 | 位置 | 现在怎么用 |
|---|---|---|
| 部署检查 | `src/setup.ts` / `deployment.ts` | 启动时验证账号能推送到它，失败即 `repositoryUnreadable` |
| 来源轮询 | `src/sources/github.ts` / `github-pull.ts` | 只轮询这一个仓库的通知、Issue、PR、CI |
| 工单工作区 | `machine.repository` → executor `prepare` | 从该仓 `origin/main` 开分支建 worktree |
| PR 链路 | github channel / read | 开 PR、查 CI、判"已过 CR"都针对它 |
| 回复 | outbox | PR 链接指向它 |

## 目标模型

```
Ticket.repository = "owner/name"        ← 每张工单绑一个仓
sources.github.repositories = [a, b]    ← 来源可监听多个
deployment 校验 = 每个仓都要能推
executor prepare = 用 ticket.repository 开 worktree
PR/回复 = 用 ticket.repository
```

## 分阶段

**阶段 1：数据模型**
- `Ticket` 加 `repository`（缺省回落到配置的默认仓）
- `machine.repository` 保留为默认仓（单仓用户零感知）
- 迁移：既有工单填默认仓

**阶段 2：来源**
- `source:github` 配置从 `repository: string` 变为 `repositories: string[]`（保留 `repository` 作为单值兼容）
- 轮询按仓逐个进行，触发时把 `repository` 写进 `trigger.meta.repository`
- 准入表按仓区分（`policy.sources.github.admission` 以 `owner/name` 为键）

**阶段 3：执行器**
- `prepare` 命令的 `$DSH_SUPERAGENT_REPOSITORY` 来自工单而不是全局
- worktree 目录按仓分组：`<workspace>/<owner>/<name>/<worktree>`
- 环境变量新增 `DSH_SUPERAGENT_REPOSITORY`

**阶段 4：PR 与回复**
- `gh` 调用带 `--repo <ticket.repository>`
- 回复里的 PR 链接按工单的仓生成

**阶段 5：面板**
- 来源设置：仓库列表（增删行）
- 工单详情显示所属仓库

## 兼容与回滚

- `repository`（单值）继续可用，内部归一成 `[repository]`
- 每阶段独立提交；阶段 1 只加字段不改变行为，可单独回滚

## 验收

1. 配两个仓（sandbox + 一个空仓）→ 两个仓各 @ 一次 → 各开一张单，worktree 分别落在各自目录
2. 各出 PR，链接分别指向各自的仓
3. 回滚到 `repository` 单值配置，行为与今天完全一致

## 风险

- worktree 目录布局变化会影响既有 worker 的 cwd 约定 → 阶段 3 需要同时更新 prompts/work.md 里的路径说明
- 通知轮询变 N 个仓，GitHub 速率上限要复核（每仓一次轮询）
## 多源：现状与改动面（2026-11-08 调研）

需求：飞书、企业微信、钉钉都能配**多个来源实例**（多个机器人、多个群各自独立）。

现状 **不支持**，而且不是缺 UI：`src/sources/registry.ts` 里

```ts
instances(settings) {
  const installed = [...this.kinds.values()]
    .map(kind => ({ ...this.resolve(kind, settings.sources[kind.kind]), installed: true }))
}
```

`settings.sources` 的**键就是 kind**，所以一个 kind 只能有一个实例，存储层表达不了第二个飞书机器人。

改动面：

| 层 | 现在 | 要变成 |
|---|---|---|
| `settings.sources` | `{ [kind]: { enabled, config } }` | `{ [instanceId]: { kind, enabled, config } }` |
| `instances()` | 每个 kind 一个 | 遍历存储里的所有实例 |
| 健康条目 | 每 kind 一组 | 每实例一组 |
| patch 条目 | 每 kind 一行 | 可多行同 kind、id 不同 |
| 面板 | 每 kind 一个设置块 | 实例列表 + 新增/删除 |
| 迁移 | — | 既有 `{ [kind]: … }` 归一成 `{ [kind]: { kind, … } }`，id 沿用 kind |

## 调整后的顺序

原来把多源排在多仓之后，现在看两者共享同一个前置条件：**配置从单值变集合**。

1. 多仓阶段 2（`source:github` 的 `repository` 变 `repositories` 列表）——第一个"单值变集合"的样本
2. **多源改造**（`settings.sources` 按实例 id）——把阶段 2 的模式推广到所有 kind
3. 多仓阶段 3–5

阶段 2 因此不只是多仓的一步，也是多源的探路。

## 多源：真正的障碍在 `SourceContext.config`（2026-11-08 补）

上一节列了六层改动。实际动手前又确认了一处**更硬**的耦合：

```ts
// src/sources/host.ts:40
config<C extends Record<string, unknown>>(kind: string): C | undefined
```

来源插件拿配置的方式是 **`ctx.config(kind)`** —— 按 **kind 名**取，不是按实例 id。而每个 kind 的插件在 `apply` 里只注册一次自我：

```ts
ctx.effect(() => ctx.orchestrator.sources.register(feishuKind), 'feishu: source kind')
```

所以同一个 kind 的第二个实例，会拿到的仍是**第一个实例的配置**。这不是加个 `kind` 字段能解决的，而是要把 **实例 id 贯穿到 `SourceContext`**：

1. `SourceInstanceSchema` 加 `kind`（缺省 = 键名）
2. `SourceRegistry.instances()` 按 kind 归组，允许一个 kind 多个实例
3. `SourceContext` 增加实例 id，`config()` 改为按实例取
4. 每个 kind 的插件从"注册一个 kind"改为"注册 kind，并按实例启动循环"
5. patch 条目可用不同 id 声明同一 kind
6. 面板：实例列表 + 新增/删除
7. 迁移：`{ github: {...} }` → `{ github: { kind: 'github', ... } }`，id 沿用 kind

第 3、4 条是主体：它改变的是"插件与配置的绑定方式"，影响所有 kind（`github`、`feishu`、`im`）。

## 结论

多源不能靠改 schema 完成，需要一次**贯穿 SourceContext 的改造**。在此之前，可行的是：
- 同一 kind 只跑一个实例（今天的状态）
- 不同 kind 可以同时跑（飞书 + 钉钉 + IM，已验证 `im` 与 `feishu` 并存）

## 实施状态（2026-11-08）

多仓五阶段**代码全部完成**，每阶段独立提交：

| 阶段 | 提交 | 内容 |
|---|---|---|
| 1 | `bfc7a41` | `Ticket.repository`，建单时从 `trigger.meta.repository` 填充 |
| 2 | `38d0347` `163d7a7` `6073beb` `98fb798` `549fe46` `b43b84a` | 来源与部署接受多仓；通知与 PR 归属按仓集合；触发把仓写进 `meta` 与回复地址 |
| 3 | `6af3800` `06a4db9` `78508c3` | `DSH_SUPERAGENT_GITHUB_REPOSITORY` 按工单；worktree 落在 `<root>/<owner>/<name>/`；默认仓接线 |
| 4 | `0c85f8b` `941f624` `f70e19c` | 回复与读 PR 按工单的仓 |
| 5 | `29fe6c8` | 面板可编辑额外仓库列表 |

**兼容性**：`repository` 仍是默认仓；`repositories` 为空时行为与改造前逐字节一致（`ticket.repository` 为空、watchtree 路径不变、触发对象不变）。

**未验证**：没有真的用两个仓库跑过一张工单（需要第二个仓库）。代码与基线测试通过，端到端待实测。

## 多源实施状态

| 步骤 | 提交 | 内容 |
|---|---|---|
| 1 | `78a92d6` | 实例可声明 `kind`，`instances()` 按 kind 归组 |
| 2 | `8397d08` | `instance()` / `validate()` 按声明的 kind 解析 |
| 3 | `07ab9b5` `b28d55c` | `SourceContext` 绑定实例 id，`config()` 无参取绑定实例 |
| 4 | `8484f6c` `09c8192` | `im` 按实例起桥循环；放开四处「id 必须等于 kind」的守卫（路由、保存、校验、parse 丢弃 kind） |
| 4b | （合并在上） | 每实例 `config.env`，桥启动时注入 |
| 4c | `6c19df8` | 新建实例后自动重启，循环随之启动 |
| 4d | `bf20b2f` | `feishu` 同样按实例起消费者循环 |

**实机**：开发实例同时跑 `im` 与 `im-2`（两个钉钉机器人、两个桥进程、各自凭据），均为 `ready`。

**未验证**：两个机器人各收到一条消息的实测（需要人分别在群里 @ 它们）。

## 已知缺陷：线程键不含仓库（2026-11-08 实测）

第二个仓的 issue #5 被发现后，判定记录的线程键是：

```
thread = github:5
```

`githubChannel()` 只用编号拼线程（`src/sources/github-trigger.ts:9`）。多仓下的后果：

- 仓 A 的 #5 与仓 B 的 #5 落到**同一条 Thread**，描述、订阅、回复地址都会互串
- 工单虽然记了自己的 `repository`，但 Thread 是共享的，回话会走 `trigger.channel.address`——那里带的仓可能来自另一条线

**修法**（未实施）：线程键带仓，但默认仓保持原格式以兼容既有数据：

```
默认仓      github:<number>
其它仓      github:<owner>/<name>#<number>
```

要改的位置：`githubChannel`（加可选 repository）、`github.ts` 里 `ctx.threads.patch/describe` 的几处硬编码、`github-pull.ts` 两处、`migration.ts` 一处。改动面 5 个文件，且涉及既有线程键的兼容，需单独一轮并迁移验证。

## 缺陷已修：线程键带仓（`4634438`）

`stamped()` 现在为非默认仓改写线程键与回复地址：

```
默认仓      github:<number>
其它仓      github:<owner>/<name>#<number>
```

实测（开发实例）：第二个仓的 issue 产生 `thread=github:439436269-ctrl/superagent-second#6`，默认仓的旧线程 `github:5` 不受影响。

改法只在 `stamped()` 一处（三份），**没有改任何函数签名**——上一轮尝试在行内做字符串替换，把合法的模板字符串吞掉了，已回滚；最终用「Node 脚本按行号 splice」完成。

## 端到端实测通过（2026-11-08 23:30）

全部发生在第二个仓 `439436269-ctrl/superagent-second`：

| 环节 | 证据 |
|---|---|
| 发现 | issue #17 被列表轮询发现（`fetched=2`，另一条是 agent 自己开的 #10，被 `own` 正确跳过） |
| 判定 | `accept`，理由「Explicit, fully specified one-word typo correction in a comment」 |
| 工单 | `ticket.repository = "439436269-ctrl/superagent-second"` |
| worktree | `E:\codes\superagent-sandbox\439436269-ctrl\superagent-second\fix-comment-typo-f133df157ac0` |
| PR | `https://github.com/439436269-ctrl/superagent-second/pull/18`，分支 `agent/fix-comment-typo-f133df157ac0`，改 `src/greet.js`，已合并 |
| 回复 | issue #17 上一条 VFVrPQ 评论 |

过程中修掉的真 bug（都是单仓部署看不出来的）：

1. `deployment.repositories` 从未被填充，轮询只扫默认仓 → 改为读来源配置的 `repositories`
2. `served` 用「有额外仓就替换」的写法，把默认仓挤出了轮询
3. 把游标名当流 id 传，`id === 'issues'` 判断失败，流退化成 `comments` 分支
4. 304 提前 return，坏游标永远修不好
5. 线程键只用编号（两个仓的同号 issue 撞车）
6. 线程回读用默认仓的 Commands（读到另一个仓的同号 issue）
7. `Ticket.repository` 算出来却没放进工单对象
8. 工单行不输出 `repository`（面板与接口看不到）

## 排查教训（值得记住）

先后有 **五轮** 误判"轮询坏了"，实际都是测试数据的问题：

- PowerShell 发中文 JSON 变成 `?` → 模型判 `unavailable`（判断正确）
- 用 agent 账号开 issue → 被 `sameName(user.login, login)` 正当跳过
- 同仓同类请求 → 被已有工单判为重复（合理）

**先确认测试数据本身有效，再怀疑实现。**

## 已知缺陷：PR 编号跨仓不唯一（2026-11-08 23:40）

`pullsOf(ticket)` 返回的是**纯编号**（`src/sources/github-pull.ts:19`），而 `pollTicketPulls` 拿编号去默认仓的 `Commands` 读：

```ts
const numbers = [...new Set(ctx.tickets.open().flatMap(ticket => pullsOf(ticket, true)))]
for (const number of numbers) { const pr = await pull(ctx, round, number) }   // ← ctx.commands = 默认仓
```

后果（实测）：第二仓的 PR #18 已合并，工单仍停在 `working`——轮询去默认仓找 #18，那里要么没有要么是另一条 PR。

同一处的其它受害者：`claimPull`、`pullEndNotices`、`observePull` 都用编号匹配 `follows`，两个仓的同号 PR 会互相认领。

**修法**（需要数据模型改动，未实施）：
1. `follows` 里记的从 `number` 改为 `repository#number`（或增加 `repository` 字段）
2. `pullsOf` 返回 `{ repository, number }`，`pollTicketPulls` 按仓取 `commands.forRepository(repository)`
3. 迁移：既有 `follows` 里的纯编号视为默认仓

这与线程键的修法（`github:<owner>/<name>#<n>`）是同一个模式：**凡是"编号当身份"的地方，多仓下都要带上仓库**。

## 多源验证：已证与未证（2026-11-08 23:50）

**已证（实测）**

| 观察 | 含义 |
|---|---|
| `im` 与 `im-2` 同时 `ready`，两个独立的 `node dingtalk-stream.mjs` 进程 | 一个 kind 可以同时跑两个实例，各自独立进程 |
| 两个实例配置的是**同一个群**，但消息只到了 `im`（`received=1`，`im-2` 为 0） | 两个实例用的是不同应用的凭据，不会互收对方机器人的消息 |
| `im-2` 出现在设置接口里（`kind=im`，5 个字段） | 面板能渲染非默认实例 |
| 保存新实例后自动重启，循环随之启动 | 新增实例无需手工重启 |

**未证**

「`@yoga-dsh小钉` 的消息进到 `im-2`」——需要在钉钉群里由人 @ 一次。这一次没有任何自动化替代方案：Stream 是实时长连接，补发无效。

**为什么不能靠"代码看起来对"顶替**：多源最容易出的错恰好在运行时——两个实例共用一个游标、一个进程、一份凭据。前两者已用进程与计数证明，第三项用「同群只到其一」证明；只有"第二个机器人真的收到过一条"仍需一次人工触发。

## 未完成：健康条目按实例区分（2026-11-08 23:45）

现状：`report()` 写入的健康条目按 **kind 名**登记，三个 `im` 实例共用一个 `im` 槽，最后写入者覆盖，`/sources` 里三个实例显示同一条文案——**看不出哪个实例健康**。

两次尝试都失败并回滚：

| 尝试 | 做法 | 失败原因 |
|---|---|---|
| 1 | 在 `runIm` 里给 detail 加 `[instance]` 前缀 | 真正写这条文案的是 `runBridge`（在 `runIm` 作用域外），前缀没生效 |
| 2 | `healthEntries` 按需创建 `im:im-2` 分槽 + `report` 映射到分槽 | 功能生效，但 `sources.spec` 从 6 → **9** 失败 |

第 2 次的 3 个新失败说明这是**接口约定变更**：既有测试断言「一个 kind 一组健康条目」。正确顺序应是：

1. 先改测试，明确「每个实例一组健康条目」是新约定
2. 改 `registry.register`：为每个实例的 `kind.health` 声明条目（默认实例用原名，其余 `name:instance`）
3. `sourceContextOf` 绑定实例后把 `report(name)` 映射到该实例的槽
4. 面板与 `/sources` 按实例列出

改哪三处：`src/sources/registry.ts`（`register` 与 `healthEntries`）、`src/app/source-context.ts`（`health` 与 `report`）、`tests/sources.spec.ts`（健康条目预期）。

## 已修：停用的实例会污染同类实例的健康显示（`dc0b6c2` 之后）

实测复现：三个 `im` 实例（两个钉钉 + 一个企业微信）全部 `ready` 时，把 `im-3` 设为 `enabled: false`，**`im` 和 `im-2` 一起变成 `paused — The IM Source has no bridge command`**，而它们其实在正常工作。

根因是两层叠加：

1. 健康条目**按 kind 共用一条**，最后写入者覆盖
2. 停用的实例仍会起循环，而它解析出的 `config` 是 `undefined`，于是往共用条目里写 `paused`

修法（minimal）：构建循环时直接跳过停用的实例——

```ts
const instances = sources.instances().filter(i => i.kind === imKind.kind && i.enabled)
```

`im.ts` 与 `feishu.ts` 同样处理。效果：

- 停用 `im-3` 后，`im` / `im-2` 保持 `ready`，桥进程从 3 个正确降到 2 个
- 停用不再需要重启才生效（历史问题一并消除）

**仍未做**：多个**启用**实例之间的健康区分（它们共用一条文案，都健康时显示 `ready` 是正确的，只是分不清谁是谁）。危害已消除，属于纯展示问题。

## 严重缺陷（2026-11-09 00:12）：准入用的是默认实例的配置

用两个探针实例（`im-probe-a`、`im-probe-b`，同一 kind `im`，各自配置自己的群 `probe-a`/`probe-b`）实测：

```
im: received=3  filtered=2
  filtered: {code: chat_not_allowed} × 2
```

**两条探针消息都到了引擎，但被判「群不允许」**——因为准入检查按 kind 解析实例：

```ts
// src/sources/registry.ts:87
channelAllowed(channel) {
  const kind = this.kinds.get(channel.source)          // channel.source 是 kind 名
  const instance = this.resolve(kind, settings.sources[channel.source])   // ← 永远解析到默认实例
  ...
}
```

后果：**第二个实例自己配置的群不会被承认**，消息一律被判 `chat_not_allowed`。

这解释了为什么之前一直没暴露：`im` 与 `im-2` 配的是**同一个群**，而该群在默认实例 `im` 的列表里，所以两者都"通过"了。一旦两个实例监听不同群，第二个就完全收不到东西——**这正是「多个群各自独立」要验证的场景，而它现在是坏的**。

修法与线程键同源：**实例身份要贯穿 channel**。`channel.source` 目前只有 kind 名，需要带上实例 id（或 trigger 加 `meta.instance`，`channelAllowed` 与 `listened` 按它解析）。

## 多源验证的真实结论

- 「各跑各的进程/凭据」✅ 已证
- 「各自的群被承认」❌ **反证**（本轮探针实测失败）
- 「两个机器人各收一条」仍缺人工触发（钉钉），但即使发了，只要两个实例监听不同群，就会撞上这个缺陷

## 已支持：在未预先配置的仓库里干活（2026-11-09 深夜）

两条通路补齐后，工单可以落在**监听列表之外**的仓库：

1. `orchestrator_repo_add` —— 人明确要求时把 `owner/name` 加入 GitHub 源的 `repositories`
2. **按需克隆** —— 工单的仓库目录不存在时，执行器用配置里的 `gh` 现场克隆：`executor.directory/<owner>/<name>`
3. 新增环境变量 `DSH_SUPERAGENT_REPOSITORY_DIR`（克隆目录），`DSH_SUPERAGENT_DIR` 仍是 worktree

实测（全新仓库 `439436269-ctrl/dsh-crew-demo`，从未手动克隆）：

```
issue #1 → accept → 工单 repository=dsh-crew-demo
       → 自动克隆 E:/codes/superagent-sandbox/439436269-ctrl/dsh-crew-demo
       → worktree fix-notes-typo-6214ad5d0ae2
       → PR #2「Fix NOTES.md typo: Instalation -> Installation」已合并
```

同轮修掉：`github.ts` 里 PR 轮询仍用 `Number(thread.ref.id)`，遇到 `owner/name#5` 抛错导致连续 253 次轮询失败；改为 `pullRef(...)?.number ?? Number(...)`。

## 飞书 / 企业微信的多实例：已证与已知限制（2026-11-10 凌晨）

**已证**：给飞书再加一个实例（`feishu-2`，`chats: []`）后，两个实例同时 `ready`，`lark-cli` 消费者进程从 3 个增到 4 个，主实例不受影响；停用它后进程回落。

**已知限制（重要）**：`lark-cli` 的事件订阅是**按应用**的，不是按实例的。两个 `feishu` 实例若共用同一个应用，就会**同时收到同一批事件**（各自起一个消费者）。所以：

> 想要两个真正独立的飞书机器人，必须是**两个不同的飞书自建应用**，各自 `app_id/app_secret`，而不是同一应用配两个实例。

企业微信同理：`wecom.mjs` 桥的实例已能运行（`im-3` 曾以 wecom 桥启动），但**没有凭据连过真实群**，因此其多实例与路由均未实机验证。

## 为什么"健康条目按实例区分"需要改接口，而不是小修补（2026-11-10 凌晨，第二次尝试）

尝试：`sourceContextOf` 把上报名字映射成 `im:im-2` 这类实例槽，`registry.healthEntries` 对未知名字**按需认领**。

结果：`sources.spec` 从 6 个失败涨到 **9 个**。原因不是断言"期望只有一个条目"，而是更根本的一条契约：

> `healthEntries` 的原注释写明：上下文拿到的是**注册时建立的**条目，注册结束后再上报应当是 no-op。

按需认领会给"已注销的 kind"重新认领槽位，于是注销后的上报又生效了——测试正是靠这一点判断 kind 是否真的注销。

因此正确做法不是懒认领，而是**在注册时就知道实例列表**：

1. `registry.register(kind)` 增加参数（或新增 `claimInstances(kind, ids)`），为每个启用实例认领 `name:instance`
2. 停用/删除实例时释放对应的槽
3. 测试改为断言"每个实例一组条目"

这属于接口变更，需要连测试一起设计；两次尝试都证明不能顺手改。危害已经消除（停用实例不再写入共享槽），剩下的是可观测性问题。
