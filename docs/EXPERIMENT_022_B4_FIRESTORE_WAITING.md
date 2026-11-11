# 実験022-B4：Firestore Emulator WAITING

2026-11-09。ARCHのみ改修、合成データのみ使用。旧021-B経路とCore/CMRP/Checkを変更せず、src/adapters/workflow-firestore/waiting.cjsにFirestoreWaitingStoreを追加した。道場への導入・正式配布はしていない。

## 1. 実装構造

```text
既存CWorkflow / CJob / CJobForm / Check
                 ↓ IWaitingHistoryStore
FirestoreWaitingStore
  ↓ Firestore Transactionで状態を読込
  既存WaitingHistoryStoreの共通Lifecycle判定
  （隔離したMemory backendをTransactionごとに生成）
  ↓ 状態・履歴・所有権・receiptを一括確定
Firestore Emulator専用namespace
```

既存emulator.cjs:connectEmulator、store.cjs:hashを再利用する。新しいWorkflow実行ループやFirestore固有Jobはない。common reducerは検証とDTO変更だけを行い、Job/Form/Checkの実行はCWorkflowがTransaction外で行う。SDKのABORTED再試行でcallbackが複数回呼ばれてもJobを再実行しない試験を行った。

新AdapterはSDK9.3.1の正規化済み接続設定servicePath/port/sslも検証し、127.0.0.1、demo project、c2 namespace、arch026_c2領域以外を拒否する。既存factoryはEmulator専用HTTP probe後にSDKを作り、ADC・本番fallbackを使わない。SDK内部の設定表現に依存する検査なので、SDK更新時は再検証し、不明な構成を許可側へ倒さない。

## 2. 保存契約・Schema

rootは既存arch026_c2/{専用namespace}、新しいwaitingRuns/{hash(runId)}配下を使用する。既存runs、Definition、021-B業務保存領域を変更しない。

| 領域 | 内容 |
| --- | --- |
| run.value | Memory/SQLiteと同じLifecycle DTO：schemaVersion=1、run/定義ID・Version/digest、snapshot、WAITING理由/世代/次工程、revision、owner、操作履歴、control events、入力、公開成果、updatedAt |
| run.digest | プロパティ順に依存しないcanonical JSONのSHA-256 |
| run.committedAt | サーバーcommit時刻。value.updatedAtはTransactionのreadTimeに基づく論理更新時刻で、役割が異なる |
| mutations/{mutationId} | 個々の確定したAdapter更新のdigest/revision/kind。payload本体は二重保存しない |
| operations/{hash(operationId)} | 再開claimのAPPLIED証拠、またはNOT_APPLIED照合障壁。要求digestのみを持ち、詳細要求・結果は共通DTOのoperationsを参照 |

DTOは既存共通validatorを使う。Firestoreによるmap順序変化はcanonical digestで吸収する。保存valueは64KiBを上限とする実験用Adapterであり、大量履歴を無制限に一文書へ追加する本番設計ではない。将来の履歴分割は別工程。

## 3. WAITING確定Transaction

1. runとmutation receiptを読む。
2. 共通Lifecycleでowner ID/token/fence、readTime時点のLease、期待revision、履歴prefixを検証。
3. WAITING snapshot、次工程・理由・世代、revision、対応operationの確定結果、WAIT_ENTERED、owner RELEASEDを同じrun文書として更新。
4. mutation receiptとサーバーcommit時刻を同じTransactionで保存。

一方だけを保存する経路はない。Transaction失敗なら旧RUNNING＋ACTIVE等の最後の確定状態を保持する。RELEASED ownerには監査用の旧token/fenceが残るが、実行権としては無効。人間待ちの間にHeartbeatを維持しない。

時間はFirestore readTimeをミリ秒へ切り下げて共通reducerへ渡す。Lease判定は読み取った時点の保証であり、commitまで期限内だったことは証明していない。新しい自動Takeover・commit時刻Lease保証を主張しない。

## 4. 明示再開とFencing

要求はB3と同じ5項目：runId、operationId、expectedWaitGeneration、expectedRevision、result。JSON構造・型・サイズを検証し、認可済みの操作だけを渡すことが呼出元の責務。

Transactionでoperation markerと共通DTOを照合し、WAITING・世代・revision・定義・snapshot・owner RELEASEDを確認する。新tokenと増加fence、Lease、操作結果、WAIT_RESOLVED、次工程のRUNNINGを一括保存し、operation markerも同じTransactionでAPPLIEDにする。確定後にCWorkflowがCheck/Jobを進める。前Jobを再実行しない。

同一ID・同じ内容で完了済みなら既存snapshotを返し、Job・履歴・保存を追加しない。未完了ならOPERATION_IN_PROGRESS、同一IDの異内容はOPERATION_CONFLICT、別IDの競合はNOT_WAITING/REVISION_CONFLICT、旧世代はSTALE_WAIT_GENERATION、古いHost/誤token/誤fenceはFENCED。これらはUnit codeで、HTTP statusはApplication側で対応する。

load/readは非同期、実行中のProductReader/getInputは最新の確認済みcacheから同期取得する。postのputは非同期Transactionで確定する。新Hostはloadしてからグラフを再構築する。scopeの違う任意の外部副作用までexactly-onceになる保証はない。

## 5. 結果照合：APPLIED / NOT_APPLIED / UNKNOWN

| API・証拠 | 結果とscope |
| --- | --- |
| observeMutation(id)でreceipt存在 | APPLIED / MUTATION。指定Adapter更新が確定した証拠 |
| mutation receipt不存在・読込不能 | UNKNOWN。不存在だけでは未確定RPCが後でcommitしない証明にならない |
| observeOperation(request)でAPPLIED marker | APPLIED / RESUME_CLAIM。再開claimが確定した証拠であり、後続Jobの完了ではない |
| NOT_APPLIED marker | NOT_APPLIED / RESUME_CLAIM。以後も同じ操作を適用しない永続障壁 |
| markerなし・状態取得不能 | UNKNOWN。自動再実行しない |

observeOperationの既定はread-only Transaction。APPLIEDであってもvalue.operationsのstatusがRUNNINGなら、Workflow実行結果は未確定である。UNKNOWNをCOMPLETEDへ変換しない。

### 明示的なsealAbsent

NOT_APPLIEDを強く確認する必要がある場合だけ、認可された回復操作としてobserveOperation(request,{sealAbsent:true})を使う。これは読取りだけではなく、**その操作IDを今後拒否する変更操作**である。

同じWAITING・世代・revision、owner RELEASED、marker未存在をTransactionで検証してNOT_APPLIED markerを作り、同時にrun文書のobservationFenceを更新する。既に読み始めたclaim Transactionとは競合し、その再試行もmarkerを検証するので、障壁確定後にその操作を遅れて適用できない。別payloadで同じIDを使うことも拒否する。

RUNNING等で安全条件を満たさなければUNKNOWN。seal自体の結果不明もUNKNOWNとし、Storeをpoisonして後続mutationを拒否する。新しいStoreからmarkerを再照会する。別operationIdによる操作は、人の明示判断と通常の権限確認なしに自動生成しない。LeaseやFencingを迂回する回復ではない。

## 6. 異常終了・応答喪失

| 障害 | 観測・停止条件 |
| --- | --- |
| WAITING commit直前でprocess.exit | 旧RUNNING＋ACTIVE。新WAITING/RELEASEDは保存されない |
| WAITING commit直後でexit | WAITING＋RELEASED、理由・次工程・履歴が別プロセスから取得可能 |
| 再開claim commit直前でexit | 旧WAITING＋RELEASED。marker不在だけではUNKNOWN |
| 再開claim commit直後でexit | RUNNING＋ACTIVE、claim APPLIED。Jobの自動再実行をOPERATION_IN_PROGRESSで拒否 |
| WAITING保存後の応答喪失 | CoreはHISTORY_SAVE_OUTCOME_UNKNOWNのまま。mutation receiptでAPPLIEDを照合 |
| claim応答喪失 | StoreはOUTCOME_UNKNOWN/poison。APPLIED markerがあっても未実行/未完了Jobを再実行しない |

Transaction中にクライアントを終了させると、Emulatorの孤立Transactionロックが約60秒残る場面があった。アプリのLease期限とは別のサーバー側ロックである。解放待ちをLease延長で隠さず、read-only照合とUNKNOWNで安全に扱う。commit前exit直後のNOT_APPLIED即時確定は保証しない。

## 7. 試験結果と初回FAIL

| 集合 | 最終結果 |
| --- | --- |
| 既存npm test | 529 PASS／0 FAIL |
| 既存実験集合（Lease・所有権・再開含む） | 291 PASS／0 FAIL |
| 既存Memoryデモ | 27 PASS／0 FAIL |
| 既存020-B＋019-C2 Emulator | 45 PASS／0 FAIL |
| 既存基準合計 | 892 PASS／0 FAIL |
| 既存WAITING契約 | 49 PASS／0 FAIL |
| 既存候補パッケージ | 2 PASS／0 FAIL |
| 新SQLite UNKNOWN観測 | 8 PASS／0 FAIL |
| 新Firestore WAITING | 20 PASS／0 FAIL |

最終合計971 PASS（反復試行・focused再実行は重複加算しない）。Build/noEmit型検査/変更JS構文/diff checkも成功した。

新20件は、正常保存/Lease解放、TRUE/FALSE、世代・revision・不正形式、二重要求、2プロセス競合、stale Host・誤fence・誤token、別プロセス再開、WAITING/再開Transaction失敗、commit前後の実プロセス終了、応答喪失、read不能、NOT_APPLIED障壁、障壁結果不明後の停止、本番host拒否、SDK ABORTED callback再試行でのJob非重複をassertする。

初回FAILは省略しない：

- 最初の実行は新規scenario fixtureの引用符漏れによりファイル読込1件FAIL。fixtureを修正。
- 次の実行は17件FAIL。SDKがhostをservicePath/portへ正規化するため安全検査が全件拒否した。インストール済みSDKの実設定を確認し、loopback/ssl条件を緩めず検査方法を修正。
- 次の実行は16 PASS／1 FAIL。commit前exit直後にsealで必ずNOT_APPLIEDを得られるという試験前提が、孤立Transactionロックのため成立しなかった。不存在を未適用とみなす保証は追加せず、既定read-only照合はUNKNOWNで停止する試験に修正。正常abort後の明示sealは別試験で検証。
- その後18件全PASS、token/poison/本番拒否のfocused確認3件PASS、最終20件全PASS。B1-Rの過去UNKNOWNが解消したという意味ではない。

ログはlogs/022b4-firestore-tests*.log、旧回帰は022b4-npm-test-final.log、022b4-extra-regression-final.log、022b4-memory-regression.log、022b4-legacy-firestore.log等。各runnerは所有Emulatorを停止し、停止後の接続拒否も確認した。

## 8. 実行・停止方法

- npm run test:firestore-waiting：Build後、専用Emulatorを起動し新契約試験を実行して停止。
- npm run test:history-unknown：SQLite観測8件。
- npm run test:waiting：既存Memory/SQLite WAITING・診断49件。
- node tools/run-exam-persistence-tests.cjs --with-c2：既存Emulator45件。
- --waiting-only --test-name-pattern=パターン：特定新規試験だけを実行可能。

JavaとEmulator JAR1.21.0（既存cache、またはARCH026_FIRESTORE_EMULATOR_JAR）が必要。利用不可なら未実施として失敗する。loopbackの動的port、demo-arch026-c2、c2-wait-UUIDだけを使い、本番・Memoryへfallbackしない。子プロセスはIPC close/exitで終了し、専用namespaceだけをcleanupする。公開server/APIは追加していない。

## 9. 変更ファイル・配布物

新規：src/adapters/workflow-firestore/waiting.cjs、src/adapters/job-execution/history-observation.cjs、tests/history-unknown.test.cjs、tests/workflow-firestore-waiting.test.cjs、tests/workflow-firestore-waiting/{scenario,child}.cjs、本報告とB1-R報告。

変更：src/adapters/simpledb/database.cjs、tests/job-run-lease/host.cjs、tools/run-exam-persistence-tests.cjs、package.json。

Workflow/Job/Form/Check、Memory/SQLite Lifecycle、旧Firestore store/composition/emulator、既存892件の期待値は変更していない。既存test fixtureには観測だけを追加。桜風館側も変更していない。道場側021-B統合11件は本工程では再実行せず、既存ソース・配布/導入物の非改変をSHAで確認する。

旧0.1.0-experiment.021.1のarchive SHA：e7f97e55ed2da17adf32cb7358df39c816ed7e929ea4c7dee1b87d0aafda34c4。

候補0.2.0-experiment.022.2のarchive SHA：676c4f5eaa41667ed9f247866e5a5e8bffba451c2822a04ecf90093dd786dfc2。

両方とも再計算して一致。候補の既存whitelistには今回新規waiting.cjsが入っていないため、B4はARCH sourceでのAdapter検証までである。同候補へ黙って内容を追加・上書きせず、正式配布や道場導入もしない。

## 9.1 開始時・最終のソースSHA-256

開始時の既存tracked変更はpackage/lock、Prototype definition/workflow、既存3試験、tsconfig等。多数の未追跡実験成果も保全した。今回の変更対象コード・試験の記録は以下。報告書自身の自己hashは含めない。

| ファイル | 開始時 | 最終 |
| --- | --- | --- |
| src/adapters/simpledb/database.cjs | fa338046bf065294c65a3e553dae3e3dd6b325d8e20afb051996ec32755929a5 | c9e3eaad5c316d78ba9b1259941f9ab75ab54fd1e35c28274ebaa3abad5e830e |
| tests/job-run-lease/host.cjs | 3efe8a3c58523bb151923a50c01dd5192c448daef6d182ffacff4f2aa8a4a34f | 5eab3963f62801ce11e18a0f68a79bb49c9a16f9492cf62c0db3aaeb37b6a95a |
| tools/run-exam-persistence-tests.cjs | 97d8dced4766003e49cd1b78224d78c35a460598acd1134e748382e1684cdfbd | bc4cc4890bc7f0b07cfa72bbf0b7a9b11cc749e8d9d85f5e2a95a65f89746a11 |
| package.json | bc64311072fd67f29ff1c9ca0c23dbf94683ad300865563327d081bcf99090ad | 41e643ca7b34bdc0c95ed55b5f78b3803a577bbb5697c704568801aa0dfb6501 |
| src/adapters/job-execution/history-observation.cjs | 新規 | f246a45e34866a51cc8ad33f709128fc0cbd42ce58fde0b8dc4b3c6bca407573 |
| src/adapters/workflow-firestore/waiting.cjs | 新規 | 7d7a003c77629640e9aec075a01a0c28bdcb67f690d68b1a5c2279fc48d049bd |
| tests/history-unknown.test.cjs | 新規 | 044a251fbe9fd8e4b61360761529b53d7d8c9d499b78fa70bc5b689cd674bf3b |
| tests/workflow-firestore-waiting.test.cjs | 新規 | 9ece91a440ae2a1b069525f92332e86c2ddf6094f76c91f3335e3268d73e6905 |
| tests/workflow-firestore-waiting/scenario.cjs | 新規 | fb4233caac068e6bcfb2b2ec15985034fe18e482729ebf5ae66b98f449adcaa1 |
| tests/workflow-firestore-waiting/child.cjs | 新規 | 02b798cf6780b46122518d4c29c9ce8ccc21b39645598864e33c29e6cd059a54 |

## 10. 引継ぎ・判定

Firestore Emulator上のWAITING保存・原子的Lease解放・再開・競合拒否を実測できた。Memory/SQLiteと同じCore/Lifecycle判定を使用する。B1-Rの過去UNKNOWN原因は未解明だが、安全な観測・照合と追加50回の結果を記録した。

次工程で配布が必要なら、新Adapterをwhitelistへ追加した新VersionとSHAで再検証する。今回022-B5/022-Cへは進まない。大規模履歴分割、認可/業務接続、途中Jobや外部副作用の補修、本番Firestore/Cloud Run、commit時点のLease保証は未対応。

既存未コミット成果を保全。Stage・Commit・Push・Deployなし。レビュー待ちで停止する。
