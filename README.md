[简体中文](README.md) · [English](README.en.md) · [日本語](README.ja.md)

# Live Growth OS：直播运营副驾

**把直播指标、转写和商品上下文放进同一个工作台，让运营建议带上依据与时效。**

Live Growth OS 面向直播运营团队与开发者。接入指标、转写和商品信息后，规则与状态机结合时间窗和缺失数据状态生成建议，再由使用者确认操作；也可以先用仓库内的合成场景了解流程。

这个源码版本保留原有 **Web、Server、Chrome 扩展、Electron 桌面端** 与共享契约／规则模块。为保护内部资料，旧真实场次回放和专用评审已停用，经营数据、原话术、账号预配置与安装包没有附带。这是**公开源码实验版**：源码整理阶段完成了源码闭包与有限离线检查，尚未完成干净安装、完整语义类型检查、全量测试、构建及启动验收。

作者项目与更新：[FateClear](https://fateclear.com) · [X](https://x.com/liu_xiaoyu27334)

## 先看已有的合成场景

仓库提供了[场景数据](examples/synthetic-scenarios.json)与[生成脚本](scripts/generate-synthetic-demo.mjs)。以下是已有 JSON 的字段节选，展示来源标记与固定种子；不是实际运营结果：

```json
{
  "classification": "independently_synthetic",
  "seed": 20300101,
  "startAt": "2030-01-01T00:00:00.000Z"
}
```

场景中的 `sampleSize: 0` 表示没有历史观察样本。生成器只使用固定字面量与种子，不读取外部文件，也不联网；重新生成 `examples/synthetic-scenarios.json` 和 `packages/source-adapters/src/calibrations/historical.ts`。旧导出名称只用于源码兼容。示例价格与 GMV 是独立选取的虚构圆整数值，不是匿名化真实订单。详见[合成示例来源说明（英文）](examples/README.md)。

## 最短入口：本地合成演示

需要 Node.js 24+、pnpm 10.33.0。从仓库根目录运行以下命令；这是使用入口，**本轮文档整理没有安装依赖或启动应用**：

```sh
pnpm install --frozen-lockfile
pnpm demo:generate
pnpm dev
```

前端默认 `http://127.0.0.1:3000`，服务端默认 `http://127.0.0.1:4100`。`dev` 明确使用内存存储；打开 `http://127.0.0.1:3000/lab` 或 `/mvp`，手动选择并启动合成场景。刷新/退出后不保证保留内存数据。旧真实场次选项不会自动加载；其旧 API 明确返回未收录，而非用合成内容假扮真实记录。

## 包含什么

- Next.js 工作台：直播状态、来源健康、运营规则、合成场景、商品配置与复盘界面。
- Fastify 服务：事件校验／去重、内存演示、PostgreSQL 持久化接口；桌面端使用 SQLite。
- 确定性规则、状态机、时间窗聚合、缺失值与证据判断、人工确认及恢复限流。
- Chrome 扩展：用户手动连接已授权的罗盘／千川页面，指标采集和可选音频流程。
- Electron 启动、子进程隔离、导航约束与源码打包脚本；不附预构建二进制。
- 官方接口、ASR、LLM、工作簿历史导入的可配置适配器。未配置时不自动请求这些服务。

历史经营规则参数与原话术已整体移除。内置规则配置与旧时间段兼容导出采用独立合成参数；它们不代表历史统计、行业基准或有效经营策略。原始分析算法保留，`analyzeRules` 可接受调用方自己的规则配置。默认参考脚本是通用合成要点，ASR 专用热词默认为空。

## 在线使用与桌面版

真实采集必须由使用者明确连接自己获授权的平台页面。扩展会在用户授权后处理真实指标或音频，**不是始终离线的工具**。官方千川授权、ASR、LLM 和历史工作簿同步均需使用者提供自己的配置和权限；本仓库不附凭据、不代为授权、不自动投流或执行建议。

`.env.example` 只列空配置。内存演示无需复制它。真实持久化需自行配置数据库和 Redis，再执行 `pnpm db:migrate`；不要将工作环境文件、录音或运行目录提交到 Git。历史导入需显式设置 `HISTORY_REGISTER_URL`，并由使用者另行安装 `lark-cli`、将其加入 `PATH`，完成自己账号及目标工作簿的授权；此 CLI 不随仓库提供。每日同步还需显式开启 `HISTORY_DAILY_SYNC=1`。

构建扩展：`pnpm --filter @live-growth/extension build`，再按浏览器开发者模式加载其 `dist`。构建桌面：`pnpm desktop:build`，然后 `pnpm --filter @live-growth/desktop start`。桌面打包入口为 `desktop:pack:mac` / `desktop:pack:win`；运行、签名、安装与平台连通性未验证。发布安装包前还需要核对打包依赖许可。

## 验证与成熟度

下面是已有检查命令。本轮只核对文档，未执行应用测试或构建：

```sh
pnpm check:public
node --test apps/desktop/tests/*.test.cjs
pnpm typecheck
pnpm test
pnpm build
```

源码整理阶段，前两项已在隔离候选上运行；后三项需完整依赖，当时未运行。改变演示阈值后，全量规则触发测试尤其需要实际运行复核。

已有记录：13 项独立离线行为／桌面模拟测试通过，176 个 TypeScript 文件完成语法检查和静态相对引用闭包检查；扩展清单检查通过。完整语义类型检查、原 Vitest 套件、干净安装／构建／启动、浏览器视觉、真实平台调用、桌面打包与业务效果未验证。静态扫描不能保证不存在任何未知敏感值。

## 详细说明与数据边界

- [合成示例来源说明（英文）](examples/README.md)：固定种子、零历史样本与示例范围。
- [根命令清单](package.json)：开发、演示、构建、检查和桌面打包入口。
- [公开源码检查](tests/public-source.test.mjs)：已有离线检查的覆盖范围。
- [第三方声明](THIRD_PARTY_NOTICES.md)与[许可范围](LICENSE-STATUS.md)：依赖和自写代码的许可边界。

没有包含原数据库、订单／客户记录、内部工作簿链接、业务报表、原录音／转写、历史校准常量、私有素材、账号预配置、Git 历史或已安装依赖。只有生成的示例值及新的通用参考／规则默认值属于独立合成内容；整个仓库仍是带可选在线适配器的应用源码。

## 许可与作者

自写源码采用 [MIT](LICENSE)。第三方依赖保留自己的许可，详见 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md) 与 [LICENSE-STATUS.md](LICENSE-STATUS.md)。源码公开不代表安装包或生产环境已通过验收。

欢迎试试 [FateClear](https://fateclear.com) 的免费生日排盘与解读，也可以在 [X](https://x.com/liu_xiaoyu27334) 关注作者的新项目和后续更新。
