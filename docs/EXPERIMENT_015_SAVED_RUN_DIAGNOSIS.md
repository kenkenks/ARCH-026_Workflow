# 実験015：保存済み実行状態の診断

本実験は診断のみ。再開・Job再実行・post再送・修復・Migrationは実装しない。

## 配置と利用

- `src/prototype/diagnosis.ts`：保存済みDTOを検査する純粋関数 `diagnoseSavedRun()`。
- `src/adapters/job-execution/diagnostic.cjs`：`readDiagnosticInput()` / `diagnoseSQLiteRun()`。SQLite専用読込境界。
- `tests/job-run-diagnosis.test.cjs`：一時DB、Promise待機、保存故障注入、診断DTOの矛盾注入による36試験。

Build後の利用例（指定ファイルは既存の実験用DBとする）：

```js
const { diagnoseSQLiteRun } = require('./src/adapters/job-execution/diagnostic.cjs');
const diagnosis = await diagnoseSQLiteRun({
  historyFile: '/absolute/path/runs.sqlite',
  definitionFile: '/absolute/path/definitions.sqlite',
  runId: 'run-001',
});
```

実行履歴DBは実験014のapplication_id／物理Version 2、定義DBは既存Definition保存のapplication_id／Version 1を読む。通常の書込可能openやinitializeは呼ばず、`DatabaseSync(..., {readOnly:true})`を使う。履歴側のSnapshot・正規化Trace・Job・成果物は一つの読取Transactionで取得する。定義は独立DBから別途取得するため、両DB全体の原子的Snapshotは保証しない。既存Definitionの不変性を前提とする。

## 観測データと判定

入力はrunId、Definition ID／Version、Workflow SnapshotとTrace行、Job ID／stepNo／stepId／jobFormId／iterationNo／status／phase、内部・公開成果の値・型・公開観測根拠。取得には生存中のJob、メモリ完成品置き場、実験014の保存Observerを必要としない。

結果の`observed`は保存値、`inferred`はJob訪問と履歴の対応・公開行から導出した最新公開情報。`evidence`は判定根拠、`warnings`は注意、`unresolved`は不明事項である。成果物本文は診断結果に複製せず、識別情報・型・公開根拠を返す。入力DTO取得関数は本文も保持する内部調査用境界であり、そのまま外部公開するAPIではない。

| 分類 | 本実験での条件 | 実測 |
|---|---|---|
| COMPLETED | 保存上COMPLETED、定義経路・履歴・取得できたJob／成果行に検出矛盾や未確定根拠なし | 通常完了、業務FAIL、3反復 |
| RESUMABLE_CANDIDATE | 整合するLIMIT_REACHEDの保存境界、取得できたJob完了、未確定公開なし | 反復途中の上限停止 |
| REVIEW_REQUIRED | 保存RUNNING／FAILED、公開操作不明、内部成果のみ、取得不能など | post待機、公開後例外、同値公開例外、保存障害 |
| INCONSISTENT | 定義・履歴・Job・成果物の構造または相互関係に検出矛盾 | DTO故障注入、保存JSON破損 |

分類はWorkflow状態を変更しない。COMPLETEDは保存された制御フロー完了の診断であり、業務受入・最終出力充足・外部副作用の成功保証ではない。旧CDummyJob等にJob実行行がない場合はTraceだけの観測として警告し、存在しないCJob状態を補完しない。

候補は自動再開許可ではない。所有権、現在稼働中か、外部副作用、チェックや仕事の再生成条件は未確定。FAILEDは自動的に候補へ分類しない。

## 整合性検査と反復

既存Memory History DTO ValidatorとDefinition Validatorを再利用する。履歴の連番、Snapshotとの一致、定義から辿った実遷移、現在位置、Jobのrun／定義参照、ID重複、状態と工程、訪問連番、成果物参照と公開根拠を検査する。

同じstepNoのn回目のJobを、その工程のn回目のTraceへ対応付ける。3反復でiteration 1/2/3はhistory order 1/3/5に対応した。同じ成果物キーの公開行はすべて残し、artifactId順の最後を「最新の保存済み公開」として導出する。現在の外部保存先の値や、新しいJobによる同値公開成功を証明するものではない。

制約により挿入不能な重複・孤立参照等は診断DTO側で注入し、SQLiteの本番用制約は緩めない。FAILEDと公開済み成果の共存、LIMIT_REACHEDと完了Job、反復、同一キー再公開、業務FAILを矛盾扱いしない。factory／Observerの例外によりERROR TraceとREADY Jobが共存するケースも、Job失敗を捏造せず要確認とする。

## 不確実性・保存失敗

- 内部成果あり／公開行なし：post未開始の証明ではない。公開後の保存障害でも同じ保存像になる。
- OBSERVED_AFTER_ERROR：値の変化を観測した根拠であり、公開操作の確定成功ではない。
- 同値公開後の例外：新しい公開行がなくても旧公開行を新しいJobへ帰属させない。
- 保存RUNNING：最後の保存状態だけを示す。現在の稼働／停止や保存されなかったFAILEDは分からない。
- Job行・内部成果・公開成果・Traceの保存障害、beforeStep失敗後のFAILED保存障害を実際に注入し、保存像はREVIEW_REQUIREDとなった。他runの診断は不変。

正常なFAILEDや部分公開の完全な回復手順は提供しない。成果物の期待個数・内容の受入条件が永続化されていないため、部分公開の完全性を自動証明することもできない。

## 検証と保証範囲

```text
npm test
node --test tests/job-form-post-failure.test.cjs tests/job-form-check-branch.test.cjs tests/job-form-loop.test.cjs tests/job-form-execution.test.cjs tests/job-form-sqlite.test.cjs tests/job-execution-sqlite.test.cjs tests/job-run-diagnosis.test.cjs
```

独立した読取接続で同じ診断が得られ、診断前後の両DBのSHA-256とディレクトリ内ファイル一覧が不変であることを試験する。返却結果を編集しても次回診断は不変。実DBのMigrationや書込、履歴・既存状態Schemaの変更は行わない。

実験016以降への引継ぎ候補：再開判断に必要な所有権・副作用・公開確定根拠、状態復元の対象範囲、同値公開の識別、Job／Check再生成の契約。今回はいずれも確定・実装しない。
