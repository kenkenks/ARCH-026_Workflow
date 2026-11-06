# Data Migration フェーズ2

DemoItemに限定した更新可能なData RepositoryとMigration。Definition Migration、Hello、Workflow実行処理は変更しない。

## 保存領域と物理版の判断

**新規の専用DBだけを使用する。既存Definition DBのupgradeは不要であり、実行しない。**

- `DATA_STORAGE_SCHEMA`: application_id `0x41524441`、user_version `1`。
- Definition DB（application_id `0x41524348`）とは異なるDB系列。両者を同じファイルとしてopenするとSTORAGE_SCHEMA_MISMATCH。
- data_records: collection BLOB、record_id BLOB、record_json TEXT、revision TEXT。collection＋record_idが複合主キー。
- initializeは新規ファイルだけに明示実行。通常openでテーブルを作成しない。既存ファイルへinitializeしない。
- 同じDBにDefinitionとDataを統合する場合は、別工程の物理Migration設計が必要。本実装に自動移行・DDL更新はない。
- logical Schema VersionはJSON内に保持する。DB物理版、Record Revision、変換版と区別する。

```js
const {SimpleDB, DATA_STORAGE_SCHEMA, SimpleDBDataRepository} =
  require('./src/adapters/data/simpledb.cjs');
// Provision once, in an existing dedicated test directory:
SimpleDB.initialize(newDataPath, DATA_STORAGE_SCHEMA);
// Normal startup:
const db = SimpleDB.open(newDataPath, DATA_STORAGE_SCHEMA);
const repository = new SimpleDBDataRepository(db, 'demo-items');
// Composition owns db.close(); the repository never closes a shared connection.
```

## Model / Repository

`src/data/demo-item.ts`の純粋Validatorは余分なfield・不正型・未知Schemaを拒否する。

- v1: `{id, schemaVersion:"1", name, enabled}`
- v2: `{id, schemaVersion:"2", label, enabled}`
- `demo-name-to-label/1`: nameをlabelに変換、ID・enabledを保持。v2入力はそのまま検証して返す。
- IDとcollectionは非空・正当なUnicode文字列。大小文字を正規化せず、UTF-8 BLOBで識別する。
- 初期モデルに外部参照・削除・業務Versionは持たせない。

既存Helloの汎用`Repository<T>`/`Stored<T>`/`Revision`を**型として**利用し、HelloのValidatorやAdapterに依存しない。
DataRepositoryはcollectionに束縛したread/add/write(expectedRevision)を公開する。
read未存在はnull。add既存はALREADY_EXISTS。write未存在はNOT_FOUND、Revision不一致はCONFLICT。
暗黙upsert/deleteなし。参照独立性と同内容write時のRevision更新を保証する。Revisionは保存先発行のUUIDであり、大小や日時で比較しない。
writeはBEGIN IMMEDIATE内で既存データ検証→ID＋期待Revision条件付きUPDATE→COMMIT。
データと新Revisionを一括保存する。破損・未知Schemaを上書き修復しない。

## Manifest / Dry Run

```json
{
  "manifestVersion": 1,
  "migrationId": "demo-v1-to-v2",
  "collection": "demo-items",
  "transformVersion": "demo-name-to-label/1",
  "items": [{"id":"a","allowUpdate":false,"expectedTarget":null}]
}
```

更新を許可する場合はallowUpdate=trueと、移行先の実Revision・内容指紋をexpectedTargetへ指定する。
例: `expectedTarget: {revision: before.revision, fingerprint: await dataFingerprint(before.record)}`。
移行元Revisionをここへ設定しない。初回Dry Runで状態確認し、必要な更新だけを明示的に許可する。

`src/migration/data.ts`:

- Classifier `classifyData`: CREATE / UPDATE / NO_OP / CONFLICT / REJECT。変換後の期待レコードと比較。UPDATEは許可と基準状態の完全一致が必要。
- Planner `planDataMigration`: ID重複拒否、両端のSchema/ID/Revision検証、変換、元/先/出力の指紋付き計画を生成。read-only Portのみを受け、add/write/Journalを呼ばない。
- fingerprintは検証済み論理JSONを対象とし、objectキー順に依存しない。配列順は維持する。

```js
// Inside an async function after npm run build:
const {planDataMigration, executeDataMigration, dataFingerprint} =
  require('./dist/src/migration/data');
const plan = await planDataMigration(manifest, source, destination);
console.log(JSON.stringify(plan, null, 2)); // Dry Run only
```

source/destinationはmanifestと同じ論理collectionへ束縛する。物理DBパスはCompositionが選ぶ。
計画指紋は改変・欠落検出用で、署名・認可トークンではない。ファイルからロードした計画も信頼済みのローカル成果物として扱う。

## 明示適用 / 記録 / 再実行

```js
const {FileMigrationJournal} = require('./src/adapters/data/file-journal.cjs');
const journal = new FileMigrationJournal(newRunLogPath); // wx: existing file rejected
try {
  const result = await executeDataMigration(plan, source, destination, 'unique-run-id', journal);
  console.log(JSON.stringify(result, null, 2));
} finally { journal.close(); }
```

Executorは元のRevision＋指紋と先のRevision＋指紋を再照合する。同内容に戻ってもRevisionが変われば検出する。
計画後の元/先変化はSOURCE_CHANGED/TARGET_CHANGEDで停止し、新しいRevisionへ勝手に追従しない。
CREATEだけadd、UPDATEだけ計画時の移行先Revisionでwrite。NO_OPは無書込。
保存後は戻り値と再読込のID/Schema/内容/Revisionを照合し、UPDATEでRevision未更新なら失敗。
実行中の競合は停止して新計画を要求する。自動再送・自動削除はしない。

JournalはPLAN / INTENT / RESULT / SUMMARYのJSONL。各appendでfsyncし、migrationId/runId/計画指紋/collection/対象ID/変換版/元先Revision/結果/検証/停止位置/未処理対象を記録する。
PLANを最初に記録するため、停止でSUMMARYが欠けても対象一覧が残る。INTENTには元先指紋と出力指紋、RESULTには確定性と検証結果がある。
Journal失敗前にDB操作を開始しない。保存後のRESULT失敗は既存成功結果を保持しjournalFailedとして停止する。
記録が部分的に残ることはある。記録ファイルとDBは原子的に確定しない。
ログはappend-onlyの1run/新規ファイルとし、既存ログへ追記して再開済みと見なす機能は設けない。

再開時はログを手掛かりに**新しい計画をDBから再生成し、別runId/ログで適用する**。
完了済みで期待値と一致するレコードはNO_OPになりRevisionも変更しない。内容が異なるものを再実行の都合で自動更新しない。
未確定INTENTや壊れた最終ログ行は成功証明として使わない。ファイルに保存された結果だけで処理をskipしない。

## 障害と保証範囲

- 保存前の確定障害はCONFIRMED_FAILURE。未知の書込例外・commit障害はOUTCOME_UNKNOWN、writeOutcome=UNKNOWN。
- unknown時の事後Readはreconciliationに記録する。期待値一致でも操作成功の証明ではなく、verified=trueや成功statusへ変更しない。
- 保存確定後の読戻し失敗はCONFIRMED_SUCCESSを保持し、検証失敗として停止する。
- SQLiteのrollback失敗でpoisonされた接続は再利用しない。close後に別接続で状態確認する。
- 一操作のSQLiteトランザクションのみ。複数レコード/両DB/Journalとの全体原子性なし。
- 確定済み操作の自動Rollbackなし。補償更新・Before image復元は未実装。
- 元の再読込後に外部から変更されることを両DB横断で防ぐ仕組みはない。再検証したスナップショットを移行する。
- 外部の直接SQL変更をRepositoryで防げるとは扱わない。電源断・ネットワークFSの保証は今回実証しない。
- 公開結果には固定コードだけを載せ、SQL/パス/raw stackを出さない。ログには識別子が含まれるため、公開リポジトリへ実データのログを追加しない。

## 検証

`npm run test:data-migration`。新規一時directoryの専用DBのみを生成・終了・破棄する。
判定5種、CAS、同内容Revision更新、並行/別プロセス競合、計画変更、論理変換、Dry Run、保存前/commit/応答喪失/Journal障害、読戻し不一致、再実行、再接続/別プロセス読込を検証。
`npm test`に含め、既存Definition Migrationも維持する。
Firebase/GAS、Ticket/Instance、参照関係の移行、SQLite物理Migrationは対象外。
