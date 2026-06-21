# R4 — CredentialLease lifecycle（設計文件，DRAFT）

> 2026-06-21。本文件是 ITEM **R4 CredentialLease lifecycle** 的設計文件（doc-first）。
> 規劃骨架見 [`../slices/phase-2-remaining/INDEX.md`](../slices/phase-2-remaining/INDEX.md) 第 R4 列；
> 方法論見 [`../standards/looping-engineering.md`](../standards/looping-engineering.md)、slice 規範見
> [`../standards/slice-spec.md`](../standards/slice-spec.md) §6/§10。
> **AGENTS.md 在任何衝突上勝出。only command output is truth。**

> **三大不可插拔壟斷之一（憑證注入）：** Phase 2 已立的鐵律是「**OpenShell `SecretResolver` 是唯一憑證注入點**」
> （見 [`../slices/phase-2/INDEX.md`](../slices/phase-2/INDEX.md) 開頭②）。R4 不重做 SecretResolver，
> 而是在 OS 治理面提供它的**生命週期前緣（lifecycle front）**：把「一個 agent 在某 sandbox 內有權使用哪些
> 憑證、有效到何時、何時被撤銷」變成**可驗的有限狀態機 + 一個 bundleRef-only 的 lease 物件**，再以一個
> 薄注入縫（injection seam）餵給 SecretResolver 的 placeholder 字串。**lease 本身絕不持有 literal secret。**

---

## 1. 什麼 / 為什麼（what / why）

### 1.1 問題

Agent OS 的核心安全不變量之一是 **Credential Non-Leak**：腦（brain）與成本（cost）等治理元件**credential-blind**
（見 §3 grounding：`runtime/brain/credential-guard.ts`、`cost/port.ts:9`），真實 secret 只在 OpenShell egress 的
`SecretResolver` 那一刻物化（materialize）。但目前缺一個**治理面的物件**回答：

- 一個 agent / sandbox **被授予哪些憑證**（by reference，不是 by value）？
- 這份授權 **有效到何時**（expiry）？被誰、何時 **撤銷（revoke）**？
- 從「鑄造（mint）→ 注入（inject 進 sandbox provider-env）→ 使用（use，即 SecretResolver 解析）→ 撤銷/過期」
  的**狀態轉移是否合法**？非法轉移（例如 revoke 後再 use）是否 **fail-closed**？

沒有這個物件，授權散落在「誰把哪個 env var 塞進哪個 sandbox」的隱性約定裡，無法被 `pnpm run verify` 驗，也無法被
WORM kernel audit。R4 把它變成一個**小而強型別的領域物件 + FSM**。

### 1.2 為什麼是 bundleRef-only（lease 絕不持有 secret）

OpenShell 的 `SecretResolver` 已經把「真實 secret」鎖在 egress 代理進程內：sandbox 子環境（child env）只看到
**placeholder 字串** `openshell:resolve:env:<KEY>`（grounding §3.1），真正的值由 resolver 在 HTTP/WebSocket
改寫那一刻才填入，且 `SecretResolver` 連 `Debug` 都被手寫成只印 placeholder 數量、不印值
（`secrets.rs:104-110`）。R4 必須**延續**這個 discipline：

- **lease 攜帶的是 `bundleRef`**（一個指向「某憑證束」的不透明引用，例如 `"anthropic-prod"`），
  **不是** secret，也**不是** placeholder 的真實值。
- lease → SecretResolver 的縫只產生/比對 **placeholder 字串**（`openshell:resolve:env:<KEY>` 或 revision 形式
  `openshell:resolve:env:v<rev>_<KEY>`，grounding §3.2），**永遠不經手 literal secret**。
- 任何試圖把 raw secret 放進 lease 的輸入，必須在 `.strict()` Zod 邊界 **parse-fail（fail-closed）**，
  且 secret-scan 對所有 source/fixture/snapshot 必須乾淨（測試 canary 為 runtime 組裝）。

> 一句話：**R4 管「誰、哪些、到何時」（lifecycle + reference），SecretResolver 管「值是什麼」（materialization）。
> 兩者之間只流動 placeholder 與 bundleRef，永不流動 secret。**

---

## 2. 架構（architecture）

### 2.1 元件與邊界

```
            mint(spec)                inject()                       use()                      revoke()/expire()
  caller ───────────▶ CredentialLease ─────────▶ provider-env map ─────────▶ SecretResolver ───────────▶ (revoked|expired)
 (PDP-gated)   bundleRef-only      ISSUED  (KEY -> placeholder str)  INJECTED  (placeholder->secret)  USED      terminal
                  .strict()                  NO literal secret                 [OpenShell egress]      fail-closed on illegal txn
```

- **`src/credential/` （新 module，OS 治理面，vendor-neutral）** — 唯一責任：定義 `CredentialLease` schema
  與 lease FSM；**不** import 任何 vendor、**不** import audit（事件由 caller append，與 substrate/brain 同模式）。
- **injection seam（薄函式）** — 把一個 INJECTED 且**未過期**的 lease 投影成 **provider-env map**（`{ KEY: placeholder }`），
  其形狀**逐字相容** OpenShell `SecretResolver::from_provider_env*` 的輸出契約（child_env：`KEY -> placeholder`，
  grounding §3.1）。seam **只產生 placeholder 字串**，是 OS 與 OpenShell 的型別化接點，本身不解析 secret。
  seam 與 FSM `use` 同樣**接受時鐘注入並對 `expiresAtMs <= now` fail-closed**（denied），以堵住「lease 已過期但尚未呼叫
  `expire()` 轉態」的視窗（見 §2.2 末段「過期視窗」說明）。
- **SecretResolver（OpenShell，既有，不改）** — 唯一憑證物化點；R4 透過 placeholder 字串與它對齊，不 fork、不 deep-import。

### 2.2 Lease FSM（mint → inject → use → revoke → expire）

狀態與合法轉移（deny-by-default：未列出的轉移一律拒絕、fail-closed）：

```
            mint                inject                 use
  (none) ───────▶ ISSUED ──────────────▶ INJECTED ──────────▶ USED
                    │                        │                   │
                    │ revoke / expire        │ revoke / expire   │ revoke / expire
                    ▼                        ▼                   ▼
                 REVOKED  ◀───────────────────────────────────────  (terminal)
                 EXPIRED  ◀───────────────────────────────────────  (terminal, by clock)
```

- **ISSUED** — 已鑄造，bundleRef 已綁定 AgentContext（actor/tenant/project/task/sandbox）+ `expiresAtMs`；尚未注入。
- **INJECTED** — 已投影為 provider-env placeholder map，交給某 sandbox 的子環境；secret 仍未物化。
- **USED** — SecretResolver 至少解析過一次該 lease 的某 placeholder（標記，供 audit；不改變後續可用性）。
- **REVOKED** / **EXPIRED** — terminal。`REVOKED` 由顯式 revoke；`EXPIRED` 由 clock（`expiresAtMs <= now`）。
- **fail-closed 轉移規則：** 對 terminal lease 再 `inject`/`use` → deny；過期 lease 的 `use` → deny
  （對齊 `SecretResolver::resolve_placeholder` 對 `expires_at_ms <= now_ms()` 回 `None` 的行為，`secrets.rs:222-228`）；
  非法/未知/malformed 轉移 → deny（deny-by-default）。

> **時鐘注入（testability + fail-closed）：** FSM 的 `now()` 以參數注入（與 OpenShell `now_ms()` 對齊概念），
> 測試以固定時鐘逼出 expiry 邊界，不靠 wall-clock。
>
> **過期視窗（expiry window）— 重要不變量：** `EXPIRED` 終態只由顯式 `expire()` 達成，因此一個 lease 可能
> `state==="injected"` 但 `expiresAtMs <= now`（尚未呼叫 `expire()`）。為避免此視窗洩漏授權，**所有「會放行使用」的
> 入口都必須自帶過期檢查、fail-closed**，不得僅依賴 state：(1) FSM `use(lease, now)` 對 `expiresAtMs <= now` → denied；
> (2) injection seam `toProviderEnv(lease, now)` 對 `expiresAtMs <= now` → denied（即使 state 為 injected）。
> 兩處 + OpenShell resolver（`secrets.rs:222-228`）構成三道過期防線，治理面提前擋下，OpenShell 為最後一道。

### 2.3 與既有 P2 槽位的關係

- **brain credential-blind（P2-D）：** 腦只能以 bundleRef 參照憑證（`runtime/brain/credential-guard.ts` 的
  DENY_REASON 明寫「reference credentials by bundleRef only」）。R4 的 lease **正是那個 bundleRef 所指對象**的
  治理化：腦提的 bundleRef → caller 用 R4 lease 解析授權 → injection seam 產 placeholder → SecretResolver 物化。
- **cost credential-blind（P2-G）：** cost gate「NEVER receives a credential」（`cost/port.ts:9`）。R4 不改 cost；
  lease 與 cost 互不經手 secret，正交。
- **substrate（P2-A）：** lease 的 INJECTED 目標是某 `SandboxId` 的 provider-env；R4 **不**改 `SandboxAdapter`，
  只生成可餵給「sandbox 啟動時設定子環境」那一步的 placeholder map（real wiring 屬 R1 live adapter，R4 只定義 seam 契約）。

---

## 3. Grounding（真實 clone 的引用；verified-from-code vs inferred）

> 來源：OpenShell clone `/tmp/openshell`。下列 file:line 為 **verified-from-code**（已實際讀取）。

### 3.1 placeholder 形狀 + child_env 契約（verified）

- `/tmp/openshell/crates/openshell-core/src/secrets.rs:9` — `const PLACEHOLDER_PREFIX: &str = "openshell:resolve:env:";`
- `secrets.rs:483-485` — `placeholder_for_env_key(key) = format!("{PLACEHOLDER_PREFIX}{key}")` →
  `openshell:resolve:env:<KEY>`。
- `secrets.rs:166`（fn 簽名）/ body `179-195` — `from_provider_env_for_revision_with_current_aliases`：對每個 `(key,value)`，
  **child_env 存的是 `key -> placeholder`**（`child_env.insert(key.clone(), placeholder.clone())`，line 188），
  真實 value 只進 resolver 的 `by_placeholder`。**這就是 R4 injection seam 要逐字相容的輸出形狀。**
- `secrets.rs:172-174` — 空 provider_env → 回 `(empty, None)`（無憑證即無 resolver；R4 的「無 lease 即無注入」與此對齊）。

### 3.2 revision 形式 placeholder（verified）

- `secrets.rs:487-493` — `placeholder_for_env_key_for_revision(key, revision)`：`revision==0` → canonical；
  否則 `format!("{PLACEHOLDER_PREFIX}v{revision}_{key}")` →
  `openshell:resolve:env:v<rev>_<KEY>`。R4 的 lease 可選帶 `revision`，seam 據此產 canonical 或 revision 形式。

### 3.3 expiry / fail-closed materialization（verified）

- `secrets.rs:91-95` — `SecretValue { value, expires_at_ms }`：resolver 內部就有 per-secret 過期時戳。
- `secrets.rs:214-240` `resolve_placeholder`：未知 placeholder → `None`；
  `secret.expires_at_ms > 0 && secret.expires_at_ms <= now_ms()` → warn + `None`（line 222-228）；
  解析值含 CR/LF/NUL → `None`（`validate_resolved_secret`，line 501-509）。
  **R4 的 EXPIRED 終態與「過期 use → deny」直接呼應這段；R4 在治理面提前一層擋下，SecretResolver 是最後一道。**
- `secrets.rs:104-110` — `SecretResolver` 手寫 `Debug` 只印 placeholder **數量**、不印 key/value。
  **R4 的 lease 物件同樣不得在任何 Debug/serialize/audit payload 出現 secret（本檔 §4 約束）。**

### 3.4 unresolved → fail-closed（verified）

- `secrets.rs:1108-1122` 測試 `unresolved_provider_shaped_alias_fails_closed`：未知 alias →
  `UnresolvedPlaceholderError`。**R4 的「lease 指向不存在/已撤銷 bundleRef → deny」是同一 fail-closed 哲學的治理面版本。**

### 3.5 OS 側既有可重用件（verified，本 repo）

- `src/iam/ids.ts` — `AgentContext`（actor/tenant/project/task/request/sandbox 之 branded ids）、`SandboxId`、
  `parseAgentContext`（fail-closed parse）。R4 lease **重用** `AgentContext` 綁定授權主體。
- `src/audit/redact.ts:12-20` — `redactSecrets` + `SECRET_KEY`/`SECRET_VALUE` 高訊號偵測。
  R4 的 raw-secret parse-fail 測試**注入** `redactSecrets` 作 secret detector（與 P2-D 同模式），不自寫偵測器。
- `src/runtime/substrate/port.ts:57-78` — `deny()`/`ok()` 的「結果 + auditable event」雙態 + fail-closed-on-bad-ctx
  模式。R4 lease FSM 的轉移結果**沿用同一形狀**（`{status:"ok"|"denied", ..., event}`），不發明新風格。

### 3.6 inferred（尚未 verified-from-code，標示為推論）

- **inferred：** OpenShell 把 `child_env` 實際塞進 sandbox 子進程環境的那一步（sandbox 啟動路徑）在 R1 live
  adapter 才會接線；R4 **只**定義 injection seam 的**輸出契約**（provider-env map 形狀），不假設 OpenShell 內部
  啟動細節。real wiring 與其 file:line 由 R1 補。
- **inferred：** bundleRef → 一組 `KEY` 的映射來源（哪個 bundle 含哪些 env key）在 R4 為**輸入參數**（caller/
  config 提供），不在本 ITEM 落地 bundle registry；R4 只保證「lease 攜帶 bundleRef + 一組宣告的 KEY 名（非值）」。

---

## 4. 重用 vs 新增（reuse vs new）、安全約束

### 4.1 重用（不重造）

| 既有件 | 來源 | R4 如何重用 |
|---|---|---|
| `AgentContext` / `SandboxId` / `parseAgentContext` | `src/iam/ids.ts` | lease 綁定授權主體；fail-closed parse 壞 ctx |
| `redactSecrets`（secret detector） | `src/audit/redact.ts` | raw-secret parse-fail 測試注入它當 detector（不自寫） |
| `deny()/ok()` 雙態結果模式 | `src/runtime/substrate/port.ts` | FSM 轉移結果沿用 `{status, …, event}` 形狀 |
| placeholder 形狀 + child_env 契約 | OpenShell `secrets.rs` | injection seam 逐字相容其輸出（`KEY -> placeholder`） |
| SecretResolver（唯一物化點） | OpenShell `secrets.rs` | R4 不改、不 fork；只經 placeholder 字串對齊 |

### 4.2 新增（this ITEM）

- `src/credential/lease.ts` — `.strict()` `CredentialLease` Zod schema（bundleRef-only）+ 型別。
- `src/credential/fsm.ts` — lease FSM（mint/inject/use/revoke/expire 的合法轉移，deny-by-default）。
- `src/credential/inject.ts` — injection seam：INJECTED lease → provider-env placeholder map。
- `src/credential/index.ts` — barrel（唯一 public surface；core 只經此消費）。

### 4.3 安全約束（不變量，逐 slice 由測試強制）

1. **bundleRef-only / 無 literal secret：** lease schema `.strict()`；任何多餘欄位或 secret-shaped 值 → parse-fail。
2. **deny-by-default + fail-closed：** 未知/非法/terminal/過期轉移一律 deny；malformed ctx → deny（不丟例外致放行）。
3. **credentials 絕不落地：** source/log/artifact/fixture/snapshot/trace 無 secret 字面值；測試 canary runtime 組裝；
   lease 的任何 toString/JSON/audit 投影只含 bundleRef + placeholder 名，**永不含值**。
4. **low coupling：** `credential/` 不 import vendor、不 import audit（detector 注入）、不 deep-import 他模組內部；
   只經 `iam` barrel + zod；依賴方向 inward（adapters → application → domain）、無 cycle。

---

## 5. 能力閘門（honest capability gates）

- **R4 不接真實 OpenShell sandbox 啟動**：injection seam 只交付 provider-env map 契約；真實「把 map 塞進 sandbox
  子環境並讓 SecretResolver 生效」屬 **R1 live OpenShell substrate adapter**（depends-on P2-A）。R4 over fakes 證明形狀正確。
- **R4 不落地 bundle registry**：bundleRef → KEY 名集合的來源是輸入；具名 bundle 的持久化/輪替屬後續 ITEM。
- **R4 不把 lease 事件寫進 WORM kernel**：FSM 產 auditable event（形狀同 substrate），**append 到 kernel** 由 caller/
  R2 ingest client 負責（lease 模組不 import audit）。
- **secret 物化仍唯一在 OpenShell**：R4 永不在 TS 面持有真實 secret；任何「R4 解析了 secret」的假設都是錯的。

---

## 6. Slice 分解（小 slice，DAG 無 cycle）

| Slice | Title | 模組 | Net LOC（估） | Depends-on |
|---|---|---|---|---|
| **P2R-R4-S1** | `.strict()` CredentialLease(bundleRef-only) schema + raw-secret parse-fail | `credential` | ~140 | P2-A（iam/redact 既有） |
| **P2R-R4-S2** | lease FSM：mint→inject→use→revoke→expire（deny-by-default 轉移） | `credential` | ~180 | P2R-R4-S1 |
| **P2R-R4-S3** | SecretResolver injection seam：INJECTED lease → provider-env placeholder map | `credential` | ~120 | P2R-R4-S2 |
| **P2R-R4-S4** | secret 不外洩 adversarial 測試 + secret-scan/redact 整合（無新 src，純測試強化） | `credential`（test-only） | ~90 | P2R-R4-S3 |

### Slice DAG（鄰接表，無 cycle）
```
P2R-R4-S1 -> { P2-A }            # schema 先於 FSM；用既有 iam/ids + audit/redact
P2R-R4-S2 -> { P2R-R4-S1 }       # FSM 消費 S1 的 lease 型別
P2R-R4-S3 -> { P2R-R4-S2 }       # seam 只投影 INJECTED 態 lease
P2R-R4-S4 -> { P2R-R4-S3 }       # 對抗式不外洩測試覆蓋 schema+FSM+seam 全鏈
```
> 無 cycle 證明：rank = 0（P2-A 既有）/ 1（S1）/ 2（S2）/ 3（S3）/ 4（S4）；每條邊嚴格遞減 ⇒ DAG。
> 排序紀律：先 **S1** 鎖 bundleRef-only 邊界（schema 先於消費者），再 **S2** 加合法轉移（deny-by-default），
> **S3** 才產出與 OpenShell 對齊的 placeholder map，最後 **S4** 以對抗式測試把「secret 永不外洩」釘死。
