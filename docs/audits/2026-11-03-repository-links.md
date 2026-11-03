# 当前维护仓库引用核验

日期：2026-11-03（北京时间，Asia/Shanghai）。

## 范围

依据 origin `https://github.com/1saachen/RichiDrama.git`，修正以下 9 个现有文件的 20 行旧引用：

- `README.md`：克隆、报告问题和 Pull Requests。
- `CONTRIBUTING.md`：Issues 搜索、新建和建议入口。
- `backend-node/README.md`：GitHub 徽章显示、链接与反馈入口。
- `docs/en.md`、`docs/story.md`：英文仓库、克隆、反馈和联系方式。
- `.github/ISSUE_TEMPLATE/config.yml`：文档入口。
- `deploy/README.md`、`deploy/PR_PREVIEWS.md`：SSH 和分支保护命令示例。
- `deploy/configure-github-protection`：默认目标为当前维护仓库；显式参数仍可覆盖。

独立分支 `codex/repository-links` 基于 `db363014a4c3d55202fdd4fe26321634cd124180`，只提交上述修正及本任务日志、证据。不推进 main，不改动今晚 18:30 固定版本发布，也不主动执行分支保护或生产部署。草稿 PR 触发仓库既有验证流程。

## 验证

- 原工作区 940 个受版本管理文件引用复查通过；历史迁移记录和第三方引用保留。
- `frontweb/src`、`backend-node/src`、`backend-node/test` 消费者检索无旧仓库业务源码引用；现有部署安全测试读取该脚本。
- 最新远端基线隔离副本：`node --test backend-node/test/deploymentSafety.test.js`，6/6 通过。首次因 Windows 自动检出的 CRLF 与测试中的 LF 正则不一致而失败；将本地检出内容恢复为仓库原有 LF 后通过，没有提交工作流变更。
- Git Bash 语法检查及替身 gh 隔离验证：默认仓库、显式覆盖、非法批准数、缺少工作流，4 个场景验证默认目标、JSON 参数和失败前停止写入。替身不连接网络，不修改 GitHub 设置。
- `git diff --check` 通过。未改业务前后端或页面，前端构建、页面验收与业务恢复验证不适用。
- 提交前状态：实现和本地验证完成；远端分支、准确提交和 CI 仍待推送后核对。最终结果记录于本地工作日志和报告，避免只为补记证据再次推动已通过 CI 的提交。

## 兼容边界

保留原作者署名、MIT 许可证、第三方依赖资料、历史迁移及上游 PR 证据。Fork 用户名占位符保留。新地址只作用于文档和今后手动执行脚本时的默认目标，不自动修改 GitHub 规则、现有用户、数据、账本或任务。
