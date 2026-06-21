# Phase 2 Slices — INDEX（DRAFT / 規劃中）

> **狀態（2026-06-21）：DRAFT。** 本目錄的 slice spec **先於實作撰寫**（doc-first，無 doc 不開工）。
> 下列 slice 尚未實作；每個都將走 branch → **DRAFT spec 先行（本目錄）** → **RED test-first（親眼見紅）** →
> 實作到 GREEN → `pnpm run verify` exit 0 → **fresh-context Independent Verifier = PASS** → `--no-ff` merge，
> 完成後把該 slice spec 的 §RED/§DoD 以**真實 exit code** 覆蓋並標 DONE。
> 權威設計見 [docs/design/five-piece-integration.md](../../design/five-piece-integration.md)；定位見 [AGENTS.md](../../../AGENTS.md)。
> **AGENTS.md 在任何衝突上勝出。only command output is truth。**

> **Phase 2 的意圖**：把承諾 v1 棧（Hermes 腦 + OpenShell 身體 + NemoClaw hosting + AGT policy + SpendGuard 成本）
> 的整合骨架立起來，並把「可插拔」與「三大不可插拔壟斷」變成 `pnpm run verify` 可驗：
> ① PDP 唯一 deny 權威 ② OpenShell SecretResolver 唯一憑證注入 ③ Go WORM kernel + 離線 verifier 唯一證據根。

> 鐵律（Looping Engineering，逐 slice 強制；沿用 [phase-1/INDEX.md §2 / §2.1](../phase-1/INDEX.md)，此處不重述全文）：
> 只有指令輸出是真相；Test-first（RED 先行、capped loop）；三條 HARD CONSTRAINT（低耦合/高內聚、每 slice
> 對抗式 review、**可插拔：每 port vendor-neutral + ≥2 impl + contract test、core 不得 import vendor**）；
> deny-by-default + fail-closed；credentials 絕不落地（測試 canary 為 runtime 組裝、不入 fixture 檔）。

---

## 1. Slice 清單與 DAG（規劃；實作順序 B→A→C→D）

| Slice | 檔案 | Title | 模組 | Net LOC（估） | Depends-on | 狀態 |
|---|---|---|---|---|---|---|
| **P2-B** | [P2-B-…](./P2-B-no-vendor-in-core-pluggability-rule.md) | `no-vendor-in-core` dependency 規則 — 可插拔變 `verify` 可驗 | build/boundary gate | ~120 | （承接 P0/P1 dependency-cruiser gate） | **DONE** |
| **P2-A** | [P2-A-…](./P2-A-vendor-neutral-substrate-port-contract.md) | vendor-neutral ExecutionSubstrate port + Fake 第二實作 + contract harness（`runtime/openshell`→`runtime/substrate` 正名） | runtime/substrate | ~300 | P2-B | DRAFT |
| **P2-C** | [P2-C-…](./P2-C-ts-commit-before-effect-guard.md) | TS commit-before-effect guard — 關閉 BLOCKING「護城河空心」 | commitgate | ~190 | （獨立；承接 P1 commitgate 概念） | DRAFT |
| **P2-D** | [P2-D-…](./P2-D-brain-port-credential-blind-guard.md) | vendor-neutral Brain port + credential-blind guard + 2 impls | runtime/brain | ~300 | P2-A | DRAFT |

### Slice DAG（鄰接表，無 cycle）
```
P2-B -> ()                 # 可插拔法則先於 adapter 增生；承接 P0/P1 已 merge 的 dependency-cruiser gate
P2-A -> { P2-B }           # 第一個 ≥2-impl 的 port；在 B 鎖死 no-vendor-in-core 後正名 substrate/ 並加 Fake
P2-C -> ()                 # commit-before-effect guard；純 sequencing、零 src 耦合
P2-D -> { P2-A }           # Brain port 沿用 A 的 port+contract-harness 模式
```
> 無 cycle 證明：rank(B)=0, rank(A)=1, rank(C)=0, rank(D)=2；每條邊嚴格遞減 ⇒ DAG。
> 排序紀律：先 **B** 把「core 不得 import vendor」變 verify 可驗（adapter 增生前先鎖），再 **A** 交出第一個真正
> ≥2-impl 的 port（順手正名 `runtime/openshell`→`runtime/substrate`），**C** 補 commit-before-effect（先前只是口號），
> **D** 讓「腦」成為可驗可插拔槽位並把 credential-blind 變強制。B/C 互相獨立；A 在 B 之後；D 沿用 A。

---

## 2. 每個 slice 共同遵守的 Definition of Done（逐條指令可證；沿用 phase-1/INDEX §2）
- [ ] **Test-first 成立**：實作前先有 RED 測試並親眼見紅（exit≠0），git history 可證 doc→red→impl 順序。
- [ ] `pnpm run verify` **exit 0**（typecheck && lint && build && test && deps:check && proto:check && verify:go && verify:py && secret-scan）。
- [ ] **dependency-boundary 綠**：`pnpm run deps:check` exit 0；B 之後 `no-vendor-in-core` enforcing。
- [ ] **三條 HARD CONSTRAINT 遵守**：無新增跨 module/cyclic 依賴；core 不 import vendor；觸及 port 者 ≥2 impl + contract test。
- [ ] **secret-scan 乾淨**；測試 secret canary 為 runtime 組裝、無 source 字面值。
- [ ] **Adversarial code review = PASS**（fresh-context、非作者、refute-by-default；親自重跑 verify + mutation 驗證測試非 theater；MAJOR/minor 當場修正後 re-confirm）。
