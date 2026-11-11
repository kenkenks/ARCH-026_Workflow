# 実験020-B：Firestore Emulator永続化・再起動・競合制御

## 1. 結果と範囲

2026-11-09。020-Aの画面・Definition Version 2・JobForm・Check・業務フローを維持し、Firestore Emulator用Application Adapterを追加した。

**同じ申請IDで別サーバープロセスへ復元し、正しい次操作から完了まで継続できた。** 差し戻し・再申請・完了の復元、複数サーバー競合、stale Host保存拒否、HTTP応答喪失時の照会、UNKNOWN停止を実測した。

Memory版を残し、保存方式は起動時の明示選択とする。接続失敗後のMemory／実Firestoreへの自動fallbackはない。両Core、道場側、既存SQLite Adapter、019-C2のStore／Compositionは変更していない。

本書の保証は合成データとローカルEmulatorに限定する。実Firestore・Cloud Run・実認証・実会員・通知・決済を使用しない。Emulator自体の再起動後のデータ保持は、export/importを実装・検証していないため保証しない。

## 2. 実装構造・020-Aとの接続

```text
020-AのBrowser（画面構成・操作を維持）
 → 同じHTTP API（非同期Applicationをawait）
 → FirestoreExamApplication
     ・020-Aと共通の入力検証／Fake認可／状態表示
     ・操作受付／確定／照会のFirestore Transaction
 → 既存createExecution
 → 既存CWorkflow.run / resume、CJob、CJobForm、CCheckJob
 → 既存FirestoreExperimentStore.commit / guard / claim等
 → 専用Firestore Emulator
```

追加Adapter：`src/adapters/workflow-firestore/exam-application.cjs`。

- FirestoreExamApplicationは020-AのApplication層を利用し、永続化・非同期操作を実装する。Coreの実行ループを複製しない。
- 020-Aの入力検証を共通関数へ抽出した。Memory側の同じ検証を維持し、既存27試験を削除・変更していない。
- JobFormは既存createForms、Checkは既存checksをそのまま利用。操作の入力は保存済みcommandから読み、実行別contextへ複製する。
- 既存createExecutionが公開成果物を復元し、既存診断で確定LIMIT_REACHED境界を確認してCWorkflow.resumeを呼ぶ。
- 非同期境界は既存collect／post／History Store.save。同期Registryの契約を変更しない。
- state表示用にMemory DTOを一時的に構成するが、Firestore読込成功後の投影専用であり、データ取得失敗時のMemory代替ではない。

HTTPのURL・payloadを維持し、Application呼出しをawaitするよう拡張した。Emulator版のbootSessionIdはnamespace設定Documentに保存し、Host再起動で変えない。技術Host IDとclaimTokenは実行ごとに別管理する。MemoryのbootSessionIdは従来どおりHost作成時に変わる。

## 3. 保存構造

N=`arch026_c2/{namespace}`、R=`N/runs/{hash(runId)}`。すべて実験専用namespace内。

| Document | 保存情報・更新主体 |
|---|---|
| N/demo/config | schemaVersion、固定Definition digest、保存セッションID。初期化時にcreate／検証のみ |
| N/definitions/{hash(ID,Version)} | 既存Validator済みDefinition Version 2、digest。既存get/addでcreate-only |
| R | 019-C2のrun head、snapshot、Definition ID／Version／digest、履歴digest・件数、保存revision |
| R/history/{order} | 既存TraceEntry。Check TRUE／FALSEと遷移先、反復履歴を追記 |
| R/jobs/{UUID} | 個別Job ID、Step、JobForm ID、iteration、観測status／phase |
| R/artifacts/{stable key} | INTERNAL／PUBLISHED、成果物値、artifactId、公開観測根拠 |
| R/control/ownership | ownerId、token、fence、Lease、ACTIVE／RELEASED。019-C2そのまま |
| R/mutations/{UUID} | 019-C2の保存意図receipt |
| R/demo/application | applicationId／runId、createdBy／createdAt、Definition識別、apiRevision、commandSequence、pendingCommandId、blocked、業務工程・入力条件投影 |
| R/commands/{commandId} | actor、検証済み要求全体、sequence、操作履歴、ACCEPTED／APPLIED／UNKNOWN／FAILED、確定時のrun revision・履歴digestのproof |

会員ID・級・再申請内容はapplication成果物、審査実施日はexamConfirmation、結果はexamResult／applicationOutcome、承認・差し戻し・操作IDはteacherDecisionとcommand台帳に保存する。

保存した業務工程／入力条件の投影は表示上の正本にしない。表示・次操作は、一貫した読取Transactionで得た実run head・履歴・公開成果物・pending commandから再構成する。履歴表示だけを復元して、別の新規Workflowを動かす方式ではない。

既存の保存revisionと、APIのexpectedRevisionに使用するapiRevisionは区別する。前者はCMRP／履歴の各保存で増え、後者は一つのユーザー操作の確定時に増える。どちらも古い更新を防ぐ条件として検証する。

## 4. 操作受付とTransaction境界

### 4.1 受付

1. 共通のHTTP本文・入力型・合成ユーザー権限を検証。
2. 同じoperation IDがあれば、actorと要求全体を照合して既存結果を返す。再実行しない。
3. 同一プロセス内guardを取得したうえで、既存Store.claimを呼ぶ。
4. Firestore Transaction内でownershipをreadし、既存Store.guardがowner／claimToken／fence／読取時点Leaseを検証。
5. command、申請metadata、run headをすべて先にreadする。
6. pendingなし、状態、期待apiRevision、期待Step、Definition、操作の適合を再検証。
7. ACCEPTED commandとpendingCommandIdを同時保存する。

単一プロセスguardだけを排他とはしていない。異なるサーバープロセス間でもclaimと受付Transactionが直列化する。後からclaimできた要求も、最新metadataでrevisionを再検証する。

### 4.2 Workflow実行

保存済み操作からcontextを作り、既存createExecutionで一工程sliceを実行する。自動Check／Jobは次の人の入力条件まで進める。実際の遷移先はCWorkflowが決めたcurrentStepNoを読む。JobはTransaction callback外で実行する。

Workflow／Job／成果物／履歴の書込は既存Store.commitのみ。所有権検証と保護更新を同じTransactionに置く019-C2の構造を維持した。

### 4.3 操作確定

最後の保存状態が確定した入力境界／終端であることを確認し、別のTransactionでownership・command・metadata・run headを再読込する。pending ID、ACCEPTED状態、観測run revisionと履歴digestが一致した場合だけ、次を一括確定する。

- commandをAPPLIEDにし、遷移先・確定時刻・proofを保存。
- apiRevisionを増やし、pending解除、業務工程／入力条件投影を保存。
- ownershipをRELEASEDへ更新。

このため人の操作待ちではLeaseを保持しない。業務待ちを期限切れLeaseと表現しない。LIMIT_REACHEDは技術的確定境界のままである。

操作受付、複数のCMRP保存、最終APPLIED記録の全体原子性は保証しない。各原子境界の間の障害はUNKNOWNとして保留する。

## 5. 重複・競合

同じ操作ID・同じactor・同じ要求は既存記録を返す。要求内容が違えば409 COMMAND_CONFLICT。STARTの申請IDは020-Aと同じ安定導出で、再送により別runを生成しない。

異なるIDでも古いapiRevision／Step、入力条件不一致、完了済み、pendingありは拒否する。再申請後に同じStepへ戻ってもapiRevisionで古い画面を拒否する。

複数プロセスの競合結果：

| 条件 | 実測結果 |
|---|---|
| 同時承認 | 200が1件、409が1件。先生判断Jobは1件、TRUEも1件 |
| 承認対差し戻し | IPC barrierで受付順を制御。勝者の分岐だけを記録 |
| 差し戻し対承認 | 逆順も実測。FALSEと再申請待ちが一致 |
| 古い画面 | 409、操作履歴・業務状態・Jobは増加しない |
| 完了後の操作 | 409、完了履歴を維持 |
| 同IDを別プロセスで再送 | APPLIEDを返し、Job ID・履歴・操作件数を維持 |

敗者が後からclaimを取得して状態検証で拒否される場合、技術的所有権の世代は進み得る。保証は敗者の業務遷移・Job・操作履歴を二重確定しないことであり、技術的claim行への全書込ゼロではない。

## 6. 再起動と復元

tests/exam-persistence/host.cjsはデモHTTPサーバーを別Nodeプロセスで起動するfixtureである。正常停止を待ってから新しいprocessで同じnamespaceへ接続する。

- 承認待ち：元Job ID・履歴・申請IDを復元し、承認→審査実施確認→結果登録→COMPLETED。
- 差し戻し後：理由とFALSEを復元し、再申請できる。
- 再申請後：修正grade・補足と後方遷移を復元し、再度承認できる。
- 完了後：結果PASS／FAIL、Core履歴、操作履歴を復元し、新しい操作は拒否。

人待ちの確定境界では、前のHostがLeaseをreleaseしているため、新Hostは通常claimできる。異常終了でACTIVEが残った場合は自動Takeoverしない。UNKNOWN、未確定RUNNING、破損状態からの自動再開も行わない。

Emulatorプロセス自体の停止でデータが残るとは主張しない。実験runnerはテスト用Emulatorを作り直す。export/importの運用は今回追加していない。

## 7. Fencing・Lease

時刻源・比較・単調fence・claimTokenは019-C2をそのまま利用する。readTimeとcommit時刻は別であり、commit瞬間のLease有効性を保証しない。

- stale Hostが操作受付後に停止した状況をIPC barrierで作る。
- 親fixtureだけが期限切れTimestampと明示的administrativeTakeoverを設定する。
- 世代更新後に旧Hostを再開し、Workflow／Job／成果物の保存が拒否されることを確認する。
- 旧HostによるAPPLIED確定やUNKNOWN診断更新も同じguardで拒否する。
- token不一致／fence不一致でも同じ保存拒否を確認する。
- HTTP APIから期限切れACTIVEを取得し直そうとすると409 ADMINISTRATIVE_TAKEOVER_REQUIRED。管理Takeover APIは追加していない。

stale Hostが診断を書けない場合、保存済みcommandはACCEPTEDのまま残り得る。これは成功確定ではない。pending状態で追加操作を止め、画面では要確認とする。無権限の旧HostがUNKNOWNへ上書きしてはいけないためである。

旧Hostの純粋計算の即時停止や、任意の外部副作用の取消は保証しない。

## 8. 応答喪失・UNKNOWN

| 状況 | 保存・HTTP・照会の扱い |
|---|---|
| 正常確定・応答成功 | APPLIEDと業務境界を保存し200／201 |
| APPLIED後にHTTP接続喪失 | res.destroyで実測。GETで同操作IDのAPPLIEDを取得、同ID再送でもJob実行なし |
| APPLIED commitの応答喪失相当 | afterFinalize故障注入。読戻しでAPPLIEDを観測し、Jobや保存を再試行せず既存結果を返す |
| 受付前の確定失敗 | beforeAccept注入は保存受付前なのでNOT_ACCEPTED、commandなし。明示した後続要求は可能 |
| ACCEPTED後の障害 | 所有権が有効ならUNKNOWNとblockedを同一guard付きTransactionで保存 |
| Workflowは境界まで進んだが確定記録前の障害 | UNKNOWNのまま停止。履歴・成果物があるだけでAPPLIEDと断定しない |
| 読戻し不能／所有権喪失 | OUTCOME_UNKNOWN。無条件の再実行なし。権限のない診断更新も行わない |

読戻しは観測時点の状態確認であり、過去の保存呼出しの成功そのものの証明ではない。実験018の外部副作用保証やexactly-onceを一般化していない。今回のJobは合成データの純粋処理であり、外部サービスを呼ばない。

BrowserはACCEPTED／UNKNOWNをAPPLIEDと表示せず、操作IDを保持して照会する。POSTがHTTP成功でも、operation.statusがAPPLIED以外なら追加送信を止める。

## 9. 画面・APIの最小変更

020-Aのページ、操作ボタン、Definition、JobForm、Checkは維持した。追加表示は保存方式ラベルとmode別説明。既存の競合／結果不明messageを拡張した。

- configでFirestore Emulator／namespace／安定sessionを返す。
- 別Hostへ再接続しても同じ申請IDをGETできる。
- HTTP APIの非同期呼出しをawaitする。
- GETは履歴や状態を観測するだけで、Jobを呼ばない。
- owner token、raw SDK例外、内部パス、stackは公開しない。

最終試験で、APPLIED＋release後のPOST応答へ終了直前のローカルguardが「処理中」として混入する問題を検出した。永続化は正しかったが応答投影を修正し、確定済み応答でbusy／waitingFor／許可操作を正しく表示するようにした。試験期待値を弱めず、新規24件を全再実行した。

## 10. 自動試験・実ブラウザ

### 環境

Node v24.16.0、Java 21、既存Firestore Emulator JAR v1.21.0、SDK 9.3.1を使用。新しい依存packageは追加していない。

`tools/run-exam-persistence-tests.cjs`が空きloopback portを選び、所有するJava子プロセスでEmulatorを自動起動する。専用demo project・probeを確認してから試験を開始する。試験データはc2-UUID namespaceだけ。終了時は所有するEmulatorを停止し、停止後の再接続がEMULATOR_UNAVAILABLEになることも確認する。

Emulator未導入／起動失敗ならdependent testsをPASS／skipにせず失敗終了する。実Firestoreへ接続しない。停止確認は新しい接続の拒否であり、すべてのSDK送信中タイミングを強制切断した試験ではない。

### ケース対応

| ケース | 確認した内容 |
|---|---|
| P01 | metadata、業務工程・入力条件、native Job、成果物、Check、両履歴保存 |
| P02 | 別プロセス承認待ち復元→次操作→完了、旧Job ID維持 |
| P03 | 差し戻し後と再申請後の2回のprocess再起動、FALSEと修正内容 |
| P04 | 完了復元と終端後操作拒否 |
| P05 | 別processで同じ操作ID再送、Job／履歴不変 |
| P06 | 二つのサーバーで同時承認、勝者1・敗者1 |
| P07（2ケース） | 承認／差し戻しの勝者を両順で制御し分岐と保存を突合 |
| P08 | 古いBrowser状態を拒否 |
| P09 | 同ID・異内容を拒否 |
| P10 | 実HTTP接続の応答喪失、照会・同ID再送で二重処理なし |
| P11 | 受付後UNKNOWNの再起動復元と再実行拒否 |
| P12 | 受付前の確定失敗と、記録なしの照会 |
| P13 | APPLIED確定後例外で読戻し確認、Job再実行ゼロ |
| P14 | 境界到達後・操作確定前のUNKNOWN停止 |
| P15 | 別process stale Host、明示的世代更新後の保存・診断更新拒否 |
| P16（2ケース） | claimToken／fence不一致による保護保存拒否 |
| P17 | 期限切れACTIVEへの自動Takeover拒否 |
| P18 | 外部endpoint／通常projectの接続前拒否 |
| P19 | 不正入力の受付・保存ゼロ |
| P20 | 再起動後の申請者／先生のserver側認可 |
| P21 | 再申請で同Stepへ戻っても古いrevisionを拒否 |
| P22 | 人待ちでowner RELEASED、業務入力条件を表示 |

P01〜P22とパラメータ2追加で新規24件。Emulator起動・停止検証はrunnerの別確認で、Node試験件数へ水増ししない。

### 実ブラウザ

既存Chrome/CDP試験をmode指定可能に拡張した。Memoryの既存7確認は保持し、Emulatorでは同じ7確認に加え、承認待ちでHostを作り直して同じ申請を復元し、Browserボタンから次の承認操作を行うB08を追加した。

APIによる再起動試験は実際に別Nodeプロセスを使用する。Browser試験のHost作り直しは同じrunner内の別Hostインスタンスであり、両者を区別する。画面だけの状態代入でWorkflowを進めていない。

画像：runtime-data/experiment020b-desktop.png、runtime-data/experiment020b-mobile.png（Git管理外）。

### 最終結果

| 集合 | 結果 |
|---|---|
| 既存npm test | 529 PASS／0 FAIL |
| 既存実験009〜019-B | 291 PASS／0 FAIL |
| 既存019-C2・独立最終実行 | 21 PASS／0 FAIL／skip 0 |
| 既存020-A HTTP／Application | 27 PASS／0 FAIL |
| **既存合計** | **868 PASS／0 FAIL** |
| **新規永続化・再起動・競合** | **24 PASS／0 FAIL／skip 0** |
| **Node自動試験合計** | **892 PASS／0 FAIL** |
| 実Chrome・Memory | 7 PASS／0 FAIL（別集計） |
| 実Chrome・Emulator | 8 PASS／0 FAIL（別集計） |
| runnerのEmulator起動・停止後接続拒否 | PASS（Node件数へ加算しない） |
| Build／noEmit型検査／変更JS構文検査 | PASS |
| git diff --check | PASS（既存改行変換警告のみ） |

初回の最終確認でP22の応答投影が失敗した。実装修正後、期待値を維持した全24件を再実行してPASS。既存019-C2も独立した最終ログで21件PASSを確認した。未実施やskipをPASS扱いにしていない。

## 11. 起動・停止・再現

### デモ

先に既存のローカルEmulatorを専用設定で起動する。

```powershell
java -jar "$env:USERPROFILE/.cache/firebase/emulators/cloud-firestore-emulator-v1.21.0.jar" --host 127.0.0.1 --port 8692 --project_id demo-arch026-c2 --single_project_mode true --single_project_mode_error true
```

Emulatorを起動したまま、別のPowerShellで実行する。

```powershell
$env:FIRESTORE_EMULATOR_HOST='127.0.0.1:8692'
npm run demo:exam -- --storage=emulator --project=demo-arch026-c2 --namespace=c2-experiment020
```

URLは http://127.0.0.1:3020 。サーバーを正常停止して同じコマンド・namespaceで起動し、画面を再読込する。操作入力条件、履歴、次操作を復元できる。Emulatorを止めずに行うHost再起動である。

Memoryは従来どおり明示選択する。

```powershell
npm run demo:exam -- --storage=memory
```

Ctrl+C、または試験fixtureのclose()で受付済み操作をdrainし、SDK／HTTPを閉じる。通常の人待ちでLeaseを持ち続けない。強制終了後の不確実状態は自動復旧しない。

### 自動試験

```powershell
npm run test:exam-persistence
npm run test:exam-persistence -- --with-c2
npm run test:exam-persistence-browser
node tools/run-exam-persistence-tests.cjs --c2-only
npm run test:exam-demo
npm run test:exam-browser
npm test
```

最初の4つは検証専用Emulatorを自動起動・停止する。JARは既存cacheを利用し、必要ならARCH026_FIRESTORE_EMULATOR_JARで明示する。Browserは既存Chrome／Edgeを使う。テスト用namespace／専用Browser profile以外は削除しない。実運用のFirestore・DB・会員データへ触れない。

## 12. 変更ファイル

新規：

1. src/adapters/workflow-firestore/exam-application.cjs
2. tools/run-exam-persistence-tests.cjs
3. tests/exam-application-persistence.test.cjs
4. tests/exam-persistence/host.cjs
5. docs/EXPERIMENT_020_B_FIRESTORE_PERSISTENCE.md

既存変更：

- demo/exam-application/application.cjs：020-Aの同じ入力検証を共通関数へ抽出・export。Memory動作維持。
- tools/exam-application-demo.cjs：明示Emulator構成、async API、メッセージ、SDK close、試験専用応答喪失hook。
- demo/exam-application/index.html：保存方式ラベルのIDのみ。
- demo/exam-application/app.js：mode表示、APPLIED以外の送信結果を不明扱いで照会。
- tests/exam-application-browser.cjs：Memory確認維持、Emulator復元確認を追加。
- package.json：test:exam-persistence、test:exam-persistence-browserを追加。

既存Core・Definition・JobForm・Checkの業務内容、019-C2のStore／Composition、SQLite Adapter、道場側は変更しない。依存追加、lockfile、Schema Migrationはない。

## 13. 未解決・次工程

- commit瞬間までのLease期限保証は未証明。自動Takeoverを追加していない。
- ACCEPTED／UNKNOWNでHostを失った場合の管理照合・手動回復APIは未実装。安全に停止する。
- Workflow境界が保存されてもAPPLIED記録前なら、全面的に自動確定・再実行しない。対応する運用回復手順は後工程。
- Emulator自体の再起動後保持、export/import、バックアップ、保管期間は未検証。
- Cloud Run、実FirestoreのIAM・本番負荷・本番認証・業務冪等性との接続は未実装。
- 任意の外部副作用のexactly-once、通知・決済、実Ticket／Instance統合は保証対象外。
- 019-C2の64KiB／100履歴／20書込の実験上限を引き継ぐ。巨大Workflow対応へ一般化しない。
- SQL／Firestoreへ直接書き込める管理者や任意の非協調Hostは保証対象外。実運用には書込権限の境界設計が必要。

次は管理照合が必要な状態の分類と、手動回復の許可条件をレビューする。今回の成功だけで自動Takeoverや本番接続へ進まない。

## 14. Git保全・終了

開始時のGit状態と既存ファイルのSHA-256を採取した。最終照合を追記する。ステージ・Commit・Push・Deployは行わず、結果提示後に停止する。

最終保全照合：着手時のARCH 173ファイル中、上記6つの変更対象以外の167ファイルはSHA-256一致。package.jsonも今回の2 script追加を除いた内容が開始時hashと一致し、既存変更を保持している。両Core、既存SQLite、019-C2 Store／Composition、Definition／JobForm／Check、既存文書・Inventoryは変更なし。道場917ファイルはすべてSHA-256一致、Git状態も一致。今回新規5件・既存6件変更。ステージ済みファイルなし。HEADは26f22fdcafb1276f8a32d31629cef52759436d03のまま。各runnerは所有するEmulator・検証Hostを終了し、停止後probeもPASSした。
