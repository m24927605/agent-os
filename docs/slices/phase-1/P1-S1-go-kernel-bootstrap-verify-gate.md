# SLICE-P1-001: `kernel/` Go module bootstrap + 真實 `verify:go` gate（depguard + `internal/` 邊界，cascade 從 skip 變 enforcing）

- **Phase**: P1（roadmap §3.1 — Go evidence kernel；本 slice 是 P1 的**第一塊**：把 gate 立起來、不放任何證據邏輯）
- **Branch**: slice/p1-001-go-kernel-bootstrap-verify-gate
- **Author**: <id>    **Adversarial reviewer**: <須為 fresh-context、非作者>
- **Size budget**: 估計 <= 0.5 day；預期 net LOC <~80、files <~5（`kernel/go.mod` · `kernel/.golangci.yml` · `kernel/internal/version/version.go` · `kernel/internal/version/version_test.go` · README 片段）、modules <~1（新建 Go module `kernel/`）、新增第三方 Go 依賴 = 0

## (1) ID + Title
SLICE-P1-001 — 在 `kernel/` 新建 Go module（`go.mod` 固定 module path、go 1.22）+ `.golangci.yml`（啟用 **depguard**）+ 一個帶 `internal/` 邊界的最小可編譯 package（`internal/version`）+ 首個 `go test`，使 S0.8（SLICE-P0-008）建立的 `verify:go` cascade **從 fail-closed skip 轉為真實 enforcing**（`go vet ./... && go test ./... && golangci-lint run` 全綠）。

## (2) Goal（一句話）
讓 `kernel/` 目錄一旦存在，S0.8 的 `verify:go` 偵測契約（go toolchain / `go.mod` / `.golangci.*` 三項齊備）即被滿足並**真實執行** Go 語言 gate，且該 gate 在指令層強制 `internal/` 封裝與 depguard 跨 plane 禁令——而**不**寫入任何 crypto / hash-chain / canonical / checkpoint / gRPC / storage 邏輯。

## (3) In-scope / Out-of-scope
- In-scope:
  - `kernel/go.mod`：**module path 在本 slice 釘死為 `github.com/agent-os/kernel`**（非「建議」——depguard deny-list 與 `internal/` 封裝判定皆相對於此 path；不依賴實際 VCS 託管即可 `go build`），`go 1.22` directive；**零第三方 require**（golangci-lint 為 dev tool，不入 module require）。
  - `kernel/.golangci.yml`：啟用 **depguard** linter。**最低 golangci-lint 版本 = v1.55.0**（depguard v2 config schema，即 `linters-settings.depguard.rules.<name>.deny` 的 `[{ pkg, desc }]` 形態；本 slice 的 `.golangci.yml` 即依此 schema 撰寫——版本/schema 釘死，使 (B) RED 可重現）。**deny-list 為 load-bearing artifact，pattern 在本 slice 釘死如下**（depguard 對 import path 做 prefix match）：
    ```yaml
    # kernel/.golangci.yml（depguard v2 schema；golangci-lint >= v1.55.0）
    linters:
      enable: [depguard, govet]
    linters-settings:
      depguard:
        rules:
          kernel-no-cross-plane:
            list-mode: lax            # 只禁 deny 清單，其餘（stdlib + kernel 自身 internal/）放行
            deny:
              - pkg: github.com/agent-os/agent-os      # control plane / TS plane repo 根（若以 Go module 形式出現）
                desc: "kernel must not import the control plane / SDK; cross-plane only via gRPC proto (HARD CONSTRAINT A)"
              - pkg: agent-os/src
                desc: "kernel must not deep-import the TS control-plane source tree"
              - pkg: github.com/agent-os/sdk
                desc: "kernel must not import the SDK; cross-plane only via typed contract"
    ```
    > deny pattern = 上列三條精確 prefix；後續 slice（S2 起）只**增補** deny rule（如 `internal/canonical` 不得 import `internal/chain`），不改本三條跨 plane 禁令。depguard 規則 severity 由 golangci-lint 預設即「違規 = 非零 exit」。**規則必須非 no-op**：以「對一個刻意違規 import 必 exit≠0」的對抗證據確認（見 §5、§6）。
  - `kernel/internal/version/version.go`：一個最小 placeholder package，置於 `internal/` 下以取得**編譯器級**封裝（`internal/` 套件無法被 `kernel/` module 樹之外 import）。內容僅一個確定性的純函式（例如回傳 `KernelContractVersion` 常量字串），**不**含任何證據/crypto 行為。
  - `kernel/internal/version/version_test.go`：首個 `go test`（**RED 先行**）——對 placeholder 行為的具體斷言（例如斷言版本常量為釘死值），先在 package 尚未存在時為紅。
  - 確認 `scripts/verify-go.sh`（S0.8 既有，**不改動其邏輯**）的 fail-closed 偵測（`command -v go` / `go.mod` / `.golangci.yml|.yaml`）全數滿足後，腳本進入 `( cd kernel && go vet ./... && go test ./... && golangci-lint run )` 並回 exit 0。
  - `README.md` dev 區：把現有「`verify:go` … skip cleanly when that language plane is absent」一句**增補**為「Go plane 已存在於 `kernel/`，`verify:go` 現為 **enforcing**（`go vet` + `go test` + `golangci-lint`/depguard）」。
- Out-of-scope（明確不做，註記留給哪個後續 slice）:
  - 任何 crypto / hash-chain / canonical bytes / Ed25519 checkpoint / verifier 邏輯 → 留給 **SLICE-P1-002**（Go 端 conformance：byte-for-byte 對齊 S0.5 pinned 常量）。
  - 任何 gRPC / proto / 跨進程 ingest path / kernel-as-separate-process → 留給 **SLICE-P1-006**。
  - 任何 storage / durability / WAL / outbox → 留給 **SLICE-P1-004**。
  - monotonic per-source sequence + gap detection（Go 端）→ 留給 **SLICE-P1-003/005**。
  - 在 CI runner 上**安裝** golangci-lint 的 provisioning（toolchain 供裝是 CI/dev-env 設定，非本 slice 的程式碼）→ 本 slice 只**要求** golangci-lint 在 PATH 並被執行；其安裝以 dev/CI 環境步驟處理（見 §5 對「golangci-lint 未安裝 → verify:go fail-closed」的對抗確認）。

## (4) Design delta + modules + public interface + dependency direction
- **Design delta**: 在本 slice 之前，repo 無 `kernel/` 目錄，`verify:go` 走 S0.8 的 `skip — no Go plane` 分支（exit 0，但**未執法**）。本 slice 新建 `kernel/` Go module 使該分支條件翻轉：S0.8 腳本偵測到 plane 存在 → 進入「gate 必須已設定」分支 → 因 `go.mod` + `.golangci.yml` 齊備而**實跑** Go gate。狀態機差異：`verify:go` 從 `{skip}` 狀態進入 `{enforcing}` 狀態。**契約承接**：S0.8 §(8) 明寫「Blocks: P1 Go kernel（其 `verify:go` gate 由本 cascade 承接）」——本 slice 即該承接點，**不修改 `verify-go.sh` 的判斷邏輯**（避免動到 S0.8 已審過的 fail-closed 契約），只提供讓其分支翻轉的檔案。
- **Modules touched（每個一句唯一責任，high cohesion 自證）**:
  - `kernel/go.mod` — **唯一責任**：宣告 Go module 身分（path = 釘死的 `github.com/agent-os/kernel` + `go 1.22`）與依賴邊界的根（零第三方 require）。
  - `kernel/.golangci.yml` — **唯一責任**：以 depguard 在指令層強制 kernel 的跨 plane import 禁令（Go 端 HARD CONSTRAINT A 執法）。
  - `kernel/internal/version/version.go` — **唯一責任**：提供一個位於 `internal/` 的最小可編譯 placeholder，使 module 可 `go build`/`go test` 並示範 `internal/` 封裝邊界；**不承載任何證據邏輯**。
  - `kernel/internal/version/version_test.go` — **唯一責任**：以一條 `go test` 斷言鎖住 placeholder 行為（RED-first 證明 gate 真在跑測試，而非空跑）。
  - `README.md`（dev 區，文件）— **唯一責任**：記載 `verify:go` 現為 enforcing 的命令面語義。
- **PUBLIC interface（新增/變更的對外公共面；內部實作不列）**:
  - **命令面（本 slice 的對外面就是命令，不是 Go API）**：`pnpm run verify:go` 的語義從「skip exit 0」變為「enforcing：`go vet ./...` && `go test ./...` && `golangci-lint run` 全綠 → exit 0；任一失敗或 gate 未設定 → exit≠0」。`pnpm run verify`（root）因 S0.8 已級聯 `verify:go`，自動納入此 enforcing leg。
  - **Go module 對外面**：**刻意為零**——`internal/version` 在 `internal/` 下，**結構上無法**被 `kernel/` module 之外的任何 Go 程式 import（編譯器級封裝）。這正是 HARD CONSTRAINT A「auditee 只能 append、kernel 內部零外露」在 Go 端的起手式：本 slice 不開任何 public Go 套件，未來的 public surface（gRPC ingest）留給 SLICE-P1-006，且屆時 control plane 仍只透過 proto 契約互動、永不 import `internal/`。
- **Dependency direction（low coupling 自證；HARD CONSTRAINT A）**:
  - 箭頭圖（向內、無 cycle）:
    ```
    kernel/internal/version  ──▶ (Go stdlib only)
    (kernel module 不 import 任何 control-plane / SDK / TS plane 路徑)
    (control-plane / TS plane 不 import kernel 任何套件——更不可能 import internal/)
    ```
  - 僅經 public surface 消費（無 deep import）: ☑ 是（本 slice 不暴露任何 Go public surface；跨 plane 零連結，遠強於「只經 public surface」）。
  - **Go 端邊界的雙重執法（編譯器 + linter）**:
    - **編譯器級**：`internal/` 套件路徑使外部 module 無法 import `kernel/internal/...`，違規者 `go build` 直接失敗——天然封裝，無需信任 reviewer 眼睛。
    - **linter 級**：`.golangci.yml` 的 **depguard** deny-list 攔截「kernel 套件反向 import control-plane / SDK / 任一跨 plane 內部路徑」，違規 → `golangci-lint run` 非零 → `verify:go` 非零 → `verify` 非零。對齊 roadmap §0.2「Go evidence kernel：depguard（golangci-lint）+ `internal/` package 結構——非法 import ⇒ 非零 exit」與 test-and-acceptance §8 表格。
  - 新依賴宣告（逐一證明 inward + acyclic + justified；無則填「無」）:
    - **無新第三方 Go 依賴**（`go.mod` 零 require；placeholder 只用 stdlib）。golangci-lint 是 **dev/CI tool**，不進 module require graph，不製造 cycle，理由 = roadmap §0.2 指定的 Go 端邊界執法工具（YAGNI 之外的正當性：它是 HARD CONSTRAINT A 的 Go 端唯一指令化手段）。
    - **跨 plane 依賴 = 零**：kernel 與 TS control plane 在本 slice 之間**無任何 import 邊**（gRPC 契約是 SLICE-P1-006 才引入）；因此本 slice 不可能引入跨 plane cycle。

## (5) Test-first plan（先寫的 RED 測試）
> 本 slice 是 P1 的 **infra/bootstrap slice**，但仍嚴格 test-first：它同時帶 (A) 一個**真實的 `go test`**（RED 先行，證明 enforcing gate 真在跑測試而非空跑），與 (B) 兩條**對抗式 gate 斷言**（證明 gate 真正執法、不偽綠）。RED 必須在寫實作前真實跑出 exit≠0 並 commit（INDEX §2.1 規則 2）。

- 測試檔: `kernel/internal/version/version_test.go`（首個 `go test`）
- RED 測試清單（每條對應一個行為/不變量）:
  - [ ] **(A) placeholder 行為**：`version_test.go` 斷言 `Version()`（或 `KernelContractVersion` 常量）等於釘死值——在 `version.go` 尚未存在時，`go test ./...` 因編譯失敗（找不到 symbol / package）而紅。
  - [ ] **(B) gate enforcing — depguard 非 no-op（對抗式 RED）**：暫時在 `internal/version` 加入一行刻意違規的 import——**精確使用 §3 釘死 deny-list 的一條 prefix**（如 `import _ "agent-os/src/audit/event"` 命中 `agent-os/src` deny rule），跑 `cd kernel && golangci-lint run`，**必須 exit≠0**（depguard 報 `import 'agent-os/src/...' is not allowed`）；移除後 exit 0。這是針對 key risk「depguard 規則寫成 no-op」的命令化 RED：若規則是 no-op，違規 import 也會綠 → 此步驟抓得到。
  - [ ] **(C1) gate enforcing — cascade 翻轉「`.golangci.yml` 缺」（對抗式 RED，走 `verify-go.sh` 第 20-26 行的顯式 `fail=1`）**：在 `kernel/` 建立**前**，`pnpm run verify:go` 印 `skip — no Go plane`（exit 0）；建立 `go.mod` 但**故意尚未**放 `.golangci.yml` 時，`pnpm run verify:go` 必 **exit≠0**——此路徑由 `verify-go.sh` 第 21-22 行偵測 `.golangci.yml|.yaml` 皆缺 → `fail=1` → 第 23-26 行 `exit 1`（plane 存在卻 gate 未設定的**顯式** fail-closed）；補齊 `.golangci.yml` 後此分支不再觸發。
  - [ ] **(C2) gate enforcing — 「golangci-lint 不在 PATH」（對抗式 RED，走 `verify-go.sh` 第 29 行的子 shell 隱式失敗）**：當 `go.mod` **與** `.golangci.yml` **都齊備**（故第 20-26 行的顯式 fail 分支**不**觸發、腳本進入第 29 行的 gate 執行），但 golangci-lint 不在 PATH 時，第 29 行 `( cd kernel && go vet ./... && go test ./... && golangci-lint run )` 中的 `golangci-lint run` 因 `command not found` 使該子 shell 非零 → `|| { … exit 1; }` → `verify:go` **exit≠0**（不會被誤判為綠）。**註記行號歸因**：`verify-go.sh` **第 19 行** `command -v go` 檢查的是 **`go` toolchain**（非 golangci-lint）；golangci-lint 的缺席**不**由第 19 行捕獲，而是由**第 29 行**的子 shell 隱式失敗捕獲。(C1) 與 (C2) 是**兩條分離的 fail-closed 路徑**（不同觸發條件、不同行號），各自獨立貼 transcript。
  - [ ] 安全對抗式（依需取用）: 本 slice **不觸碰** credential / cross-tenant / audit payload（無證據邏輯）；對應攻擊面在 §6 以結構性理由標 `N/A`（引用所屬層：本 slice 只建 build/boundary gate，結構上不持有 credential、不寫 audit sink、不跨租）。**唯一適用的安全維度是 HARD CONSTRAINT A（耦合/邊界）與 fail-closed gate 語義**，已由 (B)(C) 對抗式 RED 覆蓋。
- 首次紅燈證據（貼 exit≠0；package / gate 尚未存在）:
  ```
  # (A) placeholder 測試先紅（version.go 尚未存在）
  $ cd kernel && go test ./...
  ... internal/version: cannot find package / undefined: Version ...
  exit code: <非 0>

  # (B) depguard 非 no-op：植入 §3 deny-list 命中的違規 import（如 agent-os/src）後必紅
  $ cd kernel && golangci-lint run
  ... internal/version/version.go: import 'agent-os/src/audit/event' is not allowed (depguard): kernel must not deep-import the TS control-plane source tree
  exit code: <非 0>

  # (C1) cascade fail-closed（路徑一）：go.mod 存在但 .golangci.yml 缺 → verify-go.sh 第 20-26 行顯式 fail=1
  $ pnpm run verify:go
  verify:go: Go plane present (.../kernel) — gate must be configured (fail-closed)
    FAIL: lint gate (.golangci.yml) missing
  verify:go: FAIL — Go plane present but gate unconfigured ...
  exit code: 1

  # (C2) cascade fail-closed（路徑二，與 C1 分離）：go.mod + .golangci.yml 皆在、但 golangci-lint 不在 PATH
  #      → 跳過第 20-26 行顯式 fail，進入第 29 行 gate；golangci-lint run 子 shell 隱式失敗 → exit 1
  $ command -v golangci-lint || echo "(golangci-lint absent)"
  (golangci-lint absent)
  $ pnpm run verify:go
  verify:go: Go plane present (.../kernel) — gate must be configured (fail-closed)
  ... go vet / go test 跑完 ... /bin/sh: golangci-lint: command not found
  verify:go: FAIL — Go gate failed
  exit code: 1

  # (D) 編譯器級封裝：module 外 import kernel/internal/version → go build 必失敗（與 linter 平行的第二道執法）
  $ cd /tmp && cat > x.go <<'EOF'
  package main
  import _ "github.com/agent-os/kernel/internal/version"  // module 外 import internal/ → 編譯器拒絕
  func main() {}
  EOF
  $ go build x.go
  use of internal package github.com/agent-os/kernel/internal/version not allowed
  exit code: <非 0>
  ```
  > 上述 transcript 為**樣板佔位**（INDEX §2.1 規則 1）：必須在執行時以**真實輸出**覆蓋；覆蓋前不得宣稱已綠。
  > (B)=linter 級執法、(D)=編譯器級執法——**邊界由 depguard + `internal/` 雙重把守**，兩條都附命令證據。

## (6) Definition of Done（每條附指令證據）
- [ ] **Test-first 成立**：首個 `go test`（A）與兩條對抗式 gate 斷言（B)(C) 的首次 RED 已貼於 §5 並 commit（早於實作）。
- [ ] `pnpm run verify` **exit 0**（含級聯 `verify:go` 的 **enforcing** leg；貼結尾與 exit code）。
  ```
  $ pnpm run verify
  ... verify:go: ok
  ... exit code: 0
  ```
- [ ] `pnpm run verify:go` 單獨 **exit 0**，且其輸出顯示**真的跑了** `go vet` / `go test` / `golangci-lint`（非 skip）。
  ```
  $ pnpm run verify:go
  verify:go: Go plane present (.../kernel) — gate must be configured (fail-closed)
  ... (go vet / go test / golangci-lint 實際輸出) ...
  verify:go: ok
  exit code: 0
  ```
- [ ] **depguard 非 no-op 已對抗證明**：植入一條 deny-list 命中的違規 import → `cd kernel && golangci-lint run` exit≠0；移除 → exit 0（兩段輸出皆貼，§5 (B)）。
- [ ] **cascade fail-closed 已對抗證明（兩條分離路徑各貼 transcript）**：(C1) `go.mod` 在、`.golangci.yml` 缺 → `pnpm run verify:go` exit≠0（走 `verify-go.sh` 第 20-26 行顯式 `fail=1`）；(C2) `go.mod` + `.golangci.yml` 皆在、golangci-lint 不在 PATH → `verify:go` exit≠0（走第 29 行子 shell 隱式失敗）。**行號歸因正確**：golangci-lint 缺席由第 29 行捕獲，**非**第 19 行（第 19 行檢查 `go`）。
- [ ] **golangci-lint 確實在 PATH 並被執行**：`command -v golangci-lint` 有輸出，且 §5 (B)(C) 的 exit code 證明它被 `verify-go.sh` 第 29 行調用（非靜默跳過）。
- [ ] **dependency-boundary check 綠**：TS 端 `pnpm run deps:check` exit 0（本 slice 不動 `src/`，不應有新 TS 邊界違規）；Go 端邊界由 `internal/`（編譯器）+ depguard（linter）雙重執法，已由上述 enforcing `verify:go` 覆蓋。
- [ ] **low coupling / high cohesion 遵守（編譯器 + linter 雙重執法，各附命令證據）**：kernel 與 TS plane 零 import 邊；無 Go public surface 外露；(D) **編譯器級** `internal/` 封裝成立——module-外 import `github.com/agent-os/kernel/internal/version` 的 `go build` 失敗 transcript 已貼於 §5；(B) **linter 級** depguard 對 deny-list 命中的跨 plane import 回非零 transcript 已貼於 §5。
- [ ] **secret-scan 乾淨**：`pnpm run secret-scan` clean；`go.mod` / `.golangci.yml` / placeholder / 測試 / README 片段**無** secret-like 值（本 slice 不碰 credential，結構上無 secret 來源）。
- [ ] **Docs 更新**：README dev 區已標明 `verify` 現含 enforcing Go leg（commands 變更 → 必須更新）。
- [ ] **Adversarial code review = PASS**（fresh-context、!= author、refute-by-default；**主攻面 = 偽綠**：reviewer 須親手 (i) 暫時把 `.golangci.yml` 改成空/移除 depguard 規則，確認 `verify:go` 變綠即為破口（證明規則原本有效）；(ii) 暫時把 golangci-lint 移出 PATH，確認 `verify:go` exit≠0；(iii) 暫時破壞 placeholder 測試斷言，確認 `go test` 轉紅——RED 重現兩段皆貼）。findings 已解 — 連結/摘要: <...>
- [ ] **Independent Verifier Pass**（本 slice 的安全不變量 = HARD CONSTRAINT A 的 Go 端執法 + gate fail-closed 語義）：獨立者重跑 `pnpm run verify`、並對抗式注入「plane 存在卻缺/壞 gate 設定」「golangci-lint 缺席」「depguard 規則被改 no-op」三種偽綠路徑，確認每種都使 `verify:go` exit≠0（HELD）。

## (7) Rollback
- 回退方式: `git revert <merge-sha>`（刪除 `kernel/` 目錄與 README 片段）。
- 可逆性: **安全可逆**——本 slice 無持久化、無外部副作用、無 audit append、無 credential 處置。回退後 `verify:go` 因 `kernel/` 消失而退回 S0.8 的 `skip — no Go plane`（exit 0），`verify` 仍綠（gate 強度回到 P0 的 skip 狀態，須在 PR 註記此弱化）。**前瞻**：SLICE-P1-002+ 一旦在 kernel 寫入真實 append-only 證據邏輯，已寫入的鏈為 append-only，屆時回退靠 forward-correcting event，**不得改寫歷史**（slice-spec §7）；本 slice 因尚無證據邏輯，不受此限。

## (8) Depends-on / blocks
- Depends-on:
  - **SLICE-P0-008**（`verify:go` cascade 既有 fail-closed 偵測契約；本 slice 是其 §(8) 明寫的承接點）。
  - **SLICE-P0-005**（evidence-kernel v0 TS 契約 + S0.5 pinned conformance 常量；本 slice 尚不消費這些常量，但作為 P1 的 phase 前置——SLICE-P1-002 將以它為 Go 端 byte-for-byte 對齊基線）。
- Blocks:
  - **SLICE-P1-002**（Go 端 hash-chain / canonical / Ed25519 checkpoint，需先有可編譯的 `kernel/` module + enforcing gate）。
  - **SLICE-P1-004**（storage / durability）、**SLICE-P1-006**（gRPC ingest proto / kernel-as-separate-process），皆等待本 slice 立起 module 與 gate。
- 確認 slice DAG 無 cycle: ☑ 是（本 slice 只 depends-on 已 merge 的 P0 slice；無回邊）。
