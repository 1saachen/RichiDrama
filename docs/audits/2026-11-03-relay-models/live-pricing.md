# 真实中转站目录与报价核对

2026-11-03（北京时间）。用户明确要求本地接正常中转站核对。本次以本地已保存的瑞池中转业务 Key，通过最新工作副本的鉴权 HTTP 路由读取真实 `https://api.richbest.cn`；不生成、不接受/发布价格、不修改线上售价。

## 路径与隔离

原 `backend-node/data/drama_generator.db` 使用 SQLite readonly 打开，仅在内存中取现有连接。临时应用使用独立内存数据库，临时测试管理员通过 `/api/v1/auth/login` 登录，随后调用 `/api/v1/admin/model-discovery/:id/fetch` 和 `/api/v1/admin/provider-prices/richbest/sync`。业务 Key 只用于后端适配器请求，不输出、不写验收文件；不启动后台恢复或计划任务。

网络保护仅允许真实中转站的 `GET /v1/models` 与 `GET /v1/pricing`，拒绝其他上游路径、方法及其他外部目的地；本地管理路由的 POST 只写内存数据库。接口使用应用原有原生 HTTP 适配层，没有脚本直接拉取上游替代业务入口。

## 真实结果

两接口 HTTP 200。最终脱敏证据：[响应与映射](live-pricing.json)。

| 模型 | 当前 Key 目录/价格 | 计费映射 |
|---|---|---|
| gpt-image-2 | 均返回 | 文字输入、图片输入、图片输出，共 3 项 |
| gpt-image-2.5-flare | 均返回 | 上述三项及缓存，共 4 项 |
| gpt-image-2.5-sunburst | 均返回 | 上述三项及缓存，共 4 项 |
| vega-image-1.0-lite | 均返回 | 输出 0.162000 元/张；参考图不单独收费 |
| vega-image-1.0-flash | 均返回 | 输出 0.450000 元/张；参考图不单独收费 |
| vega-image-1.0-pro | 均返回 | 输出 0.950000 元/张；前三张参考图免费，超额输入 0.100000 元/张 |
| wand-vega-vl-1.0-lite/flash/pro | 两接口均未返回 | 不猜测、不导入为可用模型 |

三款 GPT 的当前有效价格均为：文字输入 33.532470 元/百万 Token，图片输入 53.651952 元/百万 Token，图片输出 201.194820 元/百万 Token；2.5 两款另有缓存输入 8.383118 元/百万 Token。金额直接使用十进制字符串。这里只是此次业务 Key 的报价快照，不承诺固定不变。

最终同步：六款模型共 15 个内部计费项全部 mapped。另三条为预先配置的 VL 缺失警告，不能算作已支持。返回的 billing_enabled 字段为 false，仅记录接口原值，不据此推定生成免费或绕过项目计费。

## 发现与修复

第一次实际读取发现 ModelTop 真实格式是 `provider=modeltop`、`dimension=text/image/null`。之前基于本机接口实现和模拟用的是 `modeltop:text/modeltop:image/modeltop:`，三款 GPT 因此不能完整映射。现仅对已确认 ModelTop 渠道归一化这两种格式；未知渠道的原始 image/text 维度仍不猜测。同步映射版本升至 `relay-pricing-v4-live-modeltop`，避免复用旧的未映射同步结果。

补充六款真实价格的无凭据测试快照 `backend-node/test/helpers/richbestImagePricingLive20261103.json`，检查全部 15 项、精确金额、计价标记和未知渠道拒绝；完整 HTTP 模型集成改用本次真实 ModelTop 维度格式。最后一次真实读取复核为 15/15 mapped。

测试：`relayModels.test.js`、`relayModels.integration.test.js`、`richbestPricing.integration.test.js`、`providerPriceSync.test.js`、`providerPriceReview.integration.test.js`、`providerPriceAliases.integration.test.js`，共 46/46 通过，证据：[日志](live-backend-tests.log.gz)。前端未修改，本次不重复 UI 或构建。此前全量 649/649 不计为本次修复后重跑结果。

验收辅助程序第一次运行曾因网络保护层未识别 URL 对象而报 Invalid URL，修正辅助程序后正常读取；这不是中转站故障。没有绕过只读网络限制。

未提交、未推送、未部署；原有本地演示仍使用模拟服务，不能将演示页面的数字当作此次真实报价。真实付费生成、实际 usage 与费用结算仍未验收。VL 缺失的原因不能仅由目录推定，需要中转站核实当前项目开通和模型发布状态。
