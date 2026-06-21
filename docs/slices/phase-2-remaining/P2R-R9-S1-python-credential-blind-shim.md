# SLICE-P2R-R9-S1: Python credential-blind shim + `verify:py` gate（ruff + import-linter forbidden contract）

- **Phase**: P2（R9 第一刀；Developer surface — Python plane）
- **Branch**: slice/p2r-r9-s1-python-credential-blind-shim
- **Author**: agency-agents writer（Backend Architect）    **Adversarial reviewer**: <fresh-context Opus 4.8、非作者>
- **Size budget**: <= 1 day；net LOC <~200、files <~6（`python/pyproject.toml` + `python/.importlinter` + `python/agentos_shim/__init__.py` + `python/agentos_shim/shim.py` + `python/tests/test_credential_blind.py` + `scripts/verify-py.sh` 微調一行掛 import-linter）、modules = 1（新 Python plane）、新增第三方依賴 = ruff + import-linter（**dev-only，Python plane 內，TS plane 無新依賴**）
- **狀態**: **DONE**

## (1) ID + Title
SLICE-P2R-R9-S1 — 新建 `python/` plane 與最小 **credential-blind shim**（agent 提案以 bundleRef-only 結構 emit、永不碰 secret），並用 **import-linter forbidden contract** 把「shim 不得 import 任何 secret-bearing 模組」變成 **import-time 結構性不變量**；同時把 `verify:py` gate 配置到綠（ruff + pyproject + import-linter 執行）。

## (2) Goal（一句話）
讓 Python plane 的 shim package **在 import 期結構性無法持有明文 secret**，且該不變量由 `pnpm run verify`（`verify:py`）的 exit code 強制。

## (3) In-scope / Out-of-scope
- In-scope:
  - `python/pyproject.toml`：ruff 設定 + dev deps（ruff、import-linter）+ 套件中繼。
  - `python/.importlinter`：一條 **forbidden contract**——`agentos_shim` **禁止** import secret-bearing 模組集合（至少：`os.environ` 直取憑證的 helper、任何寫 `~/.hermes` 類憑證檔的模組、任何直打 model provider client 的模組）。本 slice 以**佔位的本地違規 fixture 模組**證明 contract 會抓到違規（RED）。
  - `python/agentos_shim/shim.py`：最小 shim——把 plan-step / tool-call 表達成 **bundleRef-only** 的 dataclass/dict（args 只帶 `bundleRef: str`，無 literal secret）。純結構、無 I/O、不讀環境變數憑證。
  - `python/tests/test_credential_blind.py`：pytest 證明 shim emit 的結構不含 secret-shaped 值（runtime 組裝 canary）。
  - 把 import-linter 執行掛進 `scripts/verify-py.sh` 的 Python gate（在 `ruff check && pyright && pytest` 之外加 `lint-imports`）。**注意**：`scripts/verify-py.sh:28` 已硬性要求 `pyright` 通過，故 shim 須 type-clean 且 `pyright` toolchain 須可用（pyright 為既有 gate 要求，非本 slice 新引入的「行為依賴」，但實作時須確保其存在；`verify-py.sh:19-21` 的 fail-closed 只檢 ruff/pyproject，pyright 缺席會在第 28 行才紅）。
- Out-of-scope（明確不做，註記留給後續 slice）:
  - 真 Hermes brain 接線 / 跑真模型 → 留給 **R11**。
  - TS SDK barrel → 留給 **P2R-R9-S2**。
  - CLI → 留給 **P2R-R9-S3**。
  - SDK publish 到 PyPI → 後續發布 ITEM。

## (4) Design delta + modules + public interface + dependency direction
- **Design delta**: 目前**無 Python plane**，`scripts/verify-py.sh:11-16` 對 `python/` 缺席 skip；本 slice 新增 plane 後，`verify-py.sh:18-27` 會要求 gate 配置否則 FAIL——故必須一刀把 ruff + pyproject + import-linter 配齊到綠。新增 import-linter forbidden 不變量（credential-blind 的 import 期層，與 runtime `screenBrainEvent`（`src/runtime/brain/credential-guard.ts:32-40`）互補）。
- **Modules touched（唯一責任）**:
  - `python/agentos_shim/` — 唯一責任：以 bundleRef-only 結構表達 agent 提案，**結構性不碰 secret**。無 I/O、不讀憑證、不打 provider。
- **PUBLIC interface（新增）**:
  - `python/agentos_shim/shim.py`：`def to_bundle_ref_tool_call(tool: str, bundle_refs: dict[str, str]) -> dict` 等最小函式（args 僅接受 bundleRef 字串；傳入 secret-shaped 值的呼叫由測試證明被拒/不產生 literal）。
  - `python/.importlinter`：forbidden contract（`agentos_shim` ↛ secret-bearing modules）。
- **Dependency direction（low coupling 自證；HARD CONSTRAINT A）**:
  - 箭頭圖（向內、無 cycle）:
    ```
    python/agentos_shim/shim.py ──▶ (Python stdlib dataclasses/typing only)
    import-linter ──checks──▶ agentos_shim（禁向 secret-bearing 模組的邊）
    ```
  - 僅經 public surface 消費（無 deep import）: 是（shim 不 import TS core、不 import 任何 vendor）。
  - 新依賴宣告: `ruff`（Python lint，dev）、`import-linter`（Python import gate，dev）——方向=Python plane 內 dev tooling、cycle=無、理由=`scripts/verify-py.sh:18-27` 要求 plane 存在即須 gate（ruff），import-linter 是 slice-spec §116 指定的 Python plane import gate；AGT 亦用 `import-linter>=2.0`（grounded）。**TS plane 無新依賴。**
  - no-vendor-in-core: 綠（`agentos_shim` 不含 vendor token、不 import Hermes/OpenShell）。

## (5) Test-first plan（先寫的 RED 測試）
- 測試檔: `python/tests/test_credential_blind.py` + import-linter contract（`lint-imports`）
- RED 測試清單（每條對應一個行為/不變量）:
  - [ ] **import-linter RED**：植入一個刻意違規 fixture（`agentos_shim` import 一個 secret-bearing 模組）→ `lint-imports` exit≠0（fail-closed），移除 fixture 後 exit 0。
  - [ ] shim emit 的 tool-call 結構：args 只含 bundleRef 字串、**不含** runtime 組裝的 secret canary（recursive 掃描無 secret-shaped 值）。
  - [ ] 對抗式 credential-blind：傳入 secret-shaped 值給 shim → 不產生含 literal secret 的輸出（拒絕或只保留 bundleRef）。
  - [ ] `ruff check .` 乾淨、`pytest -q` 綠。
- 首次紅燈證據（exit≠0；mutation 證明 contract 為 load-bearing）:
  ```
  $ cd python && uv run lint-imports   # shim 暫時 import secret-bearing fixture
  agentos_shim is credential-blind (forbidden: never import a secret-bearing module) BROKEN
  Broken contracts
  _credential_blind_fixtures.env_secret_reader:
  -   agentos_shim.shim -> _credential_blind_fixtures.env_secret_reader (l.67)
  Contracts: 0 kept, 1 broken.
  exit code: 1
  ```
  移除違規 import 後 → `Contracts: 1 kept, 0 broken.` exit code: 0（contract 真的在守）。

## (6) Definition of Done（每條附指令證據；真實 exit code）
- [x] Test-first 成立（首次 RED 已貼於 §5；mutation→BROKEN exit 1、revert→KEPT exit 0；git history 可證 doc→red→impl）
- [x] `pnpm run verify` exit 0（含 `verify:py`：ruff + pyright + pytest + `lint-imports` 全綠）
  ```
  $ pnpm run verify
  ... verify:py: Python plane present — All checks passed! (ruff)
  ... 0 errors, 0 warnings, 0 informations (pyright)
  ... 5 passed in 0.00s (pytest)
  ... Contracts: 1 kept, 0 broken. (lint-imports)
  ... verify:py: ok
  ... verify:cross-tenant: ok / launcher-check: clean / secret-scan: clean
  exit code: 0
  ```
- [x] dependency-boundary check 綠（TS `deps:check` 不受影響；Python 由 import-linter forbidden contract 守：`Contracts: 1 kept, 0 broken.` exit 0）
- [x] low coupling / high cohesion 遵守（`agentos_shim` 單一責任=bundleRef-only 表達；shim 僅依 stdlib，無跨 plane deep import，no-vendor-in-core 綠）
- [x] secret-scan 乾淨（`secret-scan: clean`；canary runtime 組裝、不入 fixture/snapshot）
- [x] Docs 更新（design/developer-sdk.md §2.2 S1 與本 slice 一致）
- [x] Adversarial code review = PASS（fresh-context；reviewer mutation：在 shim 加 forbidden import → `lint-imports` BROKEN exit 1，移除後 KEPT exit 0，證明 contract 真的在守）
- [x]（安全不變量類）Independent Verifier Pass 已執行並 clean（probed：import-linter fail-closed（BROKEN→exit 1）、shim 不洩 secret（bundleRef-only、非 ref 值 fail-closed 拒絕）、verify:py 不可 no-op-green（plane 缺 gate 時 fail-closed exit 1））

## (7) Rollback
- 回退方式: `git revert <merge-sha>`（移除 `python/` plane；`verify-py.sh` 回到 skip 路徑）。
- 可逆性: 安全可逆——新增獨立 plane，無外部副作用、無資料遷移、無 audit append。回退後 `verify:py` 對缺席 plane skip（exit 0），不影響 TS gate。

## (8) Depends-on / blocks
- Depends-on: 無未 merge 前置（對齊既有 credential-blind 律 `credential-guard.ts`、`scripts/verify-py.sh`，皆已 merge）。
- Blocks: 無硬性 block（S2-S4 為 TS 鏈、獨立）；本 slice 為 Developer surface 的 credential-blind 結構地基，R11 真 Hermes shim 將依賴此 plane。
- 確認 slice DAG 無 cycle: 是（S1 rank=1，獨立 Python 鏈，無循環依賴）。
