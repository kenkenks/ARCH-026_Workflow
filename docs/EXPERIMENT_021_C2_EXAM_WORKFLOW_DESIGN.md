# 実験021-C2：審査業務現物・接続設計の停止判断

2026-11-09。設計は未確定。既存業務の置換・新実装は実施しない。repoのソース・Schema・試験・設計資料を読み、データベースや実サービスは参照していない。

## 現物調査

| 処理 | 確認した実装／資料 | 画面・API・Job・DAO・Schema／入出力・状態・権限・履歴 |
| --- | --- | --- |
| 審査進捗取得 | cloud/attendance/progress-firestore.cjs:createFirestoreProgressReader、progress-summary.cjs、member-state.cjs | 既存WebConnect attendance_progress_summary等。memberIdから会員・出席・ranks・examination_standardsを読取り、training_count／required_training_count／examination_ready等を返す。既存admin/teacher/本人scope。読取処理であり申請・承認履歴ではない |
| 審査基準 | gas/04_ExaminationStandard.js、gas/DAO_Business_Examination.js:daoExaminationEnsureMaster_、schema/ExaminationStandard.yml | マスタ準備・取得。Firestore examination_standards／GAS審査基準マスタ。級段位・回数・日数等。申請のDAOや状態遷移ではない |
| 審査管理画面 | docs/prototypes/examination/審査管理_操作プロトタイプ.html | 明示的な画面試作・保存なし。架空データの候補者／受験登録表示をページ内で変更。再読込で戻る。申請API・権限保証・永続履歴なし |
| 審査申請 | 実装された専用API／Job／DAO／保存Schemaを確認できない | docs/Architecture/審査管理_業務仕様整理_20261019.mdは構想・実装前。先生が対象者を登録する方針。会員が申請する契約は未確定 |
| 申請内容確認 | 実業務の専用入口を確認できない | 画面試作の「確認」は詳細モーダル。サーバーの確認済み状態・操作履歴ではない |
| 先生承認 | 既存申請に対する承認Commandを確認できない | 既存active teacher/Principalの権限基盤は再利用候補。承認状態・入力・履歴・副作用は未確定 |
| 差し戻し・再申請 | API／Job／DAO／Schemaを確認できない | 差し戻し理由、変更可能項目、再確認条件、操作履歴は未確定 |
| 審査実施確認 | 業務仕様整理の構想 | 保留審査レコードを扱う方向。専用保存Commandは確認できない |
| 合否結果登録 | 業務仕様整理の構想 | 級の審査日と段の允可日、会員級段位・起算日・履歴の整合が必要。結果確定処理は確認できない。既存会員更新を結果確定として代用しない |
| 合格通知 | 専用実装を確認できない | 資料には結果通知後の正式日付登録という記述。自動通知・その副作用契約は未確定 |
| 申請取り下げ | 専用実装を確認できない | 権限・状態・費用取消等は未確定 |

確認範囲はcloud／shared／gas／schema、関連docs・試験。存在しないことを全外部システムに一般化せず、現リポジトリで確認できないと判定した。会費・出席・会員の一般機能を審査申請機能と見なさない。

021-Bのcloud/workflow/application.cjsは合成「申請準備入力→既存進捗→Check→READY/要確認」で、申請・承認業務を実装したものではない。ARCHの020デモも実業務仕様の根拠にはしない。

## 固定Unitの待機契約

src/prototype/workflow.tsのRunSnapshotはRUNNING／COMPLETED／FAILED／LIMIT_REACHED。保存済み再開のdiagnosis.tsはLIMIT_REACHEDの確定境界をRESUMABLE_CANDIDATEとする。既存Firestore composition.cjs:createExecution(resume:true)も同じ診断契約を用いる。

ARCH demo/exam-application/application.cjsはLIMIT_REACHEDで1工程ずつ停止し、gatesから人間操作待ちを表示する。これは今回禁止された「LIMIT_REACHEDを承認待ちの代用」に該当するため、そのまま移植しない。

Promiseを保留すれば一時的にRUNNINGで人の入力を待てるが、それだけで別プロセス復元・安全な再開・Lease切離しを保証できない。新たなWAITINGラベルを道場側で付けるだけでも、Unitに待機・再開契約を追加したことにはならない。

**現在の固定版契約で今回要求する永続化された通常待機を実現できるとは確認できない。** Core改変・独自実行ループ・LIMIT_REACHED流用は行わず停止する。Application側の明示的な業務WAITINGとUnit確定境界を分離する案は考察候補だが、今回の禁止条件に適合するか設計判断が必要。

## 接続可能部分と未確定定義

既存進捗reader、CJobForm/CJob、Check、Firestore所有権付き保存、Principal解決は再利用できる。既存業務として確定していない承認・差し戻し等を正式なJobFormへ追加しない。

| 候補JobForm／Check | 既存処理 | 今回の判定 |
| --- | --- | --- |
| 審査進捗読取JobForm | createFirestoreProgressReader | 021-Bで実証済み、維持 |
| 申請受付／内容確認JobForm | 入口未確認 | 実装対象外・仕様判断待ち |
| 承認／差し戻しCheck | 業務Command未確認 | 判定入力・保存確定境界未定。Mockで実接続と主張しない |
| 再申請／実施確認／結果登録JobForm | 入口未確認 | 実装対象外・仕様判断待ち |

申請→確認→承認Check→承認なら実施確認→結果登録、差し戻しなら再申請→再確認、という図は要求候補であり、既存道場業務の確定定義ではない。今回はそのDefinitionを登録していない。

## 確定前に必要な判断

1. 先生による対象者登録と、会員からの申請をどう区別するか。
2. 合成デモに限る承認・差し戻し・再申請の入力、操作権限、履歴を正式業務と分離して承認するか。
3. 固定UnitのLIMIT_REACHEDとは別の業務待機をApplication層で保持する方式を許可するか。許可しない場合はARCHでの待機・再開契約の別実験が先行する。
4. 結果登録の正式日付・級段位更新・費用・通知・取消の業務整合。これらは今回実装しない。

将来実装でも専用Emulator namespaceを使用し、会員／出席／会費／既存審査進捗を変更しない。権限は既存verifyIdToken(token,true)、サーバーAccount、active teacher、本人scopeで判定する。操作ID・期待Revision・owner guardを同一Transactionで照合し、操作履歴とWorkflow履歴を分ける設計が必要。ただし未実装・未検証の保証を完成扱いにしない。

**C2は現物調査まで完了、接続設計は判断待ち。C3実装には進まない。**
