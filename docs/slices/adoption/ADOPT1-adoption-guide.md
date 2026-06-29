# ADOPT1 — 統一「導入 Agent OS」文件(docs-first 第一交付)

> 父系列:[`INDEX.md`](./INDEX.md)。**純文件、零程式變更。** 一份 user-facing 指南,讓三種使用者各自找到
> 自己的導入路徑;並把現有對不上的 import 範例修對。

## 交付物

新增 `docs/adoption.md`(README「Documentation」索引指向它)。結構 = 「**你是哪一種?→ 照做**」:

### 1. 你還沒有 AI agent,想要完整方案(路徑 A · Turnkey)
- 一句定位 + **誠實狀態**:目前的「自帶體驗」入口是 **Hermes Desktop**(路徑 B);完整一鍵 turnkey
  打包尚在進行(部分 deploy-gated:sandbox provisioning、trust root,見 `docs/slices/adoption` ADO-A1)。
- **今天能做的最接近**:`pnpm run example:personal`(in-memory 看治理 intent 流)+ 路徑 B 接 Hermes。
- 連到 [Personal Quickstart](./personal-quickstart.md)。

### 2. 你已在用 Hermes(Desktop/TUI)— 或任何支援 MCP 的 agent(路徑 B + 淺層 C)
**核心訊息:Agent OS 的治理工具是一支 standard MCP server,任何 MCP host 都能掛上。**
- **Hermes Desktop**(grounded 自 `scripts/install-hermes-desktop.sh`):
  1. `pnpm install && pnpm run build`(MCP bin 必須存在)。
  2. (選用)`export AGENTOS_OPENSHELL_ENDPOINT / AGENTOS_OPENSHELL_MTLS / AGENTOS_KERNEL_INGEST_ENDPOINT`
     (非 secret;helper 對 secret-shaped 值 throw)。
  3. `bash scripts/install-hermes-desktop.sh` —— TTY 走 `hermes mcp add`(答一次 Enable all);headless 印出
     credential-blind `config.yaml` 內容直寫 `~/.hermes/config.yaml` 的 `mcp_servers`。
  4. Hermes `tools/list` 自動發現 → 呼叫即經 `runGovernedToolCall` → OpenShell 執行 → 進 WORM。
  5. 驗:`pnpm run e2e:live-desktop-hermes`。
- **任何其他 MCP host(Claude Desktop / Cursor / 自寫 client)— 淺層 C**:給一段**通用 config 範本**——
  以 stdio 啟動同一支 bin(`node dist/runtime/brain/adapters/hermes/mcp/exec-mcp-server-bin.js`,帶同樣的
  非 secret env),掛進該 host 的 MCP servers 設定即可。**機制與 Hermes 相同,只是換 host。**

### 3. 你要把 Agent OS 當 library 嵌入自己的程式(深層 C)
- 連到 [Composition Root Guide](./sdk/composition-root-guide.md) + [Third-Party Integration](./sdk/third-party-integration.md)(後者由 PKG3 產出)。
- **誠實**:目前**未發佈 npm**;以 **tarball / pnpm workspace** 導入;factory 從**子路徑**匯入
  (`createPersonalShell` ← `agent-os/personal`,工具 authoring 走 `agent-os/developer`)。

## 修正(correctness,本片一併做)
- README/docs 任何 `import { createPersonalShell } from "agent-os"`(root)→ 改 `"agent-os/personal"`;掃所有
  docs 把 factory import 改到正確子路徑(與 publishable-package 一致)。
- 若某子路徑導入在「未加 exports map 前」其實不解析,文件需註明「**目前以 source/tarball 方式 + build 後**」
  使用,別暗示 `npm install agent-os` 可用(待 PKG-final)。

## 安全約束(所有 config/指令範例必守)
- **零 raw secret**:YAML/指令 argv/截圖/log 內**不得**出現真實憑證;只示範**非 secret**(bin 路徑、
  host:port endpoints、mTLS 目錄路徑)。對齊 `install-hermes-desktop.sh` 的純 helper(對 secret-shaped 值
  會 throw)。
- **真實憑證來源**:由 sandbox 端(零憑證、無 egress provisioning)/ egress 解析,**不寫進 config.yaml /
  shell history**。
- **檔案權限**:`~/.hermes/config.yaml` 建議 `600`;文件提醒。
- **fail-closed**:缺 build / 缺 endpoint / config malformed → **明確報錯**,不靜默退成無治理。

## host 支援矩陣(文件必含,對齊 INDEX §1b)
只有 **Hermes Desktop 標「已驗證」**(`e2e:live-desktop-hermes`);**Hermes TUI / Claude Desktop / Cursor /
通用 MCP client 標「範例、未驗證」**,各列 config 位置/格式/transport/啟動命令/OS 假設/驗證方式。

## 安全契約 — 非 Hermes host 同樣成立的保證(critical,文件必明寫)
**四不變量由「治理 MCP server」server-side 強制,與「誰是 MCP host」無關**:任何 host 只是**呼叫**這支
server,**無法繞過** `runGovernedToolCall`。對任何 MCP host 都成立:
- **deny-by-default**(未知/格式錯/出錯 → 拒);**credential-blind**(host/agent 只見 placeholder,真憑證在
  egress 解析);**commit-before-effect**(WORM 封存後才執行);**attester≠actor**(獨立 kernel 簽)。
- **approval**:閘在 server 端——`requiresApproval` 的工具若無 approver 即 `denied@approval`(與 host 無關)。

**「未驗證」的精確意義(避免 overclaim):** 對非 Hermes host,**「未驗證」= 該 host 的 *config 接線/發現
流程* 尚未實測**,**不是**安全性較弱。文件**不可**把未測 host 寫成「已支援整合」,但**可**正確聲明
「安全由 server 端保證、與 host 無關」。最小 MCP 假設(文件列出):**stdio transport、Node 可用、路徑含空格
需引號、env 傳遞、工作目錄、OS 支援、MCP 協定版本**。

## 邊界要涵蓋(文件需有 troubleshooting)
缺 `pnpm run build` / 缺 `pnpm install` / bin 路徑過期 / 多份 Hermes config / MCP server 名稱衝突
(`agentos-exec`)/ 不支援的 OS·shell / headless vs TTY / 寫檔權限失敗 / 解除安裝(`hermes mcp remove`)/
MCP server 與 host config 的版本相容。

## 機械檢查(避免文件與真實 script 漂移)
- B 段 Hermes 的 `config.yaml` 範例**不得手寫**致與 `renderHermesMcpServersConfigYaml`(install script 的純
  helper)輸出不一致——文件需註明「以 `bash scripts/install-hermes-desktop.sh` 實際印出者為準」,或在 CI
  以一個檢查比對文件片段 ⊆ 該 helper 輸出。
- bin 路徑現為 `dist/runtime/brain/adapters/hermes/mcp/exec-mcp-server-bin.js`(路徑債,INDEX §1b),文件
  **明標會搬**。

## 驗收 checklist(精確、可機械檢)
**檔案變更:** 只新增 `docs/adoption.md` + 改 `README.md`(Documentation 索引加一條);零程式。
**`docs/adoption.md` 必含區段:**
1. 三條路徑導覽(A/B/C「你是哪一種?」)。
2. host 支援矩陣(對齊 INDEX §1b:**只 Hermes Desktop 標已驗證**,其餘「範例、未驗證」+ config 位置/格式/
   transport/啟動/OS/驗證欄)。
3. **安全契約**(上節:四不變量 server-side、與 host 無關;「未驗證=接線未測,非安全較弱」)。
4. B 段 Hermes Desktop 步驟(對齊 `install-hermes-desktop.sh`)+ 通用 MCP host config 範本(標未驗證)。
5. C-深層**只連出**到 `composition-root-guide.md` / `third-party-integration.md`;**不得**放需要未實作/未發佈
   exports 的 library 範例(與 PKG1 的邊界)。
6. 安全約束、邊界 troubleshooting。

**驗證命令(完成證明):**
- `pnpm run verify` 不受影響(secret-scan 只掃 `src/scripts/.githooks`)。
- **install-script parity**:`bash scripts/install-hermes-desktop.sh`(headless,印 config)→ 文件的 Hermes
  config 片段**不得**手寫致與其輸出/純 helper `renderHermesMcpServersConfigYaml` 漂移;文件註明「以該 script
  實際輸出為準」。(可選 CI:一個測試呼叫該純 helper,斷言文件 fenced block ⊆ 其輸出。)
- **link 驗證**:`docs/adoption.md` 所有相對連結指向存在的檔。
- 所有 `agent-os` factory import 範例用正確**子路徑**;**不宣稱 `npm install agent-os` 可用**(待 PKG-final)。

**Stage gate:** 文件完成後對 `docs/adoption.md` 跑 `codex-review.sh final`(或 doc-stage gate)。

**邊界(防偷吃實作):** 本片**不**碰 ADO-B2(TUI)/ 通用 host 的程式工作——遇到照 INDEX §1b escalation
開新切片。
