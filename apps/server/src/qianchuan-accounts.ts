import { qianchuanAccountListSchema, type QianchuanAccountList, type QianchuanAccount } from "@live-growth/contracts";
import { normalizeAuthorizedAwemeId } from "@live-growth/source-adapters";

// 官方 Marketing API 查询端点；不接受来自网页的 URL 或工具名。
export const QIANCHUAN_ACCOUNT_ENDPOINTS = {
  authorized: "/open_api/oauth2/advertiser/get/",
  shop: "/open_api/v1.0/qianchuan/shop/advertiser/list/",
  customer: "/open_api/v3.0/customer_center/account/list/",
  agent: "/open_api/2/agent/advertiser/select/",
  teams: "/open_api/2/ebp/level/get/",
  enterprise: "/open_api/2/ebp/advertiser/list/",
  names: "/open_api/2/advertiser/public_info/"
} as const;
type Read = (path: string, args: Record<string, unknown>) => Promise<unknown>;
type Row = Record<string, unknown>;
function object(value: unknown): Row {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Row : {};
}
function rows(value: unknown, keys: string[]): unknown[] {
  if (Array.isArray(value)) return value;
  const data = object(value);
  const candidates = keys.map((key) => data[key]).filter(Array.isArray) as unknown[][];
  if (candidates.length) return candidates.find((items) => items.length > 0) ?? [];
  throw new Error("QIANCHUAN_ACCOUNT_RESPONSE_INVALID");
}
function idOf(row: Row): string {
  return normalizeAuthorizedAwemeId(row.account_id ?? row.advertiser_id ?? row.adv_id ?? row.id);
}
function nameOf(row: Row, fallback: string): string {
  const value = row.account_name ?? row.advertiser_name ?? row.adv_name ?? row.name;
  return typeof value === "string" && value.trim() ? value.trim().slice(0, 160) : fallback;
}
function morePages(data: unknown, count: number, page: number): boolean {
  const info = object(object(data).page_info);
  const pages = Number(info.total_page), total = Number(info.total_number);
  if (Number.isFinite(pages) && pages > 0) return page < pages;
  if (Number.isFinite(total) && total >= 0) return page * (Number(info.page_size) || 100) < total;
  return count >= 100;
}

/** 授权根账户展开到实际投放账户；部分组织不可读时保留已成功结果并明确告知。 */
export async function discoverQianchuanAccounts(read: Read, now: () => number = Date.now): Promise<QianchuanAccountList> {
  const items = new Map<string, QianchuanAccount>();
  const warnings = new Set<string>();
  const deadline = now() + 60_000;
  let requests = 0;
  const call: Read = async (path, args) => {
    if (++requests > 80 || now() >= deadline) throw new Error("QIANCHUAN_ACCOUNT_DISCOVERY_LIMIT");
    return read(path, args);
  };
  const add = (value: unknown, requireQianchuan = false) => {
    const row = object(value);
    if (requireQianchuan && row.account_type !== "QIANCHUAN") return;
    try {
      const id = typeof value === "string" || typeof value === "number" ? normalizeAuthorizedAwemeId(value) : idOf(row);
      if (items.size >= 10000 && !items.has(id)) throw new Error("QIANCHUAN_ACCOUNT_DISCOVERY_LIMIT");
      items.set(id, { id, name: nameOf(row, items.get(id)?.name ?? `账户 ${id}`) });
    } catch {
      warnings.add("部分账户标识无法安全识别，未加入可选列表。");
    }
  };
  const paginate = async (path: string, args: Row, keys: string[], typed: boolean) => {
    const signatures = new Set<string>();
    for (let page = 1; page <= 50; page += 1) {
      const data = await call(path, { ...args, page, page_size: 100 });
      const batch = rows(data, keys);
      const signature = JSON.stringify(batch.map((value) => {
        const row = object(value);
        return row.account_id ?? row.advertiser_id ?? row.adv_id ?? value;
      }));
      if (batch.length && signatures.has(signature)) throw new Error("QIANCHUAN_ACCOUNT_PAGE_REPEATED");
      signatures.add(signature);
      batch.forEach((value) => add(value, typed));
      if (!morePages(data, batch.length, page)) return;
      if (!batch.length) throw new Error("QIANCHUAN_ACCOUNT_PAGE_INCOMPLETE");
    }
    throw new Error("QIANCHUAN_ACCOUNT_DISCOVERY_LIMIT");
  };
  const roots = rows(await call(QIANCHUAN_ACCOUNT_ENDPOINTS.authorized, {}), ["list", "advertiser_list"]);
  const expanded = new Set<string>();
  for (const value of roots) {
    const row = object(value);
    if (row.is_valid === false) continue;
    const role = String(row.platform_role ?? row.account_role ?? row.role ?? "").toUpperCase();
    const accountType = String(row.account_type ?? row.advertiser_type ?? "").toUpperCase();
    const marker = `${role}_${accountType}`;
    try {
      const id = idOf(row);
      if (/ENTERPRISE_BP|^_EBP$/.test(marker)) {
        const teamIds = new Set([id]);
        try {
          const tree = object(await call(QIANCHUAN_ACCOUNT_ENDPOINTS.teams, { enterprise_organization_id: id }));
          const visit = (list: unknown, depth: number): void => {
            if (list === undefined) return;
            if (!Array.isArray(list) || depth > 4 || teamIds.size > 100) throw new Error("QIANCHUAN_ACCOUNT_DISCOVERY_LIMIT");
            for (const item of list) {
              const team = object(item);
              teamIds.add(normalizeAuthorizedAwemeId(team.team_id));
              visit(team.sub_team, depth + 1);
            }
          };
          visit(tree.sub_team, 0);
        } catch {
          warnings.add("新版工作台部分子团队未读取，请检查授权范围后重试。");
        }
        for (const teamId of teamIds) {
          if (expanded.has(`ebp:${teamId}`)) continue;
          expanded.add(`ebp:${teamId}`);
          await paginate(QIANCHUAN_ACCOUNT_ENDPOINTS.enterprise,
            { enterprise_organization_id: teamId, account_source: "QIANCHUAN" }, ["account_list"], true);
        }
      } else if (/SHOP/.test(marker)) {
        await paginate(QIANCHUAN_ACCOUNT_ENDPOINTS.shop, { shop_id: id }, ["adv_id_list", "list", "advertiser_ids", "advertisers"], false);
      } else if (/AGENT|AGENCY/.test(marker)) {
        const companyIds = Array.isArray(row.company_list) ? row.company_list.map((item) => normalizeAuthorizedAwemeId(object(item).customer_company_id)) : [];
        await paginate(QIANCHUAN_ACCOUNT_ENDPOINTS.agent,
          { advertiser_id: id, ...(companyIds.length ? { company_ids: companyIds } : {}) }, ["advertiser_ids", "list", "adv_id_list"], false);
      } else if (/CUSTOMER/.test(marker)) {
        await paginate(QIANCHUAN_ACCOUNT_ENDPOINTS.customer, { account_id: id, filter: { account_type: "QIANCHUAN" } }, ["accounts"], true);
      } else if (/QIANCHUAN|ADVERTISER/.test(marker) || (!role && !accountType && row.advertiser_id !== undefined)) {
        add(row);
      } else warnings.add("有授权入口无法识别为千川账户，未自动绑定。");
    } catch (error) {
      if (error instanceof Error && /QIANCHUAN_(HTTP_401|TOOL_40102|TOOL_40103)$/.test(error.message)) throw error;
      warnings.add("部分授权入口读取失败或达到本次读取上限，列表可能不完整，请重试。");
    }
  }
  const unnamed = [...items.values()].filter((item) => item.name === `账户 ${item.id}`).map((item) => item.id);
  for (let offset = 0; offset < unnamed.length; offset += 100) {
    try {
      const data = await call(QIANCHUAN_ACCOUNT_ENDPOINTS.names, { advertiser_ids: unnamed.slice(offset, offset + 100) });
      for (const value of rows(data, ["list"])) {
        const row = object(value);
        const id = idOf(row);
        if (items.has(id)) items.set(id, { id, name: nameOf(row, items.get(id)!.name) });
      }
    } catch { warnings.add("部分账户名称未获取，可按账号尾号区分或稍后重新读取。"); }
  }
  return qianchuanAccountListSchema.parse({ items: [...items.values()].sort((a, b) => a.name.localeCompare(b.name, "zh-CN")), warnings: [...warnings] });
}
