import Link from "next/link";

export default function LiveStartPage() {
  if (process.env.NEXT_PUBLIC_CAPTURE_ONLY === "1") return <main className="live-pilot-shell">
    <header className="live-pilot-header"><div><p className="live-pilot-eyebrow">LIVE GROWTH · 数据接入测试版</p><h1>连接直播数据</h1><p>千川通过官方 API 自动取数。日常只需在 Chrome 打开罗盘直播大屏。</p></div></header>
    <section className="live-pilot-guide"><span>首次准备</span><h2>配置副驾专用应用</h2><p>管理员在千川开放平台创建独立应用，在这里保存 App ID 与 Secret。回调地址为 http://127.0.0.1:18889/qianchuan/callback，需开通投放对象信息及今日直播数据权限。请为此应用单独配置授权。</p><Link href="/live/connect" className="live-pilot-link">配置应用 / 登录千川授权</Link></section>
    <section className="live-pilot-guide"><span>只做一次</span><h2>加载罗盘扩展</h2><p>用顶部菜单「打开扩展文件夹」，在 Chrome 的扩展程序页面开启开发者模式，选择「加载已解压的扩展程序」并选中该文件夹。</p></section>
    <section className="live-pilot-guide"><span>每次开播</span><h2>打开罗盘，连接本场</h2><ol><li>在 Chrome 登录罗盘，进入正在直播的「直播大屏·专业版」。</li><li>点击扩展「连接真实直播（罗盘）」，回到本软件查看数据。</li></ol><Link href="/live/current" className="live-pilot-link">查看当前直播</Link><p>{process.env.NEXT_PUBLIC_OPERATOR_RULES === "1" ? "本版按已验证字段给出运营提醒，问题持续时每 10 分钟复查。可手动切换脉冲模式，历史参照单独导入；缺少字段时不判断，所有动作由人工执行。语音识别与模型调用未启用。" : "本版先检验数据更新和重启恢复。实时提示规则待补充，经营建议、语音识别和模型调用已暂停。"}关闭本软件会停止采集服务，已保存数据会保留。</p></section>
  </main>;
  return <main className="live-pilot-shell">
    <header className="live-pilot-header"><div><p className="live-pilot-eyebrow">LIVE GROWTH OS · 真实试点</p><h1>连接罗盘直播大屏</h1><p>罗盘提供整体经营数据和主播音频；千川付费投放数据由服务端官方接口自动读取。两类来源分开显示，不保存原始音频。</p></div><div className="live-pilot-header-actions"><Link href="/live/review" className="live-pilot-link" target="_blank" rel="noreferrer">主播复盘</Link><Link href="/live/session-review" className="live-pilot-link" target="_blank" rel="noreferrer">本场复盘</Link></div></header>
    <section className="live-pilot-guide"><span>千川接入</span><h2>登录授权，选择本场直播间</h2><p>首次连接由管理员配置副驾专用应用，然后在官方页面登录授权。账户和抖音号从列表选择，不用手填 ID 或令牌。</p><Link href="/live/connect" className="live-pilot-link">连接千川 / 管理授权</Link></section>
    <section className="live-pilot-guide"><span>开始前</span><h2>两步进入真实直播副驾</h2><ol><li>在 Chrome 打开罗盘「直播大屏·专业版」，进入正在直播的场次并解除静音。</li><li>点击扩展「连接真实直播（罗盘）」。副驾会在侧栏和不抢焦点的独立小窗打开；顶栏显示「千川 · 官方接口」后，无需再打开千川页面。</li></ol><details><summary>官方接口未配置或已停止更新时</summary><p>打开千川独立直播大屏，点击扩展「连接千川数据」进入页面回退。只有回退模式才需要保持千川窗口可见；完全隐藏的千川标签会停止拉数。</p></details><p>指标没有更新时，过期文案不会被填成 0。官方接口异常会自动重试；需要立即看数时才启用页面回退。罗盘刷新必须确认，且会暂时中断音频。建议在 Chrome → 设置 → 性能 → 「始终保持这些网站处于活动状态」加入 compass.jinritemai.com；页面回退时再加入 qianchuan.jinritemai.com。同事看副驾：用 START_LAN_VIEW.command 启动后把观看地址发给同一网络的同事，他们不用装扩展。</p></section>
  </main>;
}
