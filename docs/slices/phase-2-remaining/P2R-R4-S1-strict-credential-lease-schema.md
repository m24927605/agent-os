# SLICE-P2R-R4-S1: `.strict()` CredentialLease(bundleRef-only) schema + raw-secret parse-fail

- **Phase**: P2（ITEM R4 — CredentialLease lifecycle，第 1 刀）
- **Branch**: slice/p2r-r4-s1-strict-credential-lease-schema
- **Author**: Security Engineer    **Adversarial reviewer**: <須為 fresh-context Opus 4.8、非作者>
- **Size budget**: 估計 <= 1 day；net LOC <~140、files <~4（`src/credential/{lease.ts,index.ts}` + `src/credential/lease.test.ts` + barrel 微調）、modules = 1、新增依賴 = 0
- **狀態**: **DRAFT**（RED plan + DoD 為 placeholder，待實作填真實 exit code）

## (1) ID + Title
SLICE-P2R-R4-S1 — 新增 `.strict()` `CredentialLease` Zod schema：攜帶 `bundleRef`（不透明引用）+ 綁定 `AgentContext` + `expiresAtMs` + 宣告的 env `keys`（KEY **名**，非值）+ 可選 `revision`；**任何 raw secret / 多餘欄位輸入 → parse-fail（fail-closed）**。

## (2) Goal（一句話）
讓「一份憑證授權」成為一個**強型別、bundleRef-only、絕不持有 literal secret** 的領域物件，由 `.strict()` 邊界結構性拒絕任何 secret-shaped 或越界輸入。

## (3) In-scope / Out-of-scope
- In-scope:
  - `src/credential/lease.ts`：`CredentialLease` Zod schema（`.strict()`），欄位至少 `{ bundleRef, context: AgentContext, keys: string[], expiresAtMs: number, revision?: number, state: LeaseState }`；`parseCredentialLease(input): CredentialLease`（fail-closed parse）。
  - `LeaseState` enum（`issued|injected|used|revoked|expired`）型別匯出（FSM 轉移在 S2，本刀只定義型別與初始 `issued` 不變量）。
  - `src/credential/index.ts` barrel（唯一 public surface）。
- Out-of-scope（明確不做）:
  - FSM 轉移（mint/inject/use/revoke/expire）→ 留給 **SLICE-P2R-R4-S2**。
  - injection seam（lease → provider-env map）→ 留給 **SLICE-P2R-R4-S3**。
  - 寫入 WORM kernel；bundleRef → KEY 集合的 registry（屬後續 ITEM，本刀 keys 為輸入）。

## (4) Design delta + modules + public interface + dependency direction
- **Design delta**: 新增 `credential` module 與 lease schema；目前無此型別，授權散在隱性 env 約定中。schema 以 `.strict()` 拒絕多餘欄位；`keys` 元素須為合法 env-key 名（`[A-Za-z_][A-Za-z0-9_]*`），**禁止 secret-shaped 值**（由測試注入 `redactSecrets` 偵測佐證 schema + 約束）。
- **Modules touched（唯一責任）**:
  - `src/credential/lease.ts` — 唯一責任：定義 bundleRef-only 的 `CredentialLease` schema 與其 fail-closed parse。
  - `src/credential/index.ts` — 唯一責任：credential module 的 public barrel。
- **PUBLIC interface（新增）**:
  - `export const CredentialLease = z.object({...}).strict();` / `export type CredentialLease`。
  - `export const LeaseState = z.enum(["issued","injected","used","revoked","expired"]);` / `export type LeaseState`。
  - `export function parseCredentialLease(input: unknown): CredentialLease`（fail-closed；壞輸入 throw）。
- **Dependency direction（low coupling；HARD CONSTRAINT A）**:
  - 箭頭圖（向內、無 cycle）:
    ```
    credential/lease.ts ──▶ iam/ids (barrel) ──▶ zod
    （測試）credential/lease.test.ts ──▶ audit/redact (redactSecrets, 僅測試注入)
    ```
  - 僅經 public surface 消費（無 deep import）: ☑ 是（只 import `../iam/ids.js` barrel + `zod`；測試 import `../audit/redact.js`）。
  - 新依賴宣告: `credential → iam`：方向=inward（domain 共用 ids）、cycle=無（iam 不 import credential）、理由=重用 `AgentContext`/`SandboxId`，DRY。第三方=0。

## (5) Test-first plan（先寫的 RED 測試）
- 測試檔: `src/credential/lease.test.ts`
- RED 測試清單（每條對應一個行為/不變量）:
  - [ ] 合法 lease（bundleRef + 有效 AgentContext + 合法 keys + 未來 expiresAtMs）parse 成功，`state==="issued"`。
  - [ ] **`.strict()`**：含未宣告欄位（例如塞 `secret`/`value`/`apiKey`）→ parse **throw**（fail-closed）。
  - [ ] **raw-secret parse-fail（安全對抗式）**：`keys` 含非法 env-key 名 或 任一欄位放入 secret-shaped 值（runtime 組裝 canary，如 `"sk-" + "a".repeat(20)`）→ parse throw **或** 注入 `redactSecrets` 偵測到 lease 投影中有 secret 即 assert 失敗。
  - [ ] 壞 `context`（缺 tenantId / 空字串）→ parse throw（沿用 `parseAgentContext` fail-closed）。
  - [ ] `expiresAtMs` 非正整數 / 非數字 → parse throw。
- 首次紅燈證據（貼 exit≠0）:
  ```
  $ pnpm test src/credential/lease.test.ts
  ... FAIL (cannot import ../credential/index.js — module 不存在) ...
  exit code: 1        # PLACEHOLDER：實作前親眼見紅後覆蓋
  ```

## (6) Definition of Done（每條附指令證據）
- [ ] Test-first 成立（首次 RED 已貼於 §5；git history 證 doc→red→impl）
- [ ] `pnpm run verify` exit 0
  ```
  $ pnpm run verify
  ... exit code: 0    # PLACEHOLDER
  ```
- [ ] dependency-boundary check 綠（`pnpm run deps:check` exit 0；no-vendor-in-core 綠）
- [ ] low coupling / high cohesion 遵守（`credential` 只經 iam barrel + zod；無 cyclic、無 deep import、無 vendor token）
- [ ] secret-scan 乾淨（`pnpm run secret-scan` exit 0；canary runtime 組裝、無 source 字面值；lease 投影無 secret）
- [ ] Docs 更新（design/credential-lease.md 已存在；本 slice 標記 schema 已落地）
- [ ] Adversarial code review = PASS（fresh-context；mutation：移除 `.strict()` → 多餘欄位測試應轉紅；findings 已解）— 摘要: <…>
- [ ] （安全不變量類 slice）Independent Verifier Pass 已執行並 clean（對抗式探測 bundleRef-only / 無 literal secret / fail-closed parse）

## (7) Rollback
- 回退方式: `git revert <merge-sha>`（移除 `credential/` module + barrel；無外部副作用、無 audit append）。
- 可逆性: 安全可逆（純新增、無資料遷移）。

## (8) Depends-on / blocks
- Depends-on: **P2-A**（重用既有 `iam/ids` 與 `audit/redact`，皆已 merge）。
- Blocks: **SLICE-P2R-R4-S2**（FSM 消費本 lease 型別）。
- 確認 slice DAG 無 cycle: ☑ 是（rank 1；iam/redact 不 import credential）。
