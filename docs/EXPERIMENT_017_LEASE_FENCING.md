# 実験017：Lease・Heartbeat・Fencing

## 結果と適用範囲

同一マシンのローカルSQLiteファイルを共有する複数Nodeプロセスで、Lease更新・期限切れTakeover・旧所有者の保存拒否を実測した。既存707件＋追加35件＝**742 PASS／0 FAIL**。npm test 529件、実験009〜017の別実行213件。Build・型検査・JS構文検査・差分チェックも実施。

成立範囲はAdapterを経由する協調したSQLite保存である。ネットワーク共有FS、別マシン間の時刻整合、電源断の実機試験、任意の直接SQL更新、外部副作用の重複防止は保証しない。Lease期限切れやTakeoverが、自動再開を開始することはない。

## 現物調査と再利用

実験016の管理DBはapplication_id `0x41525243`／Version 1で、`binding`、`claims`、`resume_events`を持つ。claimTokenはUUIDであり、STOPPED以外の再claimは禁止されていた。履歴DBは別ファイル（実験014のVersion 2）。再開時は管理DBをATTACHし、同じSimpleDB TransactionでToken照合と保存を行っていた。

この所有権処理を`src/adapters/job-execution/ownership.cjs`へ分離・共通化し、Version 1とLease用Version 2を同じ実装で扱う。`resume.cjs`は同じ共有predicateを、Job生成時checkpoint、内部成果、公開成果、Workflow履歴の保存、および工程開始前に使う。CWorkflow／CJob／CJobForm・遷移・既存TraceEntryは変更しない。

## Lease管理Schema

Lease用の管理DBだけをVersion 2として新規・明示作成する。既存の管理DB Version 1、履歴DB Version 2、定義DB Version 1は自動更新しない。Version 1ファイルをLeaseモードで開くと拒否する。実運用データや既存DBのMigrationは行っていない。

| 保存項目 | 責務 |
|---|---|
| binding.history_file | 対象履歴DBのrealpath照合 |
| binding.lease_ms | 管理DB作成時のLease長。1〜3,600,000ms、既定30,000ms |
| claims.run_id | runごとの一意キー |
| owner_id | 所有Host識別子 |
| claim_token | 取得ごとに変わるUUID。所有権資格の一致確認 |
| fencing_token | runごとに1から始まる単調増加の整数世代 |
| lease_expires_at | SQLite時刻基準の有効期限（Unixミリ秒） |
| updated_at | 取得・Heartbeat・releaseのSQLite時刻 |
| state / fingerprint | 既存のCLAIMED／ACTIVE／STOPPED／FINISHEDとinspect指紋 |

新しいclaim／Takeoverごとに世代を増加させる。releaseでも行を消さず、世代を保持する。同じownerIdによる再取得でもUUIDは変わり、旧Tokenは復活しない。安全な整数の上限に達した場合は取得を拒否する。

## APIと実行順序

```js
const api = require('./src/adapters/job-execution/resume.cjs');

// 初回のみ。既存ファイルへの上書きや暗黙Migrationはしない。
api.initializeResumeControl(controlFile, historyFile, {lease: true, leaseMs: 30000});
const options = {historyFile, definitionFile, controlFile, runId, lease: true};

const inspection = await api.inspect(options, simulationPolicy);
const ownership = await api.claim(options, inspection, 'host-A');
api.heartbeat(options, ownership);
// 実験016と同じ新規JobForm／Check Registryを渡す。
const result = await api.resume(options, ownership, registryFactory);
```

Heartbeatは明示APIであり、自動タイマーや自動再送は追加していない。HostはLease期間内にHeartbeatを呼ぶ。長い非同期Jobの待機中も別操作として更新できるが、イベントループが同期処理で塞がると更新できない。

所有者が終了した場合：

```js
const nextOwnership = await api.takeover(options, simulationPolicy, 'host-B');
const inspected = await api.inspect(options, simulationPolicy);
// ready=falseなら停止。所有権取得はJob実行の許可ではない。
if (inspected.ready) await api.resume(options, nextOwnership, registryFactory);
```

`takeover()`は所有権だけを取得できるため、診断が要確認でも取得自体は成立し得る。`resume()`は必ず再診断・指紋・確定境界・必要成果物・Version・Registryを再確認する。

`release(options, ownership)`は正しい未期限切れ所有者だけが呼べる。正常再開終了時は共通release処理を同じ終了Transaction内で実行する。COMPLETED／FAILEDはFINISHED、再びLIMIT_REACHEDならSTOPPEDとなる。STOPPEDからの新しい明示claimは世代を増やす。期限切れ後のHeartbeat／release、旧所有者のreleaseは拒否する。終了保存後にreleaseが失敗してもJobを自動再実行しない。

## SQLite時刻とHeartbeat

取得、期限判定、Heartbeat、releaseは`CAST(unixepoch('subsec') * 1000 AS INTEGER)`でSQLiteから時刻を取得する。呼出元が渡す現在時刻やJavaScriptのDateをLease判定に使わない。Heartbeatは同じTransactionでowner／UUID／世代／状態／未期限切れを確認し、期限を延長する。期限に達した時点（expires <= now）で失効する。

これはSQLiteのVFSが参照する同一OSの時計を使う構成であり、独立した時刻サーバーや単調時計を実装したものではない。OS時計の巻戻り・急変や別マシン間の時計差は未保証。SQLite時刻の仕様は[Date And Time Functions](https://www.sqlite.org/lang_datefunc.html)を参照。

## 原子的Fencing

保存時に、履歴DBとATTACHした所有権DBを**同じ接続のBEGIN IMMEDIATE Transaction**に含める。

1. Journal／同期設定を確認する。
2. runId、ownerId、claimToken、fencingToken、state、Leaseを照合する。
3. 所有権行への書込予約を取得する。
4. 同じTransaction内で履歴・Job・内部成果・公開成果を更新する。
5. COMMITする。途中例外なら既存SimpleDBのRollback／OUTCOME_UNKNOWN分類を使う。

検証と書込の間にawaitを入れない。LeaseがTransaction中に期限へ達しても、別HostのTakeoverはそのTransaction完了まで取得できない。旧所有者の更新は新世代取得より前に直列化され、新世代取得後の旧更新は拒否される。Lease期限が「COMMIT完了時まで有効である」ことを別途保証する方式ではない。

守る対象はAdapter経由のSQLite更新である。保存前に実行された外部処理や、進行中のmake等を巻き戻すことはできない。旧Hostを再開させる試験では、post前checkpointが拒否され、後続の成果保存とFAILED保存も受理されなかった。実際の保存像がRUNNINGで残る場合は診断をREVIEW_REQUIREDとし、完了と断定しない。

## 複数DBのJournal・クラッシュ制約

Leaseモードではmain／管理DBの両方にDELETE Journalを要求し、接続のsynchronous=FULLを確認する。WAL、MEMORY、OFF等へ暗黙変換せず、利用を拒否する。各保護Transactionでも設定を確認する。

SQLiteは、mainがディスク上のDBでWALを使用しない条件で、ATTACHした複数DBのTransactionを原子的に扱う。[ATTACH DATABASE](https://www.sqlite.org/lang_attach.html)および[Atomic Commit](https://www.sqlite.org/atomiccommit.html)に記載されたJournal／Super-Journal、OSロック、fsync、ファイルシステム・ストレージの正常動作を前提とする。

今回はローカルファイルで、Transaction途中のNode強制終了後に両DBの未確定変更が復元されることを実測した。物理的な電源断、ディスク故障、壊れたロック実装、ネットワークFSまで検証済みとはしない。分散Transactionの保証でもない。

## 追加35試験の検証範囲

- 取得・Heartbeat延長・不正owner／UUID／世代の拒否・期限切れ後の更新拒否。
- release後のToken失効、同じHost名での再取得でも世代増加。
- 旧Nodeプロセスの履歴、Job、内部成果、公開成果の更新をそれぞれ拒否。
- 複数Nodeの同時claim／同時Takeoverで成功は1件だけ。DBロック競合は拒否し、自動再試行しない。
- HeartbeatとTakeover、期限切れreleaseとTakeoverの競合。
- 異なるrunIdを別Nodeプロセスで独立再開。
- claim直後のHost終了、SQLiteの実時刻による期限切れ、引継ぎ後の安全境界からの再開。
- Heartbeat停止、およびHeartbeatのTransaction内での強制終了・未確定延長のRollback。
- 保存直前／未確定書込後のHost終了、両DBのRollbackと他run保全。
- Token照合後にファイルBarrierで停止し、別NodeのTakeoverがTransactionへ割り込めないこと。
- Transaction待機中にSQLite時計で実際にLeaseを失効させても、Takeoverはロック終了まで不成立。
- Takeover後の旧Host復帰で保存拒否。新Hostも要確認状態からは再開しない。
- 不足成果、不正Version、矛盾、不明postは所有権取得後も再開拒否。
- WAL／同期OFFの拒否、旧管理Version 1の暗黙変更防止。

短い期限切れの論理ケースには、テスト用DBへの期限列の故障注入も使う。実期限の試験ではSQLite時刻をポーリングし、Hostから偽の現在時刻を入力しない。Barrier／故障注入はテストfixtureだけで、本体に待機フックを追加していない。

```text
npm test
node --test tests/job-form-post-failure.test.cjs tests/job-form-check-branch.test.cjs tests/job-form-loop.test.cjs tests/job-form-execution.test.cjs tests/job-form-sqlite.test.cjs tests/job-execution-sqlite.test.cjs tests/job-run-diagnosis.test.cjs tests/job-run-resume.test.cjs tests/job-run-lease.test.cjs
```

## 変更範囲と実験018への引継ぎ

- 変更：`src/adapters/job-execution/resume.cjs`（所有処理を共通モジュールへ移し、Lease APIを接続）。
- 新規：`src/adapters/job-execution/ownership.cjs`。
- 新規：`tests/job-run-lease.test.cjs`、`tests/job-run-lease/host.cjs`。
- 新規：本書。

Core、JobForm、CMRP、実験015診断、履歴／成果物の既存保存Adapter、GUI、package.json、保護対象の既存文書は変更しない。DB作成・故障注入は専用一時領域のみ。

実験018では外部副作用の冪等性、世代を外部保存先へ伝える契約、結果不明時の照合を検討する必要がある。所有権喪失前に始まった外部処理の完全停止、状態不明のJobの自動再実行、OS時計急変、実環境への管理DB Migration、他マシン・他保存先への展開は今回未対応。実験018には着手しない。
