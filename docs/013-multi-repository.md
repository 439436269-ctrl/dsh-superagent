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
