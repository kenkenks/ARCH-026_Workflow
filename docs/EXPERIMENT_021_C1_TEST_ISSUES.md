# 実験021-C1：残存試験問題の調査

2026-11-09。ソース・既存試験・Unitは変更せず調査。021-A/B報告と現物を照合した。道場vendor archiveとARCHの生成済archiveのSHA-256を再計算し、両方とも以下と一致。道場unit.cjsによる導入済manifest・全ファイル検証も成功。

`@arch026/workflow-unit@0.1.0-experiment.021.1`

`e7f97e55ed2da17adf32cb7358df39c816ed7e929ea4c7dee1b87d0aafda34c4`

## WebConnect認証試験

対象：道場work/verify-webconnect-auth-boundary-step7a.cjs:77〜のunconnected teacher and member actions fail closed for every role。今回再実行は6 PASS／1 FAIL。既存試験はteacher_attendance_today、member_attendance_state、attendance_batch、payment_statusをすべて未接続と仮定し、全roleで404を要求する。

現物ではshared/WebConnectCore.js:resolveが最初の3 actionを既存operationへ変換する。cloud/api/webConnect.cjs:createDispatchは対応するcreateAdminApiへ渡し、admin-api.cjsは既知ルートを確認してからBearer認証、権限、入力、依存関数の順に処理する。payment_statusだけはUNKNOWN_ACTIONで404。

同じ未注入依存・空inputを用いた16組の直接観測：

| action | 匿名 | admin | teacher claimのみ | member claimのみ |
| --- | --- | --- | --- | --- |
| teacher_attendance_today | 401 | 400 INVALID_TEACHER_SCOPE | 403 | 403 |
| member_attendance_state | 401 | 400 INVALID_MEMBER_STATE_PARAMS | 403 | 403 |
| attendance_batch | 401 | 400 INVALID_ATTENDANCE_INPUT | 400 INVALID_ATTENDANCE_INPUT | 400 INVALID_ATTENDANCE_INPUT |
| payment_status | 404 | 404 | 404 | 404 |

観測で業務呼出しは0。registrationの入力検証はrole判定の前にあるため、空inputの400だけで有効入力の認可を検証したとは扱わない。既存別試験も合わせた評価が必要。

**原因**：ルート追加後も「未接続」の旧前提が試験に残る。401は認証緩和や021-Bによる回帰ではない。021-BのWorkflow APIを一切経由せず再現し、既存ソース・試験は開始時SHAと同じ。

**最小対応案**：試験を既知actionと本当に未知のactionに分ける。既知actionは有効な入力・明示したPrincipal/reader/command依存を供給し、匿名401、無権限403、許可時のみ業務呼出し、不正入力400、未注入依存503を契約別にassertする。未知actionは全role404・業務呼出し0を維持する。期待値を一括401へ置換せず、認証実装は緩和しない。今回は原因・方針提示までで既存試験を変更していない。

## Lease再現試験

対象：ARCH tests/job-run-lease.test.cjs:36「separate processes use independent run ownership and both resume」。同じhistory.sqlite/control.sqliteに異なるrunIdを作り、2子プロセスでclaim後、Promise.allでresumeし、両方COMPLETED・FINISHEDをassertする。

| 試行 | PASS | FAIL | 観測 |
| --- | --- | --- | --- |
| 無変更・通常実行5回 | 4 | 1 | 3回目INJECTED_FAILURE |
| 一時的観測preload付き30回 | 28 | 2 | 22、23回目。診断読込UNAVAILABLE |
| SQLite原例外も観測するpreload付き15回 | 14 | 1 | 33回目RESUME_REFUSED |

合計50回で46 PASS／4 FAIL。観測コードはlogs配下の一時preloadのみで、戻り値や例外を変更せず記録・再throwした。preload自体のタイミングへの影響はあり得るため、通常試行と混ぜて失敗率を一般化しない。021-B初回失敗と今回の通常試行INJECTED_FAILUREの原例外は残っておらず、すべてが同じ原因だったとは断定しない。

**33回目の確定した経路**：node:sqlite DatabaseSyncのstatementが`PRAGMA application_id`でERR_SQLITE_ERROR／errcode=5／database is locked → SimpleDB.getがUNAVAILABLEへ分類 → diagnostic.cjs:openReadOnly/readDiagnosticInputがHISTORY_READ_UNAVAILABLEを付加 → resume.cjs:resumeのpreliminary検証がRESUME_REFUSED。

対象試験はSQLiteのみ。Firestore Emulatorは起動せず、Emulator状態やプロジェクト共有はこの再現の原因ではない。各fixtureは専用一時directory、各試行は別Nodeプロセス。試験間のファイル依存はないが、1試験内の異なるrunIdが同じSQLiteファイルを共有する。

Leaseはfixture既定5000ms、失敗例の試験所要時間は約0.82秒。該当経路で自動HeartbeatやHeartbeat間隔設定は存在しない。SQLiteの通常SimpleDB.openはtimeout既定100msだが、diagnostic.cjsのDatabaseSync(readOnly:true)はその設定を経由せず、原例外は読込ロック競合だった。今回観測はLEASE_EXPIREDではない。テストIPCのready/requestには明示timeoutがなく、子stderrを捨て、非code例外をINJECTED_FAILUREにまとめるため原因の観測性も不足する。

**最小修正方針**：

1. ARCH側の診断用読取AdapterでSQLite BUSY/LOCKEDの一時的読込不能と保存データ不整合を区別する。
2. 一貫した読取Transaction全体を対象とする、明示的・有限のread-only再試行方針を検討する。部分DTOを再利用しない。Job・書込・commitの自動再送へ拡張しない。
3. 2runのwriterと診断readerをbarrierで制御してロック競合を決定的試験化し、異なるrunの競合を不正データ扱いしないことを確認する。
4. テストfixtureで安全な原例外分類・IPC timeout・異常終了を観測する。単にLeaseや待機時間を延長しない。

SQLite診断Adapterは今回の配布Unitに収録していない。今回Unitは変更不要で、道場側独自パッチも不要。将来Unit収録部分を変更する場合はARCHで修正・全回帰・新Version配布する。

## 結論・残存リスク

C1の原因と対応方針を提示したが、既存試験は未修正でありFAILを解消済みとはしない。C2で業務仕様未確定と固定Unitの待機・再開契約不足も確認したため、C3は実装停止。今回は892件全回帰、021-B Emulator統合、パッケージ再生成を再実施しておらず、前回結果は021-B報告を参照する。今回未実施をPASS扱いしない。検証子プロセスは終了、既存DB・実サービスは使用していない。
