# PKG3 — 第三方整合文件 + external-consumer 範例 + 修正文件 import

> **狀態:設計草圖(design sketch),非本批實作契約。** 確切文件骨架、範例專案結構、CI 驗證命令於**本片
> 開工時**才 pin;下方是方向。本批(PKG1)只交付 `package.json` 契約。

> 父系列:[`INDEX.md`](./INDEX.md)。讓人從「空專案」走到「治理 surface 在我的程式裡跑」,並修掉現有文件
> 用 root 匯 factory 的錯。

## 1. 新文件 `docs/sdk/third-party-integration.md`

對象:在**自己的專案**導入 Agent OS 的開發者。內容(步驟可照做):

1. **前置**:Node ≥22 + `@types/node`(peer)。
2. **安裝**(誠實列現支援模式):
   - **tarball**:`pnpm pack` 產 `agent-os-x.y.z.tgz` → 在你的專案 `pnpm add ./path/agent-os-x.y.z.tgz`。
   - **pnpm workspace**:monorepo 內 `"agent-os": "workspace:*"`。
   - **git 依賴**:僅在加 `prepare` build hook 時可行(`dist/` 預設不進 git)——標為選用。
   - **npm**:尚未發佈(見 INDEX §5 PKG-final)。
3. **最小 composition root**(用**子路徑**,不是 root)——兩種用途分清楚:
   - **跑意圖示範(Personal)**:`createPersonalShell` **必須帶 allow 規則**(鏡射
     `examples/surfaces/run-personal-shell.ts`),否則預設 `denied@policy`:
     ```ts
     import { createPersonalShell } from "agent-os/personal";
     const shell = createPersonalShell({ allowToolInvoke: /* 你的 allow 規則 */ });
     ```
   - **定義並暴露你自己的工具(Developer)**:Personal 面**沒有**第三方工具的 binding/effect 注入接縫,
     工具 authoring **走 Developer 面**:
     ```ts
     import { createDeveloperKit } from "agent-os/developer";
     import { integrationsFromEnv } from "agent-os/runtime/spendguard"; // 選用:真 SpendGuard
     const kit = createDeveloperKit(integrationsFromEnv());             // env 未設 → in-memory
     ```
4. **定義並暴露一個工具**(manifest → binding → 經同一條 `runGovernedToolCall`)——**用 Developer 面**,連到
   [Build a Tool Family](../sdk/build-a-tool-family.md)。
5. **跑**:送一個意圖 → 看 governed outcome(`decision`、可讀 timeline)。
6. **自驗證據鏈**:`<verifier> --chain … --pubkey …`(連 [Verifier Release](../sdk/verifier-release.md))。
7. **規則框**:自建 surface 必須讓**每個** effect 走 `runGovernedToolCall`,絕不可直呼 substrate/connector
   (引 composition-root-guide §1)。

> **in-package 連結用絕對 repo URL**(`https://github.com/m24927605/agent-os/blob/main/docs/...`),因為
> `files` 不含 `docs/`,tarball 內的 README 相對連結會斷。

## 2. `examples/external-consumer/`(最小可跑範例)

- 一個最小專案:`package.json`(透過 tarball 或 `file:`/workspace 依賴 `agent-os`)+ `src/main.ts`:
  **Personal 面(帶 allow 規則)跑一次意圖** + **Developer 面(`createDeveloperKit`)定義並跑一個示範工具**,
  印 governed outcome(`decision`/timeline)。
- 與 PKG2 的 harness 互補:PKG2 是**自動 smoke 證明**,本範例是**給人讀/改的起手式**。
- 不納入 14-leg verify(它需要安裝步驟);文件說明如何跑。

## 3. 修正既有文件的 import 範例(spec-gate fix)

- **README**:目前 `import { createPersonalShell } from "agent-os"` **錯**(root 無此 factory)→ 改成
  `from "agent-os/personal"`。掃所有 docs 把 factory 匯入改到正確子路徑。
- README/Documentation 索引新增「**[Third-Party Integration](docs/sdk/third-party-integration.md)** —
  在你自己的專案導入 Agent OS」。

## 不變量 / 驗收

- 一個人照 `third-party-integration.md` 能從空專案跑到 governed outcome(用 tarball/workspace)。
- 所有 docs 的 `agent-os` factory import 範例都用**正確子路徑**;PKG1 測試 3(文件 ⊆ exports)綠。
- `examples/external-consumer/` 可跑並印出 `executed` + timeline。
- 不改治理行為;`pnpm run verify` 綠。
