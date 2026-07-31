/**
 * src/licenseRegistry.ts — 資料授權登錄表(正式版路徑)
 * 第四輪仲裁:單一 DATA_DERIVED_DISPLAY_OK 僅過渡可用;
 * 正式判斷維度 = 供應商 × 資料集 × 頻道 × 法域 × 用途 × 效期。
 * 每筆 grant 應對應一份書面授權文件(docRef)。
 */
export interface LicenseGrant {
  supplier: string;          // e.g. "massive"
  dataset: string;           // e.g. "options_chain_snapshot"
  channels: string[];        // e.g. ["telegram","web"] 或 ["*"]
  jurisdictions: string[];   // e.g. ["TW","SG"] 或 ["*"]
  uses: string[];            // e.g. ["derived_display","internal_research"]
  validUntilIso: string | null; // null = 未設限(仍應年度覆核)
  docRef: string;            // 書面授權文件編號/連結
}
export interface LicenseQuery {
  supplier: string; dataset: string; channel: string; jurisdiction: string; use: string;
}
const hit = (list: string[], v: string) => list.includes("*") || list.includes(v);

export class LicenseRegistry {
  private grants: LicenseGrant[];
  constructor(grants: LicenseGrant[]) { this.grants = grants; }
  isGranted(q: LicenseQuery, nowIso: string = new Date().toISOString()): boolean {
    return this.grants.some(g =>
      g.supplier === q.supplier && g.dataset === q.dataset &&
      hit(g.channels, q.channel) && hit(g.jurisdictions, q.jurisdiction) &&
      hit(g.uses, q.use) &&
      (g.validUntilIso === null || nowIso <= g.validUntilIso));
  }
}
