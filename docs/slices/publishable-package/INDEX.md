# Slices: publishable package — 讓第三方能導入並使用 Agent OS

> **全局策略(spec-gate 連 3 次「需更精確的實作契約」後改採):** 本批**只把 PKG1 收斂成完全釘死、可直接
> 實作的契約**(下方路徑/鍵/決定皆已用實際 `pnpm run build` 驗證);**PKG2 / PKG3 / PKG4 標為設計草圖**
> ——它們的 fixture、tsconfig、命令、斷言在各自開工時才 pin,**不作為本批的實作契約**(避免把未動工的片
> 當成已 ready)。
>
> **實作守則:本文件只可執行 PKG1 任務。PKG2/PKG3/PKG4 為草圖,不得據以動工**(各自開工時另 pin + 過 gate)。

## 0. 動機(誠實現況,2026-06-29)

Agent OS 是 **library, not a service**:使用者在自己的程式寫 composition root,讓每個 effect 走過單一治理
閘 `runGovernedToolCall`。但目前**無法被第三方乾淨導入**:`package.json` 是 `private:true`、`0.0.0`、
**無 `exports` / `files` / `license` / build-on-pack**,文件卻教 `import … from "agent-os/personal"` 等
子路徑(無解析契約)。本批補上「明確 public surface + 可打包 + 解析證明 + 整合文件」。

## 1. 範圍與基本決定(PKG1-3)

- **散佈模式 = 本地 tarball(`npm pack`) + pnpm workspace。** **`private` 維持 `true`**(PKG1-3 不翻);
  `private:true` 不擋 `npm pack`/`file:`/workspace,只擋 `npm publish`。實際 publish = **PKG-final(gated)**。
- **純 ESM**(`"type":"module"`):`exports` 只給 `types`+`import` 條件,**不提供 `require`/CJS**。消費者
  `tsconfig` 用 `moduleResolution: "node16" | "nodenext" | "bundler"`。
- **MVP = in-memory**:跑出來的是 **in-memory 簽章 append-only audit timeline**,**不是**耐久的 Go-kernel
  WORM(那需注入 kernel reader/writer,屬 **PKG4**)。本批文案**不**用「WORM-backed」描述 in-memory。
- **root `.` 契約(精確)**:`.` **保留既有 exports**(含現有的 `createDeveloperKit` re-export)→ 因此
  **`.` 並非 vendor-neutral-pure**(developer factory 的圖含預設 Hermes)。**三面 factory 的權威入口在子路徑**
  (`createPersonalShell`←`/personal`、`createEnterpriseFleet`←`/enterprise`、`createDeveloperKit`←`/developer`)。
- **vendor 邊界保證的確切出處**:`pnpm run deps:check`(`dependency-cruiser`,verify 第 5 leg)維持綠——
  **不**主張 `.` 的 transitive graph 零 vendor。
- **type 依賴**:公開 `.d.ts` 會用到 Node 全域(`Buffer`/`node:crypto` 等)→ 文件要求消費者 **Node ≥22 +
  安裝 `@types/node`**;在 `package.json` 以 `peerDependencies: { "@types/node": ">=22" }` +
  `peerDependenciesMeta: { "@types/node": { "optional": true } }` 宣告(缺只影響型別、不影響 runtime),
  並**續留 `devDependencies`**(本 repo 自用)。

## 2. 不變量(必須保)

1. **public surface = 明確 allowlist**(下表 9 入口),**無 `./*`**。內部模組(如
   `runtime/brain/adapters/hermes`)**不在 `exports`** → 外部深路徑匯入須被擋。
2. **`deps:check` 維持綠**(既有 spine 邊界)。
3. **import 無副作用**:匯入任一公開子路徑**不得**觸發 live kernel / 網路 / 憑證 / 檔案系統 副作用。
4. **缺省行為 byte-identical**:只加 `exports`/`files`/`prepack`/`license`/peer(+ 必要薄 barrel)。既有測試
   全綠不變。
5. **tarball 不含** `src` / `*.test.*` / `*.map` / fixtures / secret / verifier 二進位。

## 3. PKG1 已釘死的 public surface(已用 `pnpm run build` 驗證每個入口存在)

| import 子路徑 | dist 入口(實測存在) |
|---|---|
| `agent-os` (`.`) | `dist/index.js` + `dist/index.d.ts` |
| `agent-os/personal` | `dist/personal/index.{js,d.ts}` |
| `agent-os/developer` | `dist/developer/index.{js,d.ts}` |
| `agent-os/enterprise` | `dist/enterprise/index.{js,d.ts}` |
| `agent-os/tools` | `dist/tools/index.{js,d.ts}` |
| `agent-os/sdk/templates` | `dist/sdk/templates/index.{js,d.ts}` |
| `agent-os/runtime/spendguard` | `dist/runtime/spendguard/index.{js,d.ts}` |
| `agent-os/policy/adapters/agt` | `dist/policy/adapters/agt/index.{js,d.ts}` |

(**7 子路徑 + `.` = 8 入口**〔+`./package.json` 共 **9 個 `exports` keys**〕皆有 `index.js`+`index.d.ts`;
build 出 163 個 `.map`、0 test → PKG1 關 source map。root `.` = `src/index.ts` 現有 **29 條 export**,PKG1
**不增不減 root 符號**,只把它對應到 `exports["."]`。)

## 4. 切片

| Slice | 範圍 | 狀態 |
|---|---|---|
| **PKG1** | `package.json`:上表 9 入口的明確 `exports`(`types`+`import`)、`files:["dist","README.md","LICENSE"]`、`"prepack":"pnpm run build"`、`"license":"MIT"`、`@types/node` optional peer;`tsconfig.build` 關 `sourceMap`/`declarationMap`(不打包 163 個 map);`pkg:check`(build-first)測試。**完全釘死、可直接實作。** spec:`PKG1-exports-and-public-surface.md` | ⬜ **READY** |
| **PKG2** | 第三方 tarball 消費煙霧證明(import 每入口 + tsc + 跑一次治理呼叫〔鏡射 reference root 的 allow 規則〕+ 深路徑被擋的 `ERR_PACKAGE_PATH_NOT_EXPORTED`)。 | 📝 **設計草圖**(開工 pin) |
| **PKG3** | `docs/sdk/third-party-integration.md` + `examples/external-consumer/`;修 README/docs 的 factory import 為子路徑(Personal 帶 allow、工具 authoring 走 Developer)。 | 📝 **設計草圖**(開工 pin) |
| **PKG4** | 生產級 WORM 接線的公開 exports(`createIngestAppender`/`createRpcAppendTransport`/`createEntriesReader`/`createPartitionedIngestSink`)。 | 📝 **設計草圖**(MVP 外) |
| **PKG-final** | 翻 `private:false` + `npm publish`(org/scope/2FA/供應鏈)。 | ⛔ gated |

## 5. 驗收(本批 = PKG1)

- `pnpm run build` 後 **8 入口(`.` + 7 子路徑)** 的 `types`/`import` 目標皆存在(已驗);`pkg:check` 由紅轉綠。
- `pnpm run verify`(14-leg)全綠(`deps:check` 不退步;secret-scan 乾淨)。
- `npm pack --json --dry-run` 根目錄 = `dist/**` + `README.md` + `LICENSE` + `package.json`;`dist/**` 內
  **無** `*.map`/`*.test.*`/fixtures/secret/verifier 二進位(且**掃實際產出的 tarball 內容**,非僅 dry-run)。
- 匯入每個公開子路徑無 live-kernel/網路/憑證/檔案副作用。
- doc-first → 失敗測試先紅 → verify 綠 → 獨立對抗式 review → merge。

## 6. 非目標(誠實)

- `npm publish`(=PKG-final,gated);git 依賴(因 `dist/` gitignore,需消費端 `prepare`,列選用);動治理
  核心 / 三面行為 / Hermes Desktop 設施;生產 WORM 接線(=PKG4)。
- in-package README 連到 docs 用**版本化 repo URL**(對應該版,不指向會漂移的 `main`)。
