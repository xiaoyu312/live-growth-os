import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

const layoutPath = new URL("../app/layout.tsx", import.meta.url);
const nextConfigPath = new URL("../next.config.ts", import.meta.url);
const liveStartPath = new URL("../app/live/page.tsx", import.meta.url);

describe("根布局 hydration 边界", () => {
  it("在根 html 上声明 suppressHydrationWarning，避免浏览器扩展预注入造成遮罩", async () => {
    const source = await readFile(layoutPath, "utf8");
    expect(source).toMatch(/<html\s+lang="zh-CN"\s+suppressHydrationWarning>/);
  });

  it("允许本机副驾被扩展侧栏 iframe，不开放平台域名嵌入", async () => {
    const source = await readFile(nextConfigPath, "utf8");
    expect(source).toMatch(/frame-ancestors 'self' chrome-extension:/);
    expect(source).toMatch(/source: "\/live\/:path\*"/);
    expect(source).toMatch(/allowedDevOrigins/);
    expect(source).toMatch(/127\.0\.0\.1/);
    expect(source).toMatch(/LAN_VIEW_SHARE_ORIGIN/);
    expect(source).toMatch(/NEXT_OUTPUT === "standalone"/);
  });

  it("默认接入只要求罗盘，千川页面只作为官方接口失败时的回退", async () => {
    const source = await readFile(liveStartPath, "utf8");
    expect(source).toContain("两步进入真实直播副驾");
    expect(source).toContain("无需再打开千川页面");
    expect(source).toContain("官方接口未配置或已停止更新时");
    expect(source).not.toContain("三步进入真实直播副驾");
  });
});
