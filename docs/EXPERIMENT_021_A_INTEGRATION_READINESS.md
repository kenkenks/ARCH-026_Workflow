# 実験021-A：Workflow Unit統合設計・実施可否

2026-11-09。両repoのGit状態・全既存ファイルhashを記録。既存892件を維持し、Core変更なしで021-Bを進める。

## 現物と範囲

ARCHの実行主体はsrc/prototype/{workflow,job-form,definition,diagnosis}.ts。src/core/engine.tsは骨格であり配布しない。Node24.16.0、TypeScript5.9.3、CommonJS／ES2022。既存Firestore Adapterはasync、所有権Docと保護保存を同じTransactionで検証する。

道場はCJSのcloud/api/server.cjsとESMのtools/target.mjsが共存。root startと配布startは異なる。現行Cloud Run入口はADC／本番相当profileをimport時に初期化するため、本実験で起動・接続しない。稼働中Cloud Runの実Node／IAM設定は未調査。配布依存の解決はNode24を使用するローカルの隔離npm環境で検証する。

参照：019-A／B、019-C2、020-A／B報告と実装。道場のJob・DAO・STORYはARCHの実行単位と異なる。既存shared/Flow.js、DAO_Business、Firestore DAO、STORYの予約・UNKNOWNはそのまま残す。

## 配布方式

採用：@arch026/workflow-unit の固定Version npm tarball。ARCHでのみ生成し、道場vendorへ配布物とSHA-256記録を置き、file:依存＋lockで固定する。道場に編集可能なCoreソースをコピーしない。node_modules内も変更しない。

Git固定依存は現在の未コミット実験成果をHEADだけで再現できないため不採用。隣接ディレクトリ参照はCloud Run buildで成立しないため不採用。公開npm登録・Git操作は行わない。

Unit範囲：
- CWorkflow、CJob、CWorkflowTask、CCheckJob、CDummyJob、CSequenceBool、Memory History Store。
- CJobForm／ProductShelf契約、Definition Validator／reconstructWorkflow、診断関数。
- 型宣言と定義Repository型。Core/typesは宣言上の参照のみでEngine実装ではない。
- 共通Emulator接続、FirestoreExperimentStore、createExecution。元Adapterの相対配置を保持して未変更byteを配布。
- 除外：SQLite、Ticket、GUI、020の業務デモ、道場固有処理。

固定Versionごとに内部ファイルmanifest、開発元TSのSHA-256、archive SHA-256を記録する。同Versionへの異内容の再配布は拒否する。SDKは既存同等の9.3.1を固定。Node24を実行条件として明示する。

## 021-Bの最小業務接続

道場cloud/workflowへApplication Adapter、既存認可方式に従うWorkflow API、Emulator限定dev Hostを追加する。最小の合成審査申請準備Workflow：入力取得→既存審査進捗reader→Check→受付準備可／要確認で終了。020の全面移植や実承認業務はしない。

業務処理は既存cloud/attendance/progress-firestore.cjs:createFirestoreProgressReaderとprogress-summary.cjsの実計算を使う。合成DAO（readById/queryEqual/readPage）を注入する。計算式・業務Job本体を複製しない。副作用を持つ会費・決済・通知Jobは接続しない。

認可は既存verifyIdToken(token,true)契約、dojo-principal.cjsのserver側Account解決、canAccessMember、active teacher確認を使う。合成Verifier／Accountを注入しても判定を省略しない。既存createAdminApiも同じdev Hostから呼び、既存APIの意味を変えない。既存Cloud Run server.cjsの認証や本番ルートは変更しない。

Workflowは専用Emulator project・namespaceへ保存し、会員／出席／会費Collectionには書かない。操作receiptも所有権guard付きTransactionで保存し、重複／競合を拒否。UNKNOWNは自動再実行しない。自動Takeover・commit瞬間Lease保証は追加しない。

## 改修と互換性

ARCH：新しいUnit専用build設定、packager、必要なpackage script、検証・報告のみ。既存Core／Adapterを変更しない。
道場：vendorアーカイブ、package／lock、Unit検証ツール、cloud/workflow、offline検証fixture／試験。target.mjsは新moduleとvendorを配布対象へ追加するだけ。既存業務APIは未変更factoryを利用し回帰検証。

Cloud Runの再現条件は、vendor archive／lockの同梱、npm ci、Node24、Unit hash検証。今回は配布ファイル閉包・隔離依存解決まで検証し、Cloud Runへの接続・実配布はしない。

## リスク・停止条件

未コミット成果由来なのでcommit固定だけを証拠にしない。source／compiled／installedのhashと一致試験が必要。package内容改変やVersion違いは起動前拒否。archive hashは改ざんの暗号署名ではなく、承認した配布物との一致確認である。

本番認証／本番DAO接続、Core変更、既存API破壊、同一性不成立、既存変更を保全できない場合は停止する。現状は依存注入と別開発入口で回避できる。

**021-B実施可：開発Host・Emulator・合成データに限定。** 本番Cloud Runルートへの有効化、実ユーザー、実承認業務は次工程で別判断する。
