# ADO-B3 — vendor-neutral MCP bin 路徑

> 父系列:[`INDEX.md`](./INDEX.md)。小重構:給 governed MCP server 一個**不含 `hermes`** 的入口,讓
> 「任何 MCP host」的採用敘事名實相符(adoption 文件的 generic 段不再指向 `…/hermes/…`)。

## 現況(grounded)

- 既有 bin:`src/runtime/brain/adapters/hermes/mcp/exec-mcp-server-bin.ts`(路徑含 `hermes`,歷史位置)。
  已有 shebang;`main()`(line 1113)**只在「自己是 entry」時跑**(`import.meta.url === pathToFileURL(argv[1])`),
  被 import 時不跑(讓 `buildBinDeps` 等可測)。
- `package.json` `bin` 只有 `{ "agentos": "./dist/cli/main.js" }`。

## 設計(最小、低風險)

1. **export 既有 bin 的 `main`**:`async function main()` → `export async function main()`。entry guard **不動**
   → hermes 路徑照舊自跑;test import 照舊不跑 main。
2. **新增 vendor-neutral wrapper** `src/runtime/mcp/server-bin.ts`(shebang + 委派):
   ```ts
   #!/usr/bin/env node
   import { main } from "../runtime/brain/adapters/hermes/mcp/exec-mcp-server-bin.js";
   main().catch((e) => { process.stderr.write(`agent-os-mcp: fatal: ${e}\n`); process.exitCode = 1; });
   ```
   它只當 bin 用(無人 import)→ 直接呼叫 main。spawn 為 entry 時,bin 模組的 guard 看到 entry 是 wrapper
   ≠ bin → 不重複跑;wrapper 再顯式呼叫 main()。**每個 tools/call 仍走 `runGovernedToolCall`(治理不變)。**
3. **`package.json` `bin`** 加 `"agent-os-mcp": "./dist/runtime/mcp/server-bin.js"`(隨 PKG1 的 `files:["dist"]` 打包)。
4. **`docs/adoption.md`**:generic MCP host 範例改用 `node <AGENT_OS_DIR>/dist/runtime/mcp/server-bin.js`;path-debt 註記
   改為「已提供 vendor-neutral 入口」。

## 範圍邊界(不動)

- **不改 `install-hermes-desktop.sh` / 其 helper / e2e**(Hermes-specific、已測、e2e-verified;改其路徑會牽動
  helper 單元測試 + 我無法跑的 e2e)。Hermes 安裝器續用既有路徑;generic 敘事用 neutral 入口——gate 的疑慮
  (generic「any host」指向 hermes 路徑)即解。

## 測試(RED-first)

`src/mcp/server-bin.test.ts`:`pkg.bin["agent-os-mcp"]` = `"./dist/runtime/mcp/server-bin.js"`(**不含 `hermes`**)、
build 後該檔存在且首行為 `#!/usr/bin/env node`。先紅(bin/wrapper 未建)→ 實作轉綠。

## 驗收

- `pnpm run verify`(14-leg)全綠;`pnpm run pkg:pack-check` 仍乾淨(新 bin 進 tarball、有 shebang)。
- neutral bin 存在、有 shebang、`bin` 映射不含 `hermes`;adoption 文件 generic 段用 neutral 路徑。
- 既有行為 byte-identical(export main 不改 guard;Hermes 安裝器未動)。
