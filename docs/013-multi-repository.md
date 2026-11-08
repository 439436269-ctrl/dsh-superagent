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