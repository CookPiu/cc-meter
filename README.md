# token-almanac

A Claude Code mod that shows how much of your plan's usage limits you have used, when each limit resets, and how long the rest is likely to last. It also counts the current session's tokens and sums every transcript on your machine into daily, per-project and per-model views, priced at API list prices.

[中文说明](README.zh-CN.md)

## What it shows

**Band above the prompt**: the session's cost and context use, and each limit window (5-hour, weekly) with its percent and, when it will fill before its reset, how soon. It has buttons to open the pane or hide the band.

**Pane** (`/token-almanac`, or the band's button), with two views:

| View | Contents |
|---|---|
| This session | Limit rings, cost, tokens, context, turns; per-turn chart (subagent turns folded into the turn that started them); under *Show breakdown*, token makeup by API-equivalent cost and the per-model split |
| This machine | Limit rings, each with the API-equivalent dollars a full window holds and what is left; your plan, picked from a list; 30-day or all-time totals; daily chart by model; under *Show breakdown*, top models and projects, a capacity card per window (whether it fills before the reset at your usual hourly pace, confidence, past limit hits on your plan on a dollar scale) and the estimate details as interval plots, with any earlier plan inferred from the history |

Each ring shows the share used, a paler arc for where the window is headed by its reset, and a tick for how far through the window the clock is. In the terminal the same figures are written as text, with meters in place of the rings and the capacity table under them.

The UI is in English or Chinese, picked from the `language` option, then Claude Code's `language` setting, then `LC_ALL` / `LANG`, then the system locale. It renders in the terminal, the desktop app, VS Code and mobile.

## Install

Requires Claude Code 2.1.287 or later (mods support). The machine view needs Node.js 18 or later on `PATH`, or set its path in the `nodePath` option.

In a Claude Code session, add this repository as a marketplace, then install from it:

```
/plugin marketplace add CookPiu/token-almanac
/plugin install token-almanac@token-almanac
```

Or from a shell, in one step:

```
claude plugin install token-almanac --marketplace CookPiu/token-almanac
```

Installed at user scope (the default), it also loads in sessions the desktop app starts. Run `/plugin marketplace update token-almanac` to pick up new versions.

## Options

Set them in `/config` under the plugin:

| Option | Default | Meaning |
|---|---|---|
| `language` | `auto` | `auto`, `en` or `zh` |
| `nodePath` | `node` | The Node.js used to read transcript history |
| `motion` | `on` | `on` lets meters and charts glide to new values and a spinner turn while scanning; `off` draws them still |

To price models at other rates (Bedrock, Vertex, a gateway) or to add models the built-in table lacks, write `<config>/token-almanac/prices.json`, with prices in USD per million tokens as `[input, output, cache read, cache write 5m, cache write 1h]`, keyed by model id or id prefix:

```json
{ "claude-opus-5-5": [4, 20, 0.2, 5, 8] }
```

`<config>` is `CLAUDE_CONFIG_DIR`, or `~/.claude`.

## How the estimate works

Claude Code reports each limit only as a percent and a reset time. To turn that into "how much is left", the mod sums what this machine spent in each window, by model and token kind, at API list prices, and fits how much of a window each API dollar takes:

- every rise of 5 points or more within a window, and every limit hit (a whole window), is one observation;
- the fit is `rise × plan multiple ≈ Σ model factor × Σ token-kind factor × API spend`, solved by Levenberg–Marquardt in log parameters with weak priors and Huber reweighting;
- token-kind factors capture that limits weigh kinds differently from API prices (cache reads count for much less, so one long session lasts longer than many short ones);
- you pick your plan in the pane, and each window counts under the plan picked when it began, so windows from different plans share one fit with each plan's multiple fitted rather than taken as sold;
- windows from before your first pick count under that plan, unless their share per API dollar moved by 1.8× or more for 3 windows or more: such a stretch is fitted as a plan of its own and named after the plan sold at about that multiple (shown as inferred in the estimate details). Changes between plans of about the same size, such as Pro and Team, cannot be told this way.

The pane shows the confidence and the fitted factors. Use from claude.ai or other devices counts in the official percent but not in this machine's transcripts, which makes estimates less certain. How Anthropic counts limits is not published; these figures are inferences.

## What it reads, writes and runs

Everything stays on your machine. Nothing is sent anywhere: the mod makes no network requests, and the program it runs makes none either.

- **Reads** Claude Code's transcripts under `<config>/projects/` to count tokens; message text is parsed only to find turn boundaries and is never stored or sent.
- **Reads** Claude Code's `language` setting and the `CLAUDE_CONFIG_DIR`, `HOME`, `USERPROFILE`, `LC_ALL` and `LANG` environment variables.
- **Writes** no files itself. Its scanner writes one file of its own, `<config>/token-almanac/cache.json` (per-file read offsets and 10-minute sums, so later scans read only new lines), which only token-almanac reads; it is not a setting, instruction or script for Claude Code or any other tool. Limit readings and the plans you pick go in the plugin's own store.
- **Does not read** Claude Code's credentials or any token: the plan comes from your pick in the pane.
- **Runs** one program: Node.js (`node`, or the `nodePath` option) on the bundled `scan/scan.mjs`, because transcripts are larger than the mod environment can read. The two command lines are
  - `node <plugin>/scan/scan.mjs session <this session's transcript>`, when a session starts, to count what ran before the mod loaded;
  - `node <plugin>/scan/scan.mjs global <config>/projects <config>/token-almanac/cache.json`, when the machine view opens or refreshes, with the window start times and limit readings on stdin.

  The scanner reads the transcripts and its own cache, writes only `cache.json`, prints token sums as JSON on stdout for the mod, and makes no network requests. Its source is in `scan/scan.mjs`.

## Development

```
claude plugin validate .
claude plugin test .
node --test scan/scan.check.mjs
```

For a working copy, start Claude Code with `claude --plugin-dir <this folder>`.

## License

MIT
