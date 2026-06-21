# SLICE-P2R-R7-S6: docker-compose launcher（localhost-only、secrets-as-mount）

- **Phase**: P2（R7 Personal 零技能殼 — 一鍵起停、deny-by-default 網路面）
- **Branch**: slice/p2r-r7-s6-launcher
- **Author**: Frontend Developer（agency-agents）   **Adversarial reviewer**: fresh-context 獨立 Opus 4.8（非作者）
- **Size budget**: <= 1 day；net LOC <~120、files <~5（`deploy/personal/docker-compose.yml` + `deploy/personal/README.md` + `scripts/launcher-check.mjs` lint + `scripts/launcher-check.test.ts` + 接進 verify 的一行）、modules <~2（`deploy/personal`、`scripts`）、新增依賴 = 0
- **狀態**: **DONE**

## (1) ID + Title
SLICE-P2R-R7-S6 — 新增 Personal surface 的 docker-compose launcher（把 intent→approval→timeline 殼 + 既有 substrate/kernel 一鍵起停），並用一支 deterministic linter 把「**localhost-only 綁定 + compose 檔零明文 secret**」變成 `pnpm run verify` 可驗的不變量。

## (2) Goal（一句話）
零技能使用者用一條 `docker compose up` 起停整個 Personal surface，且其網路面 deny-by-default（只綁 `127.0.0.1`）、credential 絕不落地（secrets-as-mount/env、compose 檔無明文）——並由 linter 在 verify 中強制。

## (3) In-scope / Out-of-scope
- In-scope：
  - `deploy/personal/docker-compose.yml`：服務只綁 `127.0.0.1`（借鏡 Hermes dashboard 預設 `127.0.0.1`、`/tmp/hermes-agent-probe/docker-compose.yml:14`、`:76`）；secret 一律走 `${ENV}`/volume 掛載，**compose 檔零明文**（借鏡 Hermes `API_SERVER_KEY` env-only、`:25`、`:42-44`）。
  - `deploy/personal/README.md`：白話啟動說明（host UID/GID、secret 經 env 注入、不要 `0.0.0.0`）。
  - `scripts/launcher-check.mjs`：deterministic linter，斷言 compose **無 `0.0.0.0` bind**、**無 secret-like 明文字面值**；違規 exit≠0；接進 `pnpm run verify`（一條 `launcher:check` 子關卡）。
- Out-of-scope（明確不做）：
  - 實際容器 image build / runtime 編排正確性（屬整合測試環境；本 slice 驗的是 compose **靜態不變量**）。
  - LAN 暴露 / 反向代理 / TLS（屬 R8 Enterprise；Personal 單機 localhost-only）。
  - s6-overlay 級 supervision 移植（用 compose 原生 healthcheck/depends_on，不照搬 Hermes `/init`）。

## (4) Design delta + modules + public interface + dependency direction
- **Design delta**：新增 deploy 工件 + 一支 linter 接進 verify；無 src 行為變更（不 import 任何 src 模組）。
- **Modules touched（唯一責任）**：
  - `deploy/personal/docker-compose.yml` — 唯一責任：以 localhost-only + secrets-as-mount 起停 Personal surface。
  - `scripts/launcher-check.mjs` — 唯一責任：把 compose 的安全不變量變成 exit-code 可驗。
- **PUBLIC interface**：無 TS public API（deploy 工件 + script）。`package.json` 追加 `"launcher:check"` 並串進 `verify`。
- **Dependency direction（inward、acyclic）**：
  ```
  scripts/launcher-check.mjs ──▶ (檔案讀取 deploy/personal/docker-compose.yml，靜態 lint)
  ```
  - 不 import 任何 src 模組（零耦合）：☐ 是。無 cycle、無 vendor 名於 core。

## (5) Test-first plan（RED 先行）
- 測試檔：`scripts/launcher-check.test.ts`（對 linter 跑 fixture）。
- RED 測試清單（先寫、會紅）：
  - [ ] 對一個**故意違規 fixture**（含 `0.0.0.0` bind）→ `launcher-check` exit≠0（RED 紅燈證據，類比 slice-spec §5 的 fixture-driven gate）。
  - [ ] 對一個**含明文 secret-like fixture**（runtime 組裝的 canary 寫進 compose 字串）→ exit≠0。
  - [ ] 對**合規 compose**（只綁 `127.0.0.1`、secret 走 `${ENV}`）→ exit 0。
  - [ ] **fail-closed**：compose 檔缺失/malformed YAML → exit≠0（不 fail-open 當作通過）。
- 首次紅燈證據（RED-first，已執行）：linter 對植入違規 fixture 必須 exit≠0，合規 fixture exit 0。
  vitest 把這四個不變量編成 fixture-driven 斷言（`scripts/launcher-check.test.ts`）：
  ```
  $ pnpm run test  →  scripts/launcher-check.test.ts (6 tests) PASS
    ✓ rejects a compose with a 0.0.0.0 bind (network deny-by-default)        → exit≠0
    ✓ rejects a plaintext secret-like literal (runtime-assembled canary)     → exit≠0
    ✓ passes a compliant compose (127.0.0.1 binds + ${ENV}/mount secrets)    → exit 0
    ✓ fails closed on a missing compose file (deny, not fail-open)           → exit≠0
    ✓ fails closed on malformed YAML (deny, not fail-open)                   → exit≠0
    ✓ checks the real Personal compose by default and is wired into verify   → exit 0
  ```
  > 註：本 slice 的 RED 是「linter 對植入違規 fixture 必須 exit≠0」（同 slice-spec §5 的 deps-gate 模式）；合規後 exit 0。

## (6) Definition of Done（每條附指令證據）
- [x] Test-first 成立（§5 fixture 首次 RED）：`scripts/launcher-check.test.ts` 把違規 fixture→exit≠0、合規→exit 0 編成斷言（見 §5 證據）。
- [x] `pnpm run verify` exit 0（含新 `launcher:check` 子關卡）。實測：`EXIT verify=0`（52 test files / 510 tests passed, 1 skipped；typecheck/lint/build/test/deps:check/proto:check/openshell:proto:check/verify:go/verify:py/launcher:check/secret-scan 全綠）。
- [x] `pnpm run launcher:check` exit 0（合規 compose）。實測：`launcher-check: clean — deploy/personal/docker-compose.yml`，`EXIT launcher:check=0`。
- [x] `pnpm run deps:check` exit 0（script 不 import src、無 cycle、無 vendor 名於 core）。實測：`✔ no dependency violations found (86 modules, 203 dependencies cruised)`，`EXIT deps:check=0`。
- [x] low coupling / high cohesion 遵守（launcher 與殼層解耦）：`scripts/launcher-check.mjs` 零 `src` import；deploy 工件無 src 行為變更（deps:check 0、no-vendor-in-core 測試綠）。
- [x] **secret-scan 乾淨（重點）**：`pnpm run secret-scan` → `secret-scan: clean`。compose 與 README 零明文 secret；canary 為 runtime 於 tmpdir fixture 組裝（`launcher-check.test.ts:65`），不入 repo 檔。
- [x] Docs 更新（README 啟動說明 `deploy/personal/README.md` + `package.json` 追加 `launcher:check` 並串進 `verify`）。
- [x] Adversarial code review = PASS（fresh-context 獨立 Opus 4.8）— 摘要：攻擊「把 bind 改 `0.0.0.0`／塞 bare `PORT:PORT`／在 compose 塞明文 secret／缺檔／malformed YAML」皆被 linter 抓到 exit≠0（fixture-driven 已驗）；linter 不回顯命中的 secret 值，自身不成為洩漏源。Slice 通過獨立審查。
- [x] （安全不變量類 slice）Independent Verifier Pass 已執行並 clean：網路面 deny-by-default（僅 `127.0.0.1` bind）、credential non-leak（`${ENV}`/RO mount、零明文）、fail-closed on missing/malformed — 由 verify 全綠 + 6 fixture 斷言證明。

## (7) Rollback
- 回退方式：`git revert <merge-sha>`（移除 `deploy/personal/*`、`scripts/launcher-check*`、verify 串接行）。
- 可逆性：安全可逆（無 src 行為、無 audit append；移除 launcher 不影響殼層單元）。

## (8) Depends-on / blocks
- Depends-on：S4（ApprovalInbox）、S5（TaskTimeline）——launcher 把這兩個視圖與既有 substrate/kernel 起起來。
- Blocks：（無；S6 為 R7 收口之一）。
- 確認 slice DAG 無 cycle：☐ 是（S6 rank 4，依賴 rank 3 的 S4 與 rank 0 的 S5）。
