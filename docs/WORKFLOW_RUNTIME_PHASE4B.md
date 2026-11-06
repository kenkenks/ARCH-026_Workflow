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
