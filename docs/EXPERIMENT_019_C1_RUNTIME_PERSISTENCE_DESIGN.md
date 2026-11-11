# 実験019-C1：実行環境・永続化契約の調査と接続設計

調査日：2026-11-09。判定：**設計上は条件付きで接続可能。Firestore上での動作成立は未検証**。

## 1. 調査範囲と結論

現物を確認したリポジトリは次の2つである。

- ARCH：`C:/Users/pxk07/Documents/道場サポ/workspace/ARCH-026_Workflow`、HEAD `26f22fdcafb1276f8a32d31629cef52759436d03`
- 道場：`C:/Users/pxk07/Documents/道場サポ/workspace/clasp_道場サポ`、HEAD `4d6f55582d4e89cb8957b814d267d82461cc2951`

両方に未コミット変更がある。以下はHEADだけでなく、現在の作業ツリーの実験実装を対象とする。既存019-A／B報告書と、その根拠ソースを確認した。本書以外を変更しない。実データ・DB・実サービスには接続せず、Emulatorも起動していない。

本書では【事実】をソース確認結果、【公式仕様】を公式資料による確認、【提案】を未実装の接続案、【未確認】を未検証事項として区別する。820 PASS／0 FAILは依頼の回帰基準であり、今回の実行結果ではない。テスト・Buildは実行していない。

【結論】両Coreの統合・改名ではなく、ARCHの既存非同期境界にFirestore AdapterとHost Compositionを接続する案を推奨する。ただし、同期Registry、同期成果物読取、保存単位、Lease時刻の4点を019-C2の成立条件とする。SQLite Adapterの差し替えだけで、そのまま成立するとはいえない。

## 2. 実行環境の比較

| 項目 | ARCHの現物 | 道場の現物・未確認事項 |
|---|---|---|
| Node | 調査端末 v24.16.0。`node:sqlite`を使用 | 同端末で調査。稼働中Cloud RunのNode Versionは未確認。package.jsonにengines固定なし |
| 言語 | PrototypeはTypeScript、Adapter／GUIはJS・CJS | shared／gas／adaptersはJS、cloudはCJS、toolsは主にMJS |
| Module | tsconfig.prototype.jsonはCommonJS、ES2022。distへ生成 | CJSのcloud入口とESM toolsが共存。単一形式への統一を前提としない |
| Build | package.jsonのbuildは`tsc -p tsconfig.prototype.json` | tools/target.mjsの配布生成、tools/build-time-travel-firestore.mjsの業務ソースbundleなど用途別 |
| 入口 | prototype/demo.ts、gui/server.js。src/core/engine.tsのWorkflowEngineは骨格 | root startと配布startは異なる。tools/target.mjsのbuildFirebaseが配布packageのstartを`node cloud/api/server.cjs`に設定 |
| async | CWorkflow／CJob、履歴Storeはawait可能。Registry生成と成果物has/getは同期 | shared/Flow.jsのrunStepsは同期／Promiseを扱う。Firestore DAOは非同期。既存GAS Jobは別契約 |
| 環境変数 | ローカルComposition中心。Cloud Run配布契約なし | server.cjsがPORT・TZ等を使用し、ADCとtarget profileから初期化。実際の値は本書に載せない |
| Cloud Run | 専用実装なし | cloud/api/server.cjsはPORT指定時0.0.0.0でlisten。実デプロイのtimeout、concurrency、CPU割当、SA権限、volumeは未確認 |
| SDK | package.jsonにFirebase SDK依存なし | firebase ^12.19.0、firebase-admin ^14.5.0宣言。実配布の解決Versionは別途固定が必要 |
| Firestore | SQLite実装と019-B純粋業務接続まで | Admin SDKによる業務Transactionと、RESTベースDAOが共存 |

根拠：両package.json、ARCH tsconfig.prototype.json、src/prototype/workflow.ts、src/prototype/job-form.ts、src/prototype/definition.ts、道場cloud/api/server.cjs、tools/target.mjs、shared/Flow.js。

【公式仕様】Node 24の公式APIにnode:sqliteが存在する。しかし、これは実稼働Cloud RunのNode imageを確認したことにはならない。[Node SQLite API](https://nodejs.org/docs/latest-v24.x/api/sqlite.html)

【公式仕様】Cloud Runの通常の書込可能ファイルシステムはインスタンス終了後の永続保存先ではない。停止通知後の猶予も有限である。したがってSQLiteファイルとローカルlockをそのまま共有永続基盤として採用しない。[Container contract](https://docs.cloud.google.com/run/docs/container-contract)

## 3. SimpleDB・Schema・Repositoryの差異

| 観点 | ARCH | 道場 | 接続判断 |
|---|---|---|---|
| SimpleDB | adapters/simpledb/database.cjsのDatabaseSync基盤 | 調査対象の現行DAO群はARCHのSQLite基盤を共有していない | 名称による互換性なし |
| Definition | get(id,version)／add、create-only。prototype/definition.tsの厳密Validator | 業務entityのDAOとSchema | Definition契約は維持し専用Adapter追加 |
| Schema | prototype-workflow/1、論理Definition Version、DB物理user_versionを分離 | schema/*.yml、portable-data-definition-core.mjs、Schema_Renderer_Firestore.js | Workflow SchemaはARCH側を正とし、業務Schemaへ混在させない |
| DAO | 用途ごとのRepository、保存時検証 | shared/DAO_Business.js:createDaoのreadById／append／update／upsert等 | upsertをDefinition.addへ代用しない |
| Firestore読書 | 未実装 | cloud/member-read/DAO_Core_Firestore.cjsはREST、create-onlyと任意updateTime条件あり | 複数Document所有権Transactionの代替にはならない |
| Transaction | 同期callback、BEGIN IMMEDIATE。Promise拒否。履歴とJob保存の同一tx、所有権DBとのATTACH | adapters/firestore/DAO_Core.jsのSDK Transactionと、業務別executor | SQL callbackの移植不可。Firestore専用非同期Adapterが必要 |
| ID | UUID Job／要求ID、Definition複合ID、数値履歴order・artifactId | entityキー、業務要求ID、独自安定キー | 論理IDを維持し物理documentIdだけ符号化 |
| Version | Schema／Definition／Revision／fencing世代が別 | entity version、updateTime、業務ledger version等 | 相互代用しない |

ARCHの物理識別：Definitionはapplication_id `0x41524348`・v1、一般Dataは`0x41524441`・v2、実行履歴系列は`0x41525255`、所有権系列は`0x41525243`。実行履歴v1に対するJob永続化拡張はv2、所有権系列は基本v1・Lease付きv2・副作用管理付きv3である。各Adapterのopen検証を正とする。これらをFirestoreのuser_versionとして再現する必要はない。Firestoreには専用storageSchemaVersionと明示的decoderを置く案とする。通常openでの暗黙変換は引き継がない。

根拠：ARCH adapters/simpledb/database.cjs、workflow-definition/simpledb.cjs、data/simpledb.cjs、workflow-history/simpledb.cjs、job-execution/{simpledb,ownership,external}.cjs。道場shared/DAO_Definitions.jsにはmembers定義も存在する。DAOに会員定義がないという前提は採らない。

## 4. 永続化対象とFirestore対応案

以下のFirestore名はすべて【提案】であり、既存Collectionではない。Rは`arch026_runs/{runId}`、Dは`arch026_definitionVersions/{encodedKey}`を表す。ID／Version組の長さ付き正規化値のhashを物理キー候補とし、本文の元ID・Version・digestを必ず照合する。

| 対象 | 現在の保存主体・契機 | 原子的に扱う範囲 | 読取・再開用途 | Firestore案 | 不足・注意 |
|---|---|---|---|---|---|
| Workflow定義 | Definition Repository.add | ID＋Versionのcreate-only | Loader／再構築、固定Version解決 | Dに論理定義全文とdigest | 削除・上書き不可。Job実装配布は別 |
| 実行状態 | SQLiteHistoryStore.save、開始／各遷移／終端 | 履歴prefix、Job観測、成果物観測、所有権検証 | load／diagnose／resume | Rにstatus、currentStepNo、headRevision、履歴末尾order | rootへ全履歴配列を入れない |
| 実行履歴 | 同Store、Job・Check終了時 | 状態遷移と同時、追記のみ | 監視、分岐・反復の再現 | R/history/{order} | 既存TraceEntry形式をdecode時に復元 |
| Job実行状態 | SQLiteJobRunStoreのregister／checkpoint／flush | jobId・内部成果・対応checkpoint | 診断、完了済みJob再実行防止 | R/jobs/{jobId} | 現在は観測したphaseであり全工程ログではない |
| Job実行ID | 同register、Registry onCreate | run・step・iterationの一意対応 | 新規反復と過去実行の識別 | jobsのUUID＋一意性用索引Document案 | Firestoreで同期onCreate保存不可 |
| 内部成果 | checkpointがnative Job.getRecordedを読む | Job観測と対応内部成果 | record／post境界の診断 | R/artifacts/{stableId} kind=INTERNAL | record callback内の値だけで内部確定とみなさない |
| 公開成果物 | SQLiteJobRunStore.publishとflush | 公開観測・参照head・Job観測 | 実行別棚の復元、後続collect | 同artifacts kind=PUBLISHED＋publicationHeads | 内容二重保存せずheadは参照のみ。部分公開を消さない |
| Check結果 | CWorkflowのTRUE／FALSE Trace | 次工程・履歴と同時 | 保存済み分岐を再利用 | historyにresult／nextStepNo | 再開時に完了済みCheckを再評価しない |
| Checkpoint | 履歴snapshotとJob／成果物の整合状態 | 所有権・run revision・末尾trace | 確定境界からのresume | Rのheadと関連Doc群 | 独立した未整合checkpointを作らない |
| 所有権 | ownership.cjs claim／heartbeat等 | 世代検証と保護更新を同一tx | inspect、所有・失効判定 | R/control/ownership | 独立txで確認してから別tx保存は禁止 |
| 外部要求ID | external.cjsのprepare | run・job・operation・payload digest | 結果照会／同一要求照合 | R/externalRequests/{stableKey} | 業務側要求IDとの対応を保持 |
| 外部副作用状態 | external.cjsの送信意図／応答／照合 | 対応するローカル要求状態と所有権 | UNKNOWNでの自動再送拒否 | 同要求Document＋必要な試行記録 | 外部サービスとFirestoreの全体原子性なし |

根拠：上記Adapter群、prototype/diagnosis.ts:diagnoseSavedRun、job-execution/diagnostic.cjs、resume.cjs、external.cjs。

【提案】RにはDefinition ID／Version／digest、Registry実装Version、storageSchemaVersion、headRevisionを保存する。jobsにはstepId／stepNo／jobFormId／iterationNoを保存する。artifactにはキー、kind、JSON型、公開証拠RETURNED／OBSERVED_AFTER_ERROR、論理artifactOrdinalを保存する。既存診断DTOが正の数値artifactIdを要求するため、Firestoreの文字列Doc IDをそのまま渡さず、Transactionで割り当てた安全整数ordinalから復元する。

run単位の保存意図を`R/mutations/{mutationId}`に記録する案とする。mutationIdと入力digestをTransaction外で固定し、同一意図の確認に使用する。これは業務決済の冪等性台帳を再実装するものではなく、Workflow保存の応答喪失を照合する技術記録である。

## 5. Transaction境界と結果不明

【公式仕様】Firestore Transactionは複数Documentの原子的更新に対応し、readをwriteより先に行う必要がある。競合時にcallbackが再実行され得る。[Transactions](https://firebase.google.com/docs/firestore/manage-data/transactions)

【提案】一つの保護保存は次の順序とする。

1. Transaction外でDTO検証・独立snapshot・保存意図ID・digest・必要参照を確定する。Job実行はTransaction外で一度だけ行う。
2. callback内でownership、run head、既存mutation、変更対象の既存Docをすべて読む。
3. DB種別相当のstorageSchemaVersion、ownerId／claimToken／fencingToken、Lease、期待headRevision、履歴prefixを検証する。
4. 同一mutationの確定記録が既にあれば内容を照合する。観測済み結果の返却と、新規書込権限の判定を混同しない。
5. Job観測、内部／公開成果物、履歴追記、run head、mutation記録を同一Transactionで更新する。
6. commit完了を待つ。応答不明なら書込を続行せず、その実行のAdapterを保留状態にする。読戻しは状態照合であり、元の呼出し成功の証明ではない。

callback内にCJob.execute、Check評価、業務DAO、通知、決済、HTTP、UUID生成による別要求化、ローカル棚の変更を入れない。callback再実行は保存競合の再試行に限定し、Jobや外部要求の自動再送に変換しない。

SQLiteのATTACHは指定されたローカルDB群を一つの同期Transactionで保護する方式である。Firestore案は**同じFirestore database内**の所有権Docと保護Doc群を一つのTransactionで扱う。SQLiteファイル、別database、外部サービスまで一括commitするものではない。

【公式仕様】Document上限は1MiB、API request上限は10MiB、Transactionは最大270秒・idle60秒などの制約がある。500という数値には「一つのDocumentへのfield transformation数」の制限もあり、これをすべてのAPIに共通の総書込数保証として扱わない。[Firestore limits](https://firebase.google.com/docs/firestore/quotas)

【提案】C2は一保存意図20書込以下、成果物JSON 64KiB以下、履歴100遷移以下の実験上限を事前検証する。これは公式上限ではなく、小さな原子保存を実証するための制限である。超過時に一つの確定保存を無断分割しない。履歴は分離Doc化するが、既存Coreへ渡すsnapshotは全prefixを復元するため、Coreのメモリ消費が無制限に解決するわけではない。

## 6. 非同期Job・Registryとの接続

【事実】CJob.executeはcollect→make→record→postをawaitする。IWorkflowHistoryStoreのsave/loadもPromise対応である。CWorkflowはbeforeStepをawaitし、Job実行後に履歴保存をawaitする。失敗履歴保存自体が失敗するとWorkflowRunErrorのHISTORY_SAVE_OUTCOME_UNKNOWNを返し、元原因と保存原因を区別する。既存Coreに一律のtimeout・cancel機構はない。

【事実】reconstructWorkflowのjob factoryとonCreateは同期である。非同期onCreateを登録しても永続化完了を待つ契約にはならない。ProductReader.has/getも同期であり、Firestoreへの直接lazy-readにはできない。道場側のPromise DAOを同期Jobへ無理に渡す案も採らない。

【提案：Core無変更の限定接続案】

- 起動時にasyncで必要な公開成果物を読み、実行別memory shelfを復元してからWorkflowを生成する。
- onCreateはローカルなjobId・run・step・iterationの対応確定だけを行う。未awaitのDB処理を開始しない。
- CompositionでJobFormを薄く包み、既存のawaitされるcollectの冒頭で所有権付き登録を完了してから元のcollectを呼ぶ。JobFormの仕事定義は共有し、実行bindingだけ分離する。
- この方式で最初に保存されるJobは、native CJob上では既にRUNNING／collectである。SQLiteの同期登録と同じタイミングのREADY保存ができたとは主張しない。
- record callback終了前はnative CJobの内部成果確定前である。post用ProductShelf.putでgetRecordedを観測し、内部成果の保存をawaitしてから公開保存へ進む。内部と公開の中間失敗は診断対象として残す。
- putはFirestore commit確認後にローカル棚へ反映する。HistoryStore.saveは確定済み保存とJob実測状態を照合し、run＋trace保存をawaitする。結果不明で後続saveを続行しない。
- beforeStepで次工程の開始証拠と所有権をawaitする案を検証する。callbackにはstep引数がないため、Adapterが最後に確認したsnapshotのcurrentStepNoを使用し、推測でstepNo+1に進めない。

根拠：prototype/{workflow,job-form,definition}.ts、job-execution/simpledb.cjs:SQLiteJobRunStore。

| 課題 | 変更候補の層 | C1判定 |
|---|---|---|
| Firestore read/write・所有権Transaction | 新規Adapter | 必須。未実装 |
| sync onCreateからawait境界への保存移動 | Adapter Composition | 上記案をC2で実証 |
| 同期棚読取 | Hostの事前復元＋Adapter | C2の小規模データでは検証可能 |
| Host deadline／heartbeat／停止フラグ | Host | 必須。停止と処理取消は別 |
| Promiseを返すfactoryや実行前READYの厳密保存 | Core契約変更の候補 | 今回採用しない。必要になれば停止して提案 |
| 強制cancel、巨大履歴の部分load、任意legacy Jobの永続化 | Core等の追加検討 | C2最小範囲外 |
| 同期Ticket RepositoryのFirestore化 | Ticket周辺の別調査 | 今回対象外。Prototype保存と混同しない |

この案は正式な新Runner階層や別CMRP実行ループを作らない。包み込みで安全な待機・checkpoint対応を実証できなければ、「両Core無変更で成立」とせず、必要な最小async hook変更を別途レビューする。

## 7. Cloud Run実行方式

【公式仕様】HTTP timeoutは既定300秒、最大3600秒で、504返却はコンテナ内処理の終了を保証しない。再接続先が同一インスタンスである保証もない。[Request timeout](https://docs.cloud.google.com/run/docs/configuring/request-timeout)

| 方式 | 利点 | 制約・判断 |
|---|---|---|
| HTTP内の短時間実行 | 既存Node入口に近い | 1工程が長いとtimeout。request終了後の放置Promiseを継続基盤としない |
| Job単位のslice | 確定境界を小さくできる | CWorkflowのmaxExecutionsとLIMIT_REACHEDを使う案。Job内部の任意位置からは再開不可 |
| Cloud Tasks等の起動 | 次sliceの配送を分離できる | 新規サービス導入は後続提案。重複起動を前提にclaimと保存意図を照合する |
| 明示resume要求 | 診断・利用者判断との対応が明確 | 自動進行なし。最小実験に適する |

【提案】C2はローカルNode Host／テストrunnerから明示run・inspect・resumeを呼び、1 JobまたはCheckをslice上限とする。Cloud Runへの接続・配布はしない。将来のCloud Runもこの短いslice＋明示診断を起点とし、配送だけを必要に応じTasksへ追加する。

Host終了前に確定保存・releaseを試みるが、成功を保証しない。Job待機中の強制終了はRUNNING／不明として診断し、Lease切れだけでJob再実行しない。CPU割当の設定を変えても、プロセスが永続生存する前提は置けない。実デプロイのCPU・concurrency等は未確認である。

## 8. 所有権・時刻・再開

【事実】ownership.cjsはSQLite側時刻、claim token、単調なfencing世代、Lease期限を検証する。保護更新も同一原子境界で行い、期限切れ後の旧Host保存を拒否する。resume.cjsはinspect／claimと確定境界の再構築を組み合わせるSQLite Compositionであり、Firestore汎用Adapterではない。

| 操作 | Firestore提案 | 安全条件 |
|---|---|---|
| inspect | run head、prefix、Job、成果物を整合した読取境界で取得 | 複数独立readの混在snapshotを診断しない |
| claim | ownershipをTransactionで取得・新規作成 | 同一runの勝者1つ。世代記録を消さない |
| Lease | server由来読取時刻＋期間で期限候補を計算 | Date.now単独で取得・失効判定しない |
| heartbeat | 現owner/token/fence＋有効Leaseを検証し更新 | 失効した旧世代の延命拒否 |
| fencing | 所有権Docを読んだ同じtxで保護更新 | 事前確認だけでは不可 |
| takeover | 期限切れを確認しtoken更新・世代増加 | 所有権取得は再開許可ではない |
| resume | 再診断後、既存CWorkflow.resumeへ確定snapshotを渡す | LIMIT_REACHEDとtraceの整合、Definition固定、UNKNOWN等を拒否 |
| release | 対象世代を確認し終了扱い | 世代counterを初期化しない |

【公式仕様】Node Firestore DocumentSnapshotにはreadTimeがある。[DocumentSnapshot API](https://docs.cloud.google.com/nodejs/docs/reference/firestore/latest/firestore/documentsnapshot)

【提案・未検証】callbackの各試行で取得したownership snapshotのreadTimeをLease判定用サーバー観測時刻候補とする。updatedAtのserverTimestampはcommitの監査時刻用であり、未解決sentinelのまま期限比較に使用しない。readTimeはcommit時刻そのものではない。読取後commit前に期限を跨ぐ可能性があるため、「commit瞬間にも必ず期限内」というSQLiteと同一の時間保証はまだ主張できない。同一ownership Docを読むTransactionで旧世代とtakeoverの競合を検出するFencingと、この時間上の差異を分けて試験する。

C2ではEmulator上のreadTime取得、再試行ごとの時刻更新、時計ずれ、期限境界、heartbeat対takeover、旧世代write拒否を実測する。server由来時刻が取得・解釈できなければfail closedとし、Host時計への暗黙fallbackは禁止する。Lease期間とheartbeat周期の本番値は未決定。

再開は公開済み成果物だけを棚へ復元し、内部成果を勝手に公開しない。既存診断のREVIEW_REQUIRED相当、OBSERVED_AFTER_ERROR、外部UNKNOWN、RUNNING中断などは自動再開しない。LIMIT_REACHEDでも診断結果・定義digest・末尾nextStepNo・保存世代を再確認する。診断pure関数diagnoseSavedRunは再利用候補だが、SQLite読取Adapterは新設読取へ置き換える。

## 9. 外部副作用の責務分担

| 対象 | 既存契約 | 接続方針 |
|---|---|---|
| ARCH external.cjs | PREPARED／IN_FLIGHT／CONFIRMED／UNKNOWN／REJECTED、要求ID、payload digest、照合 | Workflowが要求を発行した事実と再開制限を管理 |
| 道場payment-cash-accept-firestore.cjs | request_idと入力・actor照合、既存receiptによる再利用、業務更新とreceiptの同一tx | その業務冪等性を利用。別の決済台帳をARCHへ作らない |
| 道場payment-paypay-post-firestore.cjs | 同様に業務記帳とreceiptを保護 | 外部決済providerへのexactly-once保証と混同しない |
| 道場story902-run-ledger-model／repository | 独自送信意図、version、UNKNOWN、予約 | WorkflowのLeaseや要求状態へ機械的変換しない |
| 019-B審査進捗投影 | 純粋計算、合成データで接続済み | C2でも安全な業務接続候補。実DAOを起動しない |

ARCHの外部requestIdと業務request_idの安定した対応を保存する。同一業務要求を再開ごとに別ID化しない。UNKNOWN時は業務側の照会・既存receiptを先に確認し、再送可能性は当該業務契約に従う。既存receipt取得不能を「未送信」とはしない。ARCHの模擬通知receipt契約を決済やSTORYへ一般化しない。

道場work/story902-integrated-runner.cjsは予約状態と送信意図を区別しており、INFLIGHT等を自動再送できる契約ではない。またwork内の検証実装の存在だけで本番入口へ組込み済みとはいわない。C2では外部サービスは呼ばず、UNKNOWNの保存fixtureによる再開拒否までを候補とする。

## 10. 認証・権限

【事実】道場cloud/api/admin-api.cjsはBearer token検証を行い、dojo-principal.cjsはuidからサーバー側情報を解決する。管理者・先生・本人の範囲はAPI別に制御される。クライアントが申告したmemberIdや役割だけを信用する仕組みではない。cloud/api/server.cjsはFirebase Admin SDK／ADCを使用する。

【提案】業務起案者・実行許可者・対象member・技術Hostを別項目とする。CTicketのcreatedBy／ownerIdは、Workflow承認者の一般的権限モデルが完成していることを意味しない。Lease ownerIdはHost識別、fenceは保存権限世代であり、先生・管理者・承認者を表さない。

利用者認証、API呼出権限、Workload Service AccountのFirestore IAM、run所有権の4境界を分ける。SDKから書く技術Hostに業務認可を丸投げせず、既存APIの認可を維持する。実際のSA名・権限設定・秘密情報は調査／出力していない。ブラウザへclaim tokenやDB書込権限を公開しない。

根拠：道場cloud/api/{server,admin-api,dojo-principal}.cjs、ARCH prototype/ticket.ts。Firestoreのサーバーアクセス権限はIAMの確認も必要である。[Firestore IAM](https://firebase.google.com/docs/firestore/security/iam)

## 11. 配布とVersion固定

| 方式 | 固定・更新・rollback | Build／試験・独立性 |
|---|---|---|
| 共通package | package Version＋lock＋artifact digestで固定 | 将来の推奨候補。公開API・同梱範囲の整理が必要で今回は作らない |
| Submodule | commit固定、更新PR、旧commitへ戻す | checkout手順・CI・Windowsパス管理が増える。直ちに採用する理由は弱い |
| 固定commit取得 | 配布manifestでrepo commitと生成物digestを固定 | 実験時に追跡しやすい。取得・build・license／配布手順の明文化が必要 |
| Adapter外部module参照 | export入口とmodule Versionを固定 | 019-Bの開発接続に近いが、隣接ディレクトリや絶対パス依存は本番配布契約にならない |

【提案】C2はローカル開発用参照を明示し、両repo commit＋dirty差分の有無＋必要ソースdigestを実験manifestに残す。未コミット成果をcommit固定済みと偽らない。本番移行前に必要な純粋業務moduleとARCH公開入口を選び、固定artifactまたはprivate packageへ移行する。巨大なGAS／cloud server全体をrequireしない。

Definition Versionだけでは実装Versionを固定できないため、Job／Check Registry Versionと依存module digestをrunに結び付ける。rollbackはコードartifactを戻す操作であり、保存済みSchemaや外部副作用を自動巻戻しする操作ではない。旧実装が新DTOを読めない場合は実行を拒否する。

## 12. リスクと検証

| リスク・発生条件 | 影響 | 対策案 | C2以降の検証 |
|---|---|---|---|
| 同期onCreateにasync保存 | 未保存Jobが実行 | collectのawait境界へ移す | 保存遅延・reject時にmakeゼロ |
| 所有確認と保存が別tx | 旧Hostが上書き | 同一Firestore tx | takeoverと遅着writeをバリアで競合 |
| HostがJob途中で終了 | RUNNING／部分公開 | 再診断、確定境界以外拒否 | 子プロセス終了後のinspect |
| Host時計ずれ | 誤失効・誤claim | server readTime候補、fail closed | 時計を変えて判定不変／時刻欠落拒否 |
| heartbeatと保存の競合 | retry増加・飢餓 | 1 run ownershipを局所化、上限・周期調整 | 競合再試行でもJob回数不変 |
| callbackで業務実行 | 通知・決済重複 | callbackはDB変換のみ | callback複数回で外部呼出ゼロ |
| UNKNOWNの混同 | 危険な再送 | 保存／外部／業務ledgerを別分類 | 各UNKNOWNで適切な停止 |
| commit応答喪失 | 成功を失敗として再保存 | mutation照合、Adapter保留 | commit前／後例外、読戻し不能 |
| 履歴・成果物肥大 | 上限超過・部分commit | 分離Docと事前上限検証 | 境界サイズ、超過時書込ゼロ |
| Definition／Registry不一致 | 別業務で再開 | Version＋digest固定 | 同ID異内容、未登録Job拒否 |
| 個人情報の過剰保存 | 履歴・成果物から漏洩 | 合成データ、必要最小限DTO | snapshot／診断に入力全文・stackがない |
| 既存DAOの副作用混入 | 本番アクセス・業務変更 | 純粋projectionのみ注入 | ネットワーク禁止fixture、既存ソースhash照合 |
| 配布Versionのずれ | 再現不能・非互換 | artifact固定、run実装Version | 旧Versionでのresume拒否 |
| 複数readの時点不整合 | 誤った再開候補 | 一貫したsnapshot読取 | 保存とinspect競合、head整合検証 |
| SDK／Emulatorと本番差 | 実験成功の過大評価 | Version記録、限界を明示 | 本番特性は別工程で検証 |

## 13. 019-C2の最小実験案

構成は【未実装提案】である。

```text
ローカルNode 24 test Host A / Host B（別プロセス）
  → 既存CWorkflow / CJob / CJobForm
  → 実行別棚・async接続Composition
  → Firestore Definition / History / Job / Ownership Adapter
  → loopback Firestore Emulator（専用demo project）
```

既存道場cloud/api/server.cjsを起動しない。ADC初期化・本番target読込・本番DAO生成を避ける。依存SDKをARCH側の明示依存として固定する案とし、隣接repoのnode_modulesを暗黙借用しない。CLI／SDK／Javaの必要Versionは着手時に公式互換性とインストール現物を確認する。

【公式仕様】Admin SDKはFIRESTORE_EMULATOR_HOSTで接続先を変更でき、値にhttp://等のprotocolを含めない。同一project IDを指定する必要がある。[Emulator接続](https://firebase.google.com/docs/emulator-suite/connect_firestore)

【提案】C2起動前にloopbackのみ、demo用project、明示Emulator設定、実認証情報不使用を検証し、一つでも不明なら起動拒否する。専用データ領域以外の削除は禁止する。Emulator成功はIAM・Cloud Runライフサイクル・本番負荷の検証ではない。

| 工程 | 成果物・受入条件 |
|---|---|
| C2-1 接続前検証 | SDK／CLI等Version記録、設定異常で接続ゼロ。両Coreと道場ソースhash基準確定 |
| C2-2 Definition | get/add共通契約、同ID＋Version重複拒否、異Version共存、Schema・digest不一致拒否 |
| C2-3 async接続 | Job登録待機中はmakeしない。同期棚は事前復元。未await Promiseゼロ。Core無変更案の可否をここで判定 |
| C2-4 Job／成果物／履歴 | collect→make→record→post、内部のみ保存後の未公開、公開後取得、traceとhead一致。読戻し・再プロセス復元 |
| C2-5 原子性 | 所有権とJob／trace／run保存を同じtx。callback再実行でJob実行数は増えない |
| C2-6 claim／Lease | 二プロセス同時claimの勝者1、heartbeat、期限境界、server時刻取得・時計ずれ |
| C2-7 Fencing／takeover | 世代増加、旧token／旧fenceの全保護更新拒否。新Host所有だけでresumeしない |
| C2-8 確定再開 | LIMIT_REACHED後inspect→claim→restore→resume。TRUE／FALSE・後方遷移、iteration継続、完了Job再実行ゼロ |
| C2-9 障害 | commit前／後例外、応答喪失、Job中断、部分公開、外部UNKNOWN。再診断と停止を確認 |
| C2-10 回帰 | 820件を現行の全実験実行入口で再確認し、新規試験数を別記。Build／型／JS／差分チェック、両Core無変更証拠 |

小さな合成Workflow：生成Job→Check→消費Job→ENDと、Check後方遷移による反復を使う。Job／成果物／履歴保存は同一runに束ねる。並行試験はPromiseやIPCバリアで待機順を制御し、sleepだけに依存しない。履歴prefix・Job UUID・iteration・artifact ordinal・次Stepを具体的にassertする。

C2対象外：実Firestore、Cloud Run配布、Firebase／GAS業務Adapter拡張、Ticket永続化、実通知／決済、任意RUNNING位置の自動再開、分散exactly-once、prepare／cleanup追加、GUI改修、物理Schema移行。

## 14. 未決事項・Core変更の判定条件

1. readTimeを使うLease方式の期限判定点と必要な厳密性。commit瞬間の期限内保証が必須なら現案の不足を先に解消する。
2. collect接続による登録タイミング差を許容できるか。execute前READYの永続確定が必須ならasync生成hook等の最小Core変更が必要になる可能性がある。
3. 保存意図receipt、公開head、履歴の具体DTO／decoder・サイズ上限。Firestore Timestampと既存at文字列の変換・精度規則。
4. 再開時に必要な棚のロード範囲と、巨大履歴の将来対処。C2は上限付き全復元に限定する。
5. 実Cloud RunのNode、CPU、同時数、timeout、SA IAM、SDK解決Version。現時点では未確認。
6. Job／Check実装配布Versionの正式manifest、既存019-B外部参照の本番配布形式。
7. 個人情報の保持期間・削除・監査権限、起案／承認の正式業務モデル。技術ownerで代用しない。
8. 業務別UNKNOWNからの照会契約と安全な再送条件。既存業務の契約ごとに判断する。

【停止条件】既存await境界で保存待機と整合checkpointを作れない、同期Registryに未処理Promiseが残る、server由来時刻によるLease要件を満たせない、同一tx Fencingを実装できない場合は、C2を成立扱いにせず、理由・最小変更箇所を報告する。両Core無変更は検証対象であり結論の先取りではない。

## 15. 推奨統合方式と今回の作業結果

既存Prototypeを維持し、Firestore専用の永続化・所有権Adapter、実行別Composition、短時間Hostを追加する方向を推奨する。道場側の純粋投影は019-B Adapter経由で再利用し、既存業務の認証・冪等性は元の責務に残す。既存REST DAOだけでWorkflow全体の原子保存を代用せず、既存SQLite保存・診断・再開の安全条件をFirestore向けに実証する。

今回作成したものは本書のみ。コード・Adapter・保存Schema・DB・設定の変更、テスト実行、Build、サービス起動、ステージ、Commit、Push、Deployは行っていない。動作成立の最終判定は019-C2に持ち越す。

最終確認：開始時に採取した既存ファイルのSHA-256と照合し、ARCH 141件・道場744件の対象ソース／文書に変化なし。今回追加は本書1件のみ。既存の変更・未追跡ファイルを維持し、ステージ済みファイルは空。git diff --checkは終了コード0（既存ファイルの改行変換警告のみ）。
