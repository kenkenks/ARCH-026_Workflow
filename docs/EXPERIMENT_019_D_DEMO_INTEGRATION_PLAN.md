# 実験019-D：最小統合設計・審査申請Workflowデモ準備

調査日：2026-11-09。今回は調査・設計のみ。実装・起動・DB操作・Build・試験実行はしていない。

## 1. 採用する最小統合方式

**実験020は、独立したローカルNode HTTPサーバーと静的HTMLから、既存PrototypeのCWorkflowを操作する。保存先の第一候補は019-C2のFirestore Emulator Adapterとする。** 既存GUI Runtimeや道場システムの画面へ組み込まない。

既存CoreのWAITING追加、既存GUI Runtimeへの移植、新Runner／Looper、実認証、実Firestore接続は行わない。必要な追加は、デモ用Definition／JobForm／Check、操作入力の永続化、短時間実行をまとめるApplication層、HTTPと画面に限定する。

```text
ローカルBrowser（合成利用者、合成申請）
  → デモ専用HTTP境界／Fake Credential認可
  → 申請Application層：入力記録・重複拒否・次の入力待ち判定
  → 既存createExecution → CWorkflow.run／resume
      → 既存CJob → デモCJobForm（collect → make → record → post）
      → 既存CCheckJobによる承認／差し戻し分岐
  → 019-C2 Store＋小さな操作記録Adapter
  → 専用Firestore Emulator namespace
```

以下のAPIや追加ファイルは**実験020で新設する設計**であり、現在存在するAPIと区別する。

## 2. 現物確認と再利用範囲

| 現行実装・確認したAPI | 再利用方法／制限 |
|---|---|
| src/prototype/workflow.ts:CWorkflow.run(runId,startStepNo,maxExecutions,beforeStep?) | 新規実行。履歴のあるrunIdを再runしない |
| 同CWorkflow.resume(saved,maxExecutions,beforeStep?) | LIMIT_REACHEDの確定snapshotのみ継続。RUNNING／FAILED等から再開しない |
| 同CJob／CCheckJob／IWorkflowHistoryStore | Jobをawaitし、Check結果・遷移先・履歴をCoreが決める。PrototypeにWAITINGはない |
| src/prototype/definition.ts:reconstructWorkflow、WorkflowRegistry | JOBのjobIdをJobForm登録へ、CHECK_BOOLのcheckIdをIBool factoryへ解決。factory／onCreateは同期 |
| src/prototype/job-form.ts:CJobForm、ProductShelf | 非同期collect／make／record／postと実行別棚を維持 |
| src/adapters/workflow-firestore/composition.cjs:createExecution(store,definition,forms,checks,{resume,observe}) | 実行別binding生成・成果物復元。戻り値run(max)／products／graphを使用 |
| 同store.cjs:FirestoreExperimentStore | add／get、claim／heartbeat／release、inspect、load、commit、observeMutationを使用 |
| 同emulator.cjs:connectEmulator | demo project、loopback、専用namespace、probe、実環境変数一致の検証を維持 |
| src/prototype/diagnosis.ts:diagnoseSavedRun | 保存境界の診断。候補判定だけで再開許可を出さない |
| gui/http-input.js:readBody、BODY_LIMIT | 64KiB、fatal UTF-8、JSON root、Content-Typeの既存受信処理を再利用。validateRequestは既存GUI専用なので使わない |
| gui/server.js／gui/workflow-runtime.js | 別のGUI用Runtime。既存表示の参考に留め、requireによる初期化・データ生成をしない |
| src/hello-host/dispatch.ts | 認証・認可とdispatchを分ける考え方を参照。Hello専用Request／Result／Portを申請APIへ流用しない |
| package.json | node:http／静的HTML／fetchで成立。Webフレームワーク・bundler追加不要。SDK 9.3.1は既存devDependency |

019-C2報告の基準は841 PASS／0 FAIL（従来820＋Emulator21）。本調査では再実行していない。既存テストにBrowser E2E基盤は宣言されておらず、実験020ではHTTP自動試験と実ブラウザ操作確認を分けて実施する。

## 3. 待機の表現：技術境界と業務入力条件を分離

### 3.1 現行Coreでできること

PrototypeはRUNNING／LIMIT_REACHED／COMPLETED／FAILEDを扱い、業務承認待ちのWAITINGを持たない。CWorkflow.resumeはLIMIT_REACHEDの確定履歴を要求する。したがって、**LIMIT_REACHED自体を先生承認待ちと定義しない**。

実験020では一工程ずつrun(1)／resume(...,1)で進める。これはHostが短い技術sliceを確定するための停止条件であり、業務待ちの意味を持たない。Application層が、保存されたcurrentStepNoとDefinitionに対応する入力条件から「次のJobに人の入力が必要か」を判断する。

業務表示は例えば次の3軸とする。

```json
{
  "workflowStatus": "LIMIT_REACHED",
  "businessStage": "AWAITING_TEACHER_DECISION",
  "waitingFor": "TEACHER_DECISION",
  "operationStatus": "IDLE"
}
```

同じLIMIT_REACHEDでも、currentStepNoが自動Checkなら操作待ちではない。人の入力がない状態では、そのJobを実行せずHTTP要求を終了し、claimをreleaseする。Promiseを人の操作まで待ち続けたり、入力不足を故意にthrowしてFAILEDにしたりしない。

### 3.2 入力条件表（新規Application設定）

| 次のStep | 必要入力 | 入力なしの業務表示 |
|---|---|---|
| 10 申請受付 | START申請の合成入力 | まだ申請を生成しない |
| 20 先生判断記録 | APPROVEまたはRETURN | 先生承認待ち |
| 40 審査実施確認 | CONFIRM_EXAM | 審査待ち |
| 50 結果登録 | REGISTER_RESULT | 結果登録待ち |
| 30 Check／60 完了／90 確認案内 | 既存公開成果物のみ | 人の操作待ちにしない |

入力条件表はCoreの遷移先を上書きしない。次Stepは常にCoreが保存したcurrentStepNoを使う。表・Job登録・固定DefinitionのVersion／digestを起動時に照合する。

## 4. デモDefinition・JobForm・Check

### 4.1 固定Definition案

既存prototype-workflow/1を使用する。ENDは新しいNode種別ではなく、既存どおりJOBのnextStepId省略で表す。

```json
{
  "schemaVersion": "prototype-workflow/1",
  "definitionId": "demo-exam-application",
  "definitionVersion": "1",
  "startStepId": "application.accept",
  "steps": [
    {"stepId":"application.accept","stepNo":10,"kind":"JOB","jobId":"demo.application.accept","nextStepId":"teacher.decision"},
    {"stepId":"teacher.decision","stepNo":20,"kind":"JOB","jobId":"demo.teacher.decision","nextStepId":"teacher.branch"},
    {"stepId":"teacher.branch","stepNo":30,"kind":"CHECK_BOOL","checkId":"demo.approved","trueStepId":"exam.confirm","falseStepId":"application.review"},
    {"stepId":"exam.confirm","stepNo":40,"kind":"JOB","jobId":"demo.exam.confirm","nextStepId":"result.register"},
    {"stepId":"result.register","stepNo":50,"kind":"JOB","jobId":"demo.result.register","nextStepId":"application.finish"},
    {"stepId":"application.finish","stepNo":60,"kind":"JOB","jobId":"demo.application.finish"},
    {"stepId":"application.review","stepNo":90,"kind":"JOB","jobId":"demo.application.review"}
  ]
}
```

### 4.2 JobFormと公開成果物

| Job | collect／makeの責務 | postする成果物キー |
|---|---|---|
| application.accept | 検証済みSTART入力とサーバー発行IDを取り込む | application |
| teacher.decision | 当該run・Step20に結び付く保存済み操作を読む。承認／差し戻しとactorを記録 | teacherDecision |
| exam.confirm | 合成審査実施確認入力とapplicationを読む | examConfirmation |
| result.register | examConfirmationと検証済み結果入力を読む | examResult |
| application.finish | 受入可能なexamResultを取得し最終概要を作る | applicationOutcome（outcome=RECORDED） |
| application.review | RETURNのteacherDecisionを取得し確認案内を作る | applicationOutcome（outcome=RETURNED） |

操作を消費するJobの成果物にはcommandId、actorId、操作種別、対象applicationIdを含める。技術的な失敗情報を通常成果物として自動公開しない。出力は合成ID等に限定する。

Check demo.approvedは公開teacherDecision.decisionを読む。APPROVE→TRUE、RETURN→FALSE。それ以外・欠落は入力不整合であり勝手にFALSEへ変換しない。

現行createExecutionはCheckへproductsを引数注入しない。既存APIで接続する方法は、同期factoryが評価用closureを返し、createExecution完了後に戻り値productsをclosureへ結び付け、runの前に設定完了を確認する方法とする。factory内では評価・非同期readを行わない。JobFormのcollectは既存どおり引数のreaderを使う。

JobFormは再利用可能な処理定義を保ち、実行入力は実行別のimmutable contextからcollectへ渡す。同じ共有JobFormオブジェクトへ最新承認や結果を代入しない。

### 4.3 実際の進行

| 操作 | Coreが実行する工程 | 保存後の次工程・表示 |
|---|---|---|
| 申請開始 | 10 | next=20、先生承認待ち |
| 承認 | 20 → 30 TRUE | next=40、審査待ち |
| 差し戻し | 20 → 30 FALSE → 90 | COMPLETED、申請は差し戻し・要確認 |
| 審査実施確認 | 40 | next=50、結果登録待ち |
| 結果登録 | 50 → 60 | COMPLETED、結果登録済み |

「審査待ち」と「結果登録待ち」を別の実工程にするため、要求の操作一覧に**審査実施確認を一つだけ追加**する。これを設けないと二つを同時に表示するか、画面操作だけで切り替えることになるためである。実審査実施の証明ではなく、合成ユーザーによるデモ入力として明示する。

差し戻しではWorkflow制御は正常終了するが、業務表示は完了扱いにしない。applicationOutcome=RETURNEDと「Workflow終了／申請は要確認」を表示する。再申請・編集ループは今回追加しない。新しい合成申請の開始で再度試せる。

結果のPASS／FAILは両方とも正常な業務成果物とする。FAILをWorkflow FAILEDへ変換しない。FAILEDは技術障害や契約不整合として別表示する。

## 5. 必要な追加機構：操作入力と重複拒否

### 5.1 現状との差分

019-C2には人の操作入力、申請一覧、操作idempotencyのRepositoryがない。FirestoreExperimentStore.commitはWorkflow保存用であり、そのmutation receiptだけでHTTPの操作全体が冪等になったとはいえない。**小さなデモ専用Command Storeを追加する必要がある。** CWorkflowや既存Repositoryの契約は変更しない。

これは通知・決済の既存冪等性の再実装ではなく、今回新設するブラウザ操作受付の重複制御である。

### 5.2 保存する入力

- commandId：クライアントが操作ごとに発行するUUID。応答喪失後も同じものを使用。
- applicationId／runId、Definition ID／Version／digest。
- 操作種別、期待run revision／currentStepNo。
- 合成actor ID／サーバー判定のrole。
- 検証済みpayload、内容digest、受付時刻。
- 技術状態ACCEPTED／APPLIED／UNKNOWN、適用後のrun revision・参照する履歴order。

これらは新規Application用DTOであり、TraceEntryやWorkflow状態の追加ではない。受付拒否は400／403／409等で返し、Jobや業務状態を変更しない。

### 5.3 処理手順

1. HTTPで型・サイズ・合成Credential・対象への権限を検証する。
2. 同一applicationのプロセス内ガードを最初のawait前に取得する。既存CWorkflowガードだけに依存しない。
3. 同じcommandIdの記録を調べる。同じactor・target・内容なら既存状態を返し、再進行しない。内容違いは409。
4. 未受付なら、既存claimで短時間の所有権を取得する。
5. 新Command StoreのTransactionでownershipを読み、既存store.guardを使用する。command・申請metadata・run headを先に読み、期待revision／Step／入力条件・未処理操作なしを照合して、commandとpendingCommandIdを同時保存する。
6. 既存createExecutionから一工程実行する。collectは対応するACCEPTED操作をasync取得する。既存Check／自動Jobだけを次の入力条件まで続行する。
7. 各sliceの後は保存済みcurrentStepNoで次を判断する。Application層がTRUE／FALSEや次Step番号を再計算しない。自動工程数にも上限を設ける。
8. 次の人の入力条件、または終端に到達したら、確認したrun revisionを条件にcommandをAPPLIEDへ更新しpendingを解除する。最後にreleaseする。
9. 例外・応答不明ではUNKNOWN／要照合として停止する。Jobの自動再実行、別commandIdでの置換、新しい操作の受付をしない。

Firestoreの操作受付／確定更新でも、所有権検証と保護対象の書込は同じTransactionに置く。Transaction callback内でWorkflow、Job、外部I/Oを実行しない。既存Storeの実験APIを汎用化せず、デモ専用Adapterが同一runのowner／headを使用する。

STARTのapplicationId／runIdは、合成actorとcommandIdからサーバー側で安定して導出する案とする。HTTP再送のたびに別runを作らない。申請metadataの作成もSTART受付と同じTransactionで行い、本文不一致は拒否する。

### 5.4 部分成功・再起動

操作の受付、CMRP各保存、全操作のAPPLIED記録は一つのTransactionにはできない。全体原子性は主張しない。

- ACCEPTED後にHost終了、Job未実行：操作を勝手に再実行しない。保存状態と入力を表示し、初回デモでは手動確認対象とする。
- 成果物公開済みだがtrace／Job完了未確認：成果物の存在だけでAPPLIEDとしない。新操作を止める。
- 確定した次の業務入力境界／終端まで保存済みだがAPPLIED記録失敗：commandId入り公開成果物、対応Job完了、Trace、実行境界、Definitionを照合する。確定できた場合だけ技術記録を修復し、Jobは呼ばない。
- RUNNING／FAILED／破損／保存結果不明：resumeを自動実行しない。
- 人の入力待ちでclean release済み：同じnamespaceでHost再起動後、状態を再診断して新しい操作を受け付けられる。
- Leaseの残ったHost異常終了：019-C2の管理takeoverが必要な状態を示す。020のブラウザAPIには管理takeoverを公開しない。

最初のデモは正常な操作と正常再起動を完走させることを優先し、上記不確実ケースは安全に止まることを受入条件とする。包括的な自動回復機構は作らない。

## 6. 永続化方式

### 6.1 第一候補：Firestore Emulator

019-C2の接続制限を維持し、`demo-arch026-c2`、`127.0.0.1:8692`、namespace `c2-experiment020`をデモ専用に明示する。通常起動で毎回namespaceを変えるとHost再起動で見失うため固定設定とする。自動flush／削除は行わない。試験は別のc2-UUID namespaceを使用する。

既存のdefinitions／runs／history／jobs／artifacts／control／mutationsは再利用する。追加するのはnamespace配下のapplicationsとcommandsだけとし、runへの参照を持つ。本文とtimestampは明示decoderでJSONへ変換し、owner tokenやraw SDK情報をAPIへ出さない。

固定Definitionはgetで存在・内容を確認し、不存在ならadd。同一Versionの異内容を上書きしない。暗黙Migrationなし。保存範囲と起動設定は画面へ表示する。

Host再起動とEmulator再起動は別である。019-C2のJAR直接起動は、Emulator終了後のデータ存続を保証していない。Emulatorのexport／import設定を別途検証しない限り、「再起動後も永続」と表示するのはHostだけに限定する。

### 6.2 利用不能時の明示的代替：Memoryモード

既存CMemoryHistoryStore、createMemoryProductShelf、reconstructWorkflowを使う静的Compositionを用意する。フォーム、Check、Definition、Applicationの操作意味、HTTP／UIは共通とする。操作記録は実行別Mapとプロセス内ガードで保持する。

**起動時に明示選択した場合だけ**利用する。Emulatorへの接続失敗後や処理途中に自動fallbackしない。画面に「Memory：プロセス終了で全データ消失、分散所有権なし」と常時表示する。refreshは同じHost内で取得可能だが、Host再起動後の復元はない。bootSessionIdを付け、古い画面からの操作を拒否する。

SQLiteJobRunStoreも既存の永続化候補だが、操作入力とWorkflowの整合保存まで同等にするには専用Schema／Adapter設計が増える。最短の020ではSQLite実装を追加せず、Memoryを縮退デモとする。MemoryではFirestoreのFencing・Lease・耐再起動性を検証済みと表示しない。

## 7. HTTP API案（すべて新設）

デモ専用Nodeサーバー、127.0.0.1限定、同一Origin。既存gui/server.jsのルート・state・Ticketへ追加しない。

| API | 入力／出力・処理 |
|---|---|
| GET / | 固定HTMLのみ配信。任意ファイルパス配信なし |
| GET /api/demo/config | 保存mode、bootSessionId、固定合成選択肢、デモであること |
| POST /api/demo/applications | commandId、memberId、grade、bootSessionId。STARTを記録してStep10を実行 |
| GET /api/demo/applications/:applicationId | 申請情報、workflowStatus、currentStep、waitingFor、businessOutcome、許可操作、公開された履歴、操作状態 |
| POST /api/demo/applications/:applicationId/commands | commandId、expectedRevision、expectedStepNo、bootSessionId、kind、payload |
| GET /api/demo/applications/:applicationId/commands/:commandId | 操作の受付／適用／不明状態の照会のみ。Jobを実行しない |

kindとpayload：

- APPROVE：空payload。
- RETURN：reason（必須非空文字列、例200文字以内）。
- CONFIRM_EXAM：examDate（YYYY-MM-DDの実在暦日、合成審査）。
- REGISTER_RESULT：result=PASS|FAIL、score=0〜100の有限数値。審査業務の正式仕様ではなく実験用受入条件。

新規APIのrootはobject、既知項目と型を明示し未知項目は拒否する。合成member／gradeは固定catalogから選ぶ。起案日時、applicationId、runId、actor roleはサーバー側で確定し、クライアント指定status・nextStep・所有権は受け付けない。本文は既存readBodyで64KiB、fatal UTF-8、application/jsonを検証する。

応答は申請の最新stateとoperationの識別情報を分ける。新規START成功201、操作適用済み200、既に受付済みで処理継続中202、入力不正400、未認証401、role不一致403、不存在404、状態・revision・重複内容・実行中競合409、本文超過413、Content-Type不正415、保存不明／Lease問題503、内部障害500とする。内部例外・stackを出さない。

送信後timeoutでは画面を「結果確認が必要」にし、GETで同じcommandIdを照会する。自動再送なし。保存不明を確定失敗と表示せず、別操作ボタンを有効化しない。

## 8. 権限・HTTP安全性

実認証は導入しない。サーバー内の固定Fake Credential→合成principal対応表で、APPLICANTとTEACHERを解決する。ブラウザのrole項目だけを信用しない。

- APPLICANT：自分の合成申請の開始・参照。
- TEACHER：対象合成申請の参照、承認／差し戻し／審査確認／結果登録。
- role不一致や他の合成申請への不正操作は、claim／command記録／Job実行の前に拒否する。

画面の利用者切替はデモ資格を選ぶ補助手段であり、安全な本人認証ではない。任意のローカル利用者がデモ資格を選べることを明示する。業務上のactorIdと技術ownerId／fenceを別に扱う。

Host／Originを実listen先へ限定しCORS wildcard・Cookie認証は使わない。Browser POSTはOrigin必須。Originなしを許すのは明示したHTTP試験構成だけ。既存Hello Hostの防御方針を参考にし、Hello固有Portは使わない。

## 9. ブラウザ画面

新しいdemo/exam-application配下のHTML／JS／CSSだけを配信する。React等は追加しない。

- 申請情報：applicationId、合成memberId、grade、createdAt。
- 進捗：Definitionの工程表示、現在Step、Traceから得た完了工程、waitingFor。
- 状態：CoreのworkflowStatusと、業務の待ち／結果を並べる。RETURNEDを「申請完了」にしない。
- 操作：申請開始、承認、差し戻し、審査実施確認、結果登録、履歴更新。
- 合成ユーザー選択と保存modeの常時表示。Memoryの消失条件、Emulatorの専用設定も明示。
- 履歴：at、Step表示名、command種別／actor、Trace result。操作情報はcommandId付き成果物と対応Job／Traceから投影する。既存TraceEntryへ未知フィールドを追加しない。
- 送信中ガード・ボタン無効化は補助対策。Serverの排他／Command Storeの整合検証を省略しない。
- DOMにはtextContentを使い、差し戻し理由などをHTMLとして挿入しない。

基本は操作後と「履歴更新」でGETする。WebSocket／SSE／自動監視は作らない。申請IDを画面に表示し、同一BrowserのsessionStorageに最後の合成IDだけ保持してrefresh時に再取得する。申請一覧／検索／複数画面管理は初回対象外。

## 10. 実験020の実装手順と想定ファイル

| 工程 | 変更候補 | 完了条件 |
|---|---|---|
| 020-1 Definition／業務処理 | demo/exam-application/definition.json、job-forms.cjs | 既存Validatorを通過。両分岐、PASS／FAILをCWorkflowから実行 |
| 020-2 入力記録 | src/adapters/workflow-firestore/demo-commands.cjs | 所有権＋期待head＋単一pending＋commandを同一txで保護。再送は進行ゼロ |
| 020-3 Application | demo/exam-application/application.cjs | 既存createExecutionで入力条件まで実行。人待ちでrelease。明示再開 |
| 020-4 縮退Composition | demo/exam-application/memory.cjs | 共通Definition／JobFormで動作。mode差を明示し起動時だけ選択 |
| 020-5 HTTP | tools/exam-application-demo.cjs | localhost・Fake role・本文検証・409／503・状態取得。安全な起動停止 |
| 020-6 Browser | demo/exam-application/index.html、app.js、style.css | 実APIから進捗／履歴を表示し正常・差し戻しルートを操作 |
| 020-7 試験・手順 | tests/exam-application-demo.test.cjs、必要な子process fixture、docs/EXPERIMENT_020_EXAM_APPLICATION_DEMO.md | 下記自動／ブラウザ確認、既存回帰、起動停止手順 |
| 起動script | package.json | demo:exam scriptを追加する程度。新しいフレームワーク依存なし |

ファイル名は実装時に既存命名との衝突を確認する。既存workflow-firestore/store.cjsの参照を安全に再利用できるかを020-2で確認する。必要なら同Adapterの小さな補助公開を候補とするが、Coreを変更しない。Command保存をFencing外の直接writeで済ませる案は採らない。

## 11. 試験計画・受入条件

### 自動試験

1. 固定DefinitionのValidatorとRegistry解決、正常run、履歴・成果物の直接assert。
2. 開始後Step20、人入力なしではJobを実行せずmake回数・履歴・成果物が不変。
3. APPROVE入力→Job20→Check TRUE→Step40。画面状態の直接代入なし。
4. RETURN入力→Check FALSE→Job90、Workflow COMPLETEDと業務RETURNEDを区別。
5. CONFIRM_EXAM→Step50、REGISTER_RESULT→Job50／60完了。PASS／FAILとも正常出力。
6. 同commandId再送は元結果を返し、Job ID／Job回数／Trace／artifactが増えない。内容違い409。
7. 別commandIdの同時承認／差し戻しは一つだけ受付。古いrevision、Step違い、終端後操作を拒否。
8. Fake資格欠落401、APPLICANT承認403。他申請ID、型外値、不正暦日、不正JSON／UTF-8／body上限を拒否し保存・Jobゼロ。
9. command受付後の保存前／後例外、CMRP公開後・trace前、APPLIED更新応答喪失で停止・照合。Jobを自動再実行しない。
10. 人待ちで正常停止後、同一Emulatorで別Hostプロセスから申請と履歴を復元し次操作へ進む。Definition不一致拒否。
11. Emulator未起動で起動拒否。Memoryへの暗黙fallbackなし。Memory選択時は再起動復元なしを確認。
12. 既存841件の回帰、Build／noEmit型検査／JS構文検査／git diff --check。Emulator依存試験は明示コマンドで実行し、未実行をPASSにしない。

### 実ブラウザ確認

合成申請開始→teacherへ切替→承認→審査実施確認→結果登録→履歴更新を完走する。別申請で差し戻しルートを確認する。二重クリック、refresh、role拒否、HTTP結果不明表示、Memory bannerを確認し、画面と保存Trace／Job／artifactを突合する。

初回は手動実ブラウザ確認を必須とし、結果・画面を報告書へ記録する。Playwright等の自動E2E導入は020の完走を妨げない後続候補であり、現在導入済みとは扱わない。

## 12. 起動・停止・デモ操作手順案

以下は020で用意する手順であり、現時点でdemo:examは存在しない。

1. npm run build。Emulator・SDK・NodeのVersionと専用設定を確認する。
2. 既存019-C2と同じローカルJARを、127.0.0.1:8692、demo-arch026-c2で起動する。
3. FIRESTORE_EMULATOR_HOSTを明示し、`npm run demo:exam -- --storage=emulator --namespace=c2-experiment020`でHost起動。port既定は専用3020とする。
4. 接続検証、固定Definition照合、HTTP listenの順に行い、準備完了後だけURLを表示する。
5. Browserで127.0.0.1:3020を開き、合成member／gradeを選んで申請開始。teacher資格へ切替え、承認・審査実施確認・結果登録を行う。
6. 別申請で差し戻す。「Workflow終了／要確認」と理由・FALSE履歴を確認する。
7. Memoryは`--storage=memory`を明示して別セッションとして起動する。EmulatorデータをMemoryへ移す機能は設けない。
8. 終了時は新規操作を止め、受付済み短時間操作の完了／不明状態を確認してrelease・SDK close・HTTP close。Windowsでは試験runnerからcloseできる関数を用意し、signalだけに依存しない。
9. 異常停止やtimeoutで完了と断定しない。検証用Emulatorだけを停止し、保存データの自動削除は行わない。

## 13. 安全性・未対応・実装開始条件

- 本デモの合成承認・合成審査結果は正式な道場業務を表さない。先生資格はFake認可であり実本人認証ではない。
- 019-C2のcommit時Lease保証と自動Takeoverの不足を引き継ぐ。ブラウザから管理takeoverしない。
- Host再起動・操作の二重送信・保存応答喪失を区別する。任意RUNNINGからの自動復旧はしない。
- Ticketとの整合、既存道場画面、実審査進捗DAO、実会員、通知、決済、承認期限、再申請ループ、複数Host運用を追加しない。
- Emulator永続化とMemoryを同じ保証として扱わない。SQLiteとの完全交換可能性は今回の完了条件に含めない。
- Command StoreとWorkflow更新の間に障害があり得る。照合不能では操作を保留する。全体exactly-onceを主張しない。

**020の完了条件**：実際のCWorkflowを使い、承認／差し戻しのCheck分岐、三つの人入力条件、結果登録、公開成果物・実行履歴をブラウザと保存内容で突合できること。重複操作・権限違反・保存不明で二重進行しないこと。Core・道場側を変更せず、既存回帰を維持すること。

実装開始時に019-C2成果と本計画を再確認する。既存Adapterでは安全な操作入力保存を接続できない場合、直接writeやCore変更で迂回せず、必要な最小差分を報告する。

## 14. 今回の変更管理

作成は本書のみ。両リポジトリの既存未コミット変更・未追跡文書を保護する。テスト実行・Build・Emulator起動・DB操作・ステージ・Commit・Push・Deployは行わない。計画提示後に停止し、実験020へは着手しない。

最終保全確認：着手時のARCH 162ファイル、道場917ファイルのSHA-256がすべて一致。既存Git状態は維持し、今回の追加は本書1件のみ。ステージ済みファイルなし。git diff --checkは成功（既存ファイルの改行変換警告のみ）。
