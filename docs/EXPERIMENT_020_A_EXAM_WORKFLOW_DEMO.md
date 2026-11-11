# 実験020-A：審査申請Workflow・ブラウザ操作デモ

## 1. 結果

2026-11-09、明示選択のMemory方式で、実際のCWorkflow／CJob／CJobForm／CCheckJobを使うローカルブラウザデモを実装した。

- 申請開始 → 先生承認 → 審査実施確認 → 結果登録 → COMPLETEDを実測。
- 差し戻し → 申請内容確認 → 再申請 → 先生承認待ちの後方遷移を実測。複数回の繰返し履歴を維持。
- 正常な業務結果PASS／FAILの両方が、正常な最終成果物になることを確認。
- 同じ操作IDの再送で、Job／Trace／公開成果物が増えないことを確認。同時操作の敗者は409で副作用なし。
- 実Chromeで画面ボタンからHTTP APIを経由し、別途GETしたサーバー状態・Job ID・Check結果・履歴を突合した。

両Core、道場側コード、既存SQLite／Firestore Adapterを変更していない。ステージ・Commit・Push・Deployは行っていない。

## 2. 019-Dからの採用・差分

019-Dの独立Node HTTP＋静的HTML、入力条件と確定境界の分離、明示操作ID、Fake認可、既存Prototype利用を採用した。

今回の指示はブラウザデモを第一目標とし、Memoryの明示選択も許可しているため、020-AではMemoryに限定した。Firestoreの操作入力永続化や分散所有権を新実装していない。Emulatorへの暗黙接続・実Firestoreへのfallbackはない。既存019-C2の21試験だけは回帰のため専用Emulatorで実行した。

019-Dでは再申請ループを対象外としていたが、今回の明示要件を優先し、Definition Version 2として後方遷移を追加した。019-Dの提案Version 1や既存の保存Schema／文書を上書きしない。

## 3. 実装構造と既存API

```text
Browser（日本語HTML / app.js / CSS）
 → tools/exam-application-demo.cjs（node:http、Origin、本文検証、Fake資格）
 → demo/exam-application/application.cjs（操作受付、排他、履歴、入力条件）
 → reconstructWorkflow(definition, registry, CMemoryHistoryStore, continuation)
 → CWorkflow.run(..., 1) / CWorkflow.resume(saved, 1)
 → 新しいCJob + 再利用可能なJobForm定義 / CCheckJob
 → 実行別Memory ProductShelf、既存Core履歴
```

既存API：

- src/prototype/definition.ts：validatePrototypeDefinition、reconstructWorkflow、jobForms.definitions、同期onCreate。
- src/prototype/workflow.ts：CWorkflow、CJob、CCheckJob、CMemoryHistoryStore。
- src/prototype/job-form.ts：createMemoryProductShelf、既存CMRP契約。
- gui/http-input.js：readBody（64KiB、Content-Type、fatal UTF-8、JSON root）。既存GUI用validateRequestは使用しない。

src/core/WorkflowEngineの骨格や別のgui/WorkflowRuntimeは実行主体にしない。既存gui/server.jsをrequireせず、既存GUIデータも生成しない。

## 4. Workflow定義・分岐・反復

固定定義：demo/exam-application/definition.json。

- schemaVersion：prototype-workflow/1
- definitionId：demo-exam-application
- definitionVersion：2

| Step | Job／Check | 遷移 |
|---|---|---|
| 10 | 申請受付Job | 20 |
| 20 | 先生判断を記録するJob | 30 |
| 30 | teacher.approved Check | TRUE→40、FALSE→90 |
| 40 | 審査実施確認Job | 50 |
| 50 | 結果登録Job | 60 |
| 60 | 最終概要Job | next省略でEND |
| 90 | 申請内容確認案内Job | 95 |
| 95 | 再申請Job | 20へ後方遷移 |

Checkは公開teacherDecisionを読み、APPROVEをTRUE、RETURNをFALSEとする。それ以外や欠落を差し戻しとみなさず技術的不整合として扱う。

再申請後も同じrunIdで既存CWorkflow.resumeを使用する。reconstructWorkflowのcontinuation.historyから訪問回数が継続し、各訪問で新しいCJobとUUIDを作る。完了済みJobを再使用しない。

一回の操作で自動実行するslice数は最大4、累積履歴は100を上限とする。新しい操作に必要な余裕がない場合、受付前に409 EXECUTION_LIMITで停止する。Coreの実行制限を勝手に変更せず、既存のslice上限とデモ全体の上限を別管理する。

## 5. JobForm・CMRP

job-forms.cjsのwork定義は実行固有の可変状態を保持しない。createFormsは当該操作の独立contextを結び付け、Jobごとのcollect／makeを提供する。

| 工程 | 入力 | 公開キー |
|---|---|---|
| 申請受付 | 合成member／grade、サーバーの申請ID・日時 | application |
| 先生判断 | application＋当該操作入力 | teacherDecision |
| 審査実施確認 | 承認結果＋実在暦日の入力 | examConfirmation |
| 結果登録 | 審査実施確認＋PASS／FAIL・0〜100の有限score | examResult |
| 最終概要 | examResult | applicationOutcome |
| 確認案内 | RETURNのteacherDecision | review |
| 再申請 | application＋修正grade・note | application（最新値） |

実行順序は既存CJobのcollect→make→record→postである。recordはnative CJob内部へ独立した成果物を確定し、postは実行別shelf.putへ渡す。個別のrecord callbackやprepare／cleanupは追加していない。

onCreateでJob ID・Step・iterationを観測し、実行終了時にnative getStateを記録する。postではgetRecordedを読み、内部成果と公開値をJob ID付きで観測する。これはMemory内の実行観測であり、019-C2の永続Job Storeと同じ保証ではない。

## 6. 人の操作待ちとWorkflow状態

CoreにWAITINGを追加していない。LIMIT_REACHEDは一工程sliceを確定した技術境界であり、業務状態ではない。

Applicationの入力条件：

- next=20：APPROVE／RETURNの入力が必要。
- next=40：CONFIRM_EXAMの入力が必要。
- next=50：REGISTER_RESULTの入力が必要。
- next=95：RESUBMITの入力が必要。

入力がなければ次のJobを呼ばない。人待ちの間にRUNNINGのPromiseを保持し続けず、HTTP要求を終了する。次Stepは保存済みsnapshot.currentStepNoを読むだけで、Application層で分岐先を設定しない。

画面はCoreのworkflowStatusと、現在工程・人の入力条件・処理中／要確認を分ける。差し戻し中はCOMPLETEDではなく、Step95の確定境界と再申請待ちになる。

## 7. HTTP API

すべてローカルデモ専用。既定listenは127.0.0.1:3020。

| API | 処理 |
|---|---|
| GET / | 固定画面 |
| GET /app.js、/style.css | 固定ファイルのみ。任意ファイル配信なし |
| GET /api/demo/config | mode、bootSessionId、合成catalog、消失条件 |
| POST /api/demo/applications | commandId、bootSessionId、memberId、gradeで開始 |
| GET /api/demo/applications/:id | サーバーの申請・進捗・履歴・Job・成果物・許可操作 |
| POST /api/demo/applications/:id/commands | 承認／差し戻し／再申請／審査確認／結果登録 |
| GET /api/demo/applications/:id/history | 操作履歴とWorkflow履歴を別配列で取得 |
| GET /api/demo/applications/:id/commands/:commandId | 操作結果の照会のみ |
| GET /api/demo/commands/:commandId | STARTの応答喪失時、同じ合成actorの開始操作を照会 |

更新入力はcommandId（UUID v4）、bootSessionId、expectedRevision、expectedStepNo、kind、payload。新規APIのroot・既知項目・型を検証する。

kind：APPROVE、RETURN、RESUBMIT、CONFIRM_EXAM、REGISTER_RESULT。RETURNにはreason、再申請にはgrade／note、審査確認にはexamDate、結果にはresult／scoreが必要。合成memberはT001〜T003、gradeは表示上も合成と明示する。

Fake Bearer資格：demo-applicant、demo-teacher、demo-admin。資格をサーバーでAPPLICANT／TEACHER／ADMINへ解決する。申請者は開始・自分の申請・再申請、先生は判断・審査確認・結果登録、管理者はデモ内の全操作を行える。ブラウザが送るroleやstatusを信用しない。固定資格は本番認証ではなく、誰でも選べるデモ機能である。

Host／Originは実listen先と一致させ、Browser POSTでOriginなしも拒否する。Cookie認証・CORS wildcardは使用しない。400入力、401資格、403権限／Origin、404不存在、409状態／revision／競合、413上限、415Content-Type、503結果不明／Workflow失敗、500内部障害を区別する。raw例外・内部パス・stackを返さない。

## 8. 操作記録・重複・並行制御

ユーザー操作履歴とCoreのTraceEntryは別である。

操作履歴には、操作ID・申請ID・actor・kind・日時・遷移前Step／表示・遷移後Step／表示・ACCEPTED／APPLIED／FAILED／UNKNOWN・結果を記録する。Core TraceEntryは変更しない。

- STARTの申請IDはactorとcommandIdから安定導出し、再送で新しいrunを生成しない。
- commandId、actor、入力全体が同じ再送は既存結果を返し、Workflowを呼ばない。
- 同じIDで入力が違う場合は409 COMMAND_CONFLICT。
- 新しいIDでも期待revision／Step／操作種別を照合し、現在状態に適合しなければ受付・保存前に拒否する。
- applicationごとの実行中ガードを最初のawait前に取得し、拒否した要求ではHandler／Job／履歴／状態を変更しない。
- 異なる申請は独立して並行実行できる。
- 画面の送信中ガードも併用するが、Server排他の代用にしない。

結果不明はUNKNOWNとして申請をblockし、自動再実行・自動再送をしない。GETは観測のみ。FAILED／RUNNINGからの無理な再開も行わない。HTTP timeout後は操作IDを保持して照会する。START応答喪失でも照会できる専用入口を設けた。

## 9. 画面と実ブラウザ確認

画面は日本語で、申請情報・進捗・業務待ち・Core状態・操作ボタン・ユーザー操作履歴・折りたたみCore履歴を表示する。選択したFakeユーザー、申請ID、未確認操作IDはsessionStorageに保持するが、状態の正本にはしない。

再読込ではサーバーへGETし、保存済み審査日・結果・score・履歴に表示を揃える。既知の操作がAPPLIEDなら読戻し確認だけを行い、Jobは再実行しない。合成ユーザー選択も保持し、認可拒否をデータ消失と混同しない。

利用不能な内蔵browser／computer-use toolは共通のkernel assetsエラーだったため、インストール済みChromeを専用一時profile、headless、NodeのWebSocket／CDPで操作した。新しいBrowser依存packageは追加していない。既存EdgeはCDP起動前に終了したため、Chromeを既定候補とした。

実Chrome Version：156.0.8078.80。

| 確認 | 実測 |
|---|---|
| B01 | Browserボタンで申請開始、HTTP状態にnative Job／Traceが存在 |
| B02 | 差し戻し・再申請を2回、FALSE履歴と後方遷移を維持 |
| B03 | 承認TRUE→審査確認→FAIL／45点の正常成果物→END |
| B04 | 再読込後に同じJob ID・履歴・8操作を表示。結果入力欄もFAIL／45点 |
| B05 | 別申請をPASS／85点で完了。履歴・入力が独立 |
| B06 | 390px mobile viewportで文書横overflowなし。履歴表は横scroll |
| B07 | Memory Hostを作り直し、画面が旧データ不存在をGETで確認。新規開始のみ明示操作 |

[CDP Runtime](https://chromedevtools.github.io/devtools-protocol/tot/Runtime/)／[Page](https://chromedevtools.github.io/devtools-protocol/tot/Page/)を使用。HTMLを読むだけの試験や、画面状態の直接代入で進行させた試験ではない。DOMボタンclickから既存app.jsのfetchを通し、サーバーGETと突合している。

確認画像（Git管理外）：runtime-data/experiment020-desktop.png、runtime-data/experiment020-mobile.png。描画を確認し、モバイルの表・フォーム折返しも調整した。

## 10. 永続化・保証範囲

今回の実装はMemoryのみ。起動時に--storage=memoryが必要で、未指定、emulator、firestore等は拒否する。

- プロセス終了で申請・操作履歴・Core履歴・成果物は失われる。
- Host再起動後の復元を保証しない。
- FirestoreのLease／Fencing／複数Host所有権保証はない。
- Browser refreshは同じ生存Hostから再取得できる。Host再起動とは別。
- bootSessionIdが変わった旧要求は409。古い状態を新しい実行へ混入させない。
- 画面・起動consoleに上記を常時明示する。

Emulatorの更新保護を省略してFirestoreへ保存する代替は作っていない。実サービス・実通知・実決済・実DAO・実会員データを利用しない。

## 11. 起動・停止・操作手順

```powershell
npm run demo:exam -- --storage=memory
```

起動URL： http://127.0.0.1:3020 。--port=別番号も指定できる。起動時はBuild後、URL／Memory／Emulatorなし／消失条件／Ctrl+Cを表示する。実際のpackage scriptを起動し、config APIの200・memory応答も確認した。

操作例：

1. 申請者を選び、合成会員・級を指定して「申請開始」。
2. 先生へ切り替え「差し戻し」、理由を入力する。
3. 申請者へ戻り、級・補足を確認し「再申請」。必要なら繰り返す。
4. 先生で「承認」→「審査実施確認」→「結果登録」。
5. 「履歴更新」、内部履歴を開きTRUE／FALSE・工程順序を確認する。

デモ管理者なら同じ資格で全操作を試せる。これは実権限の証明ではない。

停止はCtrl+C。Serverのclose()は新規受付を止め、受付済み操作をdrainし、HTTP接続を閉じる。Windowsの試験runnerからもclose()を呼べる。正常終了後もMemoryのデータは復元できない。今回起動したHTTP3020と回帰用Emulator8692は終了後の停止を確認した。

## 12. 試験結果

| 集合 | 結果 |
|---|---|
| npm test（既存） | 529 PASS／0 FAIL |
| 実験009〜019-B（既存、file並列度1） | 291 PASS／0 FAIL |
| 実験019-C2 Emulator（既存） | 21 PASS／0 FAIL／skip 0 |
| 既存合計 | **841 PASS／0 FAIL** |
| 新規HTTP／Application | **27 PASS／0 FAIL** |
| 自動試験合計 | **868 PASS／0 FAIL** |
| 実Chrome操作確認（別集計） | **7 PASS／0 FAIL** |
| Build／noEmit型検査 | PASS |
| 新規JS 6ファイルの構文検査 | PASS |
| git diff --check | PASS（既存改行変換警告のみ） |

新規試験の根拠：tests/exam-application-demo.test.cjs。

- D01〜D06：開始、承認、差し戻し、再申請、複数回反復、PASS／FAIL、実Job ID・Check・Core履歴。
- D07〜D11：START再送、承認再送、内容競合、古い状態、同一申請の決定的並行要求、別申請独立実行。
- D12〜D17：Fake認可、入力拒否、HTTP本文、状態再取得、Memory新Hostで消失、明示modeとSDK非読込。
- D18〜D22：適用後例外のUNKNOWN、内部情報非公開、拒否後正常復帰、固定静的配信、native make例外でFAILED／ERROR。
- D23〜D26：反復総量制限、受付済み操作drain、旧boot拒否、申請者／先生の正規分担。

D06はPASSとFAILの2ケースであるため、D01〜D26で27試験となる。ブラウザの7確認はNode test件数へ水増しせず別集計した。

```powershell
npm run test:exam-demo
npm run test:exam-browser
npm test
```

追加の既存291件とEmulator21件の実行コマンドは019-C2／019-D報告書と同じ。新規Browser試験はChrome／Edgeの既存実行ファイルが必要で、なければ未実行PASSではなく失敗する。ARCH026_BROWSER_EXEで明示指定できる。テスト専用profileだけを作成・後処理し、利用者の既存profileを操作しない。

## 13. 変更ファイル

新規10ファイル：

1. demo/exam-application/definition.json
2. demo/exam-application/job-forms.cjs
3. demo/exam-application/application.cjs
4. demo/exam-application/index.html
5. demo/exam-application/app.js
6. demo/exam-application/style.css
7. tools/exam-application-demo.cjs
8. tests/exam-application-demo.test.cjs
9. tests/exam-application-browser.cjs
10. docs/EXPERIMENT_020_A_EXAM_WORKFLOW_DEMO.md

既存変更：package.jsonへdemo:exam、test:exam-demo、test:exam-browserの3 scriptを追加。依存追加、lockfile更新、tsconfig変更はない。package.jsonの既存未コミット変更は維持する。

## 14. 未対応・020-Bへの引継ぎ

- Firestore Emulatorへの申請・入力記録の永続化、所有権とcommand受付の同一Transaction化は未実装。019-DのFirestore案をMemoryの保証に置き換えたとはいわない。
- 不明状態からの自動復旧、永続command台帳、複数プロセス排他、Lease・Takeover管理UIはない。
- 起案者・先生の本番認証／実認可、既存Ticketとの統合、道場の既存画面・業務API接続は対象外。
- 再申請時は合成grade・補足を修正できるが、実業務の申請Schemaや承認条件ではない。
- UNKNOWNは安全に止める最小構成。Memory消失後に旧操作を追跡・復元することはできない。
- 新規Job／成果物はMemory観測であり、永続的な監査証跡として利用しない。

020-Bでは、今回のDefinition／JobForm／HTTP契約を維持してEmulator用command Storeを追加する範囲と、結果不明の照合手順を先にレビューする。自動Takeoverや実データ導入へは進まない。

## 15. Git状態・終了

開始時の既存状態を記録して作業した。最終hash照合結果を追記する。今回の成果をステージせず、Commit・Push・Deployしない。実験020-Bには着手せず停止する。

最終保全照合：着手時のARCH 163ファイル中、package.json以外の162ファイルはSHA-256一致。package.jsonも今回追加した3 scriptを除いた内容が開始時のSHA-256と一致し、既存変更を保持している。道場側917ファイルはすべてSHA-256一致、Git状態も一致。今回追加は上記10件のみ。ステージ済みファイルなし。起動したHTTP3020／Emulator8692は停止確認済み。
