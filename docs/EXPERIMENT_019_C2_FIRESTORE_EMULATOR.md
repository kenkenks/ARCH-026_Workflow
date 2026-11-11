# 実験019-C2：Firestore Emulatorによる永続化・所有権制御

## 1. 判定と適用範囲

2026-11-09、ローカルのFirestore Emulatorで検証した。両Coreを変更せず、既存CWorkflow／CJob／CJobFormのawait境界から、Workflow・Job・内部成果・公開成果物・履歴・Check結果を保存する実験用Adapterを追加した。

**成立範囲はEmulator、合成データ、協調するAdapter利用Hostに限定する。** 本番Firestore、Cloud Run、実データ、道場DAO、通知・決済は接続していない。commit瞬間までのLease有効性や安全な自動Takeoverは証明していない。自動Takeoverは実装せず、期限切れ観測後も明示的管理指定を必要とする。

019-C1の「既存await境界で保存する」「所有権と保護更新を同じTransactionに置く」「server readTimeとcommit時刻を区別する」という条件を維持した。CoreやRegistryの公開契約を変更していない。

## 2. 実験環境と接続安全性

| 項目 | 実測・設定 |
|---|---|
| Node | v24.16.0 |
| Java | OpenJDK 21.0.12.1 |
| Firebase CLI | 15.22.3（実験本体はローカルJAR直接起動） |
| Emulator | cloud-firestore-emulator-v1.21.0.jar、STANDARD／Native |
| SDK | @google-cloud/firestore 9.3.1、ARCHのdevDependencyとして固定、lock更新 |
| endpoint | 127.0.0.1:8692のみ |
| project | demo-arch026-c2（実験専用の架空project） |
| 保存範囲 | arch026_c2/c2-UUID 配下だけ |

connectEmulatorは、明示FIRESTORE_EMULATOR_HOST、同じ実環境変数値、専用demo project、namespaceを検証する。127.0.0.1以外、protocol付き、異常port、通常projectを拒否する。SDK生成前にEmulator専用ruleCoverage APIの成功と期待JSON項目を確認する。SDKもhost／ssl=false／projectを固定し、実Credentialを使用しないダミー設定とする。失敗時に実サービスへfallbackしない。

初回のsandbox内起動・loopback通信はOS制限により失敗した。許可された実行でEmulatorと試験を実行した。通常sandboxでのHTTP回帰もloopback待機が成立しなかったため停止し、既存HTTP試験は同様に許可された実行で完走した。実Firestoreアクセスは行っていない。

テストごとにUUID run、テスト実行ごとにnamespaceを作る。後処理のrecursiveDeleteはconnection.root以下のみを対象とし、project全体消去APIや道場Collectionの削除は使用しない。

根拠：src/adapters/workflow-firestore/emulator.cjs、tests/workflow-firestore.test.cjs:S01/S02。[公式Emulator接続仕様](https://firebase.google.com/docs/emulator-suite/connect_firestore)

## 3. Document構成と更新主体

Rは`arch026_c2/{namespace}/runs/{hash(runId)}`を表す。既存SQLiteテーブルの機械的変換ではない。

| Document | 責務・更新主体 |
|---|---|
| namespace/definitions/{hash(ID,Version)} | Definition保存Adapter。既存Validator、本文ID／Version、digest照合。create-only |
| R | Workflow snapshotのhistory以外、Definition ID／Version／digest、revision、historyLength／digest、artifactOrdinal。commitのみ更新 |
| R/history/{order} | TraceEntryを順序付き追記。CheckのTRUE／FALSEとnextStepNoも保存。上書き禁止 |
| R/jobs/{UUID} | 個別CJobのrun、stepId／No、JobForm ID、iteration、status／phase。Compositionが実測しcommit |
| R/artifacts/{hash(job,key,kind)} | INTERNAL／PUBLISHEDを別観測としてimmutable保存。値・type・publicationEvidence・数値artifactId |
| R/control/ownership | ownerId、token、単調fence、ACTIVE／RELEASED、expiresAt、updatedAt。claim／heartbeat／release |
| R/mutations/{UUID} | 保存意図digestと確定revision。commitの応答喪失時の事後照合 |

Checkpointは独立した矛盾する二重状態を作らず、Rのsnapshot headと同一Transactionで保存したhistory／Job／成果物から復元する。履歴配列をRへ無制限に埋め込まない。公開成果物の現在値はimmutable artifactの数値ordinal順で導出し、別領域へ内容を二重保存しない。

本実験には外部副作用Documentは追加しない。任意の外部副作用Jobを安全に再開できるという保証もない。

## 4. Adapterと既存Coreの接続

- emulator.cjs：接続前検証、Emulator固定接続、readTimeとexpiresAtの比較。
- store.cjs：Definition get/add、inspect、claim／heartbeat／release、唯一の保護保存commit。
- composition.cjs：既存Registryの同期onCreateでUUIDと実行bindingだけを生成し、非同期collect冒頭で登録を待つ。makeは元JobFormへ委譲する。
- post用shelf.putでnative Job.getRecordedを取得し、INTERNAL保存をawaitする。その後PUBLISHED保存をawaitし、最後に実行別memory shelfへ反映する。
- history Store.saveは実測Job状態とsnapshotを保存する。Store.loadは一貫したinspectから既存snapshot DTOを復元する。
- run／resumeは既存CWorkflowだけを呼ぶ。別Runner、別CMRPループ、prepare／cleanup、GUI変更はない。

記録時点では公開棚に存在しないこと、公開後の次Jobが取得できることをA02で確認した。最初のJob保存はRUNNING／collectであり、同期SQLite登録と同じexecute前READY保存ではない。make待機中にphaseの再checkpointを行わないため、保存phaseはcollectのままという実測になる。全工程のライブ状態を保存したとはいわない。

## 5. Transaction境界

commitでは所有権、run head、mutation receipt、既存history、対象Job／artifactをすべて先にreadする。その後に、所有者・token・fence・読取時Lease・期待revision・Definition・履歴prefix・immutable成果物を検証し、run／Job／artifact／trace／receiptを一括writeする。保護対象を書き込む別経路は設けない。

claim／heartbeat／releaseも所有権をTransaction内で検証する。inspectはread-only Transactionでheadと関連Doc群を同じ読取境界から取得し、履歴件数とdigest、既存Memory DTO Validatorを確認する。

Job本体はTransactionの外で実行する。callback再試行でUUIDやJobを生成し直さない。保存意図と期待revisionはcallback外で固定する。SDKの競合再試行をJob再実行にしない。

実験上限は保存意図JSON 64KiB、snapshot履歴100件、1 Transaction書込20件。超過時は分割commitせず拒否する。公式Firestore上限の代用ではなく、今回の小規模検証の制限である。[Transaction API](https://docs.cloud.google.com/nodejs/docs/reference/firestore/latest/firestore/transaction)

## 6. Lease・時刻・Takeover

Lease比較はownership DocumentSnapshot.readTimeを使用し、expiresAtと秒・nanosecondで比較する。等値は期限切れ、時刻が取得不能ならCLOCK_UNAVAILABLE。Date.nowは判定に使用しない。updatedAtのserverTimestampは監査用であり、期限判定の時刻源にはしない。

heartbeatは同じowner/token/fenceと有効Leaseを確認してから更新する。期限切れの旧Hostによる延命、release、保護保存は拒否する。claim世代は既存行から加算し、release後も削除・初期化しない。

**readTimeはcommit時刻ではない。** 読取後commitまでに期限を跨ぐ場合の厳密保証は未成立である。このため期限切れを観測したclaimは、通常呼出しではADMINISTRATIVE_TAKEOVER_REQUIREDを返す。実験の明示的管理操作`claim(owner,{administrativeTakeover:true})`だけが世代を更新できる。これは認証済み管理APIの実装ではなく、ローカル合成試験用の明示操作である。自動回復や本番運用に公開しない。

D01の期限切れは隔離fixtureがEmulator readTimeより過去のTimestampを設定して作る。sleepによる偶然の失効は利用しない。D02の時計巻戻り・進み・等値試験は比較関数の単体試験であり、Emulator OS時計そのものを変更した試験ではない。通常readTime取得はA〜Gの実通信で確認する。

## 7. 再開結果

別プロセスAでJob A、Job B、Checkを実行しLIMIT_REACHEDを保存、releaseしてプロセスを終了する。別プロセスBで読込・再claim・診断・既存CWorkflow.resumeを行う。

F01の実測：

- 初回make呼出しはa、b。historyはDONE、DONE、TRUE。
- 再開後make呼出しはcだけ。Checkを再評価しない。
- A／BのjobExecutionIdを維持し、Cには新しいUUIDを生成。全3 JobのID重複なし。
- historyの既存prefixを変更せず、CのDONEを追記。
- 公開成果物A=10、B=20を復元し、C=30を得てCOMPLETED。

resumeは既存pure診断diagnoseSavedRunでRESUMABLE_CANDIDATEを確認し、Definition digestと保存snapshotを固定する。RUNNING、FAILED、COMPLETED、不整合、未確認公開を再開候補として扱わない。C2 Compositionは外部副作用のない合成Job専用であり、任意の業務Registryを安全と認定する汎用APIではない。

## 8. 安全条件と試験対応

| ケース | 内容・直接assertした結果 |
|---|---|
| S01 | host欠落／外部host／protocol付き／port不正／通常project／namespace不正の拒否 |
| S02 | 実環境変数の不一致と、未起動endpointの拒否 |
| A01 | Definition保存読込、重複拒否、異Version、不存在null |
| A02 | 非同期make待機、RUNNING保存、Job ID、record未公開、公開値、Check TRUE、COMPLETED |
| A03 | Promise rejectでFAILED／ERROR、成果物ゼロ、不確実境界からのresume拒否 |
| B01 | 別Nodeプロセス同時claimで成功1・CLAIM_BUSY1。敗者はJob／履歴を作らない |
| B02 | 同時heartbeat後もtoken・fenceを維持 |
| C01 | 誤token／旧fenceで保存拒否、run head不変 |
| C02 | takeover後の旧Hostによるhistory／Job／artifact追加を一括拒否。全領域不変 |
| D01 | 読取時期限切れ保存・heartbeat拒否、自動takeover拒否、明示takeoverでfence=2 |
| D02 | Host時計の進み／巻戻りに比較結果が依存しない。等値失効、時刻不明拒否 |
| F01 | 別プロセス再開、A／B／Check再実行ゼロ、既存Job ID／成果物／履歴を維持 |
| G01 | commit成功後の応答喪失をOUTCOME_UNKNOWN、receipt PRESENTを観測、以降保存拒否 |
| G02 | commit前故障でreceipt ABSENT、run未公開。自動再送なし |
| G03 | 期待revisionの古い保存を拒否 |
| G04 killBefore | claim後・保存前に子プロセス終了。保護データゼロ |
| G04 killDuring | Transactionのread後・write前で子プロセス終了。部分データゼロ |
| G05 | RUNNINGから自動resumeしない |
| G06 | 読取前ABORTED故障注入でSDK callbackは2回、makeは各Job1回 |
| G07 | load返却snapshotの変更は保存へ影響せず、物理DTO Version破損は拒否 |
| G08 | byte上限超過は書込前拒否 |

G04はcommit送信中の全タイミングを網羅した強制終了試験ではない。サーバーがcommitした直後のOS強制終了は未検証であり、G01のcommit後例外による応答喪失試験と区別する。

## 9. 障害試験の切分け

保存結果不明ではAdapterをpoison状態にし、そのインスタンスで後続保存を許可しない。読戻しは状態観測であり、元呼出しの成功証明ではない。既存CoreのHISTORY_SAVE_OUTCOME_UNKNOWN処理は維持する。

初期試験で読取lock取得後に人工的ABORTEDをthrowすると、Emulatorがlockを保持し後続試験が待機する現象を観測した。故障注入を読取前へ変更し、強制終了Transactionのケースは最後に配置した。SDK callback再試行のG06と、実際の同時Claim／heartbeatのB01／B02を別試験としている。Emulator lock解放待ちによる試験時間は本番性能の証拠ではない。

既存実験291件の初回並列回帰では、実験017の期限付き試験1件が失敗した。コードを変更せず、テストfile並列度を1にして全291件を再実行した結果はPASS。タイミング依存の既存試験として記録し、今回修正していない。

## 10. 回帰・Build

- 既存npm test：529 PASS／0 FAIL。
- 実験009〜019-Bを明示列挙し、file並列度1で実行：291 PASS／0 FAIL。
- 合計既存回帰：820 PASS／0 FAIL。
- 新規Emulator試験：最終実行結果を下記追記欄に記録する。
- npm run build：PASS。
- tsc -p tsconfig.prototype.json --noEmit：PASS。
- 新規JS 6ファイルのnode --check：PASS。
- git diff --check：PASS（既存ファイルのLF→CRLF警告はあるが差分エラーなし）。

SDKの推移依存@types/nodeが自動読込され、従来のnode-shims.d.tsと干渉して既存試験の型検査が失敗した。Core／試験を変更せず、tsconfig.prototype.jsonのtypesを空配列にして従来の明示shimのみを使用した。CJSの新規AdapterはSDK付属型をPrototypeへ自動混入させない。大規模な構成変更やNode型への全面移行は行っていない。

## 11. 再現手順

ローカルJARが既に存在する環境で、別ターミナルから次を実行する。JARのパスは各環境に合わせる。

```powershell
java -jar <local-firestore-emulator.jar> --host 127.0.0.1 --port 8692 --project_id demo-arch026-c2 --single_project_mode true --single_project_mode_error true
```

```powershell
$env:FIRESTORE_EMULATOR_HOST='127.0.0.1:8692'
npm run test:firestore
npm test
node --test --test-concurrency=1 tests/job-form-post-failure.test.cjs tests/job-form-check-branch.test.cjs tests/job-form-loop.test.cjs tests/job-form-execution.test.cjs tests/job-form-sqlite.test.cjs tests/job-execution-sqlite.test.cjs tests/job-run-diagnosis.test.cjs tests/job-run-resume.test.cjs tests/job-run-lease.test.cjs tests/external-effects.test.cjs tests/exam-progress-adapter.test.cjs
```

Emulator未起動時は試験が失敗する。skipやFake置換でPASSにはしない。npm test本体へEmulator必須試験を混ぜず、専用scriptで明示起動する。

## 12. 変更ファイル

新規：

1. src/adapters/workflow-firestore/emulator.cjs
2. src/adapters/workflow-firestore/store.cjs
3. src/adapters/workflow-firestore/composition.cjs
4. tests/workflow-firestore.test.cjs
5. tests/workflow-firestore/child.cjs
6. tests/workflow-firestore/scenario.cjs
7. docs/EXPERIMENT_019_C2_FIRESTORE_EMULATOR.md

変更：package.json（SDK devDependency・専用scriptのみ追加）、package-lock.json、tsconfig.prototype.json（自動型読込範囲）。着手前からのpackage.json変更は維持する。生成distと試験logはGit管理外の検証成果物。

既存Core、SQLite Adapter、019-B Adapter、道場側Core／Job／DAO／STORY／認証／業務冪等性は変更しない。ステージ・Commit・Push・Deployは行わない。

## 13. 未成立条件・残存リスク・引継ぎ

- commit瞬間のLease期限保証、自動Takeover、本番IAM／Security Rules／Cloud Run停止特性は未検証。
- 明示管理takeoverの認証・承認APIは存在しない。現状の管理指定を外部へ公開しない。
- 任意業務Job／外部副作用の安全性、外部UNKNOWNの照会統合、実通知／決済は対象外。
- 物理Documentを直接更新するHostは保護対象外。実運用にはAdapter以外の書込経路と権限の制限が必要。
- 旧Hostの実行中計算を止める機能はない。保証対象は保護保存の拒否であり、任意外部副作用の取消ではない。
- 保存phaseはcheckpoint時の観測である。make中の常時更新やexecute前READY永続化はない。
- 巨大履歴・多成果物の分割保存、複数Job全体の原子性、Doc削除／Migration／永続化失敗の自動修復は未実装。
- Namespace、保存DTO、mutation、保存APIは実験契約。汎用公開Repositoryとして入力検証が全面完成したものではない。

次工程候補は、Leaseの保証点と管理takeover手続きを先にレビューし、次に固定Version配布・業務権限と保存権限・外部副作用照会の接続範囲を決めること。今回の結果だけで実Firestoreや道場業務への導入へ進まない。

## 14. 最終検証・Git照合

最終試験結果と保全照合は、実行完了後に追記する。
最終結果：新規Emulator試験21 PASS／0 FAIL／skip 0。既存529＋291＝820 PASS／0 FAIL。合計841 PASS／0 FAIL。最終BuildとnoEmit型検査もPASS。

保全照合：着手時のARCH 155ファイル中、今回許可したpackage.json／package-lock.json／tsconfig.prototype.json以外の152ファイルはSHA-256一致。新規追加は上記7ファイルのみ。道場917ファイルすべてSHA-256一致、Git状態も完全一致。既存Core・既存SQLite・019-B Adapter・既存未追跡文書は変更なし。ステージ済みファイルは空。実験Emulatorは検証後に停止した。
