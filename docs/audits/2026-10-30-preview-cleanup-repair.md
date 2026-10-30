# Preview Cleanup 修复与启用门槛

日期：2026-10-30，Asia/Shanghai。

## 问题与修改

- 旧工作流使用未配置的通用 SERVER_HOST / SERVER_KEY，定时运行在 SSH 连接前失败；用户要求修复。
- 新工作流使用独立 ENABLE_PREVIEW_CLEANUP 开关与四个专用 Actions Secrets，手动运行默认 dry-run；固定服务器主机公钥，避免动态信任。
- 新 preview-cleanup-owned 默认只报告；显式 --apply 才执行删除，只处理 SOURCE_REPOSITORY=1saachen/RichiDrama 且 PREVIEW_CLEANUP_POLICY_VERSION=1 的记录。过期默认 3 天，PR 关闭按同一归属校验。
- 历史未标归属、其他仓库、新鲜/未来时间的记录默认排除，路径和 PR 编号必须吻合；Docker 不可用或容器归属缺失/冲突时不删除。
- 新预览带仓库元数据及 Docker 归属标签；相同 PR 编号已经被旧仓库或未标记预览占用时，在构建/删除前拒绝，要求显式迁移。
- 专用 SSH forced-command 入口只识别报告/清理过期或单个关闭 PR 的固定命令，拒绝任意 shell 文本。不会赋予应用部署、读取凭据或任意 root 命令的能力。

## 本地验证

14/14 测试通过：真实脚本在隔离临时目录中执行，Docker/id/锁由测试替身提供。覆盖 dry-run 不写入、apply 只删除测试目录中明确归属的过期预览、历史/其他仓库/生产哨兵保留、关闭 PR 精确选择、Docker 失败、容器归属冲突、错误路径、缺少仓库、SSH 注入文本拒绝，以及新仓库预览创建不覆盖旧预览。

Shell 语法通过；涉及的新脚本加入云端 shellcheck。未修改前端或业务后端，未执行供应商调用。真实服务器和 GitHub dry-run 联通验证尚未执行，不能据本地测试宣称功能已恢复。

## 连接配置待明确授权

拟在服务器增加仅用于上述 forced-command 的专用 SSH 公钥，私钥仅在配置进程内生成并加密写入用户 GitHub 仓库的 PREVIEW_CLEANUP_KEY；同时写入 PREVIEW_CLEANUP_HOST、PREVIEW_CLEANUP_PORT、PREVIEW_CLEANUP_KNOWN_HOSTS。它与生产部署密钥分离，主机公钥沿用已核实连接。

自动审批拒绝了此配置动作，原因是用户只要求修复功能，尚未明确授权新建持久 SSH 密钥并将其传给 GitHub Actions。被拒绝的是进程创建，配置脚本没有运行；没有增加服务器授权、上传新私钥、改生产服务或清理现有预览。必须获得用户对接收方与受限权限的明确同意后才能执行，不能换用密码或其他凭据绕过。

后续顺序：候选 CI → 用户同意连接配置 → 安装受限入口与加密 Secrets → GitHub 手动 dry-run 验证，核对现有预览/元数据和生产容器未变化 → 再恢复定时清理。若合入 main，必须在 18:30 前重新核对并更新固定发布 SHA 与成功 CI 证据；本任务分支未合并前，今晚现有发布版本保持不变。
