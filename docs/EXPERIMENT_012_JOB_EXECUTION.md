# 実験012：JobFormとJob実行単位

本書は実験012の実装範囲を記録する。CMRP全体・永続化・正式な成果物Schemaの確定ではない。

## 責務

- `CWorkflowTask`：既存の抽象CJobを整理した、名前とexecuteを持つ工程の基底。CDummyJobとCCheckJobはこちらを継承する。Runnerではない。
- `CJobForm<Input, Output>`：collect/makeと任意recordの共有可能な定義。入力・出力は型引数で表す。業務別の受入検証はcollectが行う。定義に可変の実行データを置かない。
- `CJob<Input, Output>`：雛型・実行別ProductShelf・artifactKeyから生成される単一実行。状態、現在／最終工程、内部成果を保持し、collect→make→record→postを進める。
- `CWorkflow`：工程訪問、Check、遷移、run単位の状態と履歴を担当する。成果物の内容を解釈しない。

`bindJobForm`はnew CJobを返す既存入口として残し、CMRP処理はCJob.executeの一箇所へ移した。二つの実行エンジンは作らない。

## 実行

```ts
const job = new CJob(form, products, 'X');
const workflow = new CWorkflow([{no:10, job}], history);
await workflow.run('run-001', 10);
job.getState();    // status / phase
job.getRecorded(); // null またはコピーされた {value:...}
```

状態はREADY/RUNNING/COMPLETED/FAILED。phaseはnull/collect/make/record/postで、終了後は最後の工程を保持する。元例外は再送出し、Workflowの既存ERROR処理に渡す。履歴Schemaは変更しない。phaseを既存履歴へ自動保存する機能は追加していない。

recordフックと内部記録が完了した後にpostする。record前の失敗では内部成果なし、post失敗時には内部成果が残り得る。公開結果の自動推定、rollback、再送はしない。prepare/cleanupは未実装。

## 反復

```ts
let iteration = 0; // このWorkflow実行のCompositionが所有する
const jobs: CJob<number, number>[] = [];
const step = {
  no:10,
  createJob: () => {
    const job = new CJob(form, products, `X_${++iteration}`);
    jobs.push(job);
    return job;
  },
  nextStepNo:20,
};
```

createJobは工程訪問時に呼び、戻り値は新しいCJobであることを利用側が保証する。既使用CJobの再利用は拒否される。固定jobとcreateJobの両指定は拒否する。Checkは固定工程として既存の分岐先検証を使う。

反復の条件・後方遷移・maxExecutionsは既存制御のまま。Factoryは仕事データの生成・注入をCompositionへ閉じ込める。独立runには新しいWorkflow構成、Factoryの状態、ProductShelfを用意する。同じWorkflowオブジェクトの並行利用拒否も維持する。

## 既存資産

- 固定のCDummyJob・CCheckJob・構造的なexecute工程の既存利用は維持する。
- 旧抽象CJobを継承する独自実装はCWorkflowTaskへ変更する。旧抽象名の互換エイリアスは追加しない。
- DefinitionのRegistryはCWorkflowTaskを返す。保存Schemaと不正Factoryの拒否を維持する。
- 保存定義の再構築は従来どおり固定Jobを生成する。保存定義からの反復Job自動生成は今回接続していない。反復CJobにはメモリ上のcreateJob工程を使用する。
- GUI Catalogの文字列CJob/CCheckJobはGUIの既存契約であり、新しいPrototype CJobの生成APIへ自動変換しない。GUI本体は変更しない。

## 識別情報と保存準備

| 項目 | 現在の所在 | 次工程で必要な判断 |
|---|---|---|
| jobFormId | Prototype DefinitionのjobIdがRegistry論理キーに相当。CJobForm自身に新規フィールドなし | Registryキーと雛型版の対応 |
| jobId | CJobはオブジェクトとして区別。新しい永続実行IDは未実装 | 再起動後も一意な実行ID |
| workflowDefinitionId | 保存DefinitionのdefinitionId | 実行との関連保持 |
| runId | CWorkflow.run引数・RunSnapshot | 個別Jobへの永続関連付け |
| stepNo | StepとTraceEntry | Job実行IDとの関連 |
| iterationNo | 例のCompositionカウンター／履歴出現順 | 明示保存・ネスト反復の識別 |
| artifactKey | CJobの公開先キー・実行別ProductShelf | 実行／Jobとの複合識別、上書き方針 |

DB APIはCJobForm・CJobへ埋め込んでいない。ProductShelf、Job状態、内部成果はメモリのみ。SQLite対応、スキーマ変更、永続化・復元は未実装。

## 検証入口

- `npm test`：既存入口（529件）。
- `node --test tests/job-form-post-failure.test.cjs tests/job-form-check-branch.test.cjs tests/job-form-loop.test.cjs tests/job-form-execution.test.cjs`：009～012（54＋16件）。Build後に実行する。
- 合計599件。GUIは既存HTTP/DOMスタブ回帰であり、実ブラウザE2Eではない。
