# SimpleDB Schema Migration（最終フェーズ）

## 現物調査と実装範囲

基準HEAD: `a448cfc523e7b3adefa95ab4f3e72d63c8c1ffe9`。
Definition DBはapplication_id `0x41524348` / user_version `1`、Data DBは`0x41524441` / `1`だった。
両DBは独立したまま。今回はDataの物理v1→v2を実装し、Definitionはv1を維持する。

Data v2で追加するのは以下の非一意indexのみ。既存列・主キー・JSON・Revisionは変更しない。

```sql
CREATE INDEX data_records_collection_revision ON data_records(collection,revision);
```

collection/Revisionによる診断検索用のindexであり、新規業務APIや既存CAS方式の変更ではない。
テストでは全行の値（JSON文字列の表記、BLOB ID/collection、Revisionを含む）の指紋が一致することを検証する。
Data Migrationの論理Schema 1→2（name→label）とは独立した変更。
任意のDDL、列追加、データ変換、DB系列統合がすべて実証されたとは扱わない。

実運用DBを探索・変更する処理は実行していない。検証対象は新規一時directory内のDBのみ。
この実装は既存DBの自動変更を必要としない。通常Openは旧Data v1へMIGRATION_REQUIREDを返し、そこで停止する。
明示適用の前に対象を確認し、競合するwriterを停止する。対象DBの保全・復元手順の整備は実運用へ適用する前の別作業とする。
既存ファイルへのinitialize、自動Upgrade、暗黙のdowngradeは行わない。

## 配置とRegistry

- `src/adapters/simpledb/database.cjs`: 既存接続/同期Transaction/エラー処理。Openに既知旧版のMIGRATION_REQUIRED通知を追加。
- `src/adapters/data/simpledb.cjs`: DATA_STORAGE_SCHEMA（新規DB用v2）、DATA_STORAGE_SCHEMA_V1（明示的な旧版参照）、index DDL。
- `src/adapters/simpledb/schema-migration.cjs`: 既定Registryを注入する互換入口（末尾の汎用化記録参照）。
- `src/adapters/simpledb/schema-migration-engine.cjs`: Registry明示指定の汎用Planner/Executor。
- `src/adapters/simpledb/schema-migration-registry.cjs`: ARCH標準Data／Definition Registry。Definition/Dataの論理Migrationを変更しない。
- `tools/schema-migration.cjs`: Dry Runと明示適用の別入口。

RegistryはDB種別、application_id、既知Versionの物理Schema、順序付き経路、Migration ID、同期apply/verifyを明示登録する。
現在の既定経路はdataの`data-v1-v2-collection-revision-index`のみ。definitionは既知v1・経路なし。
未知DB種別/Version、欠落経路、逆方向、同じFromからの分岐、重複ID、async関数を拒否する。
Registryは信頼済みローカルコードであり、DBや計画JSONからコードを読み込まない。
検証コードは副作用なく同期実行する契約。Registryのコード・意味を変える場合はMigration ID/版の管理が必要。

## Planner / Dry Run

```text
npm run build
node tools/schema-migration.cjs dry-run data <test-db.sqlite> 2
```

標準出力をUTF-8のplan.jsonとして保存する。Node APIも利用可能:

```js
const {planSchemaMigration, executeSchemaMigration} =
  require('./src/adapters/simpledb/schema-migration.cjs');
const plan = planSchemaMigration(testDbPath, {kind: 'data', targetVersion: 2});
console.log(JSON.stringify(plan, null, 2));
```

PlannerはファイルをreadOnlyで開く。存在しないファイルを作成しない。
application_id/user_version、sqlite_schemaの既知物理定義との一致、quick_check、論理payload/ID/Revisionを検証する。
物理定義はSQLite自身が同じ登録DDLから生成したin-memoryの期待定義と照合する。
SQL本文の同値性を一般判定する機能ではなく、登録済みbaselineとの一致を要求する（無関係な追加table/index/triggerも拒否）。
期待定義作成の書込はin-memory DBのみで、対象ファイルのSchema/Version/データは変更しない。
計画には元Version/物理指紋/全行指紋/件数、目標Version、Migration ID/from/to、Registryと計画の指紋を記録する。
指紋は改変検出であり署名や認可ではない。計画と対象パスは信頼済みの明示指定を前提とする。
Schemaが既に目標版なら経路は空。新しい計画の適用はNO_OPになる。

## 明示適用とTransaction

```text
node tools/schema-migration.cjs apply <test-db.sqlite> <plan.json>
```

API: `executeSchemaMigration(testDbPath, plan)`。
コマンドの対象パスにはテスト用DBのみを指定する。既存実運用DBの移行・自動バックアップ/復元は今回実施しない。
CLIは自動初期化・自動計画適用をせず、結果JSONを表示する。通常Openからこの処理を呼ばない。

1. 計画指紋、Registry、登録経路の一致を検査。
2. DB種別/Version、現物Schema、全行指紋を再照合。
3. BEGIN IMMEDIATE後にもう一度同じ前提を確認。
4. 登録stepをFrom→To順に同期実行。期待物理Schemaを検査。
5. 同じTransaction内でuser_versionを更新。
6. quick_check・論理データ・全行不変性・登録verifyを検証し、verify後も再確認。
7. 全stepをまとめてCOMMIT。commit後にもSchema/Version/データを確認してcloseする。

既存SimpleDB.transactionを再利用し、async callback/thenableを拒否する。
callbackのSQL contextは同期呼出し中のみ有効。SQLite authorizerでTransaction制御・attach/detach・PRAGMA書込を拒否する。
SQLはAdapter内だけで扱い、外部通信は行わない。任意のJSを安全に実行するsandboxではない。
全stepのDDLとuser_versionは**一つのDB Transaction**で確定する。複数DB横断の原子性はない。

Node v24.16.0で検証。authorizer APIに対応するNode 24（24.10以降）が必要。
参考: [Node SQLite](https://nodejs.org/download/release/v24.16.0/docs/api/sqlite.html)、[SQLite Transactions](https://www.sqlite.org/lang_transaction.html)。

## 通常Openと既存Adapter

- 新規Data DBはDATA_STORAGE_SCHEMAのv2で初期化する。
- Data v1は通常OpenでMIGRATION_REQUIRED。未知版・別DB系列はSTORAGE_SCHEMA_MISMATCH。
- Definition DBはv1のまま。物理Migrationの適用を完了したとは扱わない。
- 計画生成/Executorの物理検証と、従来の通常Openでのメタデータ検証は別責務。通常OpenをSchema修復処理へ変更しない。
- 移行後もData Repositoryのread/add/CAS write、既存Revision、Data Migrationが継続動作する。

## 障害・再実行・復旧

主な拒否コード: DB_KIND_MISMATCH、UNKNOWN_VERSION、MIGRATION_PATH_MISSING、DOWNGRADE_UNSUPPORTED、PHYSICAL_SCHEMA_MISMATCH、DATA_CORRUPT。
計画後の変化: VERSION_CHANGED / DATA_CHANGED。計画/Registry変更: INVALID_PLAN / REGISTRY_CHANGED。

- DDL途中・Version更新前・verify失敗はTransactionをrollbackし、元Schema/Version/データへ戻す。
- commit例外は保守的にOUTCOME_UNKNOWN。元エラーをrollback/closeのcleanup失敗で上書きしない。
- commitOutcomeはNOT_ATTEMPTED / CONFIRMED_FAILURE / CONFIRMED_SUCCESS / UNKNOWN。commit後の検証/close失敗をcommit前失敗と区別する。
- 失敗時はwriterをcloseしてから新しいread-only接続で状態照合する。matchesSource/matchesTarget/dataPreservedを返す。
- 状態照合でv2一致でも、その操作が成功した証明とはせず、OUTCOME_UNKNOWNを成功に変換しない。自動再送しない。
- 原因解消後、新しいDry Runを作る。v1の正常状態なら再適用、v2の正常状態ならNO_OP。不整合なら停止し、自動修復しない。
- 古いv1計画をv2へ再適用するとVERSION_CHANGEDで停止する。
- 確定後の破壊的Rollback/Down Migration、手動でuser_versionだけを書き換える修復は行わない。
- close失敗/lock継続時は他の処理を進めず、接続を終了できたことを確認して再診断する。

成功結果にはsteps/from/to/planFingerprint/afterとdataPreservedを含む。失敗結果には固定codeとcleanup診断・reconciliationを返し、OS例外本文・内部パス・raw stackを含めない。
CLI終了コード: 0成功、2適用停止/結果不明、1計画/入力エラー。結果の永続保管は呼出元で行う。
外部の直接変更やcommit後の他プロセス更新を永続的に防ぐ機構ではない。完全な電源断復旧・ネットワークFSの保証は対象外。

## 検証

`npm run test:schema-migration`。新規一時DBのみで、実DDLの1→2、行/Revision保全、CAS、Data Migration、別プロセスOpenを実行する。
未知/不正Schema、欠落経路、事前変更、DDL/Version/commit/rollback/close障害、順序、async拒否、CLIを試験する。
Definitionはv1識別とNO_OP・既存保存のみを検証。DefinitionのSchema変更経路は未実装・未検証。

## 2026-11-12：Migration Engine汎用化の逆輸出

### 目的・出所・変更範囲

ARCH-026 → ThemeDialogueAI-P → ARCH-026の再利用検証結果を還元した。
ARCH-026基準HEADはa54e9d2f0f15111c88ba495356cfcbbff1692fc0。
参照元はThemeDialogueAI-Pのb43694b602cd00b47c75ee8c4f4c8e1fc0268bf8。

候補パッチをそのまま適用すると既定Registryの利用者が非互換になるため、業務定義と汎用処理を分離し、既存入口を互換レイヤーとして維持した。

| ファイル | 役割・変更 |
|---|---|
| src/adapters/simpledb/schema-migration-engine.cjs | Registry必須の汎用Planner／Executor。ThemeDialogueAI-Pの検証済みEngineとバイト一致 |
| src/adapters/simpledb/schema-migration-registry.cjs | 元のData／Definition Schema、Validator、Migration step、既定Registryを移動 |
| src/adapters/simpledb/schema-migration.cjs | 従来のExport名・呼出し方法を保つ薄い入口 |
| tests/schema-migration-generic.test.cjs | 独立アプリのRegistry、業務依存なしでの読み込み、互換性・不変性・rollback検証 |
| package.json | 既存test／test:schema-migrationに新規テストを追加。依存関係変更なし |
| docs/SCHEMA_MIGRATION.md | 構成・互換性・検証結果の追記 |

SimpleDB、既存CLI、既存テスト、Data／Definition業務モデル、Workflow本体の実装は変更していない。
ThemeDialogueAI-P側のコード・Registry・API・SQLite Schemaも変更していない。
ThemeDialogueAI-P固有のusers等5テーブル、Repository、Node APIは逆輸出していない。

### 読み込みと互換性

従来の入口はそのまま利用できる。

~~~js
const { planSchemaMigration, executeSchemaMigration } =
  require('./src/adapters/simpledb/schema-migration.cjs');
const plan = planSchemaMigration(dbFile, { kind: 'data', targetVersion: 2 });
const result = executeSchemaMigration(dbFile, plan);
~~~

- Registryを省略、またはundefined指定すると従来のARCH既定Registryを注入する。
- SCHEMA_MIGRATION_REGISTRYのExportを維持する。遅延getterが同一のRegistryオブジェクトを返す。
- 第3引数に独自Registryを渡した場合は、それをそのまま汎用Engineへ渡す。null等を既定Registryへ暗黙に置換しない。
- plan／executeの結果形式、エラー、計画指紋、Transaction、不変性、再観測の処理は変更しない。
- tools/schema-migration.cjsの入口・引数・出力・終了コードを変更していない。
- ARCH既定Registryを実際に使う場合は従来どおり業務Validatorのdistが必要であり、npm run buildを先に行う。

業務定義を一切読み込まない入口：

~~~js
const { planSchemaMigration, executeSchemaMigration } =
  require('./src/adapters/simpledb/schema-migration-engine.cjs');
const plan = planSchemaMigration(dbFile, { kind: 'myApplication', targetVersion: 2 }, myRegistry);
const result = executeSchemaMigration(dbFile, plan, myRegistry);
~~~

汎用EngineはNode標準モジュールとdatabase.cjsだけを直接読み込む。
既存互換入口も、独自Registryで利用する場合にはARCH既定Registryを読み込まない。
標準Registryの読込は、既定値を使う呼出しまたはSCHEMA_MIGRATION_REGISTRYの取得時に限定する。

Registry契約は従来どおりapplicationId／versions／steps／rowsSQL／validateRowsである。
具体的な独立2テーブルRegistryはtests/schema-migration-generic.test.cjsのcustomRegistryを参照する。
実レコードと関連行の両方を観測し、どちらの改変も検出する。空・定数の検証結果で安全性を回避していない。

### アルゴリズム維持の確認

汎用EngineはThemeDialogueAI-Pのsrc/wrapper/sqlite/schema-migration.cjsとバイト一致する。

SHA-256：9624b8a2affb2132794ac055eb774699698076853e78375420e30b394939083e

また、ARCH-026の変更前コードから業務定義と既定引数を分離した結果とも一致する。
Planner／Executorを作り直したのではなく、既存の処理本体を分離した。
標準RegistryのvalidateDataRows／validateDefinitionRows／dataStep／Registry定義は内容を維持して別モジュールへ移した。

既存の制約も維持する。任意データ変換、downgrade、非同期Migration、複数DB横断Transactionは追加しない。
Registryは信頼済みコードであり、関数本体自体をRegistry指紋でハッシュする機能は引き続きない。

### 検証結果

Node.js v24.16.0で実施。

| 検証 | 結果 |
|---|---|
| 変更前npm test | 529件PASS、FAIL／skip 0 |
| 分離後の既存Schema Migrationテスト | 20件PASS、既存テスト無変更 |
| 新規の汎用性・互換性テスト | 10件PASS |
| 変更後npm test（TypeScript buildを含む） | 539件PASS、FAIL／skip 0 |
| 既存CLI dry-run／apply | 上記既存20件に含めてPASS |
| 汎用Engineの移植元との照合 | バイト一致 |
| SimpleDB・既存未コミット成果の保全 | 変更前とのハッシュ一致 |
| ThemeDialogueAI-Pの保全 | 追跡・未追跡ファイルのハッシュ、Git状態・HEADの不変を確認 |
| Git差分・新規ファイルの空白検査 | PASS |

新規テストではdatabase.cjs、汎用Engine、互換入口の3ファイルだけを一時ディレクトリへ置き、業務モジュールのロードを禁止した別プロセスで計画・実行した。
distやWorkflow／DemoItemのSchema・Validatorがなくても、独自Registryで実Migrationが成功する。

独立2テーブルそれぞれのデータ改変、verifyによる削除、callback例外、後続step失敗を検出し、Schema／user_version／データのrollbackを確認した。
標準Registryを明示注入した汎用Engineと従来入口の計画・実行結果が一致することも確認した。

Firestore専用テスト、ブラウザE2E、配布パッケージのリリース検証は今回実行していない。npm testの範囲と混同しない。
実運用DB、クラウド、道場システムへの適用は行っていない。

### 判定と残課題

今回の汎用化・回帰検証はPASS。既存未コミット成果とは分離し、上記6ファイルを限定コミット可能な状態とする。
ステージング・コミット・Pushは未実施。

将来の配布時には汎用EngineとSimpleDBを含める必要がある。共通パッケージ化や配布構成の変更は今回行っていない。
道場システムへの適用は、Firestore構成・Workflow統合計画・DB Adapter契約を別途調査して判断する。
SQLiteのEngineを、そのままFirestoreのMigrationへ適用できると判断したものではない。
