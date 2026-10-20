"use client";

import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";
import {
  qianchuanCapabilitiesSchema, type QianchuanCapabilities, qianchuanSetupSessionSchema, qianchuanConnectionViewSchema, qianchuanAccountListSchema, qianchuanAwemeListSchema,
  type QianchuanConnectionView, type QianchuanAccountList, type QianchuanAweme
} from "@live-growth/contracts";
import { QIANCHUAN_LOCAL_ADMIN_PORT } from "@live-growth/contracts";
import { isLoopbackHost, resolveLiveBackend } from "../backend-url";
import "./connect.css";

const CALLBACK = "http://127.0.0.1:18889/qianchuan/callback";
function errorText(code: string): string {
  if (/HTTP_401|TOOL_40102|TOOL_40103/.test(code)) return "千川授权已失效，请重新登录授权。";
  const messages: Record<string, string> = {
    QIANCHUAN_LOCAL_ONLY: "请在值班电脑上打开本机副驾连接千川。同网观看页面不能修改授权。",
    QIANCHUAN_SETUP_UNAVAILABLE: "当前为隔离演示服务，请启动正式本机副驾后连接千川。",
    QIANCHUAN_APP_REQUIRED: "请先完成副驾专用应用配置。",
    QIANCHUAN_AUTH_BUSY: "已有授权正在进行，请先完成或取消。",
    QIANCHUAN_AUTH_SAVING: "授权正在保存，请稍候。",
    QIANCHUAN_AUTH_EXPIRED: "本次授权已超时，请重新点击连接千川。",
    QIANCHUAN_AUTH_CANCELLED: "已取消本次授权。",
    QIANCHUAN_AUTH_DECLINED: "本次授权未通过，可以重新选择账户授权。",
    QIANCHUAN_CALLBACK_PORT_BUSY: "另一个本机授权窗口正在使用回调端口，请完成或关闭它后重试。",
    QIANCHUAN_LIVE_BINDING_LOCKED: "当前有直播正在监测，请先结束副驾场次，再更换应用或直播间。",
    QIANCHUAN_SELECTION_INVALID: "所选抖音号不在当前授权列表，请重新读取后选择。",
    QIANCHUAN_ACCOUNT_NOT_SELECTED: "请先重新读取并选择投放账户。",
    QIANCHUAN_CONFIG_INVALID: "本机应用配置无法读取，请由管理员重新保存配置。",
    QIANCHUAN_INPUT_INVALID: "请检查输入，并确认使用副驾独立的 App ID。",
    QIANCHUAN_NETWORK_FAILED: "暂时无法访问千川，请检查网络后重试。",
    QIANCHUAN_OAUTH_NETWORK: "授权结果暂时无法取得，请检查网络后重试。",
    QIANCHUAN_ADMIN_PORT_BUSY: "本机授权管理端口被占用，请关闭旧副驾服务后重试。",
    QIANCHUAN_ADMIN_LISTENER_FAILED: "本机授权管理入口无法启动，请检查副驾服务。"
  };
  return messages[code] ?? `操作未完成，请重试${/^QIANCHUAN_[A-Z0-9_]+$/.test(code) ? `（${code.replace("QIANCHUAN_", "")}）` : ""}。`;
}
class SetupError extends Error { constructor(readonly code: string) { super(code); } }

export default function ConnectQianchuanPage() {
  const [connection, setConnection] = useState<QianchuanConnectionView>();
  const [error, setError] = useState("");
  const [busy, setBusy] = useState("");
  const [appId, setAppId] = useState("");
  const [appSecret, setAppSecret] = useState("");
  const [probe, setProbe] = useState<QianchuanCapabilities | null>(null);
  const [independent, setIndependent] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [editingBinding, setEditingBinding] = useState(false);
  const [accounts, setAccounts] = useState<QianchuanAccountList>({ items: [], warnings: [] });
  const [awemes, setAwemes] = useState<QianchuanAweme[]>([]);
  const [accountId, setAccountId] = useState("");
  const [awemeId, setAwemeId] = useState("");
  const [accountsLoaded, setAccountsLoaded] = useState(false);
  const api = useRef("");
  const csrf = useRef("");
  const mounted = useRef(false);
  const selectedEpoch = useRef(0);
  const viewEpoch = useRef(0);
  const refreshError = useRef("");

  const request = useCallback(async <T,>(path: string, schema: { parse(value: unknown): T }, body?: unknown): Promise<T> => {
    const epoch = body === undefined ? viewEpoch.current : ++viewEpoch.current;
    const response = await fetch(`${api.current}/api/qianchuan/${path}`, {
      method: body === undefined ? "GET" : "POST", cache: "no-store",
      ...(path === "authorize/cancel" ? { keepalive: true } : {}),
      headers: { "x-qianchuan-setup-token": csrf.current, ...(body === undefined ? {} : { "content-type": "application/json" }) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) })
    });
    const raw: unknown = await response.json();
    if (!response.ok) {
      const data = raw as { error?: { code?: string }; connection?: unknown };
      const updated = qianchuanConnectionViewSchema.safeParse(data.connection);
      if (mounted.current && updated.success && epoch === viewEpoch.current) setConnection(updated.data);
      throw new SetupError(data.error?.code ?? "QIANCHUAN_CONNECTION_FAILED");
    }
    return schema.parse(raw);
  }, []);
  const showError = (cause: unknown) => { if (mounted.current) setError(errorText(cause instanceof SetupError ? cause.code : "QIANCHUAN_CONNECTION_FAILED")); };
  const refresh = useCallback(async () => {
    const epoch = viewEpoch.current;
    try {
      const value = await request("connection", qianchuanConnectionViewSchema);
      if (!mounted.current || epoch !== viewEpoch.current) return;
      setConnection(value);
      if (refreshError.current) {
        const old = refreshError.current;
        setError((current) => current === old ? "" : current);
        refreshError.current = "";
      }
    } catch (cause) {
      if (!mounted.current || epoch !== viewEpoch.current) return;
      refreshError.current = errorText(cause instanceof SetupError ? cause.code : "QIANCHUAN_CONNECTION_FAILED");
      setError(refreshError.current);
    }
  }, [request]);

  useEffect(() => {
    mounted.current = true;
    if (!isLoopbackHost(window.location.hostname)) { setError(errorText("QIANCHUAN_LOCAL_ONLY")); return () => { mounted.current = false; }; }
    api.current = resolveLiveBackend(window.location).api;
    const bootstrap = async () => {
      try { return await request("setup", qianchuanSetupSessionSchema); }
      catch (cause) {
        if (!(cause instanceof SetupError) || cause.code !== "QIANCHUAN_USE_LOCAL_PORT") throw cause;
        const local = new URL(api.current);
        if (!isLoopbackHost(local.hostname)) throw new SetupError("QIANCHUAN_LOCAL_ONLY");
        local.port = String(QIANCHUAN_LOCAL_ADMIN_PORT);
        api.current = local.origin;
        return request("setup", qianchuanSetupSessionSchema);
      }
    };
    void bootstrap().then((value) => {
      if (!mounted.current) return;
      csrf.current = value.csrfToken;
      setConnection(value.connection);
      setAppId(value.connection.appId ?? "");
    }).catch(showError);
    const timer = window.setInterval(() => {
      if (!csrf.current) return;
      void refresh();
    }, 1500);
    return () => {
      mounted.current = false;
      selectedEpoch.current += 1;
      window.clearInterval(timer);
    };
  }, [request, refresh]);

  const loadAccounts = useCallback(async () => {
    setBusy("accounts"); setError(""); setAccountsLoaded(true); setAccountId(""); setAwemeId(""); setAwemes([]);
    selectedEpoch.current += 1;
    try {
      const result = await request("accounts", qianchuanAccountListSchema);
      if (mounted.current) setAccounts(result);
    } catch (cause) { showError(cause); }
    finally { if (mounted.current) setBusy(""); }
  }, [request]);
  useEffect(() => {
    if (connection?.authorized && (!connection.binding || editingBinding) && !accountsLoaded) void loadAccounts();
  }, [connection?.authorized, connection?.binding, editingBinding, accountsLoaded, loadAccounts]);

  const saveApp = async (event: React.FormEvent) => {
    event.preventDefault(); setBusy("app"); setError("");
    try {
      const value = await request("app", qianchuanConnectionViewSchema, { appId: appId.trim(), appSecret: appSecret.trim(), independentApp: independent });
      if (mounted.current) { setConnection(value); setAppSecret(""); setSettingsOpen(false); setAccountsLoaded(false); }
    } catch (cause) { showError(cause); }
    finally { if (mounted.current) setBusy(""); }
  };
  const openAuthorization = (url: string) => {
    if (process.env.NEXT_PUBLIC_CAPTURE_ONLY === "1") window.open(url, "_blank", "noopener,noreferrer");
    else window.location.assign(url);
  };
  const authorize = async () => {
    setBusy("authorize"); setError(""); setAccountsLoaded(false); setAccounts({ items: [], warnings: [] });
    try {
      const value = await request("authorize", qianchuanConnectionViewSchema, {});
      if (!mounted.current) {
        if (value.authorization.attemptId) await request("authorize/cancel", qianchuanConnectionViewSchema, { attemptId: value.authorization.attemptId });
        return;
      }
      setConnection(value);
      if (!value.authorization.authUrl) throw new SetupError(value.authorization.errorCode ?? "QIANCHUAN_CONNECTION_FAILED");
      openAuthorization(value.authorization.authUrl);
    } catch (cause) { showError(cause); }
    finally { if (mounted.current) setBusy(""); }
  };
  const cancel = async () => {
    setBusy("cancel");
    try {
      const value = await request("authorize/cancel", qianchuanConnectionViewSchema, { attemptId: connection?.authorization.attemptId });
      if (mounted.current) setConnection(value);
    } catch (cause) { showError(cause); }
    finally { if (mounted.current) setBusy(""); }
  };
  const chooseAccount = async (id: string) => {
    const epoch = ++selectedEpoch.current;
    setAccountId(id); setAwemeId(""); setAwemes([]); setError("");
    if (!id) { setBusy(""); return; }
    setBusy("awemes");
    try {
      const result = await request(`awemes?advertiserId=${encodeURIComponent(id)}`, qianchuanAwemeListSchema);
      if (mounted.current && epoch === selectedEpoch.current) setAwemes(result.items);
    } catch (cause) { if (epoch === selectedEpoch.current) showError(cause); }
    finally { if (mounted.current && epoch === selectedEpoch.current) setBusy(""); }
  };
  const bind = async () => {
    setBusy("binding"); setError("");
    try {
      const value = await request("binding", qianchuanConnectionViewSchema, { advertiserId: accountId, awemeId });
      if (mounted.current) { setConnection(value); setEditingBinding(false); }
    } catch (cause) { showError(cause); }
    finally { if (mounted.current) setBusy(""); }
  };
  const pending = connection?.authorization.state === "waiting" || connection?.authorization.state === "saving";
  const inspectFields = async () => {
    const epoch = viewEpoch.current; setBusy("capabilities"); setError("");
    try { const result = await request("capabilities", qianchuanCapabilitiesSchema); if (mounted.current && epoch === viewEpoch.current) setProbe(result); }
    catch(cause) { showError(cause); } finally { if(mounted.current)setBusy(""); }
  };
  useEffect(() => { setProbe(null); }, [connection?.appId, connection?.binding?.advertiserId, connection?.binding?.awemeId]);
  const fieldNames: Record<string,string> = {qualification_stat_cost:"直播间总消耗（优先字段）",stat_cost:"直播间总消耗（备用字段）",live_pay_order_gmv_alias:"成交金额",live_pay_order_count_alias:"支付订单数",live_click_product_count_alias:"商品点击次数",total_live_watch_cnt:"累计观看次数",total_live_pay_order_gpm:"平台 GPM",live_pay_order_gmv_roi:"平台 ROI",cpm_platform:"平台 CPM",ctr:"平台点击率（口径待核对）",convert_rate:"平台转化率（口径待核对）",total_live_comment_cnt:"评论次数",total_live_follow_cnt:"新增关注数",total_live_fans_club_join_cnt:"粉丝团加入数",total_live_share_cnt:"分享次数",live_pay_order_gmv_avg:"支付订单均额"};
  const step = !connection?.appConfigured ? 1 : !connection.authorized ? 2 : 3;
  const active = (connection?.source.activeSessions ?? 0) > 0;
  const authError = connection?.authorization.errorCode;
  return <main className="live-pilot-shell qc-connect">
    <header className="qc-header"><div><p className="qc-eyebrow">直播副驾 · 数据连接</p><h1>连接千川</h1><p>登录一次，选择直播间，投放数据直接回到副驾。</p></div><Link href="/live" className="live-pilot-link">返回接入说明</Link></header>
    <ol className="qc-steps" aria-label="接入步骤">{["应用准备", "官方登录授权", "选择直播间"].map((name, index) => <li key={name} aria-current={step === index + 1 ? "step" : undefined} data-done={step > index + 1}><span>{index + 1}</span>{name}</li>)}</ol>
    {error && <div role="alert" className="qc-message qc-error">{error}</div>}
    {!connection && !error && <p role="status">正在检查本机连接…</p>}
    {connection && <>
      {(!connection.appConfigured || settingsOpen) && <section className="qc-card"><h2>准备副驾专用应用</h2><p>由管理员完成一次。请使用独立 App ID，避免重新授权时影响片场等系统。</p>
        <form onSubmit={(event) => { void saveApp(event); }}>
          <label>App ID<input name="appId" inputMode="numeric" value={appId} onChange={(event) => setAppId(event.target.value)} autoComplete="off" required disabled={active || Boolean(busy)} /></label>
          <label>App Secret<input name="appSecret" type="password" value={appSecret} onChange={(event) => setAppSecret(event.target.value)} autoComplete="new-password" required disabled={active || Boolean(busy)} /></label>
          <label className="qc-check"><input type="checkbox" checked={independent} onChange={(event) => setIndependent(event.target.checked)} required disabled={active || Boolean(busy)} />此 App ID 专用于副驾，未与片场等系统共用</label>
          <p className="qc-note">在千川开放平台为此应用登记回调地址：<code>{CALLBACK}</code>。应用凭据仅保存于值班电脑，不会发给同网观看者。</p>
          <button type="submit" className="qc-primary" disabled={!independent || active || Boolean(busy)}>{busy === "app" ? "正在保存…" : "保存应用配置"}</button>
          {settingsOpen && <button type="button" onClick={() => { setSettingsOpen(false); setAppSecret(""); }}>取消修改</button>}
        </form>
      </section>}
      {connection.appConfigured && !settingsOpen && <section className="qc-card"><div className="qc-card-title"><h2>{connection.authorized ? "千川已授权" : "登录并授权千川"}</h2><span className="qc-badge">应用 · {connection.appId?.slice(-6)}</span></div>
        <p>在千川官方页面扫码或选择可用的登录方式，再确认账户与权限。副驾不收集千川登录密码，也不需要你复制令牌。</p>
        {pending ? <div className="qc-message" role="status"><strong>{connection.authorization.state === "saving" ? "正在保存授权…" : "等待官方页面完成授权…"}</strong><p>完成后会自动返回并显示账户。不继续时点击取消；本次授权 10 分钟后过期。</p><button onClick={() => { if (connection.authorization.authUrl) openAuthorization(connection.authorization.authUrl); }} disabled={Boolean(busy) || !connection.authorization.authUrl || connection.authorization.state === "saving"}>继续官方授权</button><button onClick={() => { void cancel(); }} disabled={Boolean(busy) || connection.authorization.state === "saving"}>取消本次授权</button></div>
          : <><button className="qc-primary" onClick={() => { void authorize(); }} disabled={Boolean(busy)}>{busy === "authorize" ? "正在打开…" : connection.authorized ? "重新登录授权" : "连接千川"}</button><button onClick={() => setSettingsOpen(true)} disabled={active || Boolean(busy)}>应用设置</button></>}
        {authError && !pending && <p role="status" className="qc-note">{errorText(authError)}</p>}
      </section>}
      {connection.authorized && !settingsOpen && <section className="qc-card"><h2>{connection.binding && !editingBinding ? "当前连接的直播间" : "选择投放账户和抖音号"}</h2>
        {connection.binding && !editingBinding ? <>
          <button disabled={Boolean(busy)} onClick={() => { void inspectFields(); }}>{busy === "capabilities" ? "正在读取真实接口…" : "检测接口字段"}</button>
          <p className="qc-note">只读一次已绑定直播间，确认本账号实际返回哪些字段。不会启动投放，也不会把缺失值填成 0。</p>
          {probe && <div className="qc-message" role="status"><strong>{probe.status === "fresh" ? "已收到直播间真实接口响应" : probe.status === "no_living_room" ? "暂无正在直播的房间，字段仍待验证" : "接口读取失败"}</strong><p>{probe.errorCode ? errorText(probe.errorCode) : `检查时间：${new Date(probe.observedAt).toLocaleString()}`}</p>{probe.fallbackUsed && <p>扩展字段请求未被接受，已保留基础数据；未请求的扩展项仍待验证。</p>}<details><summary>查看字段结果</summary><ul>{Object.entries(probe.capabilities).map(([field,state]) => <li key={field}>{fieldNames[field] ?? field}：{{available:"已返回并校验",missing:"本次未返回有效值",unsupported:"字段不支持",not_requested:"未验证"}[state]}</li>)}</ul></details></div>}
          <dl className="qc-bound"><div><dt>投放账户</dt><dd>{connection.binding.accountName}</dd></div><div><dt>抖音号</dt><dd>{connection.binding.awemeName}</dd></div></dl>
          <p role="status" className="qc-message">{connection.source.state === "healthy" ? "千川数据正在更新，无需另开千川大屏。" : connection.source.lastErrorCode === "QIANCHUAN_NO_LIVING_ROOM" ? "已完成绑定，当前未发现正在直播的房间。" : connection.source.state === "error" || connection.source.state === "stale" ? errorText(connection.source.lastErrorCode ?? "QIANCHUAN_NETWORK_FAILED") : "已完成绑定。连接罗盘后，千川会自动开始读取。"}</p>
          <Link href="/live" className="qc-primary qc-link">继续连接罗盘</Link><button disabled={active || Boolean(busy)} onClick={() => { setEditingBinding(true); setAccountsLoaded(false); }}>更换账户或抖音号</button>
          {active && <p className="qc-note">正在监测直播，结束当前副驾场次后才能切换绑定。</p>}
        </> : <>
          <p>只显示当前授权可读取的账户。请选择本场直播使用的账户和抖音号。</p>
          <label>投放账户<select value={accountId} onChange={(event) => { void chooseAccount(event.target.value); }} disabled={busy === "accounts" || busy === "binding"}><option value="">{busy === "accounts" ? "正在读取账户…" : "请选择投放账户"}</option>{accounts.items.map((item) => <option key={item.id} value={item.id}>{item.name} · 尾号 {item.id.slice(-4)}</option>)}</select></label>
          {accountsLoaded && !busy && accounts.items.length === 0 && <p role="status">未找到已授权的千川投放账户。请确认官方登录账号及授权范围，再重新读取。</p>}
          <label>抖音号<select value={awemeId} onChange={(event) => setAwemeId(event.target.value)} disabled={!accountId || Boolean(busy)}><option value="">{busy === "awemes" ? "正在读取抖音号…" : "请选择抖音号"}</option>{awemes.map((item) => <option key={item.id} value={item.id}>{item.name}{item.showId ? ` · ${item.showId}` : ""}</option>)}</select></label>
          {accountId && !busy && awemes.length === 0 && <p role="status">此账户未返回已授权抖音号，请检查千川中的抖音号授权。</p>}
          {accounts.warnings.length > 0 && <div className="qc-message" role="status">{accounts.warnings.map((warning) => <p key={warning}>{warning}</p>)}</div>}
          <div className="qc-actions"><button className="qc-primary" disabled={!accountId || !awemeId || Boolean(busy)} onClick={() => { void bind(); }}>{busy === "binding" ? "正在连接…" : "连接所选直播间"}</button><button disabled={Boolean(busy)} onClick={() => { void loadAccounts(); }}>重新读取账户</button>{connection.binding && <button onClick={() => setEditingBinding(false)} disabled={Boolean(busy)}>保留当前连接</button>}</div>
        </>}
      </section>}
    </>}
  </main>;
}
