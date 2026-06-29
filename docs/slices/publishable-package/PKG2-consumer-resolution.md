# PKG2 — 第三方解析證明(consumer smoke,RED-first)

> **狀態:設計草圖(design sketch),非本批實作契約。** 確切 fixture 檔、消費者 `tsconfig`、命令、斷言、
> 自清與 online-CI/快取細節於**本片開工時**才 pin;下方是方向。本批(PKG1)只交付 `package.json` 契約。

> 父系列:[`INDEX.md`](./INDEX.md)。證明「從套件外部」每個公開子路徑都能**解析 + 型別檢查 + 實跑**,且
> 內部深路徑被 `exports` 擋。這是 PKG1 的對外端到端驗收。

## Harness

新增 `scripts/pkg-consumer-smoke.mjs` + `scripts.pkg:consumer-smoke`。步驟(全自動、自清):

1. `pnpm run build`(或依賴 `prepack`)。
2. `npm pack --json` → 解析 tarball 絕對路徑。
3. `mktemp -d` 建 throwaway 消費者專案:`package.json`(`"type":"module"`),devDeps 裝 `typescript` +
   `@types/node@>=22`,然後 `npm i <tarball 絕對路徑>`(模擬第三方安裝;**不**用 workspace 連結,要真解析
   tarball 內的 `exports`)。
4. 產生消費者檔並執行四類斷言:

   **(a) runtime 解析 — 每個公開子路徑**:`consumer.mjs` 動態 `import()` 全部 9 入口
   (`agent-os`、`/personal`、`/developer`、`/enterprise`、`/tools`、`/sdk/templates`、
   `/runtime/spendguard`、`/policy/adapters/agt`)→ 全部 resolve、無 throw;斷言關鍵符號存在
   (`createPersonalShell`/`createDeveloperKit`/`createEnterpriseFleet`/`integrationsFromEnv`/
   `AgtSecondaryPolicy`)。

   **(b) 型別檢查**:`consumer.ts` 具名匯入上述符號 + 至少一個型別(如 tool manifest 型別)→
   `tsc --noEmit`(消費者的 `tsconfig`,`moduleResolution: "bundler"` 或 `node16`)exit 0。

   **(c) 實跑一次治理呼叫**:**鏡射 `examples/surfaces/run-personal-shell.ts` 的建構**——帶其 allow 規則
   (`createPersonalShell({ allowToolInvoke: … })`,from `agent-os/personal`)。**空 `createPersonalShell()`
   預設 `allowToolInvoke` 空 → 會 `denied@policy`**,故必須照 reference root 帶 allow。in-memory 預設、
   **不啟 live Go kernel**。跑最小意圖 → 斷言 `decision === "executed"` 且 timeline 有 ≥1 條
   **in-memory WORM-backed** 事件。

   **(d) 負向 — 深路徑被擋**:`await import("agent-os/runtime/brain/adapters/hermes")` **必須 reject**,
   且 `err.code === "ERR_PACKAGE_PATH_NOT_EXPORTED"`(證明 `exports` allowlist 真的封住內部)。另加一個
   **負向型別**:`consumer-bad.ts` 匯入未公開子路徑 → `tsc --noEmit` **必須非零**。

5. 自清:刪 throwaway 目錄 + 移除產生的 tarball。

## RED-first

- **先紅**:PKG1 尚未加 `exports` 前跑 `pkg:consumer-smoke` → (a) 多數子路徑 resolve 失敗 /(d) 負向案例
  無意義(深路徑現在反而「能」匯入,違反期望)→ script 非零。**先提交這支看它紅。**
- PKG1 落地後 → 全部轉綠。

## 掛載點

- **單一確定執行環境(iteration-2 fix):online CI / 有 registry 或預熱 pnpm store。** tarball 本身**不含**
  deps,throwaway 的 `npm i <tarball>` 仍須從 registry/cache 解析 `zod`、`@grpc/grpc-js` 等執行依賴——
  **不主張 registry-free**。CI 有網或預熱 store 即可決定性通過。
- `pkg:consumer-smoke` 為**獨立 script**(`npm pack` + 真安裝 + tsc,較慢且需 npm/network)→ **不**塞進
  14-leg `verify`(維持 verify hermetic/快);列為**發佈前 / CI 的封裝 gate**,CONTRIBUTING/INDEX 標明
  「動 `package.json.exports` 或 public surface 後必跑」。

## 不變量 / 驗收

- 9 入口 runtime+型別皆通過;治理呼叫得 `executed` + in-memory WORM timeline;深路徑 runtime 拋
  `ERR_PACKAGE_PATH_NOT_EXPORTED`、型別負向 `tsc` 非零。
- script 自清、可重複跑;不污染 repo(throwaway 在 `mktemp`,tarball 跑後刪)。
- 不需 live kernel / 不需任何外部設施(純 in-memory)。
