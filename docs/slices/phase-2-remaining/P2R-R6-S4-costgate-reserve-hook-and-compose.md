# SLICE-P2R-R6-S4: CostGate(model→cost) reserve hook + InferenceRoutingGate 組合（any-deny-wins）

- **Phase**: P2（ITEM R6 inference routing gate — 收尾刀；見 [`../../design/inference-routing-gate.md`](../../design/inference-routing-gate.md) §2.2 / §4.2 / §4.4）
- **Branch**: slice/p2r-r6-s4-costgate-hook-and-compose
- **Author**: Backend Architect    **Adversarial reviewer**: <fresh-context、非作者、Opus 4.8>
- **Size budget**: <= 1 day；net LOC <~200、files <~4（`src/inference/cost-map.ts` + `src/inference/gate.ts` + `src/inference/gate.test.ts` + `src/inference/index.ts` barrel）、modules ≤ 2（消費 cost + 自身）、新增依賴 = 0
- **狀態**: **DRAFT**

## (1) ID + Title
SLICE-P2R-R6-S4 — 新增 `cost-map`（`model → estimatedTokens`，未知 model→無估算=deny）+ `InferenceRoutingGate.authorize()`，把四道關卡（model allowlist → egress allowlist → PDP → CostGate `reserve`）組合成**單一 chokepoint**，**any-deny-wins**；只有全 allow 才呼叫 CostGate `reserve` 並回 `{ decision:"allow", reservationId }`。

## (2) Goal（一句話）
把 R6 的四道關卡收斂成單一可驗的 `authorize`：任一關 deny 即整體 deny，且**上游 deny 時絕不呼叫 reserve**（no orphan hold），只有四關全綠才預留成本並放行。

## (3) In-scope / Out-of-scope
- In-scope:
  - `CostMap` 型別 + `estimateTokens(req, costMap): { ok: true; tokens } | { ok: false; reason }`（未知 model→fail-closed，無估算即 deny）。
  - `InferenceRoutingGate.authorize(req, deps): Promise<InferenceDecision>`，`deps = { modelAllowlist, egressAllowlist, evaluate, costMap, costGate }`（全部建構期注入，解耦）。
  - 組合順序（design §2.2）：S1 model → S2 egress → S3 PDP → **最後** CostGate `reserve`；任一上游 deny 立即回 deny **不**呼叫 reserve。
  - `InferenceDecision = { decision:"allow"; reservationId: string } | { decision:"deny"; reason: string }`。
- Out-of-scope（明確不做）:
  - CostGate `commit`（effect 完成後，屬 orchestration / 後續）；`release(reservationId)` → 留給 R12 follow-up。
  - 把 decision 餵 WORM kernel ingest → 留給 R2。
  - 真實 OpenShell `inference.local` egress 執行 / `GetInferenceBundle` client → 留給 R1 / R11。
  - 真實 SpendGuard 計價 → 留給 R11（cost-map 只做 token 估算，design §4.2）。

## (4) Design delta + modules + public interface + dependency direction
- **Design delta**: 加 cost-map 與組合層；組合層**重用** S1/S2/S3 純函式 + 既有 CostGate port（`src/cost/port.ts`）。
- **Modules touched（唯一責任）**:
  - `src/inference/cost-map.ts` — `model → estimatedTokens` 對映（fail-closed：未知 model 無估算）。
  - `src/inference/gate.ts` — 組合四關卡成單一 `authorize`（any-deny-wins、never-reserve-on-deny）。
  - `src/inference/index.ts` — barrel 增 re-export。
- **PUBLIC interface（新增）**:
  - `type CostMap = ReadonlyMap<string, number>`（model → estimatedTokens）。
  - `function estimateTokens(req: InferenceRequest, costMap: CostMap): { ok: true; tokens: number } | { ok: false; reason: string }`。
  - `interface InferenceGateDeps { modelAllowlist; egressAllowlist; evaluate; costMap; costGate }`。
  - `type InferenceDecision = { decision: "allow"; reservationId: string } | { decision: "deny"; reason: string }`。
  - `class InferenceRoutingGate { authorize(req: unknown, deps: InferenceGateDeps): Promise<InferenceDecision> }`（或等價 factory function）。
- **Dependency direction（inward、acyclic）**:
  ```
  inference/index.ts ──▶ gate.ts ──▶ {model-allowlist, egress-allowlist, pdp-adapter, cost-map, types}（intra-module）
  gate.ts ──▶ cost/index.js（CostGate / ReserveRequest 型別，public barrel）
  ```
  - 僅經 public surface 消費（無 deep import）: ☐ 是（經 `../cost/index.js` barrel；CostGate 實作由注入提供，不硬連線）。
  - 新依賴宣告: `inference → cost`：方向=inward（domain↔domain，同層 port 契約）、cycle=無（cost 不 import inference）、理由=R6 必須 reserve-before-effect，消費既有 CostGate port；CostGate 實作經 `deps` 注入（測試用 `InMemoryCostGate`/`NullCostGate`），不耦合具體 adapter。

## (5) Test-first plan（先寫的 RED 測試）
- 測試檔: `src/inference/gate.test.ts`（`gate.js` / `cost-map.js` 不存在 → RED：import 失敗）。
- RED 測試清單（cost-map）:
  - [ ] 已知 model → 回對映 tokens；未知 model → `ok:false`（**fail-closed**，無估算即 deny）。
- RED 測試清單（gate `authorize`，any-deny-wins + never-reserve-on-deny）:
  - [ ] 四關全 allow + 預算足 → `{ decision:"allow", reservationId }`，且 CostGate `reserve` 被呼叫剛好一次。
  - [ ] **model deny**（S1）→ deny，且 `reserve` **未**被呼叫（spy 斷言 0 次，no orphan hold）。
  - [ ] **egress deny**（S2）→ deny，且 `reserve` 未被呼叫。
  - [ ] **PDP deny**（S3，注入 evaluate→deny）→ deny，且 `reserve` 未被呼叫（**PDP 唯一權威**，即使 model/egress allow）。
  - [ ] **CostGate reserve denied**（hard-cap，用 `InMemoryCostGate` 小預算 / `NullCostGate`）→ deny（reserve-before-effect）。
  - [ ] **fail-closed**：malformed `InferenceRequest` → deny，永不 allow、永不呼叫 reserve；任一步 throw → deny。
  - [ ] **credential-blind**：`InferenceDecision` 與 gate 介面不接收/不回傳 api_key/secret；`gate.ts` source 不含 credential 欄位名。
  - [ ] reason 不洩值：deny reason 標明被哪一關擋（關卡名）+ 靜態文字，不回顯整個請求/不含 secret。
- 首次紅燈證據（待實作時貼 exit≠0）:
  ```
  $ pnpm test src/inference/gate.test.ts
  ... FAIL（Cannot find module './gate.js'）...
  exit code: <填入>
  ```

## (6) Definition of Done（每條附指令證據）
- [ ] Test-first 成立（首次 RED 已貼於 §5）
- [ ] `pnpm run verify` exit 0
  ```
  $ pnpm run verify
  ... exit code: <填入>
  ```
- [ ] dependency-boundary check 綠（`pnpm run deps:check` exit 0；`inference → {policy,cost}` 皆經 barrel、inward、無 cycle、無 deep import；`inference` 在 core from-list）
- [ ] low coupling / high cohesion 遵守（CostGate / evaluate 皆注入；無 vendor；無新跨 module 之外的依賴）
- [ ] secret-scan 乾淨（含 credential-blind 結構斷言）
- [ ] Docs 更新（連結回 design §2.2/§4.2/§4.4；INDEX.md R6 標 READY-TO-BUILD）
- [ ] Adversarial code review = PASS（fresh-context；any-deny-wins 在四關任一位置、never-reserve-on-deny（reserve spy）、PDP 唯一權威、hard-cap、malformed/throw fail-closed、credential-blind 皆對抗探測；≥3 種 mutation（移除某關 / reserve 在 deny 後仍呼叫 / allow 路徑漏 reserve 失敗）皆被測試抓）— 連結/摘要: <填入>
- [ ] （安全不變量類 slice）Independent Verifier Pass 已執行並 clean（four-gate any-deny-wins、no-orphan-hold、reserve-before-effect、fail-closed、credential-blind）

## (7) Rollback
- 回退方式: `git revert <merge-sha>`（移除 `cost-map.ts` + `gate.ts` + barrel 兩行）。
- 可逆性: 安全可逆（純新增；reserve 僅作用於注入的 CostGate 實例，回退不留外部副作用；無 audit append、無遷移）。

## (8) Depends-on / blocks
- Depends-on: SLICE-P2R-R6-S2（egress allowlist）、SLICE-P2R-R6-S3（PDP 整合）、P2-G（CostGate port / `reserve` / `InMemoryCostGate` / `NullCostGate`）。（S2/S3 各自 depends-on S1，故 S1 為傳遞前置。）
- Blocks: R1（live OpenShell substrate）/ R11（真實 vendor adapter）把本 gate 接上真實 `inference.local` egress；R2（ingest）把 decision 餵 WORM kernel。
- 確認 slice DAG 無 cycle: ☐ 是（`P2-E → S1 → {S2,S3} → S4 ← P2-G`，無回邊）。
</content>
