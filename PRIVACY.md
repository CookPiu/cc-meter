# Privacy policy

token-almanac is a Claude Code mod that runs entirely on your machine. It collects nothing about you, and it sends nothing anywhere.

Effective 2026-10-10.

## What it reads

- Claude Code's transcripts under `<config>/projects/`, to count tokens per session, day, project and model. Message text is parsed only to find where turns begin and end; it is never stored or sent.
- The usage figures Claude Code gives every mod: context use, cost, and each limit's percent and reset time.
- Claude Code's `language` setting and the `CLAUDE_CONFIG_DIR`, `HOME`, `USERPROFILE`, `LC_ALL` and `LANG` environment variables, to find the transcripts and pick a language.
- `<config>/token-almanac/prices.json`, if you write one, for your own token prices.

It does not read Claude Code's credentials, API keys or any token. Your plan comes from what you pick in the pane.

## What it keeps

- `<config>/token-almanac/cache.json`, written by its bundled scanner: per-file read offsets and token sums in 10-minute buckets, so later scans read only new lines. No message text is in it.
- In the plugin's own store in Claude Code: limit readings (time, window, percent, reset time), the plans you picked, and a history of windows that have reset (for each, a reading every 5 points with the tokens each model had used in that window by then).

All of it stays on your machine. To remove it, uninstall the plugin and delete `<config>/token-almanac/`.

## What it sends

Nothing. Neither the mod nor the scanner it runs makes any network request, and there is no analytics or telemetry.

## Changes and contact

Changes to this policy are made in this file, and its history is in the repository. For questions, open an issue at <https://github.com/CookPiu/token-almanac/issues>.

---

# 隐私政策

token-almanac 是完全在本机运行的 Claude Code mod。它不收集任何关于你的信息，也不向任何地方发送数据。

自 2026-10-10 起生效。

## 读取的内容

- `<config>/projects/` 下的 Claude Code 会话记录，用于按会话、日期、项目和模型统计 token。消息文本只用来识别轮次的起止，从不保存或发送。
- Claude Code 提供给每个 mod 的用量数据：上下文占用、花费，以及各限额的百分比和重置时间。
- Claude Code 的 `language` 设置，以及 `CLAUDE_CONFIG_DIR`、`HOME`、`USERPROFILE`、`LC_ALL`、`LANG` 环境变量，用于找到会话记录和选择界面语言。
- `<config>/token-almanac/prices.json`（如果你写了这个文件），用于按你自己的价格折算。

它不读取 Claude Code 的凭据、API 密钥或任何令牌。套餐来自你在面板里的选择。

## 保存的内容

- `<config>/token-almanac/cache.json`，由插件自带的扫描程序写入：各文件的读取偏移和按 10 分钟汇总的 token 数，之后只读新增内容。其中不含任何消息文本。
- Claude Code 中插件自己的存储：限额读数（时间、窗口、百分比、重置时间）、你选择的套餐，以及已重置窗口的历史（每个窗口每涨 5 个点一条读数，附当时各模型在该窗口内已用的 token 数）。

这些数据都只留在本机。要删除它们，卸载插件并删除 `<config>/token-almanac/` 目录即可。

## 发送的内容

无。mod 和它运行的扫描程序都不发出任何网络请求，也没有任何统计或遥测。

## 变更与联系

本政策的变更都在这个文件里进行，修改历史见仓库记录。如有问题，请到 <https://github.com/CookPiu/token-almanac/issues> 提交 issue。
