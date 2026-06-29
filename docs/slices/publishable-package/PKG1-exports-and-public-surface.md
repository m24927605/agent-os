# PKG1 — public surface 契約(完全釘死、可直接實作)

> 父系列:[`INDEX.md`](./INDEX.md)。**只動 `package.json` + `tsconfig.build.json`(+ 必要薄 barrel)**,零
> 執行路徑變更。所有路徑已用實際 `pnpm run build` 驗證(見 INDEX §3)。

## A. `package.json` 變更(精確)

```jsonc
"license": "MIT",
"files": ["dist", "README.md", "LICENSE"],
"scripts": { "prepack": "pnpm run build", "pkg:check": "pnpm run build && vitest run src/__tests__/package-exports.test.ts" },
"peerDependencies": { "@types/node": ">=22" },
"peerDependenciesMeta": { "@types/node": { "optional": true } },
"exports": {
  ".":                      { "types": "./dist/index.d.ts",                     "import": "./dist/index.js" },
  "./personal":             { "types": "./dist/personal/index.d.ts",            "import": "./dist/personal/index.js" },
  "./developer":            { "types": "./dist/developer/index.d.ts",           "import": "./dist/developer/index.js" },
  "./enterprise":           { "types": "./dist/enterprise/index.d.ts",          "import": "./dist/enterprise/index.js" },
  "./tools":                { "types": "./dist/tools/index.d.ts",               "import": "./dist/tools/index.js" },
  "./sdk/templates":        { "types": "./dist/sdk/templates/index.d.ts",       "import": "./dist/sdk/templates/index.js" },
  "./runtime/spendguard":   { "types": "./dist/runtime/spendguard/index.d.ts",  "import": "./dist/runtime/spendguard/index.js" },
  "./policy/adapters/agt":  { "types": "./dist/policy/adapters/agt/index.d.ts", "import": "./dist/policy/adapters/agt/index.js" },
  "./package.json": "./package.json"
}
```

- **`private` 維持 `true`**(PKG1 不翻;見 INDEX §1)。保留頂層 `main`/`types` 作舊解析器後備;`exports` 為權威。
- 純 ESM:**只給 `types`+`import`,無 `require`/`default`-CJS**。`types` 必須排每條件最前。
- 明確 allowlist、**無 `./*`**:`runtime/brain/adapters/hermes` 等內部模組不在 `exports`(PKG2 負向證)。
- `@types/node` 為 **optional peer**(缺只影響型別,不影響 runtime;見上 `peerDependenciesMeta`),且續留 `devDependencies`。
- **計數(釘死)**:`.` + **7 子路徑** = **8 入口**;加 `./package.json` = **9 個 `exports` keys**。
- **root `.` 不變**:`src/index.ts` 現有 **29 條 export**(28× neutral `export *` + 1 named);PKG1 **不增不減**
  這組符號,只把它對應到 `exports["."]`(避免意外隱藏/暴露)。
- **前置:確認 `LICENSE` 存在**——已存在(MIT License),`license:"MIT"` 與之相符;PKG1 不需新建。

## B. `tsconfig.build.json` 變更

設 `"sourceMap": false` + `"declarationMap": false`(現況 build 出 **163 個 `.map`**;不打包進套件)。確認
build 仍**排除** `*.test.ts`/`__tests__`(實測 dist 內 0 test,維持)。

## C. barrel(已驗證,無需補)

INDEX §3 已實測 8/8 子路徑 + `.` 皆有 `index.js`+`index.d.ts` → **不需新增 barrel**。

## D. 測試 `src/__tests__/package-exports.test.ts`(RED-first,經 `pkg:check` 先 build)

**PKG1 測試範圍(釘死):** 只證(1) exports 目標存在、(2) import 無副作用、(3) 文件 ⊆ exports、(4) tarball
內容(§E)。**「從外部安裝的消費者解析 / 深路徑被 `exports` 擋 / `tsc` 型別」屬 PKG2**,PKG1 **不**涵蓋
(因需 throwaway 外部專案)。`pkg:check = "pnpm run build && vitest run src/__tests__/package-exports.test.ts"`。

1. **exports 目標存在**:讀 `package.json.exports`(8 入口的 `types`+`import` + `./package.json`),對每個目標
   `fs.existsSync`(build 後)→ 全存在。先紅(現況無 `exports`)。
2. **import 無副作用**(具體測法):對**每個**公開子路徑,`child_process.execFileSync(process.execPath,
   ["--input-type=module","-e", "await import('<repo>/dist/<p>/index.js')"], {env, timeout})`,並在探針內
   **預先 monkeypatch/攔截**:`node:net`/`node:tls`(`createConnection`/`connect`)、`node:dgram`、
   `node:child_process`(`spawn`/`exec`)、`node:fs` 的寫入(`writeFile*`/`open` 寫模式)→ 匯入期間**任一被呼叫
   即 fail**;**允許**讀自身 package 中繼資料/dist 唯讀。斷言每個入口匯入成功(exit 0)且零攔截命中。涵蓋
   **static `import`**(探針用 top-level `import`,非僅 dynamic)。
3. **`deps:check` 不退步**:`pnpm run deps:check`(dependency-cruiser;verify 第 5 leg)綠,不引新非法邊。
4. **文件 ⊆ exports**:grep `from "agent-os/…"`(docs+README+CONTRIBUTING)集合 ⊆ `exports` keys。

## E. tarball 內容(掃**實際產出**,非僅 dry-run)

確切命令序列:`pnpm run build` → `npm pack --json`(產 `agent-os-0.0.0.tgz`)→ `tar -tf agent-os-0.0.0.tgz`
列**實際**內容 → 斷言 → `rm agent-os-0.0.0.tgz`(自清)。斷言:
- 頂層成員 = `package/dist/**` + `package/README.md` + `package/LICENSE` + `package/package.json`(npm 必含
  `package.json`),**別無其他頂層項**;
- **deny globs(任一命中即 fail)**:`**/*.map`、`**/*.test.*`、`**/__tests__/**`、`**/*fixture*`、
  `**/.env*`、`**/*.pem`、`**/*.key`、verifier 產物(`**/verifier`、`**/*.wasm`)。
- 另跑 `secret-scan` 不得有命中(`secret-scan`/`secrets` 等**檔名字串**不算 secret,只看內容樣式)。

## 不變量

零執行路徑變更(只加 `exports`/`files`/`prepack`/`license`/peer + 關 map)。既有單元/契約/e2e 全綠不變;
`deps:check` 綠;secret-scan 乾淨。

## 驗收

- `pkg:check` 由紅轉綠;`pnpm run verify`(14-leg)全綠。
- 9 入口 `types`/`import` 目標皆存在(已驗);匯入無副作用。
- 實際 tarball 內容符合 §E;無 map/test/fixture/secret。
- 既有測試數僅因**新增** `package-exports.test.ts` 而增,無行為性變動。
