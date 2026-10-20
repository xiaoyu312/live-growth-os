"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import type { MvpProduct } from "@live-growth/contracts";

const API_URL = process.env.NEXT_PUBLIC_API_URL ?? "http://127.0.0.1:4100";
type ProductForm = { productId: string; name: string; type: MvpProduct["type"]; priceYuan: string; enabled: boolean; note: string };
const emptyForm = (): ProductForm => ({ productId: `mvp-custom-${Date.now()}`, name: "", type: "low_price_new_customer", priceYuan: "", enabled: true, note: "" });

function toForm(product: MvpProduct): ProductForm { return { productId: product.productId, name: product.name, type: product.type, priceYuan: String(product.priceFen / 100), enabled: product.enabled, note: product.note ?? "" }; }

export default function ProductsPage() {
  const [products, setProducts] = useState<MvpProduct[]>([]);
  const [form, setForm] = useState<ProductForm | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  async function load() { const response = await fetch(`${API_URL}/api/mvp/products`); if (!response.ok) throw new Error("商品读取失败"); setProducts(await response.json() as MvpProduct[]); }
  useEffect(() => { void load().catch((reason: unknown) => setError(reason instanceof Error ? reason.message : "商品读取失败")); }, []);
  function change<K extends keyof ProductForm>(key: K, value: ProductForm[K]) { setForm((current) => current ? { ...current, [key]: value } : current); }
  async function save() {
    if (!form || !form.name.trim() || !form.priceYuan.trim()) { setError("请填写商品名称和价格"); return; }
    if (!/^\d+(?:\.\d{1,2})?$/.test(form.priceYuan.trim())) { setError("价格必须是非负数字，最多保留两位小数"); return; }
    const [yuanPart, fenPart = ""] = form.priceYuan.trim().split(".");
    const priceFen = Number(yuanPart) * 100 + Number((fenPart + "00").slice(0, 2));
    if (!Number.isSafeInteger(priceFen) || priceFen < 0) { setError("价格必须是非负数字，最多保留两位小数"); return; }
    setSaving(true); setError(null); setMessage(null);
    try {
      const response = await fetch(`${API_URL}/api/mvp/products/${encodeURIComponent(form.productId)}`, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name: form.name.trim(), type: form.type, priceFen, enabled: form.enabled, ...(form.note.trim() ? { note: form.note.trim() } : {}) }) });
      const body = await response.json() as { error?: { message?: string } };
      if (!response.ok) throw new Error(body.error?.message ?? "商品保存失败");
      await load(); setMessage("商品已保存"); setForm(null);
    } catch (reason) { setError(reason instanceof Error ? reason.message : "商品保存失败"); }
    finally { setSaving(false); }
  }
  return <main className="mvp-shell mvp-dark"><header className="mvp-header"><div><p className="mvp-eyebrow">商品配置</p><h1>演示商品</h1><p className="mvp-subtitle">低客单商品用于新客承接，高客单商品用于高意向收口。这里的配置只服务于本机演示。</p></div><div className="mvp-header-actions"><Link className="mvp-ghost" href="/">返回副驾首页</Link><button className="mvp-primary" onClick={() => { setForm(emptyForm()); setMessage(null); setError(null); }}>新增商品</button></div></header>{error && <div className="mvp-alert" role="alert">{error}</div>}{message && <div className="mvp-alert mvp-success" role="status">{message}</div>}<section className="mvp-timeline-card"><div className="mvp-card-heading"><div><span className="mvp-section-kicker">当前商品</span><h2>可用于模拟场景的商品</h2></div></div><div className="mvp-product-list">{products.map((product) => <article key={product.productId}><div><strong>{product.name}</strong><p className="mvp-muted">{product.type === "low_price_new_customer" ? "低客单新客" : "高客单复购"} · ¥{(product.priceFen / 100).toLocaleString("zh-CN")} · {product.enabled ? "启用" : "停用"}</p></div><button className="mvp-ghost" onClick={() => { setForm(toForm(product)); setMessage(null); setError(null); }}>编辑</button></article>)}</div></section>{form && <section className="mvp-action-card mvp-product-form"><div className="mvp-card-heading"><div><span className="mvp-section-kicker">商品编辑</span><h2>{products.some((item) => item.productId === form.productId) ? "修改商品" : "新增商品"}</h2></div><button className="mvp-ghost" onClick={() => setForm(null)}>取消</button></div><div className="mvp-product-fields"><label>商品名称<input value={form.name} onChange={(event) => change("name", event.target.value)}/></label><label>商品类型<select value={form.type} onChange={(event) => change("type", event.target.value as ProductForm["type"])}><option value="low_price_new_customer">低客单新客</option><option value="high_price_repeat_customer">高客单复购</option></select></label><label>价格（元）<input inputMode="decimal" value={form.priceYuan} onChange={(event) => change("priceYuan", event.target.value)}/></label><label className="mvp-checkbox"><input type="checkbox" checked={form.enabled} onChange={(event) => change("enabled", event.target.checked)}/>启用</label><label className="mvp-wide">备注<textarea value={form.note} onChange={(event) => change("note", event.target.value)}/></label></div><button className="mvp-primary" disabled={saving} onClick={save}>{saving ? "保存中…" : "保存商品"}</button></section>}</main>;
}
