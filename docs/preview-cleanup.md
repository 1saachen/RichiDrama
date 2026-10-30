# 预览清理

此工作流清理带有明确归属及版本标记的新预览环境，默认保留 3 天。历史未标记预览与其他仓库预览不会自动迁移、删除。

服务器独立目录应安装 lib.sh、preview-cleanup-owned 和 preview-cleanup-entrypoint（重命名为 entrypoint），均为 root 管理、普通用户不可写；专用 SSH 公钥使用 restrict 与固定 command 选项，不复用通用生产部署私钥。

在用户明确授权后配置四个仓库 Actions Secrets：PREVIEW_CLEANUP_HOST、PREVIEW_CLEANUP_PORT、PREVIEW_CLEANUP_KEY、PREVIEW_CLEANUP_KNOWN_HOSTS，再将 ENABLE_PREVIEW_CLEANUP 设为 true 并启用工作流。私钥不得写入仓库、文档、工单或日志。

首先手动运行 Preview Cleanup，保持 dry_run=true；确认只报告候选，生产容器与预览清单未变化。验证通过后，计划任务每 6 小时清理过期且明确归属的预览，PR 关闭清理该 PR。当前尚未完成连接配置，不能把代码合并视为已启用功能。
