# Seedance 2.5 Flash 火山直连验收

时间均为 Asia/Shanghai。用户要求接入 Seedance 2.5 Flash，已选择火山直连。当前交付为独立工作树 `codex/seedance-25-flash` 中的本地适配，基线 `f53867558c9926f1448acfa652e40bf24ed9d908`，未提交、推送或部署。

## 已核对的接口与账号

- 调用 ID `doubao-seedance-2-5-flash-261115`。经生产项目管理 HTTP 的模型发现接口回读，账号连接 3 中基础模型为 Available，版本为 Published。版本查询供应商请求 ID `20261118145548BB70EA22405ACB8122C2`。
- 新增模型拟绑定当前火山视频配置 18，保留其原默认 Mini，不调整旧连接 4、Star Proxy、业务场景默认或已有任务。
- 使用仓库外保存的同一账号凭据，在空临时数据库中通过已登录项目 HTTP 价格同步路由读取 ListModelActivations。供应商真实响应为无参考视频 46 元/百万 token，含参考视频 28 元/百万 token。代码映射为输出 token 的两个条件档，未将价格写入源码。
- [账号价格响应和独立映射](account-price.json)记录两次只读供应商请求、正式基础型号和准确调用 ID；无生产模型或价目变更，无供应商推理。
- 正式规格依据[火山发布公告](https://docs.volcengine.com/docs/ark/model-release-announcement?lang=zh)、[官方教程](https://docs.volcengine.com/docs/ark/seedance-2-5?lang=zh)、[官方价格](https://docs.volcengine.com/docs/ark/model-pricing?lang=zh)。Flash 支持 480p/720p、4–30 秒、10 图/5 视频/5 音频，共 20 个参考，不支持 Draft。

## 改动与兼容边界

- 能力列表、Omni 的素材计数、提交前规格校验和火山出站适配统一识别 Flash 上限。精确模型设置可收紧限制，不能放开 1080p/4K 或扩大素材数量。
- 出站适配不截掉超量 Flash 参考，超量会明确拒绝；拒绝 Flash 的 Draft 请求。
- 官方价格同步为 Flash 建立独立映射，不匹配普通 2.5 的计费键。保留有无参考视频的单独费率。
- 新行为仅匹配 Flash 型号。现有普通 2.5、Mini、Fast 及既有中转别名的路径明确保持原行为；无数据库迁移、历史重算、任务重提或媒体处理变更。
- [消费者检索](consumers.txt)覆盖前后端及后端测试。主要消费者为单视频工具、全能/项目分镜、GenerationSettings、mediaRoutingPreview、videoModelCapabilities、omniVideoService、seedanceInputValidation、videoClient、generationSettingsService、videoDraftService、providerPriceService 和 token 估算。前端已读取能力接口的时长/分辨率/素材字段，不需要改前端源码。Draft 面板及后端仍只允许普通 2.5 的精确 ID。

## 验证结果

- 后端相关 93 项通过。[核心 68 项](backend-core-tests.log)覆盖能力、素材规格、素材路由、生成设置、价格同步、HTTP 上架/报价、重启回读、首尾帧提交及旧记录兼容。[补充 25 项](backend-regression-tests.log)覆盖现有价格别名、官方价目审核、模型目录、token 估算和火山适配。
- 自动测试采用临时数据库、虚构密钥、模拟供应商或本地请求记录器。新 Flash 的 11 图/6 音频及 1080p 请求在排队和预授权前失败；合法 10 图/5 视频/5 音频在模拟适配中完整序列化。30 秒 Flash 首尾帧任务重启后仍传递正式模型 ID 和首尾帧角色。模拟供应商拒绝后预授权释放，旧视频记录与原快照一致。
- HTTP 模型目录测试完成草稿新增、价格缺失时拒绝上架、发布独立价目、上架、46/28 两种每百万 token 报价以及重启回读；原默认模型和原价目行保持一致。
- 前端 307 项通过，production build 通过。[测试](frontend-tests.log)、[构建](frontend-build.log)。首次 Windows CRLF 检出导致一个现有文本读取测试失败；将该文件按 Git 中的 LF 内容验收后全通过，再恢复原检出换行。无前端语义修改。首次媒体探测缺少 FFPROBE_PATH，设置本机已有探测程序后复验通过。
- 内置浏览器使用空临时数据库与虚构账号，所有生成写入均被代理阻止，供应商访问被禁止。单视频工具实测 1280×720、1440×900、1920×1080、390×844，缩放 100%。验证 Flash 选择、4–30 秒列表、仅 480p/720p、报价随分辨率变化、切回 Mini 后时长回到 15 秒、长中文输入、改变窗口尺寸、页面纵向滚动及末尾按钮可达；DOM 回读无页面横向溢出。
- 全能视频在 1440×900 实测 Flash 选择和素材提示 20/10/5/5、仅 480p/720p、没有 Draft 面板。该预览主动禁止保存写入，未据此宣称 UI 自动保存通过；独立 HTTP 测试已验证持久化及重启回读。本次没有前端布局修改，未追加全工作台分栏拖动或实际浏览器 125% 缩放验收。
- 截图：[模型分辨率](flash-options.png)、[标准桌面](1440-900.png)、[大屏](1920-1080.png)、[窄屏模型菜单](390-844.png)、[全能视频](free-create-1440-900.png)。

## 发布前的下一步

用户于 2026-11-18 15:23（Asia/Shanghai）明确决定先保留本地、暂不上线。本轮仅交付已验证的本地适配，不安排提交、推送、部署或生产模型与价目变更。临时隔离预览已关闭。后续如用户另行授权上线，发布时先重新核对远端 main、生产版本和运行任务，保持既有空闲发布门槛。完成独立提交、推送及准确提交 CI 后，跟踪该提交的部署成功状态，并回读版本和历史媒体。随后通过项目管理 API 仅新增 Flash 到现有火山连接，沿用当前价格策略新增该模型两个费率，保留旧价目全部条目及默认配置，再上架并回读普通用户的模型列表、能力和报价。真实付费生成另按用户授权执行。
