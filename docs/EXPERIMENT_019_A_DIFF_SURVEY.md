# 実験019-A：ARCH-026と桜風館道場管理システムの差異調査

## 1. 調査範囲・配置・確認方法

2026-11-08、作業ツリーの現物を読み取り調査した。対象は隣接する次のGitリポジトリ。別フォルダへの推測による代替は行っていない。公開資料にユーザー名を含む絶対パス、接続先URL、プロジェクト識別値、認証情報は記載しない。

| 対象 | 本機workspace内の実配置 | 確認したHEAD |
|---|---|---|
| ARCH-026 | `workspace/ARCH-026_Workflow`（調査開始時のcwd） | `26f22fdcafb1276f8a32d31629cef52759436d03` |
| 道場システム | `workspace/clasp_道場サポ`（ARCHから`../clasp_道場サポ`） | `4d6f55582d4e89cb8957b814d267d82461cc2951` |

道場側の対象一致は`docs/Architecture/ARCH-026_Workflow_Event_Architecture.md`の対象表記でも確認した。同文書は基本設計案であり、現行実装と同一視しない。

両方に既存の未コミット変更がある。特にARCHの実験012〜018、道場の設計文書・作業スクリプト等はHEADだけでは再現できないため、評価対象は**この作業ツリー**である。

本書では次を区別する。

- **事実**：ソース・設定・試験コードで確認した内容。
- **判断／提案**：事実から推奨する接続方法。実装済みではない。
- **未確認**：外部照会や実行しなければ確定できない内容。

調査ではソース検索・読込・Git状態・コードのハッシュ確認だけを行った。業務データ、SQLite DB、Firestore、Spreadsheet、認証情報、実サービス、生成済みデータは開いていない。Build・試験・デモ・移行・Deployも実行していない。以下の道場側パスは道場リポジトリ相対、ARCH側パスはARCH相対で示す。

## 2. 両リポジトリの構成

| 層 | ARCH | 道場システム |
|---|---|---|
| 実行Core | `src/prototype/workflow.ts`、`job-form.ts`、`definition.ts` | `gas/00_Job.js`と業務別Job、`shared/`の共通業務・DAO |
| 将来契約 | `src/core/{types,engine}.ts`、`src/ports/contracts.ts` | `docs/Architecture/`の設計案、`schema/providers/`の暫定定義 |
| Application／Host | `gui/`、HelloWorldのComposition／Node Host | `cloud/api/`、`gas/WebConnect.js`、`shared/WebConnectCore.js` |
| 保存 | `src/adapters/simpledb/`、`workflow-definition/`、`workflow-history/`、`job-execution/`、`data/` | `adapters/{firestore,gas}/`、`gas/DAO_Core_Sheets.js`、`cloud/member-read/`、業務別Firestore Executor |
| Schema | Prototype定義Validator、DemoItem／Hello Validator、SQLite物理Schema | `schema/*.yml`、Portable Definition生成、`shared/DAO_Definitions.js`、Firestore Renderer |
| UI | ローカル編集GUI、手動step Runtime | `web/qr/`、Firebase Auth、既存WebConnect action |
| 検証・運用補助 | `tests/`、Migration用`tools/` | `tests/`に加えて多数の`work/verify-*`、STORY-902関連モジュール |

**重要な事実：ARCH自身にも三つの異なる実行契約がある。**

1. `src/prototype/`：実験012〜018のCJob／CWorkflow。boolean Check、工程番号、Snapshotで実行する。
2. `gui/workflow-runtime.js`：`WorkflowRuntime.advance()`。JOB／CHECK_FINAL／CHECK_PROVISIONAL／CHECK_WAIT／END、WAITING、PASS／REJECT等を扱う別Runtime。
3. `src/core/engine.ts`：`WorkflowEngine.advance()`／`onEvent()`／`retryProvisional()`はNOT_IMPLEMENTEDを送出する骨格。

したがって、`src/core/WorkflowEngine`を完成済み実験Coreとして道場側へ持ち込むことも、GUI RuntimeへSQLite再開機能が既に統合済みと判断することもできない。

## 3. Core・CMRP・Checkの比較

| 概念 | ARCHの事実 | 道場側の事実 | 差分の意味 |
|---|---|---|---|
| 仕事の雛型 | `CJobForm<Input,Output>`はname／collect／make／任意recordを定義 | `Job`基底と、入力引数・ctxを持つ業務Job | 共通クラスではない |
| 実行単位 | `CJob`がREADY／RUNNING／COMPLETED／FAILEDと工程・内部成果を保持。一度限りのexecute | `gas/00_Job.js:Job`はexecuteと6工程の空メソッドを持つ概念基底 | 同じ「Job」という語でも責務が異なる |
| 実行順序 | `CJob.execute()`がcollect→make→record→postを制御 | 各業務Job自身がexecute内の順序を決める | execute丸ごとの二重ラップに注意 |
| prepare／cleanup | 正式実装なし | 基底メソッドは存在するが、列挙した業務Jobで必ず呼ぶものではない | 6工程保証とはいえない |
| record | 任意の仕事固有recordの成功後、内部成果を保持 | 請求・入金等の実際のDAO書込を含む | 「recordはメモリ保存だけ」と解釈すると衝突 |
| post | ProductShelfへの公開。実験018はAdapterで模擬通知を接続 | View更新、エビデンス更新等を含む | 公開と業務更新を同義にしない |
| Workflow | CWorkflowが登録工程の順序・分岐・反復・履歴を制御 | 正式業務側のCWorkflowクラスは調査対象ソースに見当たらない。別途STORY-902 Runnerがある | 汎用Workflowと限定イベント実行を分離 |
| Check | `CCheckJob.evaluateBranch()`がIBoolのbooleanをTRUE／FALSEと工程番号へ変換 | 審査可否等の業務boolean、業務状態、STORYの継続Gateがある | 業務判定値を自動的にWorkflow分岐へ変換しない |

根拠：ARCH `src/prototype/workflow.ts:CWorkflowTask/CJob/CDummyJob/CCheckJob/CWorkflow`、`src/prototype/job-form.ts:CJobForm`。道場 `gas/00_Job.js:Job`、`gas/03_BillingMonthly.js:BillingMonthlyJob.execute`、`gas/03_BillingUsage.js:BillingUsageJob.execute`、`gas/09_PaymentEvidencePost.js:PaymentEvidencePostJob.execute`。

`BillingMonthlyJob.execute()`は条件によりSelection・Invoiceを作成／保存し、postでViewを更新し、例外を`{ok:false,message}`へ変換する。`PaymentEvidencePostJob.execute()`はGAS ScriptLockを保持してcollect／make／record／postを呼ぶ。ARCHの`execute(): Promise<void>`へそのまま渡すと、`ok:false`を返しただけなのに正常終了としてDONEになる恐れがある。**結果と例外の変換はAdapterの明示責務**とし、今回はこれら書込Jobを接続候補にしない。

調査対象の`gas/`、`shared/`、`adapters/`、`cloud/`、`tools/`では、道場側の実装クラスとして`CJobForm`／`CJob`／`CWorkflow`を確認できなかった。未調査の全履歴・別リポジトリ・稼働環境に存在しないと断言するものではない。

## 4. データアクセス・Schema・Transactionの比較

### 4.1 SimpleDBとDAOは別の契約

ARCHの`src/adapters/simpledb/database.cjs:SimpleDB`はNodeの`node:sqlite`を使う接続／SQL／同期Transaction基盤である。`initialize()`と通常の`open()`を分離し、application_idとuser_versionを照合する。`transaction()`はBEGIN IMMEDIATEを使い、Promiseを返す処理を拒否する。

道場側の正本ソースを検索した範囲では、同じ`SimpleDB`クラスや`node:sqlite`を使う保存実装を確認できなかった。現物は次のDAO／Adapter群であり、過去にSimpleDBと呼ばれた資産を推測で同一視しない。

- `shared/DAO_Business.js:createDao()`：論理名とIDを物理source／fieldsへ対応付ける。readById／readByIds／readAll／append／updateByKey／upsertByKey等。
- `adapters/gas/DAO_Core.js:createCore()`：Spreadsheetを扱うPortable DAO Core。readByIdは未存在null、更新はfoundフラグ等を返す。
- `gas/DAO_Composition.js:daoContext_/daoCore_()`、`gas/DAO_Core_Sheets.js`：既存GAS業務の読書き境界。上記Portable Coreと完全に同じメソッド群ではない。
- `cloud/member-read/DAO_Core_Firestore.cjs:createFirestoreCore()`：fetchと資格取得を注入できるREST Core。readById／readByIds／readPage／queryEqual、create-only相当のappend、updateTime条件付き更新等。
- `adapters/firestore/DAO_Core.js:createAttendanceCore()`：Firestore SDK Transactionで必要範囲を先に読み、同期DAO形式のSnapshotと保留書込を業務処理へ渡す出席専用境界。

最後の二つは同じ「Firestore Core」という名前に近くても、汎用REST読書きと出席業務Transactionで責務が違う。

### 4.2 Repository対応

| 対象 | ARCH | 道場側 | 必要な扱い |
|---|---|---|---|
| 不変Definition | `DefinitionRepository.get(id,version)/add()`、JSON／SQLite Adapter | 同じWorkflow Definition Repositoryは未確認 | 新しい専用Adapter候補。業務Member DAOの流用ではない |
| 一般レコード | `SimpleDBDataRepository.read/add/write(expectedRevision)` | `createDao`の論理DTO、append／update／upsert | create-onlyとupsertを区別し、Revision対応を明示 |
| Revision | 保存先発行の不透明UUID | REST CoreのreadByIdWithMetadata／updateTime条件、STORY Ledgerの整数version | それぞれ別意味。単純な数値・文字列比較へ統一しない |
| 実行履歴・Job・成果 | `SQLiteWorkflowHistoryStore`、`SQLiteJobRunStore` | 業務ログ、STORY Event Ledger | 集約単位・状態・保存保証が異なる |
| 所有権と外部要求 | `ownership.cjs`管理DB、`external.cjs`台帳 | Story限定Event Claim、業務別の冪等受付記録 | 同名テーブルや状態への機械的移行は不可 |

### 4.3 Schema・変換

ARCHは`prototype-workflow/1`の論理定義とDefinition Versionを区別し、Validatorで型・重複・参照・経路を検査する。SQLite物理Versionはそれと別管理である。Definition DB、一般Data DB、履歴DB、所有権／外部要求DBも別のDB系列。

道場は`schema/Member.yml`等にentity／version／fields／物理sourceを持ち、`tools/portable-data-definition-core.mjs:parsePortableDefinition/validatePortableDefinition/transformPortableDefinition`で`schema.fields`、`writable`、sourcesを生成する。`shared/Schema_Renderer_Firestore.js`は型・必須値・IDを検査し、論理recordとFirestore文書を相互投影する。Portable DefinitionのversionをWorkflow Definition VersionやSQLite user_versionへ対応付ける根拠はない。

変換上の実在する相違：

- `shared/DAO_Definitions.js`のmembersはmember_name等を論理項目として公開し、writableは空。Memberを任意更新できる汎用DAOではない。
- `shared/MemberObject.js:memberObject()`はnameを要求する小さな別投影。Member Schema／現在の広いMember DTOへそのまま適用しない。
- 日本語物理項目とsnake_caseの論理項目、GASのDate／文字列、Firestore Timestamp等の復号を区別する。`cloud/member-read/DAO_Core_Values.cjs:decodeValue()`はmap／array等も復号するが、同Coreの一般writeは許す値を別途制限している。
- `normalizeStorageId`はUTF-8バイト長等を検査する。一方、審査進捗Readerはより狭いID形式を要求する。HelloRecordのIDやWorkflow Definitionの識別子をMemberへ無条件に流用しない。

### 4.4 Transaction・非同期性

| 境界 | 現物で確認した保証 | 統合時の注意 |
|---|---|---|
| ARCH SimpleDB | 同期SQLite Transaction、失敗Rollback、COMMIT障害OUTCOME_UNKNOWN | Firestoreの非同期Transactionを同じ関数へ渡せない |
| ARCH Fencing | 同一接続のATTACH Transactionで所有権検証と保存。DELETE Journal／FULL同期を要求 | 独立Firestore更新の事前Token確認では代替できない |
| 道場GAS | 業務入口でScriptLock、複数のSpreadsheet操作 | 複数書込のDB的Rollback保証とは異なる |
| 道場出席Firestore | 先行読取＋保留書込をSDK Transactionで確定 | 再評価されるTransaction callbackへ外部通知を混入しない |
| 道場STORY Ledger | reserveの原子的create、expectedVersion更新、結果不明時の照合 | Job Snapshot全体やLeaseではない |

**重要な非同期契約差**：ARCH `definition.ts:JobVisitContext.onCreate`はvoidで、createJob内でawaitせずに呼ぶ。`SQLiteJobRunStore.register()`は同期checkpointが可能なので成立している。Firestoreへの非同期Job登録をそのまま差すと、ID・初期状態の永続化がJob実行より前に終わる保証がない。この部分は「Adapterを差すだけで完全対応」とは判断できない。非同期の保存完了を待つ境界と、所有権・保存の原子的Portの設計が必要となる候補であり、今回は具体仕様を確定しない。

## 5. 実行環境・Module・Build

| 項目 | ARCH | 道場システム |
|---|---|---|
| Node | 本機`node --version`はv24.16.0。SQLite実験はNode 24前提 | 同じ端末のNodeは利用可能。ただしCloud Run実稼働Node版は未確認 |
| 言語 | PrototypeはTypeScript、Adapter／GUIはJS/CJS | GAS・Browser JS、Cloud CJS、Build用MJS |
| Module | tscのCommonJS出力をCJSがdist相対パスでrequire | require／module.exports、GASグローバル、Browser動的import、MJSが混在 |
| 型検査 | `tsconfig.prototype.json` strict、ES2022。`src/core`は同設定のinclude外 | rootに同等のアプリ用tsconfigは確認できない。typescript-eslint依存はTS実行基盤の証明ではない |
| Build | `npm run build`→tsc。Coreだけの公開package exportsや配布単位はない | `tools/target.mjs`がGAS／Firebaseを選択し、`build-time-travel-firestore.mjs`が共有モジュールと既存GAS業務を組み合わせて生成 |
| パッケージ | private package、devDependency TypeScript ~5.9.3 | firebase ^12.19.0、firebase-admin ^14.5.0、ESLint等。root scriptsに統一npm testなし |
| Hosting／Host | ローカルGUI／HelloWorld Node Host。Cloud Run正式Adapterなし | Firebase Hosting静的成果物とCloud Run用Node成果物を別生成・別Deploy |
| 認証 | HelloWorld開発Verifier、GUIはloopback用途 | Firebase ID Token検証、Dojo Principal、admin／先生／本人の認可 |

道場の`tools/target.mjs:buildFirebase()`はCloud Run配布物へroot package.jsonをコピーし、startを`cloud/api/server.cjs`へ変更する。root package.jsonと調査したBuildソースにNode engines固定を確認できないため、稼働Node 24対応は保証しない。GASの`appsscript.json`はV8だが、Node APIやCommonJSの直接使用を意味しない。

設定・環境変数は値を転記せず、責務だけを確認した。

- ARCH：`ARCH026_GUI_DATA_DIR`、`PORT`等はHost／Compositionの設定。SQLiteの保存先等は明示引数。
- 道場：`PORT`、`TZ`、`K_REVISION`、Firebase Auth Emulator設定、診断用環境変数等。通常の対象選択はprofileとApplication Default Credentialsも使う。GASはSpreadsheet ContextやGAS固有サービスに依存する。
- `cloud/api/server.cjs`はPORTの有無でlisten先を変え、Firebase Adminを初期化する。調査のためにrequire／起動していない。

**Cloud RunでSQLiteをそのまま利用可能とは判定しない。** そのためにはNode版、永続ファイルの所在・所有、複数Instance間の共有、OSロックとJournal／fsync条件、再起動時の復元を確認する必要がある。既存配布ソースからARCHの複数SQLiteファイルを共有・永続化する構成は確認できなかった。Cloud側の実設定は外部照会していないためE。

## 6. Workflow関連機能の対応・重複

| 機能 | ARCH現状 | 道場側の相当機能・制約 |
|---|---|---|
| 定義管理 | 不変ID＋Version、JSON／SQLite、Loader／Registry | 業務Schema定義、STORY Manifest／実行計画はあるが、Prototype Workflow定義とは別形式 |
| Job実行 | JobForm→個別CJob→CWorkflow | 業務Job自身のexecute、既存WebConnect action、STORY IntegratedRunner |
| Check | boolean分岐、GUI側は別のPASS等 | 業務条件・進捗判定、STORY Continuation Gate。汎用CCheckJobとは別 |
| 反復 | 後方遷移と訪問単位の新CJob | 業務ループ・イベント順実行はあるが、同契約のJob反復管理は未確認 |
| 履歴 | TraceEntry、Snapshot、Job／公開成果行 | 業務ログ、STORY run／event／claim、監査・照合記録。目的とキーが違う |
| 成果物 | 実行別ProductShelf、内部／公開の分離 | 業務record／View／DTOはある。共通ProductShelf相当は未確認 |
| 中断・再開 | LIMIT_REACHEDの確定境界、既存Job非再実行 | `story902-integrated-runner.cjs:assertReservedReservation/resolveLedgerReservation`に限定継続がある。送信履歴のないRESERVEDだけを厳密照合 |
| Lease／Heartbeat | SQLite時刻・期限・owner／世代 | 調査したSTORY／正式業務コードに同じ機構は未確認 |
| Fencing | 世代とUUID、保存と同一SQLite Transaction | STORYのEvent Claim一意性・version制御はあるが単調な所有世代ではない |
| 冪等性 | 外部要求台帳、独立模擬サービス | 現金受付・PayPay記帳等にrequest_id＋内容ハッシュ＋結果再利用が存在 |
| UNKNOWN | Workflow診断と外部要求専用診断、再送拒否 | STORY LedgerのUNKNOWN、REPOSITORY_OUTCOME_UNKNOWN、継続Gate等が存在 |

主な根拠：ARCH `src/prototype/diagnosis.ts`、`src/adapters/job-execution/{resume,ownership,external}.cjs`、`src/adapters/mock-notification/service.cjs`。道場 `work/story902-{run-ledger-model,run-ledger-firestore-repository,run-ledger-inspector,integrated-runner,webconnect-runner}.cjs`、`cloud/billing/payment-{cash-accept,paypay-post}-firestore.cjs`。

STORYのFirestore Ledgerはreserveでclaim／event／runをTransaction内に作り、更新はexpectedVersionを照合する。UNKNOWNは終端として自動再送を防ぐ。再利用できる安全原則は多いが、特定Story／環境／実行証跡への制約を持ち、`businessExecutionAllowed`等の明示Gateもある。`work/`にコードがあることは、そのまま正式Cloud Run APIへ接続済みである証明ではない。

`story902-dev-environment-lock.cjs`は環境・クライアント・権限の照合であり、名前にlockがあっても実験017のLease Lockではない。承認のexpiresAtも所有Leaseへ流用しない。

## 7. 読み取り専用の接続候補

以下はいずれも**既存関数の候補**であり、今回実行・接続はしていない。

| 優先度 | 実在する入口 | 入出力・依存 | 接続上の扱い |
|---|---|---|---|
| 1 | `cloud/attendance/progress-summary.cjs:projectAttendanceProgress({member,attendanceRows,standard,rankOption})` | 純粋な業務投影。進捗・残数・examination_ready等を返す | 既存関数を変更せず、合成入力でJobFormから利用可能。最初の019-B候補 |
| 2 | `cloud/attendance/progress-firestore.cjs:createFirestoreProgressReader(core)`が返す`readProgress(memberId)` | readById／queryEqual／readPageを注入。会員・出席・級段位・基準を取得 | 最初は全読込をFakeにする。範囲上限・ページング・不正マスタは失敗として保持 |
| 3 | `shared/DAO_Business.js:createDao(...).readById('members', id)` | `DAO_Definitions.js`にmembersの読取Mappingあり。Cloud serverに実際の配線あり | 未存在null、DTO縮約、認証境界を維持。名称だけ似たMemberObjectへ直結しない |
| 4 | `cloud/attendance/member-state-firestore.cjs:createFirestoreMemberAttendanceState()` | 会員状態＋出席状態＋進捗＋会費選択＋Scope検証 | 読取は可能だが依存が広い。最小実験の第一候補にはしない |
| 補助 | `gas/DAO_Business_Member.js:daoMemberGetAll_(ctx)`／`gas/04_AttendanceProgress.js:attendanceProgress_getMemberSummary(memberId,ctx)` | GAS Context・既存業務補助・複数読取を必要とする | 名前がreadでも、依存の初期化・Schema整備を別途確認するまで実環境で呼ばない |

HTTPを使う後続候補として、既存`member_read`／`attendance_progress_summary`／`member_attendance_state`のWebConnect actionがある。`shared/WebConnectCore.js:resolve()`→`cloud/api/webConnect.cjs:createDispatch()`→`cloud/api/admin-api.cjs:createAdminApi()`という現行経路を保つ。新しい公開APIを作る必要性は今回確認できていない。

progress／memberStateは既存のID Token検証とadmin／有効な先生／本人確認を持つ。生のMember読取はadmin境界を維持している。Coreから直接DBを読むことを、ユーザー認可の代替にしない。

Member DTOは連絡先等を含み得るため、将来のAdapterはWorkflowに必要な識別・状態・進捗だけへ縮約する。成果物・履歴・外部要求へMember全体を保存しない。今回、実際のレコードや個人情報は取得していない。

## 8. 差異分類一覧

A＝そのまま共通利用可能、B＝Adapterで吸収可能、C＝インターフェース変更候補、D＝責務・設計の衝突、E＝未確認。

| ID | 分類 | 判断・必要差分 | 根拠 |
|---|---|---|---|
| D01 | A | Node上の既存Prototype遷移・boolean Checkを019-Bで維持できる。GAS直載せの判定ではない | ARCH workflow.ts:CWorkflow/CCheckJob |
| D02 | A | 既存純粋進捗投影を業務側のまま変更せず利用できる候補 | 道場 progress-summary.cjs:projectAttendanceProgress |
| D03 | B | 同期GAS値／非同期Node値はawait可能なJobForm入力境界で吸収 | ARCH CJobForm.collect、道場 shared/Flow.js:runSteps |
| D04 | D | 道場JobとARCH CJobは同じ基底・状態モデルではない | gas/00_Job.js、ARCH workflow.ts:CJob |
| D05 | D | 業務Job.executeをmakeへ丸ごと入れるとrecord/postと業務書込が重なる | BillingMonthlyJob.execute、PaymentEvidencePostJob.execute |
| D06 | B | ok:false／null／例外／欠落を明示変換し、技術失敗をDONEにしない | createDao、業務Job戻り値、CWorkflow.executeRun |
| D07 | D | Prototype booleanとGUI FINAL／PROVISIONAL／WAITは同一でない | ARCH gui/workflow-runtime.js、src/core/types.ts |
| D08 | B | 読取DTOの項目名・型・日付・必要項目への縮約 | DAO_Definitions.members、DAO_Core_Values、MemberObject |
| D09 | D | 論理Schema版、Definition版、物理DB版、業務Revisionを混同しない | ARCH definition.ts、database.cjs、道場Portable Definition |
| D10 | B | 不変DefinitionをFirestoreへ格納する専用Adapterは既存async get/add Portを維持できる候補 | DefinitionRepository、SimpleDBWorkflowDefinitionRepository、Firestore create条件 |
| D11 | C | Job生成時の同期onCreate／checkpointには非同期保存完了を待つ境界が不足 | ARCH definition.ts:100–108、SQLiteJobRunStore.register |
| D12 | C | SQL同期Transaction／ATTACHをFirestore Transactionへ置換するには原子的保存・所有権境界の契約整理が必要 | database.cjs、ownership.cjs、道場SDK Executor |
| D13 | D | ScriptLock、環境attestation、Event Claim、Leaseは別概念 | GAS業務execute、story902-dev-environment-lock、Ledger、ARCH ownership |
| D14 | D | STORYのRESERVED継続とCWorkflowのLIMIT_REACHED再開は相互代替でない | assertReservedReservation、CWorkflow.resume |
| D15 | B | 認証・認可は既存Dispatch／Principalに残し、読取Adapterへ許可済み入力だけ渡す | admin-api、dojo-principal、WebConnectCore |
| D16 | D | 業務別request_idと外部要求IDの識別範囲・Hash対象を独断で統一しない | payment-cash/paypay Executor、ARCH ExternalOperations |
| D17 | C | ARCH外部台帳のSQLite保存と汎用サービス契約はFirestore版未実装。通知用結果形式にも依存 | external.cjs:response/ExternalOperations |
| D18 | B | CommonJS出力の明示import／配布物へ含める境界が必要 | ARCH tsconfig／dist require、道場 target.mjs |
| D19 | E | Cloud RunのNode版、永続保存・共有・所有権の実配置は未確認 | root packageのengines未固定、現在の配布構成 |
| D20 | E | Story補助機構の実稼働配線・試験最新結果は本調査では確認しない | work/の実装・検証コード、Cloud配布リスト |
| D21 | D | 業務の審査可否とWorkflowの分岐、業務FAILと実行FAILEDを区別 | projectAttendanceProgress、CCheckJob、外部効果試験 |
| D22 | E | 実Firebase権限・Rules・対象環境・結果照会契約・個人情報保持方針 | 実環境には未接続。Adapter開始条件として別途確認 |

Aは将来のパッケージ提供まで完成している意味ではなく、対象の処理ロジック自体を変更せず使えるという限定判断。

## 9. 統合方式の比較

| 方式 | 変更範囲・既存影響 | 保守・Version | 検証 | 汎用サービス化 |
|---|---|---|---|---|
| ソースコピー | 最初は容易だがCore・DAO・Jobの別コピーが増える。既存Buildと相対requireの整理が必要 | 修正同期・出所追跡・二重改修の負担が大きい | 両コピーで回帰が必要 | 不向き。正式採用は非推奨 |
| 共通パッケージ | 公開API／export／配布対象／Node条件／依存を先に切り出す必要 | Version固定、更新履歴、契約試験を集中可能 | package契約＋各Adapter回帰 | 中期候補。ただし現在はprivate packageで配布境界未整備 |
| Git Submodule等 | 固定Commit参照は可能だが、相対パス・Build・CI・権限の接続が必要 | ソース由来は追跡可能。取得・更新・dirty tree運用が必要 | Submodule checkout後の再現Buildが必要 | 配布方式にはなるが契約不一致を解決しない |
| 両Core維持＋Adapter接続 | 最初は読取関数／注入済みDAOだけを境界化。業務Coreを移植しない | 初期変更を小さくできる。配布方法は別判断 | Fakeで共通契約→既存認証経路の検証 | 最小接続に適する。安定後にpackage化と併用可能 |

方式4は実行時の境界、方式2／3はコード供給の方式でもあるため、完全な排他選択ではない。いずれも、この段階で確定しない。

共通配布を選ぶ前に公開範囲・利用条件・依存Versionを確認する。道場側の業務ソースをPublicなARCHへ無条件にコピーする案ではない。最初のローカル参照も、両リポジトリの存在と対象版を明示し、将来の単独配布時に私有リポジトリのパスへ暗黙依存しないようにする。

## 10. 推奨する最小統合方法

**提案：既存Coreを維持し、最初はローカルNodeで読み取り専用の業務投影をAdapterから呼ぶ。**

1. ARCHのCWorkflow／CJobForm／ProductShelfを継続利用する。
2. 道場の`projectAttendanceProgress()`をそのまま利用し、入力はすべて新規の合成値とする。
3. 次に`createFirestoreProgressReader(fakeCore)`で既存readById／queryEqual／readPage契約を検証する。実Firestoreへ接続しない。
4. 正常な進捗結果を成果物として記録・公開し、必要ならexamination_readyを明示的なCheck条件として利用する。falseを技術ERRORと扱わない。
5. 既存認証済みWebConnect経路への接続、FirestoreへのWorkflow状態永続化、書込業務の呼出しは、それぞれ別の承認・工程とする。

これは既存の読取関数を利用する案であり、新しい業務APIやRunnerを作る案ではない。道場の全業務Core整理、CJob一括リネーム、SQLiteのCloud Run持込みを先行条件にしない。

## 11. 統合前に解決すべき課題

| 優先 | 課題 | 解決判断の基準 |
|---|---|---|
| 最優先 | Prototype／GUI／将来Engineのどれを統合対象にするか | 019-BはPrototypeに限定する提案をレビューする |
| 最優先 | コード参照の再現性 | 両作業ツリーの未コミット成果を含む基準Versionを固定。現在のHEADだけを使わない |
| 高 | 読取DTOと失敗の意味 | 未存在・業務上の否定・通信失敗・形式不正を区別し、必要最小限の項目だけ公開 |
| 高 | 認証・権限と保存汚染防止 | 既存admin／先生／本人の権限を維持。合成値以外は別工程まで読まない |
| 高 | 非同期登録・原子的保存Port | Firestore対応時にJob開始前の永続化と所有権Fencingを同一整合境界で保証 |
| 中 | 配布／Build | Node版・CommonJS境界・相対require・配布依存の固定、余分なGUI／SQLiteの混入回避 |
| 後続 | 外部効果の識別・照会・UNKNOWN | 業務既存キーを尊重し、二つの台帳から同じ副作用を別IDで発行しない |
| 後続 | Cloud永続化・再開・Lease | 実配置とFirestore側のTransaction／世代検証を設計し、ローカル試験結果をそのまま流用しない |

## 12. 試験根拠と実験019-Bへの提案

今回の評価は静的調査であり、PASS件数を新たに計測していない。ARCH実験018報告の779 PASSは直前工程の記録であり、道場システムとの互換性試験結果ではない。

実在する試験を読み、次の検証対象を確認した。

- ARCH `tests/job-form-{cmrp,execution,check-branch,loop}.test.cjs`：Job生成、工程、分岐・反復、実行別独立性。
- ARCH `tests/job-{execution-sqlite,run-diagnosis,run-resume,run-lease}.test.cjs`、`tests/external-effects.test.cjs`：永続化、診断、確定再開、複数Node、UNKNOWN、冪等性。
- 道場 `work/verify-attendance-step8i-progress-firestore.cjs`：Fake coreでmember単位読取、基準欠落、件数上限、重複マスタ、ページング異常を検査するコード。
- 道場 `work/verify-master-schema-roundtrip.cjs`：論理・物理DTOの往復検査。
- 道場 `work/verify-story902-run-ledger.cjs`、`verify-story902-firestore-run-ledger.cjs`：Claim一意性、Version、UNKNOWN、結果不明をFakeで検査するコード。
- 道場 `work/verify-fw002-payment-cash-firestore.cjs`：Transaction Fake、再試行、commit失敗等の検査コード。一部は生成済みBuildに依存するため、読んだだけで現在PASSとは扱わない。

**019-B候補（未着手）**：合成Member／出席／基準／Rankだけを使い、既存進捗投影→JobForm→内部record→公開成果→必要ならboolean Check、という小さなローカル経路を検証する。

完了条件案：

1. 両Core・既存業務関数を変更せずに、同じ入力で既存投影とWorkflow成果物が一致する。
2. 進捗未達を正常な業務結果として扱い、入力不正・不完全読取は公開しない。
3. 異なるrunIdの入力・成果・履歴が独立する。
4. Fake読取しか行われず、書込DAO・外部APIの呼出しがゼロである。
5. パッケージ／参照方法と対象Versionを明示し、既存試験に回帰がない。

今回はこの提案の実装・新規API作成・試験実行・移植を行っていない。報告書以外のファイルを変更せず、Commit／Push／Deploy／DB操作を行わず、019-Aの報告時点で停止する。

作業後確認では、本書を除いた両リポジトリのGit状態が着手時と一致した。選択したソース・package.json・Inventory／機能チェック文書等のSHA-256も、ARCH側107ファイル・道場側530ファイルで一致した。ステージ済みファイルはない。本書だけが今回の新規ファイルである。
