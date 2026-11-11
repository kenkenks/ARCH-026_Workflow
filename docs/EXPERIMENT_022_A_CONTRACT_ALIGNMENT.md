# 実験022-A：Workflow基盤・道場業務整合設計

2026-11-09。調査・設計のみ。以下の「現状」はコード・試験で確認した事実、「採用案」は次工程に向けた技術設計であり未実装、「判断待ち」は業務責任者等の決定が必要な事項である。今回はCore、既存コード、Unit、DBを変更しない。

## 1. 現状構造と調査根拠

対象はARCH-026_Workflowとclasp_道場サポ。HEADはそれぞれ26f22fdcafb1276f8a32d31629cef52759436d03、4d6f55582d4e89cb8957b814d267d82461cc2951。両方に未コミット成果があり、HEADだけで現物の実装を説明できない。既存ファイルのSHAを記録し保全する。

参照：EXPERIMENT_019_A_DIFF_SURVEY.md、EXPERIMENT_020_B_FIRESTORE_PERSISTENCE.md、EXPERIMENT_021_A_INTEGRATION_READINESS.md、EXPERIMENT_021_B_DOJO_UNIT_INTEGRATION.md、EXPERIMENT_021_C1_TEST_ISSUES.md、EXPERIMENT_021_C2_EXAM_WORKFLOW_DESIGN.md、EXPERIMENT_021_C3_EXAM_WORKFLOW_CONNECTION.md。

| 現物 | 確認した契約・試験 |
| --- | --- |
| ARCH src/prototype/workflow.ts | CWorkflow.run/resume、RunSnapshot、TraceEntry、CMemoryHistoryStore、CJob、CCheckJob。resumeはLIMIT_REACHEDのみ。CJobは単一使用のCMRP実行単位 |
| src/prototype/job-form.ts、definition.ts | 再利用するCJobFormと実行別ProductShelf。Definition schema prototype-workflow/1はJOB／CHECK_BOOLのみ。WAITノードなし |
| src/prototype/diagnosis.ts | LIMIT_REACHEDをRESUMABLE_CANDIDATEとして判定。候補判定は再開許可ではない |
| src/adapters/workflow-firestore/{store,composition,emulator}.cjs | owner guardと保存を同一Transactionで実行。run revision、mutation receipt、履歴digest、内部／公開成果を保存。接続はEmulator限定 |
| src/adapters/job-execution/{diagnostic,resume,ownership}.cjs | SQLite診断・明示再開・Lease／Fencing。診断読込競合はC1で再現 |
| demo/exam-application/application.cjs | gateの業務待ち表示にLIMIT_REACHEDを利用。現在のデモ方式であり、新WAITING契約ではない |
| tests/job-run-resume.test.cjs | 確定済みJob／Checkを繰り返さない再開、所有権拒否、異なるrunの独立性をassert |
| tests/workflow-firestore.test.cjs | async CMRP、record/post境界、別プロセス、所有権、commit応答喪失、保存不明をassert。WAITINGは試験していない |
| tests/workflow-unit-package.test.cjs | Core／Adapterの配布バイト一致、SQLite除外、同一ソースのarchive再生成一致 |
| 道場 cloud/workflow/{unit,application,api}.cjs | 固定Unit、合成申請準備＋実進捗reader、操作receipt、既存Principalによる権限判定。承認業務全体ではない |
| 道場 cloud/api/{webConnect,admin-api,dojo-principal}.cjs、shared/WebConnectCore.js | action解決、既知ルート判定、資格検証、サーバーAccountによる本人／先生解決、業務呼出し |
| 道場 cloud/attendance/progress-firestore.cjs、schema/ExaminationStandard.yml | 進捗投影と基準マスタ。審査申請の保存Schemaではない |

ARCHのsrc/core/WorkflowEngine相当の骨格を実行エンジンとして扱わない。実行主体はsrc/prototype/である。

## 2. 不整合

1. 人間の入力待ちと技術上限到達が現在のデモで同じLIMIT_REACHEDに依存している。
2. Coreの状態追加だけでは、所有権解放・入力受理・履歴・再開の原子境界が成立しない。IWorkflowHistoryStoreのsave/loadだけでは複数文書の保証を表現できない。
3. COMPLETEDは制御フローの終端であり、業務成功・成果物受入・外部通知完了と同義ではない。
4. 先生による対象者登録の構想と、会員申請／先生承認の候補フローが未整理。進捗表示を申請実装と見なせない。
5. WebConnect旧試験の未接続前提、SQLite診断読取競合が残存する。
6. 旧Unit・旧DTOを上書き更新すると、旧実行の復元と配布同一性が壊れる。

## 3. Workflow状態遷移の採用案

以下は次版の実行契約案。業務の「申請中」「承認済み」とは別軸。UNKNOWNは保存／操作の技術的結果であり、今回新しいWorkflow状態にしない。

| 状態 | 現状 | 意味・遷移条件 | 保存する内容 | Lease・再開・異常時 |
| --- | --- | --- | --- | --- |
| CREATED | Core未実装。保存前の不存在／ApplicationのNOT_STARTEDとは異なる | runをcreate-onlyで登録済み、Job未開始。明示開始でRUNNINGへ | 定義ID/Version/digest、runId、開始工程、revision、空のJob履歴 | Leaseなし。開始時にclaim＋CAS。登録結果不明はrunId/operationId照合し、別runを自動生成しない |
| RUNNING | 実装済み | 所有Hostが制御を進行。工程間でWAITING、終端でCOMPLETED、確定した処理失敗でFAILED、実行予算でLIMIT_REACHEDへ | 現工程、確定済みtrace、Job実行ID/工程/内部・公開成果、定義固定情報、revision、所有権参照 | 有効Leaseが必要。Host停止だけでFAILEDやWAITINGにしない。失効後も自動再実行せず診断・明示所有権移譲 |
| WAITING | 未実装 | 明示WAIT境界へ到達し、待機状態と所有権解放の保存が確定。人の操作を待つ | 後述のwait DTO、確定済みJob/Check履歴、control event、入力receipt参照 | Leaseを保持・延長しない。有効な入力とCAS、次世代claimを得てRUNNINGへ。読込だけで再開しない |
| COMPLETED | 実装済み | 制御フローが終端へ到達。出力受入や業務結果は別評価 | 終端snapshot、確定済みtrace、Job/成果/操作receipt | 終了保存とowner解放を新契約で原子的に確定。再開・同run再実行を拒否。応答喪失は照会 |
| FAILED | 実装済み | Job/Check例外、beforeStep例外等の確定した処理失敗 | 安全なfailure、既存ERROR履歴、内部／公開状態。未実行Jobの失敗を捏造しない | 安全に終了できた場合に解放。保存不明なら最後の確認状態を保持し診断。通常resumeを許可せず、補修・再試行は別契約 |
| LIMIT_REACHED | 実装済み | 技術的な実行回数予算を使い切り、次工程が残る。業務待ちではない | 次工程と連続履歴、確定境界、予算情報 | 明示的な技術再開のみ。保存確認後解放。WAITINGへの自動変換は禁止 |

新契約で許可する主経路：CREATED→RUNNING、RUNNING→WAITING／COMPLETED／FAILED／LIMIT_REACHED、WAITING→RUNNING、LIMIT_REACHED→RUNNING。COMPLETED／FAILEDは終端。未知状態・不正なDTO・順序不整合は実行前拒否。RUNNING→RUNNINGのcheckpointは状態遷移ではなく確定境界更新。

全状態で同一operationIdの同一要求は既存結果照会、内容不一致は競合。RUNNING中の進行要求重複、古いrevision、別run・別定義の操作は副作用前に拒否する。操作履歴はApplicationの受理／確定／拒否／不明を記録し、Workflow履歴をJob成功履歴として水増ししない。

## 4. 永続化可能なWAITING契約

### 4.1 待機位置

**採用案：工程間に明示的WAITノードを追加する。** Jobのcollect/makeの途中を停止点にしない。CJobFormにWAITING戻り値を追加せず、処理例外による待機も行わない。WAITはCheckではなく、入力が確定するまで進行を止める制御境界。入力確定後の進路は既存boolean Checkが選ぶ。

Definitionの次Schema（仮称prototype-workflow/2）に、stepId／stepNo／kind:WAIT／inputContractId／inputContractVersion／nextStepIdを持つ直列境界を追加する。入力の業務的な許可操作・役割は道場側Registry/Policyが定義し、Coreには「先生」「承認」を埋め込まない。ノード詳細名・DTO型名は実装前レビューで固定する。

旧JOB／CHECK_BOOLの意味・CMRPは維持する。新Definition validatorはWAITの参照先、入力契約解決、重複工程、到達性を検証する。実行してみて未登録契約を発見する設計にしない。

### 4.2 保存DTO案

run envelopeにはrunSchemaVersion、定義ID/Version/digest、runId、status、currentStepNo、revision、lastControlEventSeq、history長/digest、artifact参照を持つ。WAITING時には以下を必須とする。

| 項目 | 意味 |
| --- | --- |
| waitId | 待機の個別ID。同じ工程を再訪しても別ID |
| waitSequence | run内で単調増加する待機世代。stepNoだけで操作を結び付けない |
| stepId/stepNo | 今回停止したWAITノード |
| inputContractId/Version | 入力構造・許可操作を解決する固定契約 |
| resumeStepNo | 定義から決まる次工程。要求で任意指定させない |
| enteredAt | 待機確定の時刻。業務期限やLease期限とは別 |
| pendingInputRef | 受理済みの不変入力receipt参照。未受理ならnull |

入力receiptはoperationId、runId、waitId/世代、期待revision、定義digest、検証済みpayloadとその指紋、actorのサーバー識別子、Policy版、受理時刻、受理／消費状態を保存する。人の入力を通常の公開成果物として無条件登録しない。必要なJobFormのcollectが、Application注入の読取専用SignalReaderから確定入力を取り出し、make→record→postで業務成果を生成する。

payload原文・個人情報をtraceや公開エラーに複製しない。保存範囲・保持期間・公開項目は道場側契約とする。入力の参照独立性を保証する。

### 4.3 原子的な境界

現在のsave/load Portは残し、次版で小さなLifecycle Portを追加する案とする。必要な操作はcreateRun、commitWait、acceptInput、claimWaitingRun、commitBoundary。名称より以下の保証を契約にする。

1. **待機確定**：RUNNINGのowner token/fence、有効性、revision、確定済みtraceを検証し、WAITING snapshot＋WAIT_ENTERED control event＋owner RELEASEDを同一保存Transactionで確定する。直前Jobの成果保存が未確定なら待機を公開しない。
2. **入力受理**：HTTP/Applicationで資格・業務権限・payloadを検証。TransactionでWAITING、waitId/世代、期待revision、定義、未受理、owner非ACTIVEを照合し、入力receipt＋操作履歴をcreate、pendingInputRefとrevisionを更新する。まだJobを実行せず、受付結果は「受理」として返す。
3. **再開権取得**：workerがWAITING＋該当入力receipt＋revisionを検証し、新しいclaimToken・増加fenceを発行。入力消費、WAIT_RESOLVED control event、RUNNINGとresumeStepNoの保存を同一Transactionで行う。初回startとresumeの経路を区別する。
4. **実行**：確定済み入力を注入して新しいJob/Check実体を作る。次工程から進め、待機前Jobや確定済みCheckを再実行しない。Transaction callback内でJob・通知・外部通信を実行しない。Firestoreのcallback再試行で業務処理を繰り返さない。

WAITINGへの保存結果が不明ならHostは進行せず、mutationId・run revision・waitId・owner状態を照合する。単にネットワーク例外を待機確定や失敗確定と見なさない。入力受理や再開権取得でも同様に結果照会し、書込を自動再送しない。

run状態とownerが別々に確定する実装は不合格。現在のFirestoreExperimentStore.releaseは別Transactionなので、そのまま組み合わせて新保証を主張しない。新Lifecycle Adapterの原子操作で実現する。Memoryは同一プロセス内の参照独立性・排他だけを保証し、Firestore同等のプロセス間保証とはしない。

### 4.4 再起動・競合・失敗

- WAITINGを別プロセスで取得しただけではJobを起動しない。入力なしでresumeを拒否。
- 同じoperationId＋同一actor/要求は照会。別内容／別actorでの流用は409。操作ID照会にも同じ認可を適用する。
- 異なるoperationIdの同時承認／差し戻しは、同一waitIdへの未受理CASで勝者1件。敗者はJob・業務更新・確定操作履歴を発生させない。
- ループで同じWAIT工程へ戻っても世代が異なるため、前回の承認は再利用できない。
- 受理後・claim前にHostが停止した場合は、受理済み入力を照合して新しいworkerがclaim可能。入力を再受理する必要はない。
- claim後にRUNNINGでHostが停止した場合は、未完Job・部分公開・副作用を診断し、自動でWAITINGへ戻さない。安全なcheckpointの証拠がない限り自動再開しない。
- WAITINGではHeartbeat不要。業務の回答期限をLease失効で表現しない。タイマー・期限切れ業務処理は後工程。
- guardは既存同様、保存Transactionと同じ境界で検証。FirestoreのreadTime時点のLease判定をcommit時点保証へ拡張しない。失効Leaseの自動Takeoverは追加しない。

### 4.5 履歴

既存TraceEntryのDONE／TRUE／FALSE／ERRORはJob/Check実行の記録として残す。待機に到達しただけでDONEやERRORを追加しない。新control event（RUN_CREATED／WAIT_ENTERED／WAIT_RESOLVED等）を別系列で保持し、seqとsnapshot cursorを整合させる案とする。既存trace orderの連続性を壊さない。

道場操作履歴はactor、操作、入力参照、受理/確定/不明、対応control eventを記録する。WorkflowのCOMPLETED、操作受付、承認という業務結果を別表示にする。拒否要求を監査する場合は、確定業務操作履歴とは別扱いにする。

## 5. Job・JobForm・Check契約

| 要素 | 維持する現行契約 | 必要な差分案 |
| --- | --- | --- |
| CJobForm | name、collect(ProductReader)、make(input)、任意record(output)。実行可変状態を保持しない | 業務入力が必要なformはApplicationが確定SignalReaderを注入。全formへ認証・DBを持ち込まない。入力/出力契約IDはRegistry metadataで固定 |
| CJob | execute():Promise<void>、READY/RUNNING/COMPLETED/FAILED、collect→make→record→post、内部成果と公開成果の分離、単一使用 | WAITINGはJob途中に追加しない。再開・反復では新Job。既存JobExecutionId、step/iterationとrunの関連を保存 |
| Check | IBool.evaluate():boolean/Promise<boolean>、TRUE/FALSEの固定遷移。例外はERROR | 受理済み入力をJobが成果化した後、その成果を参照する。承認ボタンそのものをCheckの実行主体にしない。業務FAILは技術FAILEDではない |
| CWorkflow | 接続・順序・反復・状態・履歴、既存例外・排他 | WAITノード解釈、CREATED/WAITINGの検証、wait世代付き明示再開、新Lifecycle Portとの境界を追加。業務payloadは解釈しない |
| 診断・永続化 | 確定済みJob/Check・内部/公開成果・定義digestを照合 | WAITING/入力受理/claim済みRUNNINGを区別し、既存LIMIT_REACHED診断とは別の条件を追加 |

record後post失敗では内部成果が残り、部分公開もあり得る。JobのCOMPLETED未保存を理由に自動再実行しない。外部通知等は実験018の副作用台帳と冪等性契約を個別接続する必要があり、Firestore内receiptだけで外部exactly-onceを保証しない。今回の設計でCMRPのprepare/cleanupや新Runner階層を追加する必要はない。

## 6. 桜風館の審査業務契約

現物根拠：道場docs/Architecture/審査管理_業務仕様整理_20261019.mdは「構想・実装前」と明記。docs/prototypes/examination/審査管理_操作プロトタイプ.htmlは画面内疑似操作・保存なし。schema/ExaminationStandard.ymlとgas/DAO_Business_Examination.jsは基準マスタであり、申請・結果のRepositoryではない。

分類の「設計済み」は文書に構想が存在するという意味であり、実装着手できる詳細契約が確定した意味ではない。

| 業務 | 分類 | 操作主体・入力・出力の確認内容 | 状態・権限・履歴の未確定部分 |
| --- | --- | --- | --- |
| 審査申請 | 会員申請は未定義。先生による対象者登録は設計済み・画面一部実装 | 文書は先生が対象者を選ぶ。画面試作は候補→登録済みのメモリ表示のみ | 会員申請との関係、必須申請項目、サーバー状態、取消・再申請の履歴なし |
| 先生承認 | 未定義 | 既存active teacher確認は利用可能だが、申請承認Commandは確認できない | 誰が誰の申請を承認できるか、自己承認、委任、承認証跡、入力は判断待ち |
| 差し戻し | 未定義 | 理由入力や差し戻し先の既存契約なし | 理由必須性、編集権限、履歴保存、再確認の範囲が判断待ち |
| 再申請 | 未定義 | 差し戻された申請を再提出するAPIなし | 同一申請ID維持、内容版、過去内容保持、再審査主体が判断待ち |
| 審査実施 | 設計済み | 先生が日程・対象者を登録し、実施後に保留審査レコードを扱う構想 | 実施確認Command、保留Schema、権限、訂正履歴は未実装 |
| 結果登録 | 設計済み | 結果通知後、先生が合否と正式日付を登録。級は審査日、段は允可日を区別 | 会員級段位・起算日・履歴の同時整合、再確定・訂正・費用連携は未確定 |
| 合格通知 | 未定義 | 文書の「結果通知後」は通知済み事実を前提とする記述で、自動送信仕様ではない | 宛先、媒体、同意、送信主体、送信冪等性・UNKNOWN・履歴が判断待ち |
| 取り下げ | 未定義 | 専用Commandを確認できない | 可能な状態、申請者/先生権限、費用取消、副作用、履歴は判断待ち |

**実装済みの関連機能**は、審査進捗読取、級段位・審査基準、既存本人/先生の認可基盤。これらを上表の申請・承認が実装済みという根拠にしない。資料記載のマスタ件数は過去資料の値で、今回実DBから確認していない。

業務状態enumは今回確定しない。候補の「申請中→確認待ち→承認/差し戻し→再申請→実施待ち→結果待ち→結果確定」は将来の検討図に留め、業務責任者の判断なしでDefinitionへ登録しない。技術WAITINGを導入しても、業務の承認条件は自動的に決まらない。

合成デモを先行する場合は、Mock用入力/状態/権限を明記した別仕様を承認し、実業務契約と分ける。実装済みreaderだけを再利用し、Mockによる承認を実業務接続完了と報告しない。

## 7. 責務分担・配布Unit範囲

| 要素 | ARCH共通Unit／開発元 | 道場側 |
| --- | --- | --- |
| Workflow実行エンジン | CWorkflow/CJob、WAITの汎用解釈、定義検証・再構築・診断 | 独自エンジンを作らず固定版を利用 |
| Workflow定義 | 汎用Definition DTO/Validator | 審査工程・JobForm/Check ID・入力契約版・業務フロー |
| JobForm | CMRPと成果物契約 | 審査固有のcollect/make/record、既存業務Job接続 |
| Check | boolean分岐・接続契約 | 承認結果等を評価する業務predicate |
| Application Adapter | なし。共通Unitに道場用処理を含めない | 入力変換、業務権限、操作receipt、Signal供給、Unit起動/照会 |
| Firestore Adapter | 汎用Lifecycle/所有権/履歴/成果保存、Emulator限定接続 | 専用namespace選択・composition、業務保存との連携。汎用Adapterの独自改変禁止 |
| 業務Job・DAO・Schema | 含めない | 既存実装を維持。申請の不足部分は別途道場で定義 |
| API・UI | 汎用Coreに含めない | 既存ルートを切替えず開発用入口、状態/権限表示 |
| 認証・認可 | 認証方式やteacherを知らない。渡された検証済み入力参照を扱う | verifyIdToken(token,true)、サーバーAccount解決、active teacher、本人scope、業務Policy |

SQLite診断修正はARCHのローカル検証Adapterの責務で、今回配布Unitへ新たにSQLiteを追加する理由にはしない。Firestore Adapterも現物は実験用・Emulator限定であり、本番対応済みとは扱わない。

業務保存とWorkflow保存を同じFirestoreで行う場合でも、同一Transactionへ組み込む明示的契約がなければ原子性はない。別サービス・通知はoutbox/冪等性など別設計が必要。既存DAOを呼ぶだけで原子性を主張しない。

## 8. 既存試験問題の修正設計

### 8.1 WebConnect：優先P1、道場の試験修正

WebConnectCore.resolveで未知actionは404。既知actionは既存Admin APIがルート確認→資格検証→各operationの権限/入力/依存確認を行う。匿名への401は現行契約として維持する。全APIが同じ検証順序ではなく、attendance_batchでは入力検証が先行するため、空入力だけで認可の安全性を検証しない。

work/verify-webconnect-auth-boundary-step7a.cjsの末尾試験を、未知action全role404と、既知actionの有効入力・匿名401・無権限403・許可時呼出し・不正入力400・必要依存なし503に分割する。既存認証を変更せず、新しい試験fixtureでPrincipal/teacher/DAOを明示注入する。401への一括期待値変更は不可。021-B U08/U09と既存Principal・attendance/registrationの権限回帰を実行する。

### 8.2 SQLite診断：優先P1、ARCH Adapter修正

C1の50試行は46 PASS/4 FAIL。原例外を観測できた例はPRAGMA application_idのSQLite errcode=5、database is locked。診断用readOnly接続がSimpleDB.open(timeout既定100ms)を経由せず、UNAVAILABLE→HISTORY_READ_UNAVAILABLE→RESUME_REFUSEDとなる。Lease失効とは別問題。全失敗の原因を同一と断定しない。

修正候補はsrc/adapters/job-execution/diagnostic.cjsと限定的な診断/再開エラー分類、tests/job-run-lease等のfixture。所有権guardやclaim条件を緩めない。

- SQLite BUSY/LOCKEDは数値の基本/拡張codeで識別し、データ破損・Schema不一致と分ける。raw SQLやパスは公開しない。
- 診断読取全体だけを有限回再読込。各試行で読取Transactionを終了し接続を閉じ、部分DTOを捨てる。定義は固定Versionで再取得・照合する。
- 具体的な回数/総deadline/backoffは設定として確定し、テストでは時計/再試行schedulerを注入して上限をassertする。単なるsleep延長で試験を通さない。
- 期限内に読めなければ診断を「取得不能」とし、保存済み状態が不適切というRESUME_REFUSEDと呼出元で区別する。Job・所有権書込は実行しない。
- read-only再読込成功後にも、既存claim/fence/revision/Lease検証を省略しない。読み取れたことは実行権の証明ではない。
- writer/readerをbarrierで制御し、解放後成功、上限到達拒否、破損時即拒否、古い世代拒否、別run独立、IPC異常終了を決定的試験化。commitやJobを自動再送しない。

この修正は配布対象外のSQLite部分だけならUnit更新不要。将来収録コードの変更が入れば通常の新Version配布を行う。

## 9. Unit更新・互換性

現行固定版は@arch026/workflow-unit@0.1.0-experiment.021.1、SHA-256はe7f97e55ed2da17adf32cb7358df39c816ed7e929ea4c7dee1b87d0aafda34c4。本設計では更新しない。

**互換性方針**：旧版archiveと既存保存データを保全する必要がある。ただし旧Unitに新WAITING DTOを読ませる前方互換性は要求しない。新Unitは旧Definition/保存形式を明示判別して旧意味で読込・実行できることを受入条件とする。旧schemaを通常Openで書き換えない。旧LIMIT_REACHEDをWAITINGへ変換しない。

新runは新schema専用namespaceで開始し、既存runは定義とengineContractVersionで解決する。旧headにはengineContractVersionがないため、配備設定で旧namespaceと旧Unitの対応を固定し、任意に最新版へ振り向けない。新DTOを旧namespaceへ混在させない。既存runの移管が必要なら明示Migrationを別工程にする。

更新手順：

1. ARCHで承認した契約差分だけを実装。旧892件＋新Lifecycle/WAITING/診断試験、Build/型検査を実行。
2. 新Versionをpackagerに設定してから最終archiveを生成する。例0.2.0-experiment.022.1は候補名で、今回は割り当てない。同Version内容変更は拒否。
3. source manifest、compiled/Adapter、archive SHA-256、収録範囲、SDK/Node条件、再生成一致を確認。SQLite/道場処理の混入を拒否。
4. 道場vendorへ新archiveと検証記録を追加。旧版を削除せず、package.json/lockとunit.cjsの固定検証先・stage helper・試験fixtureを新Versionへ整合させる。現行コードは固定ファイル名なので依存追加だけでは更新完了しない。
5. 隔離npm ciで導入後のmanifest/各ファイル/元archiveを検証。隣接ARCH相対参照を排除。
6. 道場の既存認証/API回帰、021-B、新WAITING/別プロセス/二重操作/権限拒否/応答喪失をEmulatorで実行。旧データ非変更もassert。
7. 起動時に解決Unitとrun schemaを確認。検証失敗は起動拒否し、旧版やMemory/本番へ自動fallbackしない。

新schemaのrunを作成した後に旧Unitへ戻す操作はデータRollbackにならない。旧Unitだけで新runを継続できるとは保証せず、新runを保持・停止して修正版を用意する。自動downgradeや既存データ削除は行わない。

## 10. 次工程の実装単位と完了条件

| 工程 | 実装範囲・所属 | 依存 | 完了条件・必須試験 |
| --- | --- | --- | --- |
| 022-B1 | 道場WebConnect旧試験の契約別分離 | 現行契約確認のみ | 既知/未知action、401/403/400/404/503、業務呼出し0/1、既存認可回帰PASS。認証実装変更なし |
| 022-B2 | ARCH SQLite診断読取競合とfixtureの観測性 | C1結果 | BUSY/LOCKED有限再読込、deadline、破損分類、別run競合・stale所有権拒否を決定的検証。Lease/Job書込の保証維持 |
| 022-C1 | ARCH新DTO/Definition/WAITノード・Memory実行 | 本報告の技術契約レビュー | CREATED、初回Job前WAIT、既存Job間WAIT、反復世代、入力なし再開拒否、Check両分岐、旧CMRP/既存状態の回帰。まだ配布しない |
| 022-C2 | ARCH Firestore Lifecycle原子境界・診断 | C1 | WAIT確定＋release、入力CAS＋receipt、claim＋消費＋RUNNINGを実Emulatorで検証。別プロセス復元、同時操作勝者1件、stale fence、各境界の応答喪失、RUNNING停止後の安全拒否 |
| 022-D | ARCH新Unit生成＋道場固定導入 | C2、B1/B2合格 | 新SHA/source/installed一致、旧archive/データ保全、隔離build、892件＋新規Unit/統合試験PASS。未実施をPASSにしない |
| 022-E1 | 道場合成審査Workflowの入力/状態/権限仕様 | 業務開始主体・Mock仕様の判断 | 会員申請か先生登録か、差し戻し・再申請・自己承認の合成契約を文書で確定。実業務仕様と区別 |
| 022-E2 | 道場Application/JobForm/Check/開発API | DとE1 | 実UnitのWAITING→入力→Check、承認/差し戻し/再申請、専用Emulator、再起動、二重操作・無権限拒否。実装済みreader再利用、Mock箇所を明示 |
| 022-F | 実業務接続の個別設計 | E2と業務仕様確定 | 結果・級段位・費用・通知の副作用と整合契約を別審査。本設計だけで実装/本番切替を許可しない |

推奨順はB1/B2→C1→C2→D→E2。E1の業務判断は基盤修正と並行して進められる。工程IDは提案であり、今回はどれも実装しない。期限管理・汎用GUI・分散キューを待機契約の最小実装に含めない。

## 11. 未確定事項・判断が必要な事項

**技術レビュー対象**：明示WAITノードと新Lifecycle Portの採用、control eventの別系列、旧DTOの読取互換テスト範囲、新Unit Version、読取再試行の設定値、入力受理からworker起動までの運用（初期は明示呼出しでよく、queueを必須にしない）。

**業務判断対象**：先生の対象者登録と会員申請の関係、自己承認・委任、差し戻し理由と編集項目、再申請の同一性、結果確定/訂正、日付・費用・通知・取り下げ、履歴保持期間。受理後の権限剥奪を既に受理した入力へ遡及させるかも業務Policyとして決める。現在の認証確認だけでその競合まで原子的に保証したとはしない。

**後続検証**：本番Firestore接続、Cloud RunのNode/IAM、実ユーザー、実通知、実業務DBとの同時更新は未検証。本設計はEmulator・合成データの次工程を対象とする。

## 12. 今回の検証・Git状態

コード・試験・Schemaを読取り、過去報告の結果と今回の調査を分離した。今回は試験実行・Build・package生成・Unit更新を行っていない。892 PASSやC1の50回の数値は既存報告の記録であり、今回再実行した結果ではない。

今回の変更は本報告書の新規追加のみ。両repoの開始時点の既存ファイルSHAを保全し、既存未コミット成果を維持する。実DB/実サービスへ接続しない。Stage・Commit・Push・Deployなし。報告書作成をもって停止し、次工程は別途判断を待つ。
