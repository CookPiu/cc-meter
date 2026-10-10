# cc-meter

Claude Code mod：显示套餐用量限额已用多少、何时重置、剩余额度按你的习惯还能用多久；同时统计当前会话的 token，并把本机全部会话记录汇总成按天、按项目、按模型的视图，按 API 官方价格折算。

[English](README.md)

## 显示内容

**输入框上方的横条**：本会话花费与 token、上下文占用，以及各限额窗口（5 小时、每周）的百分比、重置倒计时和用满预测；带“打开面板”和“隐藏”按钮。

**面板**（`/cc-meter` 或横条上的按钮），两个视图：

| 视图 | 内容 |
|---|---|
| 本次会话 | 限额条、花费、token、上下文、轮数；按折算花费的 token 构成；每轮趋势（子代理并入发起它的那一轮）；按模型拆分 |
| 本机全局 | 限额条；容量推算（每个窗口整窗折合多少 API 美元、剩余多少、按历史时段节奏会不会在重置前用满、可信度）；当前套餐的历史触限；近 30 天或全部的汇总；按模型堆叠的每日图；项目与模型排行；推算细节与套餐时间线 |

界面支持中文和英文，语言依次取 `language` 选项、Claude Code 的 `language` 设置、`LC_ALL`/`LANG`、系统区域。终端、桌面应用、VS Code 和手机端都能显示。

## 安装

需要 Claude Code 2.1.287 或更高版本（支持 mod）。本机全局视图需要 `PATH` 上有 Node.js 18 以上，或在 `nodePath` 选项里填写路径。

在终端会话中输入：

```
/plugin install cc-meter --marketplace CookPiu/cc-meter
```

按 `y` 添加市场并选择作用域。装在 user 作用域后，桌面应用启动的会话也会加载。

## 选项

在 `/config` 的插件设置里修改：

| 选项 | 默认值 | 含义 |
|---|---|---|
| `language` | `auto` | `auto`、`en` 或 `zh` |
| `nodePath` | `node` | 读取历史记录用的 Node.js |

要按其他渠道价格（Bedrock、Vertex、网关）折算，或补充内置价格表没有的模型，可写 `<config>/cc-meter/prices.json`，单位为每百万 token 美元，顺序 `[input, output, cache 读, cache 写 5m, cache 写 1h]`，键为模型 id 或前缀：

```json
{ "claude-opus-5-5": [4, 20, 0.2, 5, 8] }
```

`<config>` 指 `CLAUDE_CONFIG_DIR`，未设置时为 `~/.claude`。

## 推算原理

Claude Code 只报告每个限额的百分比和重置时间。为了换算成“还剩多少”，mod 汇总本机在每个窗口内按模型、按 token 类型的 API 折算花费，并拟合每 API 美元占用多少窗口：

- 窗口内每上涨 5 个点以上算一段观测，每次触限算整窗 100%；
- 模型为 `上涨幅度 × 套餐倍数 ≈ Σ 模型系数 × Σ token 类型系数 × API 花费`，在对数参数上用 Levenberg–Marquardt 求解，带弱先验和 Huber 降权；
- token 类型系数反映限额对各类 token 的计权与 API 价格不同（cache 读计权低得多，所以单个长会话比多个短会话耐用）；
- 套餐时间线（`<config>/cc-meter/plans.json`，检测到套餐等级变化时自动记录，也可在面板里编辑）让不同套餐时期的窗口共用一次拟合，各套餐倍数由数据拟合，不直接采用标称值。

面板会显示可信度和拟合出的系数。网页版和其他设备的用量计入官方百分比，但不在本机记录里，会降低推算准确度。限额的真实计算方式未公开，这些数字都是推断。

## 读取、写入与运行的内容

所有数据都留在本机，mod 不发出任何网络请求。

- **读取** `<config>/projects/` 下的会话记录来统计 token；消息文本只用于识别轮次边界，不保存、不外发。
- **读取** `<config>/.credentials.json` 中的 `subscriptionType` 和 `rateLimitTier` 两个字段，用于记录套餐变化，不保留令牌或其他字段。macOS 上凭据在钥匙串里，mod 不读取，请在面板里手动编辑时间线。
- **读取** Claude Code 的 `language` 设置，以及环境变量 `CLAUDE_CONFIG_DIR`、`HOME`、`USERPROFILE`、`LC_ALL`、`LANG`。
- **写入** `<config>/cc-meter/cache.json`（各文件的读取偏移和 10 分钟汇总，之后只读新增内容）和 `<config>/cc-meter/plans.json`（套餐时间线），以及插件自身存储中的限额读数。
- **运行** 随插件附带的 `scan/scan.mjs`（通过 Node.js），因为会话记录超出 mod 环境的读取上限。

## 开发

```
claude plugin validate .
claude plugin test .
node --test scan/scan.check.mjs
```

开发时可用 `claude --plugin-dir <本目录>` 启动 Claude Code 加载工作副本。

## 许可证

MIT
