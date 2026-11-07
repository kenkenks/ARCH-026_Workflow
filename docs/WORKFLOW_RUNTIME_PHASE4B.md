# Phase 4B — GUI と WorkflowRuntime の接続

## 対応範囲
- チケットからひな型を選択すると WorkflowRuntime を生成する。
- 通常実行（既定値 `NORMAL`）は登録済み業務Handlerのみを使用する。未解決Handlerは開始前に拒否し、Ticketや実行履歴を変更しない。
- 明示的な `DEMO` は全JOBを模擬Handlerで実行する。登録済み業務Handlerも呼び出さず、業務入力・Ticketへの紐付け・Ticket完了は行わない。
- CHECK_FINAL / CHECK_PROVISIONAL / CHECK_WAIT は画面で PASS / REJECT / WAIT / ERROR を手動指定する。
- 差戻し・ループ・待機・再評価・履歴表示・工程表示に対応する。
- チケット完了は通常実行の COMPLETED とだけ連動する。デモ後のTicketはOPENのまま。
- 既存の固定4工程デモは維持する。

## 制限
- イベントルートを含むひな型は実行開始前に拒否する。既存の `exam-workflow.example.json` はイベントルートを含むため、そのままでは実行できない。イベントルートを外した複製を用意して試すこと。
- 通常実行で現在解決できるのは `exam.dateAgreement` / `CExamDateAgreementJob` と `exam.resultRegistration` / `CExamResultRegistrationJob`。カタログ登録だけではHandler実装の登録にならない。
- CHECKの結果はユーザー手動指定であり、実業務判定ではない。
- 自動実行ボタンはひな型実行時は無効。1工程ずつ進める。
- 実行状態とチケットはサーバーメモリ上のみ。再起動で消える。
- 日時表示のUTC/JST変換問題は未対応。
- 複数チケットの同時実行、実行履歴の永続化、イベントルート、外部業務システムとの連携、実CHECKは対象外。

## 確認手順
1. `npm install` → `npm run gui`。
2. 通常実行では上記keyword/classを有効として登録する。未実装の `CJob` は明示デモでのみ使用できる。
3. イベントルートのないJOB・CHECK・ENDを含むひな型を作成・保存。
4. チケットを下書き発行→提出。実行モードを選び、「実行開始」でひな型を選択する。初期表示の固定4工程は常にDEMO。
5. 1工程実行、CHECK工程ではPASS/REJECT/WAIT/ERRORを選択して進める。
6. モニターの現在工程、履歴、待機状態、完了状態を確認する。

## テスト
`npm test`（Runtime・GUI実HTTP・CLI・Ticket回帰を含む）。GUI試験は専用一時領域とループバックのみを使用する。

## P1-2：完了の意味と履歴

- `COMPLETED` は制御フローがENDに到達した状態を表す。各JOBの `DONE` は、そのHandlerが `COMPLETED` を返したことを表す。外部DB保存・承認・実業務全体の完了を保証するものではない。
- 実行結果に `executionMode`、`resultKind`、`simulatedJobUsed` を追加する。通常のEND到達は `CONTROL_FLOW_COMPLETED`、デモのEND到達は `DEMO_COMPLETED`。失敗は従来どおり `FAILED`。
- 履歴の各項目に `executionMode` と `simulated` を残す。JOB待機時も、模擬Handlerを呼び出した事実は実行結果の `simulatedJobUsed` に残る。END・手動CHECKは模擬JOBではないため `simulated:false`。固定デモは条件判定も模擬なので全項目が `simulated:true`。
- Runtime自体に未解決Handlerが渡された場合は `FAILED` とし、架空のJob完了履歴を作らない。Handler例外・不正戻り値は実行したJobの `ERROR` を記録し、失敗後は進行できない。
- GUIはモードと「デモ（業務完了ではありません）」を表示し、履歴にもモード・模擬処理を表示する。CLIの `npm run demo` も同じ注意を表示する。
- PrototypeのCWorkflow実行処理やTicket状態遷移は変更していない。固定GUI/CLIデモはComposition側で保存履歴にDEMO属性を付ける。履歴は従来どおりメモリ保持のみ。

## P2-1：プロセス内の並行実行契約

- `WorkflowRuntime.advance()` は最初の非同期処理前に実行中ガードを取得する。同じRuntimeの重複要求は `RUNTIME_BUSY` / HTTP 409で拒否し、Handler・状態・履歴・Ticketを変更しない。キューには積まない。
- 正常終了・WAITING・FAILED・例外でガードを解放する。WAITINGを返した後の正規の再評価は許可する。Handlerがまだ処理中の状態とは区別する。
- GUI Serverは要求受付時のRuntime・状態オブジェクト・runId・Ticketを固定し、本文受信後に照合する。別実行に変わった要求は `EXECUTION_CHANGED` / HTTP 409。step/業務入力では工程変更も拒否する。Ticket完了は固定した実行の結果にのみ適用する。
- 開始ボタンの送信中ガードは補助対策。別タブや直接HTTP要求に対してはServer/Runtime側で保護する。GUIの同時実行枠は引き続き1件。
- Prototypeの `CWorkflow.run()` はStoreオブジェクト＋runIdを最初のawait前に予約する。同じ組合せの実行中要求は `RUN_BUSY`。別CWorkflowオブジェクトからも拒否する。Storeの公開契約は変更しない。
- 同じCWorkflowオブジェクトを別runIdで並行利用すると `WORKFLOW_BUSY`。異なるCWorkflowオブジェクト・異なるrunIdは同じStoreでも並行実行できる。予約とオブジェクトのガードはfinallyで解放する。保存済みrunIdの再実行拒否は維持する。
- **独立実行はJob/Checkを実行ごとに生成する。** `reconstructWorkflow()` は呼出しごとにRegistry factoryで生成する既存境界を利用する。factoryは状態を持つ同一実体を使い回さないこと。固定GUIデモもinit時に新しいCSequenceBoolとJobを作成する。業務Handlerの入力は既存どおりrunId＋stepIdで区別する。
- 同じCWorkflowを順次利用することは可能だが、Job/Checkの内部状態を自動リセットしない。新しいrunIdだけでは状態分離にならない。保存履歴からの再開・取消し機構は追加しない。
- 保証は同じプロセス・同じRuntime/Storeオブジェクトの範囲。別Storeオブジェクトが同じ物理保存先を指す場合や別プロセス間の排他は保証しない。永続化/CAS・分散ロック・外部業務のexactly-onceは対象外。

並行試験は `tests/workflow-concurrency.test.cjs`、実HTTPとGUI開始ガードは `tests/gui-runtime-concurrency.test.cjs`。PromiseとHTTP受信イベントで順序を制御し、既存DBを使わず一時領域で実行する。ブラウザ操作の試験はDOMスタブでの送信ガード検証であり、実ブラウザE2Eではない。

## P2-2A：例外・履歴保存・Ticket開始

- Runtimeのsnapshotに `error`、ERROR/FAILED履歴に任意の `diagnostic` を追加する。項目は `code` / `stepId` / 固定文言の`summary` / `executionMode` / `runId`。GUI Serverは `/api/state.diagnostic` と履歴から再取得でき、既存の表示用 `error` は概要文字列を維持する。CompositionはrunIdを注入する。単体で未指定の場合はnull（未割当）。
- コードは `HANDLER_EXCEPTION`、`INVALID_JOB_RESULT`、`CHECK_ERROR`、`JOB_FAILED`、`HANDLER_NOT_FOUND`。原例外のmessage・stack・任意オブジェクトは診断へ転記しない。Runtimeはローカル呼出元へ原例外を再送出するが、Serverは非Error例外も含め安全なJSONへ正規化する。
- PrototypeのbeforeStep失敗は、Jobを実行せずFAILED snapshotを保存して `WorkflowRunError(code=BEFORE_STEP_FAILED)` を送出する。`cause`に元例外を保持する。snapshotの任意 `failure` はrunレベルの失敗であり、架空のJob ERROR履歴を追加しない。
- 履歴saveが例外を返すと `HISTORY_SAVE_OUTCOME_UNKNOWN` / `outcome=UNKNOWN`。`attemptedSnapshot`、原実行例外の`cause`、保存例外の`storageCause`を区別して保持する。事後loadは `observation`（AVAILABLE/ABSENT/UNAVAILABLE）として返す。保存前後の例外をStore契約だけでは証明できないため、読戻し一致やCOMPLETEDを観測してもsave成功と断定しない。
- saveを自動再送しない。実行済みJobを巻き戻さず、保存済みrunIdの拒否を維持する。予約はfinallyで解放する。上記Errorのcauseやsnapshotはローカル診断用であり、HTTPへ無条件serializeしない。原例外と保存例外の保持は新しいトランザクションや再開機構を意味しない。
- 通常開始は候補Runtime/状態を非公開で生成し、Ticketを一度だけ紐付け、Ticketを再取得してID・Version・runId・IN_PROGRESSを照合してから公開する。紐付け例外後でも状態が一致すれば公開し、`startReconciliation=MATCHED_AFTER_EXCEPTION` と `/api/state.startDiagnostic` に状態照合の事実を残す。これは紐付けメソッドの正常終了を証明するものではない。
- 紐付けが例外になり、旧OPEN状態・未紐付けを観測した場合は `TICKET_START_FAILED` / 500。旧Runtimeを変更せず、候補は破棄する。状態を観測できない・期待と異なる場合は `TICKET_START_OUTCOME_UNKNOWN` / 503。候補Runtimeは公開せず、`/api/state.startIssue` に対象Ticket/runIdを残す。
- 開始結果不明はプロセス内の保留として保持し、次の通常/デモ開始、step、業務入力、resetなどの変更要求を拒否する。状態が読めるようになっても自動解除しない。今回は保留の解除/回復APIは実装しない。再起動で保留・メモリTicketとも消えるため、運用での再起動を安全な回復と見なさず、事前に状態を確認すること。永続的な保留保証は対象外。
- デモはTicketを紐付けず、従来どおり模擬制御フローのみ。Ticket業務状態は追加しない。P2-2A時点ではEND後のTicket完了更新失敗の回復は対象外だったが、P2-2Bで以下の専用回復を追加した。成功Jobを再実行する処理は追加しない。
- CDummyJobはcallbackを `() => void | Promise<void>` とし、同期/非同期ともawaitする。CJob.executeのPromise<void>契約は維持し、rejectは通常のJob失敗として扱う。模擬Jobである位置づけは変更しない。

追加試験は `tests/workflow-exceptions.test.cjs`、`tests/gui-exceptions.test.cjs`、Prototypeのasync callback試験。全て専用一時領域・メモリで故障注入し、既存DBや保護対象文書を変更しない。

## P2-2B：Ticket完了調整

`gui/ticket-completion.js` のTicketCompletionを現在の通常実行ごとに1個生成する。END到達時と `POST /api/ticket-completion/reconcile` は同じ処理を使う。Job/Check、`runtime.advance()`、Workflow履歴、Ticket履歴には触れない。既存のCTicketManager/Ticket Repositoryの公開契約・業務状態は変更しない。

回復要求はJSON `{ "ticketId": "対象Ticket ID", "runId": "対象実行ID" }` の2項目だけ。Runtime・要求・Ticketの各ID、Workflow ID/Versionを照合し、NORMAL・模擬Handler未使用・Runtime COMPLETEDの場合のみ調整する。FAILED、ACTIVE、DEMO、別実行への要求は409で拒否し、技術状態も変更しない。待ち行列や自動再送は作らない。

| 観測したTicket状態 | 処理・結果 | HTTP |
| --- | --- | --- |
| 識別情報一致・COMPLETED | 保存せずCONFIRMED。updatedAtも変更しない | 200 |
| 識別情報一致・IN_PROGRESS | complete()を1回呼び、正常/例外のどちらでも再取得して判定 | 以下の結果による |
| 再取得後に一致・COMPLETED | CONFIRMED。保存例外後はCONFIRMED_AFTER_EXCEPTIONの診断コード | 200 |
| 再取得後も一致・IN_PROGRESS | PENDING。次の明示的回復要求でのみ再試行 | 503 |
| 不存在・取得例外 | UNKNOWN。Ticketを変更せず状態照合を待つ | 503 |
| ID/実行ID/Workflow/Version不一致、OPEN/DRAFT/CANCELLED等 | CONFLICT。自動完了しない | 409 |

レスポンスの `ticketCompletion`、および `/api/state.ticketCompletion` は `ticketId` / `runId` / `workflowId` / `workflowVersion` / `result` / `checkedAt` / 安全な固定`code` を返す。stateでは `inProgress` も返す。最初の照合中はresult=UNKNOWN、checkedAt=nullであり、未観測を表す。checkedAtは確認試行時刻であり、保存操作の成功時刻ではない。内部例外や任意の例外messageは公開しない。

読戻しは状態の照合であり、保存メソッドが正常終了した証明ではない。保存後例外でも望む状態を確認すれば再保存しない。Runtime COMPLETEDは維持し、Ticket調整結果を独立表示する。GUIモニターは「Ticket完了確認済み／更新待ち／結果不明／情報競合」を区別する。PENDING等のEND応答でもレスポンス内のRuntime statusはCOMPLETEDのまま。

同じ調整オブジェクトのガードを最初のawait前に取得し、全経路でfinally解放する。重複調整は409/TICKET_COMPLETION_BUSY。調整中の開始・reset・Ticket編集/取消し等も拒否する。PENDING/UNKNOWN/CONFLICTと未確認のEND到達では開始・resetを409/TICKET_COMPLETION_UNRESOLVEDで拒否し、旧Runtimeを保持する。受信済みの遅着開始要求も本文読込後に再チェックする。

状態取得だけでは自動照合しない。CONFLICTは原因の確認・修正後、明示的な回復要求で再照合する。CONFIRMEDになるまで旧実行を破棄しない。誤った要求IDや重複要求は保存・Job・履歴・既存の調整結果を変更しない。

開始結果不明の `startIssue` と完了調整は別管理。開始保留中は従来どおり変更要求を503で拒否し、完了APIで開始保留を解除することはできない。CONFIRMED後は通常の開始/reset制約へ戻る。新しい認証・権限・公開listen設定は追加せず、既存の127.0.0.1向け開発Hostと同じアクセス境界を使う。

保証は同一Hostプロセスの協調するGUI API要求まで。Ticket Repositoryは同期・CASなしであり、直接Repositoryを書き換える処理や別プロセスとの競合まで原子性を保証しない。調整中のPromise待機はテスト用の境界注入でも検証するが、非同期Ticket永続化Adapterを正式導入したものではない。Runtime・Ticket・技術状態はメモリのみで、再起動後の復元・回復は対象外。通知やTicket完了履歴も追加しない。

試験は `tests/ticket-completion.test.cjs`、`tests/gui-ticket-completion.test.cjs`。保存前後の例外、読戻し不能、状態/識別情報不一致、重複調整、開始/resetとの競合、Job/履歴/保存回数/updatedAtの不変性を隔離環境で検証する。

## P2-3：履歴と業務Job記録の参照独立性

- Memory History Storeはsave/loadの双方でsnapshotをコピーする。対象はroot、history配列、各TraceEntry、任意のfailure。現行TraceEntry/failureの値は文字列・数値・null等であるため、既知の構造だけを複製する。汎用deep-copy、JSON変換、freezeは追加しない。
- 取得値の編集はその呼出元だけに適用される。複数load結果や別runIdの値へ伝わらない。変更を保存するには従来どおり明示的saveが必要。存在しないrunIdのloadはundefinedを維持する。Monitor.getはStoreのコピーを利用し、コピーを重複追加しない。
- CWorkflowのsnapshotはCore内のTraceEntryから独立する。Storeへ渡す値も、Coreが返却結果や例外診断として保持する値と分離する。Storeが入力snapshotを保持・変更しても、過去snapshotから後続履歴や最終結果を変更できない。Store自身が意図的に壊した保存内容を修復する保証ではない。
- 業務Jobのsubmit/describeはrecordとvaluesを個別にコピーして返す。valuesは既存の入力正規化で生成した文字列辞書。保存済み入力、別呼出元の返却値、別runId/stepIdへ変更を波及させない。入力検証・HandlerのWAITING/COMPLETED判定・記録の保存形式は変更しない。
- コピー範囲は現行Schemaに限定する。将来TraceEntryや診断へ任意のネスト値を追加する場合は、Schemaとコピー境界を合わせて検討する。Job/Checkインスタンスや例外causeを無条件に複製しない。
- 対象外として、構築時のStep参照とCSequenceBool入力配列の共有は残る（後続実行へ影響し得る別課題）。Ticket型外入力ValidationはP2-4。Ticket Repository、Workflow Definition、GUI Runtime、Ticket完了調整、JSON/SQLite Adapter、Migrationは変更しない。

`tests/reference-independence.test.cjs`でsave元・load結果・配列要素・failure・Monitor・runId間・snapshotを保持/変更するStore・submit/describeのrecord/valuesを検証する。FALSE→FALSE→TRUE→ENDや既存例外・並行実行の契約も維持する。
