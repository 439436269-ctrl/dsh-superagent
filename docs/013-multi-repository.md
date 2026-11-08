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
