# 普通 Seedance 2.5 原生 4K 接入验收

2026-11-18，时间为 Asia/Shanghai。用户要求接入普通 2.5 的 4K，沿用此前“先保留本地，暂不上线”。代码位于独立工作树 `codex/seedance-25-flash`，基线 `f53867558c9926f1448acfa652e40bf24ed9d908`。此前 Flash 改动保留，[本次修改前清单](baseline.json)区分其已有状态。未提交、推送、部署，未改变生产目录、价目、默认模型或历史记录。

## 接口与价格依据

- 普通直连调用 ID 为 `doubao-seedance-2-5-260628`，支持 480p/720p/1080p/4K；Flash 仍为 480p/720p。依据[普通 2.5 官方教程](https://docs.volcengine.com/docs/ark/seedance-2-5?lang=zh)、[创建接口](https://docs.volcengine.com/docs/ark/create-video-generation-task-api?lang=zh)和[官方价格](https://docs.volcengine.com/docs/ark/model-pricing?lang=zh)。
- 通过已登录的隔离项目 HTTP 管理路由读取同账号 ListModelActivations，仅允许该元数据请求，无推理调用或生产写入。[原始脱敏价格与映射](account-price.json)显示普通 2.5 的 4K 无参考视频为 31 元/百万 token、有参考视频为 19 元/百万 token；原 1080p 为 77/46，低分辨率为 70/42。价格不写死到业务源码。
- 元数据请求 ID：`202611181529497630045182BA09A11415`、`20261118152951D8E37BB4F62199F15F5E`。
- 官方 4K 画布分别为 16:9 3840×2160、4:3 3326×2494、1:1 2880×2880、3:4 2494×3326、9:16 2160×3840、21:9 4398×1886。按实际画布估算预授权；自适应归档校验像素面积，不将未知分辨率回退到 720p。

## 实现与兼容边界

- 原生火山适配且型号精确匹配普通 2.5 时声明 4K。逐型号配置仍可收窄选项，Flash/Mini/Fast 不增加 1080p 或 4K，中转渠道不自动增加能力。
- 共享生成参数增加按能力展示的 4K，报价传递所选画幅。选择 4K 时清除不适用的超分参数；旧客户端及旧记录默认值不变。
- 普通 2.5 价格映射支持 4K 的两种素材条件，缺一个条件不能发布成完整映射；旧四档响应仍可同步。实际新 4K 报价/调用要求已发布且匹配素材条件的 4K 价目，缺失时在预授权和供应商提交前拒绝，禁止沿用低分辨率兜底价。
- 480p 样片可显式选择 1080p 或 4K 正式成片，报价、确认、预授权、快照和供应商请求使用同一分辨率。未传参数继续 1080p。保持每个样片关联一个正式任务，重复请求不重复提交或扣费，已存在其他分辨率时拒绝冲突请求。
- 内置浏览器发现全能镜头保存后 4K 回到 720p，已在 `omniSequenceService` 保存白名单修复，并补充鉴权 HTTP 保存/重启回读测试。
- 无数据库迁移、历史重算或媒体清理。新行为仅用于用户明确选择 4K 的新任务/正式子任务，以及明确保存为 4K 的设置；既有 480p/720p/1080p 任务、历史样片、已关联正式任务、账本和默认模型不批量修改。

## 消费者检查

执行跨 `frontweb/src`、`backend-node/src`、`backend-node/test` 的字段/值检索，原始结果见 [consumers.txt](consumers.txt)。

| 范围 | 覆盖结果 |
| --- | --- |
| 前端共享参数 | FreeCreate、ToolMediaGeneration、FilmCreate、CreativeDraftNode 均使用 GenerationSettings；前三项实际浏览器检查，画布节点参数传递经代码检查及共享组件自动化覆盖，未单独做画布节点视觉验收。 |
| 设置保存 | 全能镜头保存白名单已增加 4K；项目/分镜设置和画布工作流保持原字段传递，无额外分辨率白名单阻断。隔离 HTTP 已验证全能镜头保存及重启。 |
| 能力/API | 能力声明、普通报价、业务提交及 Draft quote/finalize；权限、旧字段和所有权检查保持，新增 resolution 可选。 |
| 计费 | 供应商同步/人工审核/派生价目发布、4K 条件价、预授权、真实 usage 结算、重复请求及释放。 |
| 媒体与历史 | 普通原生生成、Omni、Draft 正式任务共用归档，供应商原始本地文件保留；列表/详情/样片历史和重启读取。合成/素材库未新增分辨率选择，持久化路径契约不变。 |

## 自动化验证

- **通过**：后端相关 123/123，[完整日志](backend-tests.log)。覆盖 authBilling、providerPriceSync、providerPriceAliases、providerPriceReview、priceBookIndependentPublish、seedanceSubmission、videoModelCapabilities、videoAspectContract、videoTokenEstimate、volcOmniVideo、seedance4k、seedance4kSettings、generationSettings、videoPostprocessPolicy、seedanceInputValidation、seedanceFlashCatalog、videoDraftHttp。命令使用 `node --test --test-concurrency=2` 执行这些测试文件，`MINIDRAMA_PROFILE=dev`，显式配置本地 ffmpeg/ffprobe。
- **通过**：前端全量 310/310，[日志](frontend-tests.log)；production build [日志](frontend-build.log)。构建保留已有大 chunk 提示，无错误。
- **通过**：隔离 HTTP 测试通过本项目鉴权 API 提交，供应商为本地 mock，禁止真实外网推理。验证未发布 4K 价格时拒绝，正确价格同步→审核→派生→发布后可预授权；普通原生 4K 和样片升 4K 都传 `resolution: '4k'`，模拟真实用量 2000 token 结算为 6.2 积分，重复正式请求只提交一次。
- **通过**：归档使用本地单帧 3840×2160 HEVC 10bit fixture，成片字节保持一致；服务重启后新 4K 成片可读，原样片记录和本地文件保持一致。fixture 配置和存储均隔离到临时目录，未以本地地址作为隔离依据。
- **通过**：`git diff --check`。前端现有源码正则测试受 Windows CRLF 影响，测试时临时归一化未修改文件的换行，结束后恢复原始换行；没有引入该文件语义修改。
- **未执行**：真实供应商付费生成、生产写入、远端 CI 和部署；用户未授权本轮执行。

## 内置浏览器实测

隔离后端 5687、页面 3019，空测试数据库、假凭据和合成样片。外网推理禁止，生成/正式升级 POST 在预览代理额外阻断；允许登录、报价与隔离全能镜头保存。制作页项目写入由代理阻断，未将其当作制作页保存验收通过。

| 页面 | 实测 CSS 视口（100%） | 主要结果 |
| --- | --- | --- |
| 全能视频 / FreeCreate | 1280×720、1440×900、1920×1080、1219×620、1219×2048、390×844 | 实际改变视口；普通 2.5 四档选择，Flash 切换降至 720p；4K 保存整集并刷新保留。样片 1080p 默认、4K 报价确认后取消，无提交。长文本输入和退格焦点稳定，侧栏滚动可到最后一条样片按钮，固定底部不遮挡最终可达位置，无横向溢出，高窄窗口随高度伸展。窄屏通过“控制”页签访问参数。 |
| 单视频生成 | 1280×720、1440×900、1920×1080、390×844 | 普通 2.5 选 4K，15 秒 4:3 预计 10396.47 积分；16:9 为 10395.54。键盘滚动到底可达生成按钮，未点击生成，无页面横向溢出。 |
| 制作页配置 / FilmCreate | 1280×720、1440×900、1920×1080、390×844 | 配置展开后选择普通 2.5，4K 与报价可用，“应用到全部分镜”按钮可达；未提交项目写入或生成。 |

证据：[六视口滚动数据](viewports.json)、[单视频滚动结果](tool-viewport-results.json)、[制作页数据](project-viewports.json)、[4K 保存刷新截图](native-4k-saved.jpg)、[样片 4K 确认](draft-confirm-1440-900.jpg)、[高窄窗口](free-1219-2048.jpg)、[矮窗口](free-1219-620.jpg)、[单视频 4K](native-4k-tool-final.jpg)。截图使用内置浏览器原始 JPEG；修正了早期截图在改变视口后仍使用旧捕获尺寸的问题，保留 fullPage 截图作为最终证据。

**未完成的交付门槛：实际浏览器 125% 缩放。** 内置浏览器缩放快捷键未改变实际比例，未用 CSS zoom 冒充。尝试桌面 Chrome 后，Computer Use 因无法可靠确认浏览器当前地址自动停止；按 [Computer Use SKILL.md](C:/Users/EDY/.codex/plugins/cache/openai-bundled/computer-use/26.1103.32239/skills/computer-use/SKILL.md)所引用 guidance 的“stop issuing app input”停止桌面输入。随后仅继续用户明确要求的内置浏览器验收，不恢复被停止的桌面输入。

## 当前交付状态与下一步

实现完成，已列自动化及 100% 浏览器场景通过；整体验证仍欠实际 125% 缩放，不能标记全部验收完成。仅本地修改，未提交、推送或部署；Flash 也继续保持本地，不自动上架。后续先补实际 125% 检查；用户另行明确授权上线后，再固定提交、通过远端 CI，按平台价格同步/审核/发布流程补普通 2.5 的 4K 价目，最后执行既定部署门槛。缺少 4K 价目时保护性拒绝，不能只部署代码就宣称可生成。


## 2026-11-18 发布授权更新

用户已明确授权任务空闲时上线，范围为 Flash 与普通 2.5 4K。用户随后明确“这个以后验证不了就不验证了”，豁免工具无法完成的实际 125% 缩放门槛；该项仍记录为未执行，不伪称通过，其他自动化及浏览器证据保持。准备通过精确提交的完整 CI 和一次性手动发布工作流交付，不启用全局自动发布，不做真实生成。准确提交、检查链接、生产模型与价格发布及历史读取证据在 release.md 追加。
