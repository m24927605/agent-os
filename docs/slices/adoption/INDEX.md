# Slices: adoption surfaces — 三條導入路徑(全支援)

> **目標:** 支援三種市場情況的導入。**docs-first**:本系列先把三條路徑、現況、子切片釘清楚;每片各自
> 開工時再過 gate。**教訓沿用**(publishable-package gate 連退 5 次):只把「現在能做」的第一片釘死,
> 重的(turnkey)標為 **deployment-gated / 設計草圖**,不假裝 ready。

## 0. 三條路徑(對應使用者情況)

| 路徑 | 使用者情況 | 形態 | 現況 |
|---|---|---|---|
| **A · Turnkey** | 還沒用任何 AI agent,要完整方案 | **一鍵可執行**,綁 brain+body+kernel | 🔶 重;部分 **deployment-gated** |
| **B · Hermes 整合** | 已用 Hermes(Desktop/TUI),要低干擾接入 | **MCP server + 一條 config** | ✅ **已建 + live 驗證** |
| **C · 其他大腦** | 不用 Hermes,大腦是別的框架 | 淺層=任何 MCP host;深層=library 嵌入 | ✅淺層近免費 / 🔶深層=npm 系列 |

### 術語(給寫 user-facing 文件的人)

**brain** = 提議動作的 AI agent(預設 Hermes,可換)· **body** = effect 實跑的 sandbox(OpenShell)·
**kernel** = 獨立簽署證據的 Go WORM 行程(attester)· **WORM** = append-only、防竄改的證據鏈 ·
**MCP host** = 能 spawn/呼叫 MCP server 的 agent/客戶端(Hermes、Claude Desktop、Cursor…)·
**淺層整合** = host 指向 Agent OS 的治理 MCP server(只加 config)· **深層整合** = 把 Agent OS 當 library
嵌入、寫自訂 Brain/composition root。

## 1. 關鍵架構槓桿(先講,因為它決定切片怎麼切)

Agent OS 把治理工具暴露成一個 **standard MCP stdio server**
(`dist/runtime/brain/adapters/hermes/mcp/exec-mcp-server-bin.js`,deny-by-default 廣告 exec/action/browser
家族)。**Hermes 只是「一個 MCP host」。** 因此:

- **B(Hermes)與 C 的「淺層」(支援 MCP 的大腦,如 Claude Desktop / Cursor / 自寫 MCP client)是
  *同一個機制*** —— 指向同一支 MCP server bin + 一段 config。**一個 artifact 服務「我已經有 agent」的整個
  市場。** moat(attester≠actor WORM、brain-agnostic 治理)本就跟「誰是大腦」無關。**支援/驗證狀態見 §1b
  矩陣:目前只 Hermes Desktop 已驗證,其餘為文件範例(未驗證);bin 路徑現含 `hermes`(路徑債,§1b)。**
- 只有 **C 的「深層」**(框架不支援 MCP、或要進 propose→execute 閉環、或要把 Agent OS 當 library 嵌入)
  才需要 Brain adapter / composition root → 即 **publishable-package(PKG)** 系列。

### 1b. Status legend / host 支援矩陣 / 路徑債 / escalation(iteration-1 fix)

**Status legend:** ✅ = 已實作/已驗證可用 · ⬜ READY = 已釘死、可實作 · 📝 草圖 = 方向定、開工再 pin ·
🔶 / deployment-gated = 重且部分被部署設施擋住 · ⛔ gated = 部署決定。

**MCP host 支援矩陣(誠實,不宣稱「任何 host 都已驗證」):**

| Host | config 位置 / 格式 | transport | 啟動 | 狀態 |
|---|---|---|---|---|
| Hermes Desktop | `~/.hermes/config.yaml` `mcp_servers` | stdio | `hermes mcp add` 或直寫 | ✅ **已驗證**(`e2e:live-desktop-hermes`) |
| Hermes TUI | 同 `config.yaml` `mcp_servers`(與 CLI/Desktop 共用) | stdio | 共用 | ✅ **發現層已驗(live `hermes mcp test`)**(ADO-B2) |
| Claude Desktop / Cursor / 通用 MCP client | 各 host 自有(範本) | stdio | `node …/exec-mcp-server-bin.js` | 📝 **文件範例、未驗證**(社群/best-effort) |

→ **ADO-B1 必須以此矩陣呈現**:**只有 Hermes Desktop 標「已驗證」**;其餘標「範例/未驗證」,並列各 host 的
config 位置/格式/transport/啟動命令/OS 假設/驗證方式。

**路徑債(vendor-named path):** MCP bin 目前在
`dist/runtime/brain/adapters/hermes/mcp/exec-mcp-server-bin.js`(路徑含 `hermes`,歷史位置),但 **bin 本身
是 host-agnostic 的 standard MCP stdio server**。**follow-up(ADO-B3,草圖):** 提供 **vendor-neutral 的
bin 別名/路徑**(如 `agent-os-mcp` 或 `dist/mcp/...`)供採用文件引用,讓「任何 MCP host」名實相符;在那之前
ADO-B1 文件**明標此路徑為現況、會搬**。

**Scope / escalation(防 ADO-B1 偷吃實作):**
- ADO-B1 = **純文件**。若 **Hermes TUI** 的 config 與 Desktop 不同 → 不在 ADO-B1 解,丟 **ADO-B2**。
- 若某通用 MCP host **需要的不只一段 config**(要改 bin/transport)→ 不在 ADO-B1 解,開 follow-up 切片。
- 文件中的 config/指令 **不得手寫致與真實 script 漂移**:B 段 Hermes config 必須**對齊
  `install-hermes-desktop.sh` 的純 helper 輸出**(機械可檢)。

## 2. 路徑 A — Turnkey 一鍵可執行(#1)

**目標:** 沒有 agent 的人下載一個東西、一鍵跑起來,就得到「會照意圖自己操作的電腦」。

**現況(誠實):** 體驗面**目前是 Hermes Desktop**;真正的一鍵需把 **brain(預設)+ body(OpenShell
sandbox)+ WORM kernel(獨立 Go 行程)** 編排/打包成單一可跑物,並解掉 **deploy-gated** 項目(零憑證、
無 egress 的 sandbox provisioning;operator-unforgeable trust root)。**這是最大 TAM、也是最重、且部分被
部署設施擋住的路。**

| 子切片 | 範圍 | 狀態 |
|---|---|---|
| **ADO-A1**(turnkey bundle 規格) | 定義一鍵物要編排什麼(brain 預設 + sandbox 自備 + kernel 自起 + MCP wiring)、打包形態(單檔/Electron/容器)、首啟體驗(intent→approve→effect→timeline)、哪些是 deploy-gated。 | 📝 **設計草圖**(部分 deployment-gated) |

## 3. 路徑 B — Hermes 整合(#2)+ 淺層 C

**目標:** 既有 Hermes(Desktop/TUI)使用者**加一條 config** 就被治理。**已建:** `install-hermes-desktop.sh`
(把 MCP bin 註冊進 `~/.hermes/config.yaml` 的 `mcp_servers`;TTY 走 `hermes mcp add`,headless 印出
credential-blind config 直寫)+ `pnpm run e2e:live-desktop-hermes`(真 desktop Hermes 經 config/ACP 驅動,
GREEN)。

| 子切片 | 範圍 | 狀態 |
|---|---|---|
| **ADO-B1**(統一「導入 Agent OS」文件) | 一份 user-facing 文件,涵蓋三條路徑的**導入步驟**;B 段把現有 install 腳本步驟文件化,並**泛化成「任何 MCP host」**(不只 Hermes:給 Claude Desktop/Cursor/通用 MCP client 的 config 範本)。這就是本系列的 **docs-first 第一交付**。spec:`ADOPT1-adoption-guide.md` | ⬜ **READY**(純文件) |
| **ADO-B2**(Hermes 接入確認) | 確認 Hermes 的 MCP 接入(CLI/TUI/Desktop 共用 `config.yaml` `mcp_servers`)。 | ✅ **發現層已驗(live)** — 真 Hermes v0.17.0 `hermes mcp test agentos-exec` 連上(299ms)+ 發現全 16 治理工具;TUI 共用同份 config。**真實 effect 待 infra(OpenShell+kernel)**。 |

## 4. 路徑 C — 其他大腦(#3)

- **淺層(任何 MCP host):** 由 §1 槓桿,**B 的同一支 MCP server + 通用 config 範本**即服務之 → 併入
  **ADO-B1**(文件泛化成「任何 MCP 大腦」)。
- **深層(library 嵌入 / 自訂 Brain adapter):** = **publishable-package(PKG1–4)** 系列
  ([`../publishable-package/INDEX.md`](../publishable-package/INDEX.md))。PKG1(exports 契約)已釘死可實作;
  PKG2/3/4 草圖。**本系列把 PKG 納為 C-深層的實作載體,不重複定義。** **ADO-B1 與 PKG1 的介面邊界:** adoption 文件的
library 段**只連出**到 composition-root/PKG 文件,**不得**放需要 PKG1 未實作 exports / 未發佈 npm 的範例
(文件不得超前 PKG1)。

## 5. 優先序(都做,但有序)

1. **ADO-B1**(統一導入文件,含 B + 淺層 C 的「任何 MCP host」泛化)—— 純文件、零風險、ROI 最高、修掉
   現有文件對不上的 import 範例。**先做。**
2. **PKG1**(C-深層的 exports 契約)—— 小、低風險,讓「library 嵌入」範例變真。
3. **ADO-B2**(Hermes TUI 確認)。
4. **ADO-A1**(turnkey 規格)→ 隨 deploy-gated 項目推進。

## 6. 非目標 / 誠實

- 不在本系列重定義 PKG(C-深層)細節;不 `npm publish`(PKG-final,gated)。
- A 的一鍵物**部分被部署設施擋住**(sandbox provisioning / trust root),不假裝其已 ready。
- 不動治理核心 / 三面行為。
