# SLICE-LR1: `e2e:live-restore` — snapshot restore, live against the REAL kernel

- **Phase**: assurance（把 snapshot/restore/replay 從「單元建好」升到「live 證實」,與 AGT/kernel 同級)
- **Branch**: slice/lr1-e2e-live-restore
- **Author**: Backend Architect    **Adversarial reviewer**: <fresh-context、非作者、獨立 Opus 4.8>
- **狀態**: **DRAFT（待核准開工)**

## (0) 動機
復原模型 = snapshot restore(不做 undo)。`snapshot.ts`+`restore.ts`(`runRestore`)+`replay.ts` 三件套**單元建好**但**未 live-e2e**。LR1 補一條 gated 真跑:對**真 Go kernel** checkpoint → restore-to-S → replay 重建,證實「回到 checkpoint、forward-only、不截斷、admin 簽署、brain 不能自助」在真鏈上成立。鏡像既有 `e2e:live-kernel` / `e2e:live-agt` 樣式。

## (1) 範圍(鏡像 e2e-live-kernel.sh + 既有 *.live-kernel.e2e.test.ts)
1. **gated vitest** `src/orchestration/restore.live-kernel.e2e.test.ts`(`skipIf` 無 `AGENTOS_LIVE_KERNEL_ENDPOINT`,同既有 live-kernel 測)。對 spawn 的真 kernel:
   - **append 到 S**:經真 grpc-js ingest appender append 一串 AuditEvents(代表某 task 狀態)→ 記 anchor sequence **S**(kernel head / `Checkpoint`)。
   - **append 過 S 到 M**:再 append 若干 events(狀態前進到 M>S)。
   - **restore-to-S**:`runRestore(deps, …)` — `RestoreDeps.authorize`(admin/approver 簽署)allow → forward-append `RestoreInitiated` 然後 `RestoreCompleted`(經 `RestoreAppender` 接真 kernel)→ `rebuildProjection`(經 `ListEntries`〔read-transport〕讀到 S → `replay` fold → S 時的 projection)。
   - **斷言**:
     - **replay 正確**:重建的 projection == S 時狀態(對**真鏈**,非 in-memory)。
     - **forward-append**:兩個 RestoreEvent 出現在真鏈 M+1、M+2(`ListEntries` 讀回)。
     - **forward-only / 不截斷**:restore 後 0..S **與** S+1..M 全都還在鏈上(restore 只加不刪)。
     - **admin-signed / brain 不能自助**:未授權 actor → `runRestore` 的 authorize deny(no append)。
     - **fail-closed**:`ListEntries`/append 錯誤 → restore fail-closed(無「半完成」假象:RestoreInitiated 無 RestoreCompleted 的處理)。
2. **`scripts/e2e-live-restore.sh`**(鏡像 e2e-live-kernel.sh):`go build` kernel → spawn `--addr 127.0.0.1:$PORT` → export `AGENTOS_LIVE_KERNEL_ENDPOINT`/`_CHAIN` → 跑該 gated 測 → teardown。+ package.json `e2e:live-restore`。**不在 verify**。
3. **gating**:無 `AGENTOS_LIVE_KERNEL_ENDPOINT`(直接跑 vitest)→ 測 **skip**;`e2e-live-restore.sh` 無 kernel/Go → BLOCKED 非零(不假綠)。

## (2) 不變量
- **forward-only**:斷言 restore 後**所有** pre-restore 序號仍在(永不截斷)——這是 restore.ts 的核心保證,要在真鏈上證。
- **admin-signed**:brain actor → authorize deny(restore 不可自助)。
- **fail-closed**:讀/寫錯 → restore 不留半完成;gated 測無 kernel → skip,sh 無 kernel → BLOCKED。
- **read-only replay**:`replay` 不改鏈、不 IO(只 fold);restore 只透過 `RestoreAppender.append`(唯一 emit 能力)。
- **不碰生產碼**:LR1 只加 test + script(可能小幅 export 既有 harness 助手);`runRestore`/`replay`/`snapshot` 行為不變。

## (3) Test-first plan（RED 先行)
- gated 測寫好但**無 kernel 時 skip**(確認 skipIf 生效,verify 內 skip)。
- 對 spawn kernel:上述 5 斷言(replay 正確 / forward-append / 不截斷 / admin-deny / fail-closed)。
- non-vacuity(在測內,不改生產碼):若可,注入一個「截斷式」假 appender 對照真 runRestore 證 forward-only 斷言會抓到差異;或斷言 pre-restore 序號計數 restore 前後單調不減。
- `e2e:live-restore` 不在 verify;ungated vitest → skip;sh 無 kernel → BLOCKED。

## (4) Definition of Done（待實測填）
- [ ] RED → verify exit 0(gated 測 skip-when-ungated、不在 verify;既有全綠;depcruise/secret-scan clean;無新依賴)。
- [ ] **LIVE 跑 `pnpm run e2e:live-restore` PASS**(對真 kernel:restore-to-S 重建正確、forward-append 兩 RestoreEvent、不截斷、admin-deny、fail-closed)。
- [ ] 獨立 Opus 4.8 review PASS。

## (5) Rollback / Depends-on / 誠實前提
- Rollback:`git revert`(純加 test + script + 可能的 harness export)。
- Depends-on:`runRestore`(restore.ts)、`replay`(replay.ts)、`SnapshotRecord`(snapshot.ts)、ingest `ListEntries` reader(read-transport.ts)、真 kernel(kernel/cmd/kernel)、e2e-live-kernel 樣式。Blocks:無。
- **誠實前提**:LR1 把 snapshot restore 升到 live-proven(對真 kernel),與 AGT/kernel 同級。restore 仍是 **operator 復原工具**(admin 簽署、不在 autonomous 迴圈)——LR1 不改這個定位,只證實它真的 work。
