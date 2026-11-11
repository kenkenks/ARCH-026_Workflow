# 実験022-B2：WAITING状態・永続化契約

2026-11-09。本体はARCHのみ変更。既存CJobのCMRPとCCheckJobのboolean分岐は変更していない。

## 状態・定義

RunSnapshotにWAITING、waitSequence、waiting（reason／generation／nextStepNo）を追加した。WAITINGはJobを実行していない工程間の正常待機。WAIT工程のstepNoで停止し、次工程をwaiting.nextStepNoで保持する。LIMIT_REACHEDは従来どおり技術上限で、既存resume契約を維持する。CREATEDは今回追加していない。

src/prototype/definition.tsにprototype-workflow/2を追加し、WAIT（stepId、stepNo、reason、nextStepId）を明示的に記述できる。prototype-workflow/1はJOB／CHECK_BOOLのみで従来形式を維持し、WAITを拒否する。再構築時にはWAITノードをCWorkflowへ接続し、JobのcallbackをWAITのために作らない。

CWorkflowはWaitStep到達時にJobを生成せず、waitSequenceを増加しWAITINGを保存して返す。履歴に架空のDONEやERRORを追加しない。最初のJob前のWAITも空履歴で扱える。通常のCMemoryHistoryStoreはDTOを検証・コピーできるが、atomic Lifecycleを持たないStoreへWAITグラフを接続すると実行前拒否する。

## 保存領域

新規src/adapters/workflow-waiting/lifecycle.cjsが共通のWaitingHistoryStoreとMemoryLifecycleBackend、sqlite.cjsがSQLiteLifecycleBackendを実装する。同じ状態検証・操作判定を両backendで使用する。Memory保証は同一プロセス内だけ。

SQLiteは明示initializeで新規ファイルを作る。application_id=0x41525754、user_version=1、waiting_runs(run_id PRIMARY KEY, state_json)の専用領域。旧history/control DBのテーブルを流用・暗黙更新しない。通常OpenではID/Version不一致を拒否し、既存ファイルの削除・Migrationはしない。1runを一つの論理DTOとして保存し、内部SQLの競合処理は外部APIのupsert機能ではない。初回claimStartは既存runを拒否する。

| 保存項目 | 内容 |
| --- | --- |
| identity | runId、definitionId、definitionVersion、definitionDigest、保存schemaVersion |
| snapshot | 実行状態、現在のWAIT工程、次工程、wait reason、世代、確定済みJob/Check trace |
| revision | 保存・公開・再開claimごとのCAS revision |
| owner | ownerId、ランダムtoken、単調fence、ACTIVE/RELEASED、有効期限 |
| operations | operationId、START/RESUME_WAITING/RESUME_LIMIT、要求内容、RUNNING/FINISHED、確定結果snapshotとrevision |
| events | START_CLAIMED／WAIT_ENTERED／WAIT_RESOLVED、連番、日時、操作ID・待機情報 |
| products | postした実行別の公開成果。登録/取得時にコピー。再接続後に取得可能 |
| input／updatedAt | 受理済み操作結果、最終更新時刻 |

WAITING時の操作IDはactiveOperationId・対応operationとWAIT_ENTERED eventに保持する。state_json内にまとまっており、leaseだけ別ファイルへ保存しない。Jobの内部recordはCJobの現行実行単位に保持し、post前の内部成果を公開しない。Job途中の内部状態を復元して実行する仕組みは追加していない。

## 原子境界

SQLiteはBEGIN IMMEDIATE内で既存row、owner/token/fence/期限、期待revision、履歴prefixを検証し、新snapshot＋revision＋操作結果＋WAIT_ENTERED＋owner RELEASEDを一括保存する。WAITINGなのにACTIVE ownerが残る、RUNNINGなのにownerだけ解放される保存を行わない。RELEASED ownerの旧token/fenceは監査・stale拒否のため残すが、期限を保存時刻にし、実行権としては無効。

beforeCommit障害では全体rollback、afterCommit応答喪失ではOUTCOME_UNKNOWNとしてStoreをpoisonし、状態を勝手に戻さない。Coreも既存WorkflowRunError/HISTORY_SAVE_OUTCOME_UNKNOWNで安全な読戻し観測を付ける。確認済みWAITINGを新しいStoreから明示再開することと、保存操作を自動再送することを区別する。

JobをTransaction callback内で実行しない。make/record失敗ならpostへ進まない。post後・Job終了保存前の異常終了では公開成果があり得るが、RUNNINGと未確定operationを維持し、自動再実行しない。

## Job・Check・履歴

collect→make→record→postはそのまま。実行・反復ごとに新CJobを生成する。待機前のJob履歴は保存済みprefixとして固定される。WAIT再開後は保存された次工程へ進み、確定済み操作結果をgetInput()から受け取るApplication/Checkを構成できる。Unitは業務権限や「承認」の意味を知らない。

control eventsとJob/Check traceを分け、WAITへの到達だけでJob成功を捏造しない。旧diagnosis.tsは新WAIT制御証跡まで検証する診断器ではないため、WAIT traceを旧Checkとして解釈せず安全側に拒否する。新Lifecycleのloadは独自の保存DTO/receipt/owner構造を検証し、旧SQLite再開AdapterへWAIT状態を流用しない。

## 使用方法（ローカル合成例）

1. npm run build。
2. 新しい一時ファイルにSQLiteLifecycleBackend.initialize(file)。MemoryならMemoryLifecycleBackendを生成。
3. WaitingHistoryStoreへrunId・定義ID/Version/digest・ownerIdを渡す。claimStart(operationId)後にreconstructWorkflow(schema2, registry, store)で実際のCWorkflowを生成しrun。
4. WAITINGのsnapshotとstore.read().revisionを取得。別Hostでは新backend/Store/Job/Checkを生成する。
5. B3の要求をresumeWaitingへ明示的に渡す。例はtests/workflow-waiting/scenario.cjsとtest.cjs。
6. backendをcloseし、テスト専用ファイルだけを破棄する。既存DBは扱わない。

## 検証・変更範囲

新規49件は、WAITING共通契約44件と診断5件。Memory/SQLite双方で待機、入力、公開成果、コピー、二重要求、世代、失敗・保存応答喪失、Job/Check再実行防止をassert。SQLiteは別プロセス、同時開始、process.exitによる実Transaction中断を実行。最終49 PASS／0 FAIL。作成中の初回2件FAILはnull操作が再開経路へ入った問題で、Core入口のroot検証を修正して解消した。既存試験は弱体化していない。

既存892 PASS／0 FAIL、パッケージ2 PASS、Build/noEmit型検査/JS構文/diff check成功。ただしB1反復の保存結果不明FAILは未解決であり、本結果で隠さない。

変更：src/prototype/{workflow,definition,diagnosis}.ts、新規src/adapters/workflow-waiting/{lifecycle,sqlite}.cjs、新規tests/workflow-waiting.test.cjs、tests/workflow-waiting/{scenario,child}.cjs。package.jsonにtest:waitingを追加。B1とパッケージ変更は各報告書を参照。

## 既存Firestoreとの境界

Firestore Store/compositionは新Lifecycle PortのclaimWaitingやWAITING＋Lease解放の原子保存を持たない。CoreはそのPortなしのWAITグラフを最初の実行前に拒否する。旧Firestoreへ新WAITING snapshotを直接commitしても新保証は成立しないため、今回利用対象にしない。既存Firestore Adapterのコードは変更していない。022-B4でPort・Schema・control event・診断を接続する必要がある。今回45件のEmulator回帰は旧契約だけの確認である。
