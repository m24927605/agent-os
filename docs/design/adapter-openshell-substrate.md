# 設計：live OpenShell substrate adapter（ITEM R1）

> **狀態：DRAFT（doc-first，未實作）。** 本文件是 ITEM **R1** 的設計骨架，依
> [`looping-engineering.md`](../standards/looping-engineering.md)（doc-first、小 slice、RED 先行、
> Independent Verifier Pass = 獨立 Opus 4.8 reviewer、5 回合上限→Staff+ 升級）撰寫；slice 拆分受
> [`slice-spec.md`](../standards/slice-spec.md) §3 size budget 約束。
> 權威架構：[`three-surface-architecture.md`](./three-surface-architecture.md)、
> [`five-piece-integration.md`](./five-piece-integration.md)；要實作的 port 契約見
> [`../slices/phase-2/P2-A-vendor-neutral-substrate-port-contract.md`](../slices/phase-2/P2-A-vendor-neutral-substrate-port-contract.md)。
> **AGENTS.md 在任何衝突上勝出。only command output is truth。**

---

## 0. 一句話

把已 DONE 的 vendor-neutral **`SandboxAdapter` port**（P2-A，`src/runtime/substrate/port.ts`）接上**真實
OpenShell gateway**：在 `src/runtime/openshell/` 新增一個 **connect-node gRPC client** adapter，**pinned proto +
pinned image digest**，**不 fork OpenShell**（Strategy B），並讓它通過 P2-A 已存在的共享 contract harness
（Null/Fake 已過）。**credential 永不落地**——provider-env 只以 OpenShell 自己的 placeholder 形態經手，真值由
OpenShell `SecretResolver` 在 egress 才注入。

---

## 1. 為什麼（What / Why）

P2-A 已把「身體」（ExecutionSubstrate）做成可驗的可插拔槽位：port 路徑無 vendor 名、≥2 impl
（`NullSandboxAdapter` 失敗封閉 + `FakeSandboxAdapter` 記憶體）過同一 contract（P2-A §1、
`src/runtime/substrate/{port,null,fake}.ts`）。但目前**沒有任何 adapter 真的連到 OpenShell**——
`five-piece-integration.md:40` 明列 ExecutionSubstrate 現況「只有 NullSandboxAdapter」，真 OpenShell client
標記為「P2，不阻塞」。R1 就是補上這個真實 adapter，讓 Personal beachhead 的骨架第一次連到真實世界
（INDEX.md §47「先 R2/R1 把骨架接上真實世界，最高 de-risk 價值」）。

**Strategy B（no fork）的理由**（MEMORY：Strategy B on OpenShell）：Agent OS 是 OpenShell **之上**的治理層，
不 fork。我們只**消費** OpenShell 的 public gRPC API（`openshell.proto` 的 `OpenShell` service），透過
connect-node client 連到一個已部署的 OpenShell gateway。proto 與 boot image 都 **pinned**（見 §5），確保
adapter 對著一個固定、可重現的後端契約編譯與測試。

---

## 2. Grounding（真實 clone，verified vs inferred）

> clone：`/tmp/openshell`（commit 對應 proto `openshell.v1`）。以下 file:line 皆已親自讀過。

### 2.1 我們要消費的 RPC（VERIFIED — 直接讀 proto service block）

`/tmp/openshell/proto/openshell.proto` `service OpenShell { … }`：

| RPC | proto:line | 形態 | R1 用途 |
|---|---|---|---|
| `Health(HealthRequest) → HealthResponse` | openshell.proto:22 | unary | client 連線健檢（S1） |
| `CreateSandbox(CreateSandboxRequest) → SandboxResponse` | openshell.proto:25 | unary | `createSandbox`（S2） |
| `GetSandbox(GetSandboxRequest) → SandboxResponse` | openshell.proto:28 | unary | readiness 探測（S3） |
| `ListSandboxes(ListSandboxesRequest) → ListSandboxesResponse` | openshell.proto:31 | unary | （out-of-scope，列入 §6） |
| `DeleteSandbox(DeleteSandboxRequest) → DeleteSandboxResponse` | openshell.proto:46 | unary | `destroySandbox`（S2 收尾，見下） |
| `ExecSandbox(ExecSandboxRequest) → stream ExecSandboxEvent` | openshell.proto:67 | **server-stream** | sandbox 內執行命令（S4） |
| `GetSandboxProviderEnvironment(…Request) → …Response` | openshell.proto:153 | unary | provider-env placeholder 取得（S5） |
| `ConnectSupervisor(stream …) → stream …` | openshell.proto:169 | **bidi-stream** | supervisor relay（out-of-scope，§6） |
| `WatchSandbox(WatchSandboxRequest) → stream SandboxStreamEvent` | openshell.proto:190 | **server-stream** | readiness watch（S3 替代/補強） |

### 2.2 訊息形狀（VERIFIED）

- `CreateSandboxRequest{ SandboxSpec spec=1; string name=2; map<string,string> labels=3 }`
  （openshell.proto:427-433）。`SandboxSpec.template.image`（openshell.proto:333-335）= **pinned image digest** 注入點。
- `SandboxResponse{ Sandbox sandbox=1 }`（openshell.proto:488-490）；`Sandbox{ ObjectMeta metadata=1;
  SandboxSpec spec=2; SandboxStatus status=3 }`（openshell.proto:296-306）。
- **lookup key = name/id（不是我們的 SandboxId）**：`GetSandboxRequest{ string name=1 }`（openshell.proto:436-439），
  `WatchSandboxRequest{ string id=1; … bool stop_on_terminal=7 }`（openshell.proto:761-792），
  `ExecSandboxRequest{ string sandbox_id=1; repeated string command=2; … }`（openshell.proto:645-672），
  `DeleteSandboxRequest{ string name=1 }`（openshell.proto:482-485）。
  → adapter 必須**維護 OpenShell name ↔ 我方 `SandboxId` 的對映**（見 §3.3）。
- **readiness = `SandboxStatus.phase`（`SandboxPhase` enum）**：
  `SANDBOX_PHASE_READY=2`、`SANDBOX_PHASE_ERROR=3`、`PROVISIONING=1`、`DELETING=4`、`UNKNOWN=5`、`UNSPECIFIED=0`
  （openshell.proto:401-408）；`SandboxStatus.phase=6`（openshell.proto:378）。
- `ExecSandboxEvent{ oneof payload { ExecSandboxStdout stdout=1; ExecSandboxStderr stderr=2;
  ExecSandboxExit exit=3 } }`（openshell.proto:690-696）；`ExecSandboxExit{ int32 exit_code=1 }`（openshell.proto:685-687）。
- `GetSandboxProviderEnvironmentResponse{ map<string,string> environment=1; uint64 provider_env_revision=2;
  map<string,int64> credential_expires_at_ms=3; map<string,ProviderProfileCredential> dynamic_credentials=4 }`
  （openshell.proto:1141-1152）。

### 2.3 credential chokepoint（VERIFIED — 這是護城河約束的根據）

`/tmp/openshell/crates/openshell-core/src/secrets.rs`（2049 行）`pub struct SecretResolver`（secrets.rs:87）
持有 `by_placeholder: HashMap<String, SecretValue>`（secrets.rs:88），並**刻意自訂 `Debug` 只印 placeholder
數量、不印任何 secret**（secrets.rs:104-110）；`resolve_placeholder(&self, value)`（secrets.rs:214）才把 placeholder
換成真值。`from_provider_env*`（secrets.rs:114/120/133）把 provider-env 的真值換成 placeholder 後才放進 child env
（secrets.rs:177-195：`child_env.insert(key, placeholder)`）。

**推論（架構約束，INFERRED from secrets.rs + five-piece-integration.md:8,29）：** OpenShell 的
`GetSandboxProviderEnvironment.environment` 對外**只應含 placeholder**，真值由 `SecretResolver` 在 egress 注入。
placeholder 的**確切 grammar 由 `placeholder_for_env_key_for_revision` 決定**（secrets.rs:487-493，VERIFIED 讀過）：
共同前綴常數 `PLACEHOLDER_PREFIX = "openshell:resolve:env:"`（secrets.rs:9），其後依 revision 分兩形：
**revision==0 → `openshell:resolve:env:<KEY>`（無 `v0_`）**；**revision!=0 → `openshell:resolve:env:v<rev>_<KEY>`**
（`five-piece-integration.md:29` 只列了後者，是不完整的——R1 的 guard 必須兩形皆接受，**錨在共同前綴
`openshell:resolve:env:`**，否則會把合法的 revision-0 placeholder 誤拒，雖 fail-closed 但會打斷 happy path）。
→ R1 的 provider-env adapter **只搬運 placeholder-bearing env，絕不嘗試解析/還原真值**；若某 value 帶
reserved credential marker 卻無法當 placeholder 看待（見 secrets.rs:30 `contains_reserved_credential_marker`），
**fail-closed** 拒絕回傳（S5）。

> **誠實揭露：** 「對外 env 一定不含真值」屬 INFERRED——它來自 secrets.rs 的設計
> 意圖與 five-piece doc，不是 proto 的硬契約（proto 只說 `map<string,string> environment`）。
> placeholder 的**前綴 grammar 則是 VERIFIED**（secrets.rs:9/487-493，見上），guard 應錨此前綴而非任一 revision 形。
> 因此 S5 把它做成 **fail-closed shape guard**（任何看似 raw secret 的 value → deny），而非信任後端。

### 2.4 我方既有資產（VERIFIED — 直接讀 src）

- `SandboxAdapter` 介面：`createSandbox/startSandbox/stopSandbox/destroySandbox(ctx, …): Promise<AdapterResult>`
  （`src/runtime/substrate/port.ts:46-51`）。
- `AdapterResult = {status:"ok"; sandboxId; event} | {status:"denied"; reason; event}`（port.ts:42-44）；
  `deny()`（port.ts:57）對壞 ctx 也 fail-closed、`ok()`（port.ts:68）。
- 共享 contract harness：`src/test-contracts/sandbox-adapter.test.ts`（P2-A §5；`describe.each([Null, Fake])`）—
  R1 的 OpenShell adapter 要被加進這個 factory list 並過同一套 contract（S6）。
- boundary 規則：`.dependency-cruiser.cjs` `no-vendor-in-core`（第 49-69 行）把 `runtime/openshell/` 列為**合法
  vendor adapter 位置**（`src/runtime/<vendor>/`，第 55 行註解），core 模組 import `openshell` token 會 fail。

---

## 3. 架構

### 3.1 元件圖（向內、無 cycle）

```
                         (P2-A, DONE — 不改)
                   src/runtime/substrate/port.ts
                   SandboxAdapter / AdapterResult / deny()/ok()
                              ▲  (implements / imports barrel)
                              │
   ┌──────────────────────────────────────────────────────┐
   │  src/runtime/openshell/   (NEW — 本 ITEM，vendor adapter) │
   │                                                        │
   │  client.ts   — connect-node OpenShell gRPC client       │  S1
   │  proto/      — PINNED openshell.proto 子集 + 生成碼       │  S1
   │  adapter.ts  — OpenShellSandboxAdapter implements        │  S2/3/4
   │                SandboxAdapter (name↔SandboxId 對映)       │
   │  provider-env.ts — placeholder-only env, fail-closed     │  S5
   │  index.ts    — barrel（對外只出 adapter + factory）        │
   └──────────────────────────────────────────────────────┘
                              │ gRPC (connect-node, HTTP/2 + TLS)
                              ▼
                  (external) OpenShell gateway @ pinned proto + image digest
```

- 依賴方向：`runtime/openshell/*` → `runtime/substrate`（barrel）→ `iam/ids`。**inward、acyclic**。
- core 治理模組（policy/audit/commitgate/orchestration/…）**不 import** `runtime/openshell`；它們只認
  `SandboxAdapter` port。adapter 注入由 composition root（後續 R7/R8 surface slice）完成。

### 3.2 start/stop 是明確 shim（VERIFIED 缺口）

`openshell.proto` **無 Start/Stop RPC**（VERIFIED：`service OpenShell` block 第 20–243 行全部 41 個 rpc 掃過，無 `StartSandbox`/`StopSandbox`；只有 Create/Get/List/Delete/Exec/Watch/…）；
`five-piece-integration.md:77` 明寫「port 的 start/stop 必須是明確 noop/relay shim，否則 contract 說謊」。
→ `OpenShellSandboxAdapter.startSandbox/stopSandbox` 是 **noop shim**：對已知 sandbox 回 `ok`（不打任何 RPC），
對未知 id 回 `deny`（fail-closed），且 event 註記 `reason:"start/stop is a noop shim (OpenShell has no Start/Stop RPC)"`。
`createSandbox` 實際做 `CreateSandbox`；`destroySandbox` 做 `DeleteSandbox`。

> **S6 實作對齊（DONE）：** `src/runtime/openshell/adapter.ts` `OpenShellSandboxAdapter.startSandbox/stopSandbox`
> 共用 `private noopShim(ctx, lifecycle, sandboxId)`：① 壞 ctx → deny；② 非法 id → deny；③ 對映遺失（未知 id）
> → deny（fail-closed，不臆造成功）；④ 已知 id → `ok`，event `reason` 帶
> `"<start|stop> is a noop shim (OpenShell has no Start/Stop RPC)"`，且**完全不觸碰 transport**（noop 就是 noop）。
> 共享 contract harness `src/test-contracts/sandbox-adapter.test.ts` 把本 adapter（注入 happy-path lifecycle
> transport double）加進 `describe.each` factory list，使 ExecutionSubstrate port 現有 **3 impl（Null/Fake/
> OpenShell）過同一 contract**——可插拔 HARD CONSTRAINT 機械化證明。真實 gateway smoke 為 opt-in、預設 skip
> 的 `src/runtime/openshell/e2e.test.ts`（`OPENSHELL_E2E_BASE_URL` 未設則 `describe.skip`），不進預設 verify
> 紅綠判定。OpenShell adapter 經 connect-node 確有 egress，故**不**納入 substrate 的「零 egress」正向 allowlist
> （該 allowlist 仍只約束 `port.ts`/`null.ts`/`fake.ts`）。

### 3.3 name ↔ SandboxId 對映

我方 `SandboxId`（`iam/ids`）與 OpenShell 的 sandbox `name`/`id` 是兩個命名空間。adapter 在 `createSandbox`
時：① 用 pinned image digest 組 `CreateSandboxRequest`；② 收到 `SandboxResponse.sandbox.metadata`（含 name/id）；
③ 產生我方 `SandboxId` 並在 adapter 內維護一個 in-memory `Map<SandboxId, openshellName>`；④ 後續
Get/Exec/Delete 用對映回來的 OpenShell name/id 呼叫。**對映遺失 = fail-closed deny**（不猜、不打 RPC）。

> 持久化對映屬 out-of-scope（§6）；R1 的 in-memory map 足以過 contract + 單進程 Personal 場景。

> **S2 實作對齊（DONE）：** `src/runtime/openshell/adapter.ts` `OpenShellSandboxAdapter` 持有
> `private nameById = Map<SandboxId, openshellName>`。`createSandbox`：① 壞 ctx → deny（未呼 RPC）；
> ② image（`spec.image` 或 `PINNED_SANDBOX_IMAGE` 預設）非 `sha256:` digest → deny（未呼 RPC）；
> ③ 呼 `transport.createSandbox`，取 `resp.sandbox.metadata.name`，空/缺 → deny（不存對映）；
> ④ 產 `SandboxId = sbx-os-<uuid>`、存對映 → ok。`destroySandbox`：壞 ctx / 非法 id / 對映遺失 → deny
> （未呼 `DeleteSandbox`）；否則用對映 name 呼 `transport.deleteSandbox`，成功才移除對映（RPC reject →
> deny 並**保留**對映供 forward-fix 重試）。任何 transport reject → deny，**永不 throw**、reason 不含 baseUrl。
> 對映遺失 = fail-closed deny。`start/stop` 在 S2 仍是 fail-closed deny（noop shim 留 S6）。

### 3.4 timeout / retry / fail-closed 預算（reliability）

- 每個 unary RPC 有**明確 timeout**（client deadline）；逾時 → `deny(reason:"openshell rpc deadline exceeded")`，
  **不重試寫操作**（Create/Delete 非冪等於我方對映；重試風險見 §7）。
- streaming（Exec/Watch）：以 `AbortController` + deadline 收斂；stream error / 非預期關閉 → fail-closed
  （Exec：回非零 exit 視為 denied-ish 由 caller 判；Watch：READY 前 stream 斷 → 視為未就緒）。
- **任何 transport / decode / 未知 phase / 連線失敗 ⇒ deny**（deny-by-default）。adapter **永不 throw**
  跨 port 邊界（與 P2-A contract 一致：port.ts 的 deny/ok 一律回 `AdapterResult`）。

> **S4 實作對齊（DONE）：** `src/runtime/openshell/adapter.ts` `OpenShellSandboxAdapter.execSandbox(ctx,
> sandboxId, cmd, opts?)` 驅動 `ExecSandbox`（server-stream，openshell.proto:67），回 `ExecOutcome`
> （`{status:"ok"; result:{exitCode,stdout,stderr}}` | `{status:"denied"; reason}`，每路皆帶可審計 event）。
> 流程：① 壞 ctx / 非法或未知 id（對映遺失）/ env value 帶 raw credential marker（非乾淨
> `openshell:resolve:env:` placeholder，見 `isExecEnvValueAllowed`，client.ts）→ deny（**未呼 RPC**）；
> ② 組 `ExecSandboxRequest{sandbox_id=ref.id（gateway 穩定 id，proto:647，非 name）, command, workdir?,
> environment?, timeout_seconds?, stdin?}`；③ 消費 stream，依序累積 stdout/stderr bytes，**僅在見到終端
> `ExecSandboxExit`（proto:685）才收斂成 `ok`**（任意 exit code，含非零如實回報，非零 exit ≠ transport 失敗）。
> **收斂/fail-closed 規則**：同步 throw / 串流中途 throw（RST_STREAM/decode）/ **未見 exit 即關閉** /
> `ExecSandboxExit` 缺 exit_code / **累積 stdout+stderr 超過 `maxOutputBytes`（預設 8 MiB，防 OOM）** /
> deadline 逾時 → **全部 denied**，**永不臆造 exit 0**、**永不回傳截斷的成功**、永不 throw 跨邊界、reason
> 不含 baseUrl/endpoint/credential。逾時/溢位/任一收尾路徑皆 `AbortController.abort()` 真正取消底層
> stream（`exec(req, signal)`；honour 的 transport 會拆掉 gRPC stream，`iterator.return()` 為 fallback）。
> 信任邊界以 zod runtime schema 驗 cmd/opts（壞/超大形狀 → deny before RPC，**永不 throw**）：argv
> count/bytes、env count/per-entry bytes、workdir/stdin length、timeout/deadline 上限、`maxOutputBytes`
> 夾在有限正整數（不可用 Infinity/NaN 關掉 OOM 護欄）。每個 stream frame 亦 runtime 驗 oneof（恰一變體、
> data 為 Uint8Array、exit_code 為整數），違反即 deny+abort。
> seam `OpenShellExecTransport` **只 extends `OpenShellLifecycleTransport`**（S4 僅依賴 S2，不依賴 S3 的
> get/watch；slice DAG: S4 -> {S2}）。env guard `isExecEnvValueAllowed` 比對 SecretResolver 的**確切**
> placeholder grammar（rev0 `openshell:resolve:env:<KEY>` / revN `…:v<N>_<KEY>`，`^…$` 錨定）；alias
> marker `OPENSHELL-RESOLVE-ENV-`、空/壞 placeholder、前綴埋在字串中段者 → deny。connect-node 真實
> `ExecSandbox` descriptor 由 S6 / opt-in e2e 接線（mirror S2/S3：預設 transport double，不打網路）。
> interactive/tty（proto:665-671/75）out-of-scope（§6）。RED 測試 `adapter.exec.test.ts`。

---

## 4. 重用 vs 新增

| 重用（不改） | 新增（本 ITEM） |
|---|---|
| `src/runtime/substrate/port.ts`（SandboxAdapter / AdapterResult / deny/ok） | `src/runtime/openshell/client.ts`（connect-node client + Health 健檢） |
| `src/runtime/substrate/{null,fake}.ts`（既有 ≥2 impl） | `src/runtime/openshell/proto/`（pinned proto 子集 + 生成型別） |
| `src/test-contracts/sandbox-adapter.test.ts`（共享 contract harness；只擴 factory list） | `src/runtime/openshell/adapter.ts`（OpenShellSandboxAdapter） |
| `iam/ids`（SandboxId / AgentContext） | `src/runtime/openshell/provider-env.ts`（placeholder-only env, fail-closed） |
| `.dependency-cruiser.cjs no-vendor-in-core`（已允許 `runtime/openshell/`） | `src/runtime/openshell/index.ts`（barrel）；proto pin manifest |
| Go WORM kernel（不接觸；R1 不產生 evidence，留給 commit-before-effect 的 orchestration 層） | connect-node 第三方依賴（**單獨成一個 slice = S1**，slice-spec §3） |

---

## 5. Pinning（Strategy B 的可重現性）

- **pinned proto**：把 `openshell.proto` 我們**實際消費的子集**（外加其 `import` 的 `datamodel.proto`/`sandbox.proto`
  必要訊息）vendored 進 `src/runtime/openshell/proto/`，附一行來源註記（upstream path + 我們釘的 revision）。
  proto drift 由一個 `openshell:proto:check`（比對 vendored 子集 hash）守護，mirror 既有 `scripts/proto-check.sh`
  的「toolchain 缺則 skip、存在則 diff」哲學（`scripts/proto-check.sh:7-22`）。
- **pinned image digest**：`CreateSandboxRequest.spec.template.image`（openshell.proto:335）一律用
  `sha256:` digest（非 floating tag），存在一個常數/設定，**不可由 caller 任意覆寫成未釘 tag**（fail-closed：
  非 digest 形態 → deny）。
- **不 fork**：repo 內**沒有** OpenShell 原始碼副本，只有 proto 子集 + client；升級 = 換 pin，不是 merge fork。

> **S1 實作對齊（DONE）：** 子集 vendored 在 `src/runtime/openshell/proto/openshell.subset.proto`（pinned
> rev `f23c2c8e84193beac5c35af8cd80276b60b8dbd4`），目前只含 `Health` RPC + `HealthRequest`/`HealthResponse`/
> `ServiceStatus`（S2..S5 逐子集擴）。drift guard = `scripts/openshell-proto-check.sh`（比對
> `openshell.subset.sha256` hash manifest；無 sha256 工具則 clean skip），已接進 `pnpm run verify`。
> pinned image digest 常數 = `client.ts:PINNED_SANDBOX_IMAGE`（`sha256:<64 hex>` 形態），由
> `assertPinnedImageDigest()` deny-by-default 守護；真值在 S2 接 `CreateSandbox` 時釘定。RPC vendor
> （`@connectrpc/connect{,-node}` + `@bufbuild/protobuf`）**只**在 `src/runtime/openshell/` import。

---

## 6. Out-of-scope（明確不做，留給後續）

- `ListSandboxes`（openshell.proto:31）、`ConnectSupervisor` relay（openshell.proto:169）、ForwardTcp、SSH session、
  service expose、policy/draft RPC ⇒ R1 不碰。
- **commit-before-effect / evidence append**：R1 只做 substrate I/O；effect 前的 PDP→kernel.Append→await Receipt
  由 orchestration 層（P2-I 已有 over-fakes 版；真實接線見 R2/R5/R7）負責。R1 adapter **不自行 append audit**。
- **credential 注入真值**：永遠是 OpenShell `SecretResolver` 的事（secrets.rs）；R1 只搬 placeholder。
- 持久化 name↔SandboxId 對映、多 gateway / per-tenant 連線（→ R8 Enterprise）、interactive exec（tty）、
  file-sync（proto 無）。

---

## 7. Trade-offs / 風險 / 誠實能力閘（capability gates）

1. **寫操作非冪等 + 無持久對映** ⇒ Create/Delete **不自動重試**；逾時當 deny 並讓上層 forward-fix。風險：
   逾時但後端其實成功 → 孤兒 sandbox。R1 接受此風險（單進程 Personal）；持久對映 + reconciliation 留 R8。
2. **provider-env placeholder 屬 INFERRED 契約**（§2.3）⇒ 用 fail-closed shape guard 取代信任；若 upstream 真的
   把 raw secret 放進 `environment`，我們**拒絕回傳並 deny**，寧可斷功能不洩密（credentials never on disk）。
3. **connect-node 新依賴**（S1）⇒ 依 slice-spec §3「新依賴單獨成 slice」；它只在 `runtime/openshell/` 被 import，
   core 不可見（no-vendor-in-core + 它非 core 模組）。
4. **真實 gateway 不在 CI** ⇒ R1 的測試**不打真網路**：以**注入式 transport double**（一個實作 client 介面的測試替身）
   驅動 adapter，斷言「given 這個 RPC 回應 → adapter 回這個 AdapterResult」。真實 e2e（連活 gateway）是一個
   **opt-in、預設 skip** 的整合測試（mirror proto-check 的 skip 哲學），不進預設 `pnpm run verify` 的紅綠判定。
5. **pinned proto 子集 vs full proto** ⇒ 只 vendored 我們用到的訊息，降低維護面，但升級時要重新確認子集足夠；
   `openshell:proto:check` 抓 drift。

---

## 8. Slice 分解（DAG，全部 SMALL；詳見各 slice doc）

| Slice | Title | 模組 | Net LOC（估） | Depends-on |
|---|---|---|---|---|
| **P2R-R1-S1** | connect-node client + pinned proto/image-digest | runtime/openshell | ~180 | P2-A |
| **P2R-R1-S2** | `createSandbox`（+`destroySandbox` via DeleteSandbox）+ name↔Id 對映 | runtime/openshell | ~160 | S1 |
| **P2R-R1-S3** | `GetSandbox` / `WatchSandbox` readiness（phase→ok/deny） | runtime/openshell | ~140 | S2 |
| **P2R-R1-S4** | `ExecSandbox` server-stream（stdout/stderr/exit→result） | runtime/openshell | ~150 | S2 |
| **P2R-R1-S5** | `GetSandboxProviderEnvironment` placeholder-only（fail-closed shape guard） | runtime/openshell | ~120 | S1 |
| **P2R-R1-S6** ✅ DONE | 過 P2-A SandboxAdapter contract（加進 factory + start/stop shim + e2e opt-in skip） | runtime/openshell + test-contracts | ~120 | S2,S3,S4,S5 |

### Slice DAG（鄰接表，無 cycle）
```
S1 -> { P2-A }
S2 -> { S1 }
S3 -> { S2 }
S4 -> { S2 }
S5 -> { S1 }
S6 -> { S2, S3, S4, S5 }
```
> 無 cycle 證明：rank = 0(S1) / 1(S2,S5) / 2(S3,S4) / 3(S6)；每條邊嚴格遞減 ⇒ DAG。
> 排序：先 S1 釘契約+連線（含新依賴，獨立成 slice），S2 把「建立並對映」做出來（其他操作都要對映），
> S3/S4 互不相依（readiness vs exec），S5 與 S2 互不相依（provider-env 只需 client），最後 S6 把整個 adapter
> 接進 P2-A 共享 contract 並補 start/stop shim，機械化證明可插拔。
