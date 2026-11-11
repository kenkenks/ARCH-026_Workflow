# 実験016：Workflow中断・再開の最小実装

## 対象と制約

外部副作用のない模擬Jobを、確定した工程境界から明示的に継続する実験。自動復旧・Job再試行・post再送・補償処理は実装しない。中断には既存の実行上限による`LIMIT_REACHED`を利用する。新しいWorkflow状態や中断要求APIは追加していない。

`RUNNING`、`FAILED`、`COMPLETED`、診断の`REVIEW_REQUIRED`／`INCONSISTENT`からは再開しない。Check途中、post途中、保存結果不明も対象外。FAILEDからの安全な再開地点は今回確立していない。

## 既存制約と最小変更

- 従来の`CWorkflow.run()`は保存済みrunIdを拒否するため、明示的な`resume(saved, maxExecutions, beforeStep?)`を追加した。
- 通常実行と再開は同じ内部`executeRun()`を使用する。分岐・後方遷移・ERROR処理のロジックは二重実装しない。
- `resume()`は保存Snapshot一致、LIMIT_REACHED、履歴連番、ERRORなし、最終確定遷移先を検証する。履歴を複製して継続し、上限は今回追加する実行回数として扱う。
- `reconstructWorkflow(..., {history})`で各工程の訪問済み回数を引き継ぐ。JobForm工程は引き続き訪問時Factoryで新しいCJobを生成する。完了済みCJobは復元・再生成・再実行しない。
- CJobForm、CJobのCMRP、Checkの遷移意味論、既存TraceEntry、既存SQLiteの物理Schemaは変更しない。

Coreの再開入口自体はSQLiteやclaimを知らない。所有権・保存情報の診断・必要成果物の確認は下記Adapterが担当する。Core入口を直接呼ぶだけでは所有権は保証されない。

## inspect → claim → resume

`src/adapters/job-execution/resume.cjs`の独立した操作を使用する。新しいRunner階層はない。

```js
const {initializeResumeControl, inspect, claim, resume} =
  require('./src/adapters/job-execution/resume.cjs');

// 一度だけ明示的に管理DBを作る。既存ファイルは上書きしない。
initializeResumeControl(controlFile, historyFile);
const options = {historyFile, definitionFile, controlFile, runId};
const policy = {
  sideEffectFree: true,
  definitionId: 'example', definitionVersion: '1',
  jobFormIds: ['a', 'b', 'c'], checkIds: [],
  requiredArtifacts: ['X'],
};
const inspection = await inspect(options, policy);
if (!inspection.ready) { /* reasons / diagnosisを調査し、実行しない */ }
else {
  const ownership = await claim(options, inspection, 'host-A');
  const result = await resume(options, ownership, ({products, onCreate}) => ({
    jobs: new Map(),
    checks: new Map(),
    jobForms: {definitions: forms, products, onCreate},
  }));
}
```

`forms`は今回の模擬処理の登録Map。入力は復元された完成品置き場からcollectし、実行固有の可変状態をJobFormに保持しない。Checkも新しいFactoryから生成し、未実行Checkの条件は復元成果物から評価できる構成に限定する。状態を持つCheckの内部index等は復元しない。

### inspect

実験015の読取専用診断を再利用する。候補判定だけで許可せず、固定Definition ID／Version、JobForm／Checkの許可ID、必要成果物、すべての実行済みJobの完了とTrace対応、単一内部成果と同一キー・同一内容のRETURNED公開を要求する。複数成果の部分公開／fan-outは今回の再開対象外。

`sideEffectFree`とRegistryは、実験用Compositionを構築する呼出元の明示的な前提である。任意のJavaScript関数の副作用や実装版を自動証明する機構ではない。成果物・履歴・定義・policyを含むSHA-256指紋を作る。診断根拠と拒否理由を返し、書き込まない。

### claim

再読込・再診断・指紋照合を行い、SQLite Transaction内でrunId単位にownerId／UUID claimToken／状態を保存する。同じrunIdには一つの所有者だけが成功する。異なるrunIdは独立して取得できる。

### resume

Token照合、再診断・指紋照合、公開成果の復元、Registry解決後、Transaction内で保存像を再確認してACTIVEへ進める。必要なJobFormが解決できなければJobは実行しない。保存Snapshotの`currentStepNo`と最後の確定Traceの`nextStepNo`を使い、stepNoの加算はしない。

確定済みCheckのTRUE／FALSEは保存された進路を使い、評価し直さない。Check直前の確定境界では新しいCheckを評価する。新しいJobには新しいUUIDが割り当てられ、既存JobのID／状態／履歴は保存されたまま残る。

## 所有権の保存とToken照合

既存履歴DBは実験014のVersion 2、定義DBはVersion 1を維持する。所有権は別の明示作成SQLite管理DB（application_id `0x41525243`、Version 1）へ保存する。既存DBへのテーブル追加や暗黙Migrationは行わない。

- `binding`：対象履歴DBのrealpath。別の履歴ファイルへの誤用を拒否。
- `claims`：runId主キー、ownerId、claimToken、状態、inspect指紋。
- `resume_events`：runId／owner／Token、イベント、履歴件数、再開工程、記録日時。

状態はCLAIMED → ACTIVE → FINISHED、またはACTIVE → STOPPED（再びLIMIT_REACHED）である。STOPPEDのみ、新しいinspectと明示claimで新Tokenを取得できる。古いTokenでは再開できない。例外・保存結果不明ではACTIVEを自動解除せず、要確認として残す。

再開接続に管理DBをATTACHし、既存SimpleDBの同期Transaction内でToken／owner／ACTIVE照合と管理行への書込予約を行ってから履歴・Job・成果物を保存する。各工程の開始前にも照合する。Transaction内にawaitは持ち込まない。今回の模擬Jobは非同期待機中にDBのTransactionを保持しない。

これはSQLite接続間の協調した再開操作の排他である。DBファイルを直接変更するプログラムや、claim非対応の旧保存コードまで強制的に排除する仕組みではない。元の実行はLIMIT_REACHEDで終了していることを前提とする。複数ホストの共有ファイルシステム・分散Transaction・Host死亡・期限切れ・強制奪取は未保証。

## 成果物と履歴

保存済みPUBLISHED行のartifactId順で最新値を選び、新規メモリ完成品置き場へ復元する。INTERNAL行は復元元にしない。X=10→X=20なら復元値は20、過去の公開行は両方残る。復元処理自体は新しい公開行を作らない。

既存Snapshotの履歴prefixを維持し、新しいTraceを連番で追記する。STARTED／終了結果は管理DBの`resume_events`へ記録し、TraceEntryにRESUME等の新種別を足さない。イベントのSTARTEDは再開全体の成功を意味しない。保存結果不明時はDBを照合して判断し、自動再送しない。

## 実測と試験

- A(10)→B(40)後の確定境界からC(90)だけ実行。A／B呼出しゼロ、X=20復元、Z=30。
- Check TRUE→80、FALSE→200を維持し、完了済みCheck評価ゼロ。未実行Checkは新しく一度評価。
- 後方遷移で10から継続、同一工程のiteration 1/2/3、新旧UUID独立、公開X=1/2/3を保持。
- 同一runIdの二重claim・二重resume・不正Tokenを拒否。異なるrunIdは非同期待機も並行。
- Tokenの故障注入後は成果公開と保存を受理しない。
- 不明post、Check実行途中、矛盾、破損Snapshot、成果不足、内容不一致、未知JobForm、Version不一致、変更済みinspect、COMPLETEDを拒否。
- 別Nodeプロセスで保存ファイルだけから再開し、Cだけを実行。別プロセスからの二重claimも拒否。
- 再開後Jobの例外は既存ERROR／FAILED処理となり、過去の成功履歴を変えない。

追加試験は`tests/job-run-resume.test.cjs`、子プロセスfixtureは`tests/job-run-resume/child.cjs`。専用一時ディレクトリだけを作成・変更・削除する。

検証結果：既存677件＋追加30件＝707 PASS／0 FAIL（npm test 529件、別実行178件）。Build、型検査、JS構文検査、差分チェックもPASS。既存JobForm、診断、実験014保存Adapter、package.jsonおよびarchitecture文書の保護対象ハッシュは着手時と一致した。

```text
npm test
node --test tests/job-form-post-failure.test.cjs tests/job-form-check-branch.test.cjs tests/job-form-loop.test.cjs tests/job-form-execution.test.cjs tests/job-form-sqlite.test.cjs tests/job-execution-sqlite.test.cjs tests/job-run-diagnosis.test.cjs tests/job-run-resume.test.cjs
```

## 実験017への引継ぎ

ACTIVE／CLAIMED所有者の死亡時は保留を残す。期限・心拍・強制奪取・失効後の書込防止・判断根拠を次工程で検討する。外部副作用の冪等性、Check固有状態の復元、複数成果の原子的公開、FAILED／RUNNINGからの復旧、実行コード版の管理は今回確立していない。
