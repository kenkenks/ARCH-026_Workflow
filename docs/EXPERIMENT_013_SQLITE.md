# 実験013：SQLite模擬業務DBと保存定義からのJobForm実行

## 構成

Node 24組込みnode:sqlite（検証環境v24.16.0、SQLite 3.53.0）と既存SimpleDBを使う。依存パッケージ追加なし。
既存DBを変更・自動Migrationしないため、独立した三つの実験DBを使用する。

| DB | application_id / user_version | テーブル |
|---|---|---|
| Definition | 既存0x41524348 / 1 | 既存workflow_definitions（ID＋Version、Schema Version、定義JSON） |
| 模擬業務 | 新規0x41524558 / 1 | members、exam_applications、exam_results |
| 実行履歴 | 新規0x41525255 / 1 | workflow_runs、workflow_history |

模擬業務DBはmember ID、application ID、resultのapplication IDを主キーとする。申請→会員、結果→申請に外部キー制約を設ける。実験用のPASS/FAILとscore 0～100のみを使用する。道場の正式Schemaではない。

workflow_runsはrunId、Definition ID/Version、Snapshot JSONを保存する。workflow_historyはrunId＋履歴順序を主キーとし、工程No・Job名・DONE/TRUE/FALSE/ERROR・次工程No・TraceEntryの日時・任意エラー文字列を保存する。既存の履歴prefixを変更・削除するsaveは拒否する。全Snapshotと履歴行を一つのTransactionで保存し、読込時も二表の整合性を確認する。既存MemoryHistoryStoreのDTO検証・コピー境界を再利用している。

開始／終了日時はSnapshotに存在しないため推測して保存しない。TraceEntry.atは既存の履歴作成日時として保存する。Definitionの表示名も現行Schemaにはないため追加していない。

## 再構築

既存のvalidatePrototypeDefinition / loadWorkflow / reconstructWorkflowを使用する。保存Schema prototype-workflow/1は変更しない。

WorkflowRegistryに任意のjobFormsを追加した。

- definitions：既存jobId → 共有CJobForm＋公開先artifactKey。
- products：当該Workflow実行のProductShelf。
- artifactKeyは文字列、または(context, iterationNo)からキーを返す関数。iterationNoは当該工程の実行別Factoryが保持する。

既存jobs Registryとの同一ID二重登録はAMBIGUOUS_JOBで拒否する。未知JobForm/Checkは全件解決確認で実行前に拒否する。JobForm登録はメモリ上のcreateJob工程へ変換し、訪問するたびnew CJobを生成する。旧jobs Registry経路は従来の固定Jobのまま。

MockExamRepository Portを使うcreateMockExamJobFormsが会員・申請・結果取得の三つの雛型を返す。入力requestを実行別ProductShelfへ置き、member→application→examResultを順に公開する。雛型はSQLite SDKを参照せず、CWorkflow・CJob・CJobFormの実行契約は変更しない。

SQLiteWorkflowHistoryStoreはDefinition ID/VersionをCompositionから受け取る。所有者がDBを明示initialize/open/closeする。loadは未存在ならundefined（既存History Store契約）、業務Repositoryの取得は未存在ならnullを返す。

## 障害と保証範囲

- 業務データ不存在はBUSINESS_NOT_FOUND、型・関連不整合はBUSINESS_INPUT_INVALID。技術的DB障害UNAVAILABLEとは別。
- 通常のJob失敗はCWorkflowのFAILED/ERRORへ伝播し、書込可能なら保存される。
- 履歴保存失敗は既存HISTORY_SAVE_OUTCOME_UNKNOWN。Job失敗と同一視せず、attemptedSnapshot・cause・storageCause・観測結果を確認する。失敗履歴を保存できなければDBにRUNNINGが残ることがある。
- 読戻しは状態観測であり、保存呼出し成功の証明ではない。自動再送・自動Rollback・resumeを追加しない。
- 個々の履歴saveのTransactionは再利用するが、業務DB・Definition DB・履歴DB・メモリ成果物を横断する原子性はない。
- テストの並行性は同一Nodeプロセス・異なるrunId・別接続で検証。SQLite同期Transaction区間は直列実行される。同一runIdの複数Host所有、分散排他、Job副作用のexactly-onceは保証しない。
- Job実行ID、CMRP工程状態、内部成果、完成品置き場の永続化は未実装。新しいエラーSchema・Ticket/Instanceの保存も追加しない。

## 実験DBと再現

`seedMockExam()`は新規実験DBへM001/M002、A001/A002、PASS/FAILを追加する。重複時は拒否し、既存データの削除・更新はしない。

テストはos.tmpdir配下の専用directoryに三つの.sqliteを生成し、別接続で読戻す。全接続を閉じ、finallyで当該directoryだけを削除する。DBは保持しない。既存.gitignoreの*.sqlite等が利用可能で、除外設定の変更は不要。

```text
npm run build
node --test tests/job-form-sqlite.test.cjs
```

追加21件：別接続、固定版、保存定義からのJob生成/反復、PASS/FAIL、逐次/両完了順の並行、入力不存在、読取/書込障害、二重障害、Transaction保全、履歴破損、Definition識別、DB種別誤接続を検証する。

全回帰はnpm testの529件と、009～013の別実行91件を分ける。合計620件で二重計上しない。既存資料の実験012時点の「保存定義からのJobForm反復未接続」は、本実験のjobForms Registry接続によって限定的に解消した。
