# 実験022-B3：WAITING再開・競合・Fencing

2026-11-09。Memory/専用SQLiteで実装・検証。認可は呼出元、入力形式・状態・所有権・重複判定はUnit Portの責務。人の資格情報や道場のteacher PolicyをCoreへ追加していない。

## 公開再開契約

CWorkflow.resumeWaiting(savedWaitingSnapshot, request, maxExecutions, beforeStep?)を追加。通常runや既存LIMIT_REACHED用resumeとは別入口。

```json
{
  "runId": "run",
  "operationId": "resume-1",
  "expectedWaitGeneration": 1,
  "expectedRevision": 4,
  "result": { "approved": true }
}
```

上記5項目のみ。runId一致、非空operationId、正のsafe integerの世代/revision、有限のJSON結果、64KiB以下を検証する。null root、配列root、欠落、未知field、NaN、循環、型外値を拒否する。resultの業務Schemaと権限を検証済みの操作だけを渡すことが呼出元の前提。approvedは試験用であり、Unitの業務契約ではない。

saved snapshotはWAITINGで、理由・次工程が現在のグラフのWAIT境界と一致する必要がある。Storeはrun・定義固定情報、現在のWAITING、期待世代、revision、snapshot一致、owner RELEASEDを照合する。

## 原子的claimと再開

一つのbackend Transactionで、未適用operationを確認し、新owner tokenと増加fenceを生成、Leaseを取得、操作結果/receiptを保存、WAIT_RESOLVEDを追加、次工程のRUNNING snapshotを確定する。この後にCoreがJob/Checkを実行する。再開権だけ持って状態をWAITINGのままにしない。

この最小実装では「入力を受理だけして、別workerが後日claimする二段階受付」は追加していない。認可済み要求の永続受理とclaimを同じTransactionにまとめた。要求を受け取っただけではoperation未適用。状態変更を確定してから応答する。

snapshotの前工程履歴をコピーし、その後から実行する。Checkは保存済みgetInput()を利用し、TRUEで終了Job、FALSEで差し戻し相当Job→新WAITへ進む試験を行った。同じ工程へ戻っても世代は増加し、旧世代の入力を再利用しない。

## 重複・競合応答

| 条件 | 結果 |
| --- | --- |
| 同一operationId・同一要求、FINISHED | 保存済みsnapshotを返す。claim/save/Job/履歴追加なし |
| 同一ID・同一要求、実行中/結果未確定 | OPERATION_IN_PROGRESS。自動実行しない |
| 同一ID・内容違い | OPERATION_CONFLICT |
| 異なるID、古い待機世代 | STALE_WAIT_GENERATION |
| 世代一致だが現在WAITINGではない | NOT_WAITING |
| 期待revision不一致 | REVISION_CONFLICT |
| 保存snapshotまたは定義の不整合 | RESUME_STATE_CHANGED/DATA_CORRUPT等で停止 |
| 古いHostの保存/Heartbeat | FENCED、期限切れはLEASE_EXPIRED |
| 保存後応答喪失・commit結果不明 | OUTCOME_UNKNOWN/PERSISTENCE_UNCERTAIN。照合が必要 |

claim直前に別Hostが同一操作を完了する競合も、Transaction内でreceiptを再確認して保存済み結果を返す。既存receiptを再保存しないことを決定的試験でassertした。これはローカルPortのコードであり、HTTP statusへの変換はApplication側の仕事。

## Lease・停止・結果不明

SQLiteの所有権と実行状態は同じファイル/row Transaction内で保存し、SQLite時刻を使う。Memoryではテスト用時計を注入できる。Heartbeatは有効な現ownerに限定し、Leaseは待機確定時に解放する。自動Takeover・途中Job再開・分散queueは追加していない。

| 障害注入 | 保存状態・扱い |
| --- | --- |
| WAITING commit直前にprocess.exit | Transaction rollback。直前RUNNING＋ACTIVEを保全。待機済みと断定しない |
| WAITING commit直後にexit | WAITING＋RELEASED、操作と履歴を別プロセスで読める |
| 再開要求受信直後にexit | WAITING＋RELEASED、再開operation未適用 |
| claim commit直前にexit | 全体rollback、WAITINGと未適用を保全 |
| claim commit直後にexit | RUNNING＋ACTIVE、operation未完了。同じIDでもJobを自動再実行しない |
| Job後の結果保存前にexit | 最後のRUNNINGとoperation未完了、既存Job履歴prefixを保持。公開済み成果があっても完了と断定しない |
| WAIT commit後に例外 | CoreのHISTORY_SAVE_OUTCOME_UNKNOWNに読戻し観測。確認済み待機を新しいStoreから明示再開可能 |
| claim commit後に例外 | OUTCOME_UNKNOWN。照合するとRUNNING。再送はOPERATION_IN_PROGRESSで拒否 |

上記exit試験は本当に別プロセスを終了し、DB再Openで確認した。Lease切れだけを根拠にRUNNINGをWAITINGへ戻さない。claim後の不明結果の回復・補修APIは未実装。安全側で止める範囲であり、任意の外部副作用を一度だけ実行する保証ではない。

## 試験と配布物

- 既存基準：529＋291＋27＋45＝892 PASS／0 FAIL。
- 新規：WAITING44件＋診断5件＝49 PASS／0 FAIL。
- パッケージ：2 PASS／0 FAIL。
- Build、noEmit型検査、変更JS構文検査、git diff --check：成功。
- B1の反復は修正前48/50、修正後初回49/50、追加50/50。残存保存結果不明を無条件成功へ置き換えない。

パッケージ検証用にローカル候補0.2.0-experiment.022.2を生成した。SHA-256：

`676c4f5eaa41667ed9f247866e5a5e8bffba451c2822a04ecf90093dd786dfc2`

tools/package-workflow-unit.cjsにMemory Lifecycleを./waitingとして追加。SQLiteは従来どおり配布物に含めず、ローカルAdapterとして検証した。./waitingはCommonJSの実装入口であり、rootからはCoreのIWaitingHistoryStore等の型を提供する。独立した./waiting用クラス宣言ファイルは今回未追加。

途中の候補022.1を生成した後、receipt競合の処理を改善したため、同候補を上書きせず022.2へ進めた。道場へはどちらも導入していない。現在の配布版0.1.0-experiment.021.1はそのまま残り、archive SHAを再計算して旧記録e7f97e55ed2da17adf32cb7358df39c816ed7e929ea4c7dee1b87d0aafda34c4と一致した。

変更はB2記載ファイルに加え、B1のdiagnostic/resume、新規診断試験、package.json、tools/package-workflow-unit.cjs、B1/B2/B3報告書。旧試験を削除・弱体化せず、既存未コミットのCore変更も差分として維持した。道場側コード・依存・配布物を変更していない。

## 判定・未解決事項

B2/B3のMemory/SQLiteに限定した待機・明示再開・重複/競合/古い世代拒否は実測できた。B1の保存結果不明1件は残存リスクとして保留。全体を無条件の完了判定にはしない。

Firestore WAITING Port、旧診断器による新control eventの完全な証跡照合、途中Jobの補修、外部副作用の回復、業務権限・審査仕様、旧実行の新Schemaへの移管は未対応。892件中の既存Emulator45件だけを実行し、022-B4の新契約実装には進んでいない。Emulatorはrunnerが停止済み、テスト用SQLite/子プロセスも終了済み。

Stage・Commit・Push・Deployなし。報告してレビュー待ちで停止する。
