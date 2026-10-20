# Live Growth OS：直播运营副驾

[English](README.en.md)

作者项目与更新：[X](https://x.com/liu_xiaoyu27334) · [FateClear](https://fateclear.com)，免费的生日排盘与解读网站。

面向直播运营团队与开发者的本地工作台：把直播指标、转写、商品上下文和人工操作连起来，展示有依据、有时效和缺失数据提示的运营建议。

这个源码版本保留原有 **Web、Server、Chrome 扩展、Electron 桌面端** 与共享契约／规则模块。为保护内部资料，旧真实场次回放和专用评审已停用，经营数据、原话术、账号预配置与安装包没有附带。这是**公开源码实验版**：源码闭包与有限离线检查完成，尚未完成干净安装、完整类型检查、全量测试、构建及启动验收。

## 包含什么

- Next.js 工作台：直播状态、来源健康、运营规则、合成场景、商品配置与复盘界面。
- Fastify 服务：事件校验／去重、内存演示、PostgreSQL 持久化接口；桌面端使用 SQLite。
- 确定性规则、状态机、时间窗聚合、缺失值与证据判断、人工确认及恢复限流。
- 浏览器扩展：用户手动连接已授权的罗盘／千川页面，指标采集和可选音频流程。
- Electron 启动、子进程隔离、导航约束与源码打包脚本；不附预构建二进制。
- 官方接口、ASR、LLM、工作簿历史导入的可配置适配器。未配置时不自动请求这些服务。

## 本地合成演示

需要 Node.js 24+、pnpm 10.33.0。以下安装和启动命令是交付入口，**本次未执行依赖安装或应用启动**：

```sh
pnpm install --frozen-lockfile
pnpm demo:generate
pnpm dev
```

前端默认 `http://127.0.0.1:3000`，服务端默认 `http://127.0.0.1:4100`。`dev` 明确使用内存存储；在 `/lab` 或 `/mvp` 选择合成场景启动。刷新/退出后不保证保留内存数据。旧真实场次选项不会自动加载；其旧 API 明确返回未收录，而非用合成内容假扮真实记录。

内置规则配置与旧时间段兼容导出采用独立合成参数；它们不代表历史统计、行业基准或有效经营策略。原始分析算法保留，`analyzeRules` 可接受调用方自己的规则配置。默认参考脚本是通用合成要点，ASR 专用热词默认为空。

```sh
pnpm check:public
node --test apps/desktop/tests/*.test.cjs
pnpm typecheck
pnpm test
pnpm build
```

前两项已在隔离候选上运行；后三项需完整依赖。改变演示阈值后，全量规则触发测试尤其需要实际运行复核。

## 在线使用与桌面版

真实采集必须由使用者明确连接自己获授权的平台页面。扩展会在用户授权后处理真实指标或音频，**不是始终离线的工具**。官方千川授权、ASR、LLM 和历史工作簿同步均需使用者提供自己的配置和权限；本仓库不附凭据、不代为授权、不自动投流或执行建议。

`.env.example` 只列空配置。内存演示无需复制它。真实持久化需自行配置数据库和 Redis，再执行 `pnpm db:migrate`；不要将工作环境文件、录音或运行目录提交到 Git。历史导入需显式设置 `HISTORY_REGISTER_URL`，并由使用者另行安装 `lark-cli`、将其加入 `PATH`，完成自己账号及目标工作簿的授权；此 CLI 不随仓库提供。每日同步还需显式开启 `HISTORY_DAILY_SYNC=1`。

构建扩展：`pnpm --filter @live-growth/extension build`，再按浏览器开发者模式加载其 `dist`。构建桌面：`pnpm desktop:build`，然后 `pnpm --filter @live-growth/desktop start`。桌面打包入口为 `desktop:pack:mac` / `desktop:pack:win`；运行、签名、安装与平台连通性未验证。发布安装包前还需要核对打包依赖许可。

## 数据与验证边界

没有包含原数据库、订单／客户记录、内部工作簿链接、业务报表、原录音／转写、历史校准常量、私有素材、账号预配置、Git 历史或已安装依赖。合成参数生成器见 [examples](examples/README.md)。

已通过：13 项独立离线行为／桌面模拟测试，176 个 TypeScript 文件的语法检查和静态相对引用闭包检查；扩展清单检查。完整语义类型检查、原 Vitest 套件、干净安装／构建／启动、浏览器视觉、真实平台调用与业务效果未验证。静态扫描不能保证不存在任何未知敏感值。

自写源码采用 [MIT](LICENSE)。第三方依赖保留自己的许可，详见 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md) 与 [LICENSE-STATUS.md](LICENSE-STATUS.md)。源码公开不代表安装包或生产环境已通过验收。

如果这个项目对你有帮助，欢迎在 [X](https://x.com/liu_xiaoyu27334) 关注作者的项目更新，也可以体验 [FateClear](https://fateclear.com)。
