# 実験022-B1-R：SQLite履歴保存UNKNOWN調査

2026-11-09。ARCH側のみ変更。既存未コミット成果196ファイルのSHA・Git状態を開始時に記録した。HEADは26f22fdcafb1276f8a32d31629cef52759436d03。過去022-B1の保存UNKNOWNは未解決として調査し、今回の故障注入・反復結果と区別する。

参照：022-A、022-B1/B2/B3、020-B、021-B報告と実装。Unit候補は0.2.0-experiment.022.2、旧配布版は0.1.0-experiment.021.1。どちらも上書き・正式配布・道場導入をしていない。

## 1. 保存経路とTransaction

src/prototype/workflow.ts:CWorkflowのpersistは、IWorkflowHistoryStore.saveの例外をHISTORY_SAVE_OUTCOME_UNKNOWNへ包む。これはすべてが「COMMIT後の応答喪失」だったという意味ではない。保存前の拒否、Job例外後のFAILED保存失敗も同じ外側コードになる。元cause、storageCause、attemptedSnapshot、読戻し観測は既存契約で別々に保持される。

SQLite側はjob-execution/resume.cjs→SQLiteJobRunStore.save→fencedTransaction/所有権guard→SQLiteWorkflowHistoryStore.saveとJob観測flush→SimpleDB.transaction。BEGIN IMMEDIATE後、同じTransaction内で所有者・claimToken・fencingToken・SQLite時刻でのLeaseを検証し、履歴・snapshot等を保存する。COMMITで確定、失敗時はROLLBACKを試みる。I/O待機やJob処理をTransaction内へ追加していない。

workflow_historyは(run_id, trace_order)が主キー。保存済み履歴のprefix一致を確認し、追加分だけINSERTする。既存snapshotと同じ内容の再保存は物理UPDATEになり得るが、traceを二重追加しない。履歴IDは記録位置のIDであって、個々のsave呼出しIDではない。

## 2. 原因として確定できたこと・できないこと

過去の022-B1反復結果は修正前48/50、修正後初回49/50、追加50/50。初回修正後の1件はHISTORY_SAVE_OUTCOME_UNKNOWNだけが子fixtureから返り、COMMIT前後・元SQLite code・実保存状態が残っていない。**この過去1件の原因は今回も未解明。** 読取競合だった、Lease失効だった、COMMIT後だった、と推測で断定しない。

SQLiteは同期APIであり、Firestoreのようなネットワークcommit応答を使わない。ただしCOMMIT成功後にStoreの後処理が例外になる、Core/IPC応答前にプロセスが終了する、等によって呼出元が結果を知らない窓は存在する。今回のCOMMIT後例外は故障注入による再現であり、過去1件の原因の証明ではない。

診断読取のBUSYは022-B1の有限再読込・DIAGNOSTIC_UNAVAILABLEで区別する。履歴保存のBEGIN/COMMIT競合、所有権拒否、Job例外と履歴保存の二重障害は別経路である。

## 3. 修正内容：観測だけを追加

src/adapters/simpledb/database.cjsのエラーに非enumerableの内部情報sqliteCode、transactionPhase（BEGIN/ACTION/COMMIT）、rollbackConfirmedを付けた。既存公開code、timeout、Lease長、guard、Transaction順序は変更していない。COMMIT例外は従来どおりOUTCOME_UNKNOWNのまま。非拡張の元Errorへ診断を付けられなくても、そのErrorを別の例外で上書きしない。

新規job-execution/history-observation.cjs:observeHistorySaveは既存のread-only診断を使い、書込・再開を一切行わない。判定のscopeとcommitOutcomeを必ず併記する。

| state | 証拠・scope | 意味と制限 |
| --- | --- | --- |
| NOT_APPLIED | SAVE_OPERATION、ローカルTransactionのrollback証拠 | BEGIN/ACTION失敗とrollback確認、またはCOMMITのBUSY/LOCKEDとrollback確認。対象saveは未適用。Jobや以前のcheckpointの副作用まで未実行とは言わない |
| APPLIED | OBSERVED_SNAPSHOT、読戻しがattemptedSnapshotと一致 | 目的のsnapshotが保存されていることを観測。保存操作固有IDがないためcommitOutcomeはUNKNOWN。元エラーを成功へ変換しない |
| UNKNOWN | 読込不能、内容不一致、固有IDの証拠不足 | 保存操作の結果を確定できない。不一致や不存在だけでNOT_APPLIEDにしない |

既存SQLite履歴Schemaにはsave固有のoperationId/receiptがない。過去履歴と同じsnapshotが見えたことだけで、今回のsave成功を証明できない。操作IDを追加するには保存Schema・Migration設計が必要であり、今回は暗黙追加しない。新WAITING/Firestoreの操作receiptとは別契約。

tests/job-run-lease/host.cjsに、primaryCode/phaseとstorageCode/phase、数値SQLite code、rollback、読戻し状態を記録する観測を追加。主障害と二次的な履歴保存障害を分ける。raw SQL・stack・内部パスは診断に含めず、本番APIへ追加していない。ログ出力失敗で元の結果を変更しない。

## 4. 再現試験

tests/history-unknown.test.cjs、最終8 PASS／0 FAIL。

1. 保存処理中の例外でrollbackし、NOT_APPLIEDを確認。
2. COMMIT前にSQLITE_BUSYを注入。OUTCOME_UNKNOWNの元codeを維持し、rollback証拠を別に観測。
3. 実COMMIT成功後に例外を注入。rollback不能、Store poison、保存snapshot一致を観測するがcommitOutcomeはUNKNOWNのまま。
4. 同内容の複数保存・複数照会でもtraceは1件。
5. 内容不一致にsave固有IDがない場合はUNKNOWN。
6. 実ロックで読戻し不能ならUNKNOWN、履歴一意性も未確認としてnull。
7. BEGIN競合のphase/codeを捕捉し、timeoutを変更しない。
8. frozenな元Errorを診断追加が上書きせず、rollback済みデータを保全。

プロセス終了前後のSQLite保存については既存job-run-lease.test.cjsのwrite途中kill・stale保存拒否・所有権喪失試験も回帰した。新たな自動再試行・自動再開・補修処理は追加していない。

## 5. 反復試験と実際の保存観測

既存「separate processes use independent run ownership and both resume」を50回実行し、**50 PASS／0 FAIL**。各回2子プロセス、専用一時SQLite。既存のアサーション・期限・Lease設定は維持した。

logs/022b1r-lease-1.log〜50.logと022b1r-lease-observations.jsonlに記録した。100 resume呼出しはすべて正常に返り、既存試験は両runのCOMPLETEDと所有権FINISHEDを確認した。追加のread-only観測は99件で保存snapshot一致・履歴order一意を確認、1件は読戻し不能でUNKNOWN。未確認の1件を保存確認済みに数えない。初期の観測ログでは空配列の一意性がtrueになったため、その1件は証拠に採用せず、最終observerは取得不能時にhistoryLength/uniqueHistoryOrdersをnullにする。

観測を追加したこと自体がタイミングへ影響し得る。50/50だけで過去の事象を修正済みと結論しない。今回、過去と同じHISTORY_SAVE_OUTCOME_UNKNOWNの自然発生は再現しなかった。原因を推測した書込再試行等の対症修正もしていない。

再実行例：npm run build後、ARCH rootのPowerShellでARCH026_LEASE_OBSERVATIONSを新しいlogs内JSONL絶対パスへ設定し、node --test --test-name-pattern='separate processes use independent run ownership and both resume' tests/job-run-lease.test.cjsを50回呼ぶ。各回のexit codeと個別ログを保全し、最後に環境変数を除去する。既存ログを上書きして初回FAILを消さない。

## 6. 回帰・残存リスク

最終共通回帰は既存892件、既存WAITING49件、既存パッケージ2件がPASS。今回新規はSQLite観測8件、Firestore WAITING20件がPASS。Build/型検査/JS構文/diff checkも成功した。詳細はB4報告。

変更：src/adapters/simpledb/database.cjs、tests/job-run-lease/host.cjs、新規src/adapters/job-execution/history-observation.cjs、tests/history-unknown.test.cjs、実行script追加のpackage.json。本体のWorkflow/CMRP/Check、所有権guard、保存Schemaを変更していない。

**判定：安全な検出・照合方法と追加観測は実装／検証済み。過去事象の原因は未解決のまま引き継ぐ。** 次に自然再現した際はphase、元SQLite code、primary/storageの区別、rollback、保存snapshotとtraceを今回の方法で採取する。固有保存operationIdを導入する場合は明示Schema変更の別判断が必要。UNKNOWNを成功へ読み替えず、自動再開しない。
