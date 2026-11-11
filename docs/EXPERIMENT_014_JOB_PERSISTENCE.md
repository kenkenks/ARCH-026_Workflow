# 実験014：Job実行と成果物のSQLite観測保存

## 実装範囲

CJob/CJobForm/CWorkflowの実行処理は変更しない。既存getState/getRecordedとProductShelf.put境界を利用する。
LoaderのjobForms登録に任意onCreate(job, context)通知を追加し、生成時点で定義ID/Version・工程ID/No・JobForm論理ID・同一工程訪問回数を渡す。これは工程Hookではなく生成通知である。JobForm論理IDは保存定義のjobIdを再利用する。

SQLiteJobRunStoreはIWorkflowHistoryStoreとProductShelfのAdapterである。CJobにSQLite SDKを埋め込まず、DBを差し替える境界は既存のHistoryStore、ProductShelf、Loader生成通知となる。Runnerは追加しない。

## 識別

生成通知でNode組込みrandomUUIDを使いjobExecutionIdを一度割り当てる。Jobオブジェクトとの対応を当該runのAdapterが保持し、DBには同じIDを保存する。getIdentity(job)はコピーした識別情報を返す。IDはCJobFormに保存しない。再開用CJobの再生成・ID再割当は今回未実装。

| 情報 | 取得元 |
|---|---|
| Definition ID/Version | Compositionと保存定義。workflow_runsに保存 |
| runId | CompositionとWorkflow Snapshot |
| stepNo / stepId | 保存定義からLoaderが取得 |
| jobFormId | 保存定義の既存jobId |
| iterationNo | Loaderの工程別Factory訪問回数。今回文字列artifactKeyでも増加させる |
| jobExecutionId | 生成通知で割当。DB保存後も同じID |
| artifactKey | CJob.artifactKey、または実際のpost登録キー |

## Schema

履歴DBのapplication_idは既存0x41525255、物理user_versionは新規実験DBで2とする。v1の二表を維持し、次を追加する。

- job_executions：jobExecutionId、runId、stepNo、stepId、jobFormId、iterationNo、status、phase。
- job_artifacts：内部順序artifact_id、jobExecutionId、artifactKey、INTERNAL/PUBLISHED、JSON値の種別と本文、公開観測根拠。

同一runId＋stepNo＋iterationNoを一意とし、成果物はjobExecutionId＋artifactKey＋種別で識別する。現在値用の別コピーは保存しない。currentProductsはPUBLISHEDの保存順から各キーの最新値を投影する。公開履歴10/20/30を保持しても現在値は30となる。

v2用Schemaは既存v1 Schema SQLを再利用する。実験013のv1定数は変更しない。v1 DBをv2として通常openするとMIGRATION_REQUIRED。自動変更・既存DBのMigrationは実施しない。必要なら明示的なv1→v2 Migrationを別工程で設計する。

## 観測と保存

- onCreateでREADY/nullのJobを登録し、実在するrunに関連付ける。
- post登録前にgetRecordedから内部成果を保存する。この時点でCJobはRUNNING/post、公開成果物はまだない。
- post後は読取APIから観測した値をPUBLISHEDとして保存する。
- Workflowの通常saveでは、同一SQLite Transaction内でWorkflow Snapshot/TraceEntryと全登録JobのgetState/getRecorded、公開履歴を保存する。
- 既存SQLiteWorkflowHistoryStore.saveは、Adapterが開始したTransactionに参加できるようにした。単独呼出しの原子性は従来どおり。外側Transactionの確定・Rollbackは外側の責任である。

Job状態を別の実行機構で再計算しない。DB行は既存getterから得た観測Snapshot。phaseは現在／最後の工程であり、各工程に独立したREADY/RUNNING/COMPLETEDフラグを新設していない。テスト中にcollect/make/recordで待機してcheckpointした場合は、その時点のRUNNING/phaseを保存できる。各工程境界の自動監査ログではない。

## 公開例外と結果不明

postが正常に戻った登録はRETURNEDとして記録する。post例外後に置き場の値の変化を観測した場合はOBSERVED_AFTER_ERRORとして記録する。後者は保存操作成功の証明ではなく、値が観測されたという意味である。

例外前後で同じ値だった場合、そのJobが公開したと証明できないため、そのJobの新しいPUBLISHED履歴を捏造しない。以前の現在値は残す。この場合の公開元帰属は未確定。新しいWorkflow状態は追加しない。

公開成果物のRollbackはしない。部分公開では内部bundleと公開済みX/Yを区別する。例外エラーそのものを成果物へ自動登録しない。

## 保存失敗

Job実行情報／内部成果／公開成果／Workflow履歴の保存を故障注入で個別検証する。失敗したTransactionの更新はRollbackする。既に確定したcheckpointまでは戻さない。

保存失敗後は当該run用Adapterを保留し、後続checkpoint/saveで自動再送しない。getPersistenceFailureはコード・保存処理区分・当該実行に公開観測があるかを返す。再開APIではない。

既存CoreのHISTORY_SAVE_OUTCOME_UNKNOWNとattemptedSnapshot/cause/storageCauseを使い、Job実行結果と保存結果を区別する。例えばJobがCOMPLETEDでも最終履歴保存が失敗すれば、DBには前のRUNNING/post観測値が残り得る。逆に、メモリ上は公開済みでもPUBLISHED保存が失敗すればDBには内部成果だけが残る。最新状態を保存済みと報告しない。

## 読戻しと制約

readRun(runId)はWorkflow Snapshot/履歴とJob実行・成果物をDBから返す。currentProducts(runId)もDBだけで計算する。テストでは書込接続を閉じ、新しいAdapter/接続（Job参照なし）から確認する。複数Hostが動作中の全表横断スナップショット読取りは未検証。

保存値は有限数値・文字列・boolean・null・通常のオブジェクト/配列のJSONデータに限定する。NaN、Infinity、undefined等の暗黙変換は拒否する。一般的な任意オブジェクト保存ではない。

中断再開、Job再実行、分散所有、別DBとの原子性、公開Rollback、prepare/cleanup、GUIは未実装。実験DBは専用一時directoryに新規生成し、全接続close後に削除する。実運用DBは使用しない。

## 検証

```text
npm test
node --test tests/job-form-post-failure.test.cjs tests/job-form-check-branch.test.cjs tests/job-form-loop.test.cjs tests/job-form-execution.test.cjs tests/job-form-sqlite.test.cjs tests/job-execution-sqlite.test.cjs
```

既存620件＋追加21件＝641件。package.jsonは従来の529件入口のまま変更しない。追加ファイルは明示的に別実行する。
