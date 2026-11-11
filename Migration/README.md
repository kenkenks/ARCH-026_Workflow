# Migration進捗管理 MVP

Framework開発用の管理Tool。RuntimeのMigration Unitとは別であり、自動コピー・上書き・DB操作はしない。旧道場は読取り専用。既存Frameworkファイル、ルートpackage.jsonは変更しない。

## コマンド

このディレクトリで実行する。外部依存のインストールは不要。Node24を対象とする。

```
npm test
npm run migration:scan
npm run migration:status
npm run migration:verify
npm run migration:report
```

scan/statusは読取り専用。reportは`reports/status.md`だけ生成する。verifyは固定allowlistのローカル試験だけ実行し、`reports/latest.json`へ結果・入力SHA・件数・Node版・出力を記録する。全関連試験が成功した資産の`destinationVerifiedSha256`だけをRegistryへ明示更新する。ハッシュが同じならRegistryを書き直さない。結果の日時はRegistryに入れない。

## Registry

`registry.json`はschemaVersion 1。repositoriesはFrameworkルートからの兄弟リポジトリ相対パス、source/destination/inputs/testsは各ルートからの相対パス。絶対パス、traversal、symlink/junctionを拒否する。ソース基準SHAは今回登録時の現物から取得しており、過去のコピー時点を推測したものではない。

- assets: ID、コピー元repo/path、先path、所有Unit、元基準SHA、先検証済みSHA、関連検証ID、調査判断、保留/対象外理由、明示承認。
- verifications: 固定kind `node-test`、永続試験、期待件数、試験ファイル、入力ファイル/ディレクトリ。
- discoveryRoots: 未登録候補を検出する範囲。現在は登録UnitのsrcとMember/schema。全リポジトリを調査済みとは扱わない。

意図的なimport修正があるため、元と先のハッシュ一致は要求しない。元の更新検知と先の検証失効を別に扱う。

## 自動状態と承認

NEW: 先なし・未調査。ANALYZED: 調査判断あり・先なし。COPIED: 先あり・現在有効な検証なし。VERIFIED: 先SHAと、全関連試験・依存入力・実行器・Node版の証跡が現在一致。COMPLETE: VERIFIEDに加え、同じ内容と検証範囲への明示承認あり。

ACTIVE/DEFERRED/EXCLUDEDは判断上の分類で、進捗とは別。SOURCE_CHANGED/MISSING、DESTINATION_CHANGED/MISSING、TEST_MISSING/FAILED、VERIFICATION_STALEを警告として併記する。ファイルの追加・欠落、依存/試験の変更でも検証を失効させる。

skipはCOMPLETE、ACTIVE、警告ゼロの時だけtrue。source変更で承認記録を消さないがskip=falseとする。依存・試験変更後は再検証しても旧承認はその範囲に一致せず、再承認が必要。

承認は自動実行しない。担当者がレポート、差分、検証範囲をレビュー後、対象assetのapprovalを明示編集する。

```
{
  "approved": true,
  "destinationSha256": "scan出力のdestinationHash",
  "verificationFingerprint": "scan出力のapprovalVerificationFingerprint"
}
```

この編集だけで検証未実施をCOMPLETEへ昇格できない。承認の認証・電子署名・権限管理はMVP対象外。検証証跡とRegistryは信頼されたローカル作業者が管理する前提であり、改ざん耐性は保証しない。

## 試験と保証範囲

既存DB Builder 7件を変更せず利用する。過去の一時試験は実行済み証拠として取り込まず、Core 3件、Member 3件、TimeTrip 4件を`tests/assets/`へ永続化して今回実行する。モデルの試験はMember.ymlを検証しないため、そのassetは検証IDなし・COPY済みのまま。既存17件は全面的な意味・全関数網羅を保証するものではない。

verifyはshell/npmを呼ばず、allowlistのNode試験だけ実行する。期待件数・PASS数一致、失敗/skipなし、実行前後の入力指紋一致を要求する。空試験ファイルがnode:testのファイル単位PASSとして扱われる問題を避け、既存allowlistで使用する明示test宣言も確認する。

network-guardはHTTP/HTTPS、net/tls、DNS、fetch、WebSocket、子プロセス、Workerの通常入口を遮断し、資格情報・接続設定等を子環境から除去する。これはレビュー済みローカル試験の防御補助であり、悪意のあるコードに対するOS隔離ではない。新規コマンドは登録するだけでは実行できず、allowlistのコードレビューが必要。

依存追跡は宣言inputsの再帰ハッシュと実行器、試験、Node版に限定する。動的依存・OS/ICU差・宣言外の環境やパッケージを自動解析した保証はない。Member/TimeTripでは導入済みCoreと元Coreを両方追跡し、試験でも必要ファイルの一致を照合する。Core変更時の自動再導入はしない。

## 今回の検証記録

初回の管理試験は追加テストの括弧誤記で起動失敗した。修正後、実verifier試験の追加で、親node:testのNODE_TEST_*環境継承により子出力が内部プロトコルになる問題を検出し、その環境変数を子から除去した。また空ファイルのPASS誤認を検出して拒否条件を追加した。いずれも新規管理Tool内の修正で、既存資産の試験は変更していない。

通常sandboxではjunction試験をOS権限で1件skipした。後続の許可された一時領域での実行ではjunction拒否も実測し、最終結果は管理26件PASS/0 FAIL/0 SKIP、資産17件PASS/0 FAIL。完了承認は全10件falseのまま。

将来課題: 依存自動解析、検証失敗の履歴蓄積、承認操作支援、署名、登録対象範囲の拡大、Member Schema専用検証。今回、自動承認・コピー・上書き機能は追加していない。

## Framework再構築進捗（2026-11-10 最終確認）

既存の進捗管理資料に今回の統合結果を追記する。上記26件／17件／10資産はMVP構築時の過去記録であり、以下の直近結果とは区別する。全体進捗率の算出基準は定義されていないため、パーセンテージは設定しない。

| 対象 | 今回の完了状況 | 根拠・境界 |
|---|---|---|
| Workflow Unit | 正式配備完了 | Frwk_Units/Workflowに正本・公開入口・単独ビルド・試験を配置 |
| CJobForm | 継承可能な基底クラス化完了 | prepare → collect → make → record → post → cleanupの6工程。旧CJob互換契約を維持 |
| CWorkflow | Unit側の正本化完了 | Prototype入口はUnit実装の再公開。順序・Check分岐・循環・WAITING・履歴を維持 |
| Check | Workflow Unitへ配備完了 | 同一クラスを公開し、独立した重複実装は追加しない |
| TimeTrip | CJobForm継承による正式統合完了 | 設定・記録はJob、日時取得はJobの実行状態と独立 |
| TimeTripCore | 改名完了 | 旧TimeTravel.jsと内容のSHA-256一致。移植元は旧道場shared/TimeTravel.jsを維持 |
| Framework公開サブパス | 既存契約維持 | /timeの参照先だけ変更。既存Applicationの3 APIを維持 |
| Migration | 24件登録・23件VERIFIED・1件未検証 | 未検証はMember Schema。COMPLETE承認は全24件false、skip対象0件 |
| 既存道場システム | 変更なし | Framework側だけの統合。元ファイル・実サービスは変更しない |

### 直近の検証結果

2026-11-10 16:49 JSTのコミット前確認で再実行した結果。過去の合計件数を流用せず、今回のコマンド出力とMigration/reports/latest.jsonに基づく。

| 検証 | 結果 |
|---|---|
| TimeTrip Unit（既存Application API回帰を含む） | 17 PASS / 0 FAIL / 0 SKIP |
| Workflow Unit | 20 PASS / 0 FAIL / 0 SKIP |
| Migration再検証 | 50 PASS（DB 7・Core 3・Member 3・TimeTrip 17・Workflow 20）/ 0 FAIL / 0 SKIP |
| Build | PASS（ルート・Workflow Unit） |
| 型検査 | PASS（Prototype・Workflow Unit、noEmit） |
| JS構文検査 | PASS |

TimeTrip／Workflow試験はMigration再検証にも含まれるため、上表の件数を独立した総試験数として加算しない。VERIFIEDはファイルと検証証跡の一致を表し、Unit統合完了や人間によるCOMPLETE承認とは別の判定とする。

### 統合完了とは分けて管理する残作業

| 残課題 | 状態・次の確認 |
|---|---|
| Member Schemaの検証 | 未対応。専用の永続試験が必要 |
| Framework公開API・Wrapper契約の整理 | 残作業。既存公開契約を保ったうえで整理する |
| Unit間依存関係の確認 | 残作業。必要依存・独立配布・クラス同一性の範囲を確認する |
| TimeTrip設定保存の非Transaction問題 | 既存制限。途中失敗時の部分保存・競合書込を今回解消済みとは扱わない |
| 対象月の厳密な妥当性検証 | 仕様判断待ち。既存の形式検証を独断で狭めない |

上記残課題を理由に、今回のWorkflow／TimeTrip正式統合そのものを未完へ戻さない。一方、Migrationの完了承認を自動付与しない。

## Framework公開API・Wrapper契約（2026-11-10 整理）

以下は現在の公開入口。Unit内部のファイル名ではなく、利用先はパッケージ名／公開サブパスを選ぶ。内部関数やprivate状態を公開するための新しいWrapperクラスは追加しない。

| Unit | 公開入口 | 公開機能・契約 |
|---|---|---|
| Core | @arch026/core/flow | runSteps(iterator)。同期結果は同期値、非同期処理を含む場合はPromise |
| Core | @arch026/core/storage-id | normalizeStorageId、byteLength。root入口は未定義であり追加しない |
| Workflow | @arch026/workflow | CJobForm、CWorkflow、CWorkflowMonitor、CMemoryHistoryStore、CWorkflowTask、CJob、CDummyJob、CCheckJob、CSequenceBool、WorkflowValidationError、WorkflowRunError。createExecutionContext／getExecutionState／getRecorded／getCleanupWarning／createMemoryProductShelf。履歴・Port・実行コンテキスト等の型も公開 |
| Workflow | @arch026/workflow/check | CCheckJob、CSequenceBool、IBool。同じクラスを再公開。CJobは互換用途、executeLegacyFormはroot公開対象外 |
| TimeTrip | @arch026/timetrip | createApplication(dao, dependencies)。戻り値のgetSystemContext／getTimeTravel／saveTimeTravelという既存3 APIを維持 |
| TimeTrip | @arch026/timetrip/job | TimeTrip。既存Job兼日時取得Wrapper。now／today／targetMonthはJob実行状態と独立 |
| TimeTrip | @arch026/timetrip/time | now／today／targetMonth／getSetting／getSystemContext／getAdminSetting／saveAdminSetting／format。既存の公開済み関数群。TimeTripCoreという実装ファイル名を直接参照しない |
| TimeTrip | @arch026/timetrip/context | createSystemContext／reloadSettings／settingNames。公開済みだが低水準の構成用入口。削除・非公開化しない |
| DB Builder | @arch026/db-builder/definition | parsePortableDefinition／validatePortableDefinition／transformPortableDefinition（ESM） |
| DB Builder | @arch026/db-builder/builder | buildPortableDataDefinition（ESM）。ファイル生成を伴う開発用機能であり、読取専用関数ではない |
| DB Builder | @arch026/db-builder/firestore | renderFirestoreSchema／renderFirestoreDocuments／verifyFirestoreDocuments／restoreFirestoreRecord（CommonJS）。Firestore SDKへの接続ではなくローカル投影・検証 |
| Member | @arch026/member | normalizeMemberId／memberObject。現状の最小オブジェクト契約であり、Member.ymlや会員業務全体の保証ではない |

DB Builderには従来exportsがなく、rootの実装入口もなかった。今回、既存3モジュールへ公開サブパスを追加した。既存の深部ファイル参照を急に拒否しないため、ワイルドカードの互換経路とRendererの拡張子なし参照を維持する。これは深部パスを将来の推奨APIにする意味ではない。DB Builderの内部アクセスを技術的に全面禁止する変更は今回行わない。他の4 Unitのexportsは変更していない。

### Wrapper相当の配置と日時利用の標準形

Wrapper相当の実装は既存TimeTripクラスの日時メソッドとTimeApplicationCoreのcreateApplicationである。Coreは関数、Memberはオブジェクト変換関数、DB Builderは既存モジュール、Workflowは実行機構自体が公開契約であり、形式を揃えるためのWrapperは作らない。

アプリケーションのCompositionでTimeTripを構築し、他Unitへ必要な日時メソッドを持つオブジェクトとして注入する。他UnitがTimeTripのsrcを参照したり、CoreがTimeTripをimportしたりする構造にはしない。

```js
const {TimeTrip}=require('@arch026/timetrip/job');
const dateSource=new TimeTrip(dao, undefined, {timezone:'Asia/Tokyo'});
const current=await dateSource.now();
const day=await dateSource.today();
const month=await dateSource.targetMonth();
// 日時取得だけならexecuteは呼ばない。executeは取得元の設定・記録を行う。
```

同期DAOでは同期値、非同期DAOではPromiseという既存契約を維持する。共通利用側でawaitすれば両方を扱える。低水準の公開入口を使う場合は、`/context`のcreateSystemContextをawaitし、`/time`の関数へ渡す。保持したcontextは自動更新されないため、必要な時点で再読込する。saveTimeTravelのok:falseという入力検証結果と、Job実行時のINVALID_TIME_SETTINGは呼出経路が異なるため混同しない。

### Unit依存と互換境界

```
TimeTrip ──→ Core
    └─────→ Workflow
Member ────→ Core
DB Builder → Node標準ライブラリ
Workflow   → Unit内の実装のみ（実行時の他Unit依存なし）
```

CoreとWorkflowの間に依存はない。実装上の相対importは同一Unit内に留まり、Unit間は依存宣言と公開パッケージを利用する。Migration/tools/inspect-api.cjsはTypeScript ASTでsrcの静的import／export／requireを検査し、Unit・ファイルの循環、未宣言依存、他Unitの内部への相対参照、公開入口の欠落を報告する。TypeScriptは開発用検査器の依存であり、Unitの実行時依存へ追加しない。計算された動的importや生成コード・利用側アプリ全体の解析を保証するものではない。

Prototypeのworkflow／job-form互換入口とdefinition Registryは、TypeScriptソースを同じビルドへ取り込むためUnit内部への直接参照が残る。これらはUnit間実行依存とは区別した移行用ビルド境界であり、一般利用側が模倣する入口ではない。今回、自動的に別パッケージ参照へ置換しない。旧Registryの構造型CJobFormと新版の実装クラスは別の公開契約である。

旧配布生成器tools/package-workflow-unit.cjsはホワイトリストで正本のコンパイル済みモジュールと既存Adapterを収録する。@arch026/workflow-unitのroot／waiting／firestoreと、Frameworkの@arch026/workflowを同一パッケージとは扱わない。旧版のAPIや配布物は変更しない。Registryの正式Unitへの移動、永続化Wrapperの配布範囲、異なる配布物のクラス同一性は別途判断が必要。

### 今回の直近検証と進捗更新

既存Unit試験は公開入口から読み込む方式へ変更し、アサーションと期待動作は維持した。内部ファイルのSHA照合・ビルド印検証など、出自を確認する白箱試験は残す。Core 3／Workflow 20／TimeTrip 17／DB Builder 7／Member 3がPASS。公開APIからの利用と依存検査8件がPASS、Migration再検証は計58 PASS（既存50件を含む）。Migration管理29件もPASS。Build、型検査、JS構文検査を確認した。

Migrationは検査器と公開API試験を新規2資産として登録し、26件中25件VERIFIED、Member Schema 1件は未検証のまま。全件の完了承認はfalseを維持する。従来の24件／23件VERIFIEDおよび50 PASSは前節の時点の記録であり、上書きして混同しない。

公開API・Wrapper契約の基本整理と5 Unitの静的依存確認は完了。残作業は、DB深部互換経路の将来的な閉鎖判断、Prototype／Registry／旧配布Unitの境界整理、動的・利用先依存の検証、Member Schema、TimeTrip非Transaction保存と対象月の厳密検証である。これらの仕様判断を今回独断で確定しない。

## セッション終了時の現状と次回引継ぎ（2026-11-10）

この節を次回の再開入口とする。新しい進捗・引継ぎ文書は作らない。今回はコード、設定、Registry、承認、配布物を変更せず、現物調査と本資料の追記だけを行った。以下のコミット案は実施許可ではない。今回も次回も、別途指示なしにStage・Commit・Pushを行わない。

### 正本・互換入口・Registry・配布の境界

| 現在の所在 | 現在の責務と正本の扱い | 今後の整理条件 |
|---|---|---|
| Frwk_Units/Workflow/src/CJobForm.ts | 継承可能なCJobFormとCMRP 6工程の正本。実行コンテキストは定義から分離。旧CJobも共通実行処理へ委譲 | CJobの削除は未実施。既存利用箇所・型・履歴・再開・配布の互換性確認が先 |
| Frwk_Units/Workflow/src/CWorkflow.ts、Check.ts、index.ts | Workflow実行・状態・履歴・Checkの正本と公開入口 | Check.tsは再公開であり、Checkの二重実装ではない |
| src/prototype/workflow.ts、job-form.ts | 前者はUnit正本の再公開、後者は構造型CJobForm／bindJobFormの互換入口。独立したCMRPエンジンではない | 利用側の公開パッケージ参照への移行と配布の型互換性を確認してから縮小する |
| src/prototype/definition.ts | WorkflowRegistryというfactory対応表、定義Validator、reconstructWorkflow／loadWorkflowの現行正本。IDからJob／Checkを解決し、Version固定の定義を実行グラフへ再構築。JobForm登録は実行別Shelf・artifactKey・onCreateへ接続 | Workflow Unitにはまだ正式Registryとして配備していない。移設する場合は既存Registry API、永続化Port、WAIT定義Version、構造型／実装クラスの関係を先に決定 |
| src/prototype/diagnosis.ts | 保存済み実行状態の診断ロジック。Workflow履歴型・定義Validatorに依存 | 正式Unitへの所属は未確定。無条件にCoreへ移動しない |
| src/adapters/workflow-waiting、workflow-firestore、job-execution、workflow-history | Memory／Firestore／SQLiteの永続化・Lease／Fencing・診断／再開などの現行実装。UnitのPortとPrototype互換入口を利用 | 名前が似ていてもBackend・保存形式・保証範囲が異なる。統合は共通契約と契約試験を確認してから行う |
| tools/package-workflow-unit.cjs、tsconfig.workflow-unit.json、tools/workflow-unit/ | @arch026/workflow-unitのホワイトリスト配布生成器と既存waiting／firestore公開Wrapper。Prototypeの互換入口・Registry・診断・Unit正本・Adapterを収録 | 新しい実行正本ではなく、ビルド時点のコードを収める互換配布。@arch026/workflowの公開入口と同一契約とは扱わない |
| runtime-data/workflow-unit/*.tgz | 旧版を含む固定スナップショット。開発用の正本ではない | 既存版を上書きせず、SHA付きで保全。旧版の利用を終えるまでは削除しない |
| gui/workflow-runtime.js | GUI用Definition・Handler契約で動く別Runtime。正式Unitを再公開するだけの入口ではない | 動作の重複はあるが、同じ契約の二重正本とは断定しない。統一にはGUI／Ticket／HTTP／E2Eの接続設計が必要 |
| src/core/engine.ts | WorkflowEngineの未実装骨格。advance等はNOT_IMPLEMENTEDを送出 | 完成済みエンジンと扱わず、Formal UnitやFrwk_Units/Coreと混同しない。削除／統合は将来判断 |
| Migration/registry.json、src/ | 開発用資産台帳、SHA・検証範囲・承認の管理。実行用WorkflowRegistryとは別物 | Jobの登録・業務状態・実行順序を管理する場所へ拡張しない |

同一リポジトリ内でPrototypeからUnitへ移した実行機構の正本重複は解消している。一方、dist、導入済みnode_modules、旧tgzにはコンパイル済みコピーが存在する。これらは生成物／配布物であり直接編集しない。別ビルド・別パッケージのクラスを混在させるとinstanceof等の同一性が失われ得る。Registryや旧Wrapperをそのまま正式Unitへ移すだけでは、この問題の解決にならない。

### 再構築進捗の現在値

| 対象 | 状態 | 未完了・適用範囲 |
|---|---|---|
| Core | Flow／StorageIdの移植・検証済み | Framework全体のCore設計が完成したという意味ではない |
| DB Builder | 既存3ソース・7試験を移植、公開3サブパスを整理済み | DB構築・DAO・Rendererの責務分離やDB全方式の実装完了ではない。深部互換パスの将来扱いは未決定 |
| Member | MemberObjectとSchemaを移植。オブジェクト試験は検証済み | Member Schema専用検証は未完了。会員業務全体の移植ではない |
| Workflow／Check | 正式Unit配備、Unit側を正本化、既存制御・履歴を維持 | Registry／診断／Adapterの正式配布範囲は未確定 |
| CJobForm | 継承可能な基底クラス、CMRP 6工程対応済み | 旧CJobを互換維持。全旧利用先の移行完了ではない |
| TimeTrip | CJobForm化、取得元設定・記録と日時取得を分離済み | 保存の非Transaction・同じDAOへの競合・対象月の厳密検証は残課題 |
| TimeTripCore | 旧TimeTravel.jsから名称統一済み | 旧道場の移植元ファイル名・内容は変更しない |
| 公開API／Wrapper | 既存契約を維持し基本整理済み | 旧配布Unitとの契約差、低水準公開API、互換経路の整理が残る |
| Unit依存検査 | 5 Unitの静的検査器・公開入口試験を追加済み | 現行検査で循環・未宣言依存・Unit間の内部直接参照はなし。動的依存と利用アプリ全体は対象外 |
| Migration | 26登録、25 VERIFIED、Member Schema 1件COPIED／TEST_MISSING | 承認は全件false、COMPLETE 0、skip 0。未登録0は宣言した探索範囲内だけの値 |

25/26は旧移植と新規資産を含む「現在の登録資産の検証済み割合」である。Framework全体の再構築進捗率ではなく、移植元リポジトリの全資産を調べ終えた割合でもない。Framework全体の母数・重み・完了条件は未定義なので、全体進捗率は算出しない。

### Git棚卸しと機密情報の扱い

調査時点：main、HEAD `26f22fdcafb1276f8a32d31629cef52759436d03`。追跡済み変更10ファイル、未追跡150ファイル、ステージ済み0。未追跡のディレクトリ表示をファイル数と混同しない。

| 区分 | ファイル数 | 現在の内容 |
|---|---:|---|
| Frwk_Units | 31 | 5 Unitのソース、Schema、テスト、公開設定、依存ロック、資料 |
| Migration | 18 | 資産台帳、管理Tool、検査器、テスト、検証証跡、本資料 |
| src | 23 | Prototype互換／Registry／診断、永続化／再開／Lease等のAdapter、SimpleDBの修正 |
| tests | 39 | CMRP、分岐、反復、永続化、診断、再開、Lease、外部副作用Mock、Emulator、ブラウザ、配布等の試験・fixture |
| tools | 8 | デモ・Emulator試験の起動、配布生成器、配布Wrapper、配布検証 |
| demo | 6 | 合成審査申請デモのApplication／JobForm／画面／定義 |
| root設定 | 4 | package.json／package-lock.json、Prototype／配布用tsconfig |
| docs | 31 | 実験報告26件、既存未追跡の設計・Inventory等4文書、別課題の計画書差分1件 |

生成済みdist、node_modules、runtime-data、logs、*.log、ローカルDB、desktop.ini等はGit対象から除外されている。GUIのローカル定義・catalog、docs/architecture/migration-generalization/の別設計資料にも除外設定がある。除外されている理由を確認せず、force-add、削除、クリーンアップしない。Migration/reports/latest.jsonとstatus.mdは通常のGit候補に含まれる管理証跡であり、一時ログとは区別する。

変更・未追跡候補160ファイルに対し、秘密鍵、Google APIキー、GitHub token、service-account private_keyの典型パターンと秘匿ファイル名を内容非表示で確認し、検出0だった。これは秘密情報・個人情報が存在しないことの証明ではない。資格情報の環境変数名や合成認証用文字列を、実秘密そのものと誤認しない。一方、証跡・文書にはローカル絶対パス、ユーザー名、合成fixture、他リポジトリへの参照が含まれ得るため、公開先の範囲と情報開示の確認は別途必要。実会員データや実認証情報を取得して追加検査することはしない。

### 推奨コミット計画（実行していない）

過去にWorkflow／TimeTripだけの限定コミットを止めたのは、同じファイル内の先行変更と、未追跡の前提Adapter・配布・検証資産を含める権限が確定していなかったためである。技術的にGitで分割不能という意味ではない。今回の棚卸しを基に、次回は先行成果を含める範囲を明示して判断する。

推奨は、レビュー・許可後に「実験012以降の関連基盤から正式Unit・公開API・Migrationまでの整合した基準点」を1コミットにする案。Frwk_Units全体とMigration全体、関連するsrc／tests／demo／tools、ルート4設定、実験報告26件を依存関係ごと確認する。CoreはTimeTrip／Member、SimpleDBの修正は診断／Lease／UNKNOWN、RegistryはWAIT定義・再構築・配布と関連しており、今回分だけを機械的に抜き出さない。ソース・設定・テスト・lock・対応資料は一緒に扱う。

ただし現状160件を無条件に一括追加する案ではない。少なくとも以下5文書は初回候補から保留し、既存内容を保全する。この場合、基準点候補は155ファイルとなるが、これは最終承認済みマニフェストではない。

- docs/plans/PHASE-5B-minimal-contract-design.md：ThemeDialogueAI-Pとの別課題の保留方針39行。今回の基盤実装と分け、必要なら独立した文書コミットを後で判断する。
- docs/architecture/ARCH-026_CMRP_設計対話整理_2026-11-07.md
- docs/architecture/ARCH-026_設計判断履歴_CJobFormとCJobの未定義_2026-11-08.md
- docs/architecture/ARCH-026_Migration_Function_Inventory_20261106.md
- docs/architecture/ARCH-026_Workflow_Function_Check_20261106.md

既存4文書は設計・調査履歴として保全し、内容・公開可否のレビュー後に同じ基準点へ含めるか、資料として後で記録するかを決める。古いInventoryを現行実装へ自動更新しない。ThemeDialogueAI-P側のフォルダを再接続する必要はない。

コミット前のゲート：候補を明示一覧化 → 機密・実データ・生成物の確認 → 空の検証用ディレクトリへ候補とHEADを再現 → 依存導入・Build・関連試験 → 旧配布物が必要な試験の前提確認 → 許可された範囲だけStage → cached差分・件数・check確認 → コミット。候補外の未追跡ソース、既存dist、兄弟リポジトリ、ローカルtgzに暗黙依存していないかを確認する。本セッションではこのゲートに必要な承認や空ディレクトリ検証は実施していない。

特に旧tgzはruntime-data内にのみ保全され、通常のGit取得だけでは復元できない。旧版0.1.0-experiment.021.1のSHA-256は`e7f97e55ed2da17adf32cb7358df39c816ed7e929ea4c7dee1b87d0aafda34c4`、現行互換候補0.3.0-framework.3は`f2a71fd1ebe888dc0928db9ef7cc60dccc3d40d0c3c8ef7fe1bd1044af4b6d86`（今回現物を再計算）。配布物の保管・取得方式は決定が必要であり、無断でGitへ追加しない。

配布生成器はmanifestへgit HEADを含める。このため基準コミット後は、同じソースでも既存と同名のtgzの内容が変わり、IMMUTABLE_VERSION_CHANGEDとなり得る。基準点確定後に新バージョンを選んで配布検証する順序を推奨し、既存tgzを消して同じ版を作り直さない。ARCHから旧道場側への配布・導入は別作業とする。

### 次回の最初の確認と試験手順

最初に本節と最新のstatusを読み、Gitの差分・時刻・検証指紋が変わっていないか確認する。過去のPASSや今回の155候補をそのまま信用しない。

```text
git status --short
git diff --stat
git diff --cached --name-only
npm run migration:scan --prefix Migration
npm run migration:status --prefix Migration
node Migration/tools/inspect-api.cjs
```

Node 24、TypeScript 5.9系。初回導入はルートpackage-lockと各Unitのpackage-lockを確認し、許可されたローカル／オフライン依存を使用する。TimeTripはCore／Workflowのローカルリンク、Memberは導入済みCoreの同一ファイルを検証する。TimeTripのロックからの再導入は`npm ci --prefix Frwk_Units/TimeTrip --offline --ignore-scripts --no-audit --no-fund --install-links=false`で確認済み。Windowsのリンク権限、オフラインキャッシュが不足する場合は失敗として扱い、別ソースや実サービスへ自動フォールバックしない。

```text
npm run build
node node_modules/typescript/bin/tsc -p tsconfig.prototype.json --noEmit
node node_modules/typescript/bin/tsc -p Frwk_Units/Workflow/tsconfig.json --noEmit
npm test --prefix Frwk_Units/DB/Builder
npm test --prefix Frwk_Units/TimeTrip
npm test --prefix Frwk_Units/Workflow
npm test --prefix Migration
node --test Migration/tests/public-api.test.cjs
npm run migration:verify --prefix Migration
npm run migration:report --prefix Migration
git diff --check
```

Core／Memberの永続試験はMigration/tests/assetsにあり、verifyで実行される。scan/status/検査器は読取のみ。verifyは許可済みローカル試験を実行して証跡と検証済みSHAを更新し、reportはstatus.mdを更新する。承認の付与は含まれない。Registryのorigin=NEWとMIGRATED、移植元の実在する旧名称を維持する。

ルートの既存回帰は`npm test`。追加のWAITING・SQLite診断は`npm run test:waiting`、UNKNOWNは`npm run test:history-unknown`。それ以外の実験試験はpackage.jsonと各実験報告を参照し、起動前に副作用・Emulator条件を確認する。ローカルHTTP／子プロセス／junction試験が制限環境で実行不能なら、その失敗・SKIPを記録し、PASSへ置換しない。

Emulator依存試験は`npm run test:firestore`、`npm run test:firestore-waiting`、`npm run test:exam-persistence`、配布単体の`npm run test:unit-release`等に分かれる。これらは別の環境前提を持ち、今回は起動していない。既存tests/exam-progress-adapter.test.cjsは兄弟の旧道場リポジトリの実投影モジュールを読取り参照するため、ARCH単独取得で実行可能とは保証しない。実サービス接続・実データ利用を避け、Emulator／検証プロセスを起動した場合は必ず停止する。

最新証跡の試験結果は2026-11-10 17:22 JSTの50既存Unit試験＋公開API 8件＝58 PASS。前回のMigration管理29 PASS、Build・型検査・構文検査PASSと区別する。本セッション終了整理では全テストやBuildを再実行していない。読取のstatusで26件中25 VERIFIEDが現在も有効であることと、静的検査のエラー・警告0を確認しただけである。今回の資料追記は検証対象ソースの変更ではない。

### 推奨優先順位と保全対象

1. Git基準点の範囲・情報開示・配布物保全をレビューし、空の環境で候補を再現する。承認後にのみ基準コミットを行う。次の機能追加を先に重ねない。
2. Member Schemaの意味・既存契約を確認して専用試験を追加し、唯一の未検証資産を検証する。業務Schemaを推測で拡張しない。
3. Prototype Registry／診断／永続化Port／旧配布Wrapperの所属と正式配布契約を決める。クラス同一性と旧データ・旧APIの契約試験を先に用意し、実装・移設はその後。
4. TimeTripの非Transaction保存・競合・対象月の許容範囲を設計判断する。現状の挙動を不具合と決めつけて変更しない。
5. DB Builderの責務分離・深部互換経路、依存検査の動的範囲、将来のSkeleton／業務組込みを検討する。既存資産の所有Unitを確認する前に新機構を増やさない。

旧道場は読み取り専用。Ohfukan／ThemeDialogueAI-Pは今回の変更対象外。既存未コミット成果、上記4文書、別Migration設計資料、旧配布物、ローカルDB／GUI設定を保全する。CJob互換入口、既存API、試験、Migration承認を独断で削除・緩和・更新しない。実Firestore／本番・DEV環境、実会員情報、実通知・決済へ接続しない。Migration検証済みと人間による完了承認、正式Unit統合とFramework全体の完成を混同しない。

## 基準点候補の独立再現監査（2026-11-11）

### 候補確定と隔離方法

main／HEAD `26f22fdcafb1276f8a32d31629cef52759436d03`、追跡済み変更10・未追跡150・ステージ0を再確認した。前節の保留5文書を除いた候補は155ファイルで、前回一覧に対する追加・削除は0。今回の引継ぎ追記も既存候補Migration/README.md内なので候補数は変わらない。末尾に全候補パスを記録する。生成物・ローカルDB・資格情報ファイルは候補に含めず、内容非表示の典型的な秘密情報パターン検査で検出0だった。公開先に応じた個人情報・内部パスのレビューまで完了したという意味ではない。

元リポジトリのHEADをgit archiveで取り出し、155候補をSHA-256照合して上書きした。HEADにある保留計画書はHEAD版のまま保持し、その未コミット差分は入れていない。未追跡の保留4文書は存在しない。候補外の未追跡ファイル、既存node_modules／dist、旧配布物、兄弟リポジトリは一切コピーしていない。初期の実ファイル259件がHEAD＋候補の和集合と完全一致（余分0・不足0）することを確認した。

標準TEMPはコマンド間で消えるため、許可済みの別書込み領域にある`arch026-baseline-2ZUT5C/checkout`を継続用の独立環境とした。元ARCHリポジトリの配下ではなく、親のnode_modulesを借りない配置である。Windows標準tarによる日本語名の文字化けを検出したため、HEADアーカイブをUTF-8名と元バイト列を保つ方法で再展開した。元ファイルやGitオブジェクトの変更ではない。Node v24.16.0／npm 11.13.0。検証用の台帳・ログは元リポジトリのGit対象外`logs/baseline-audit/`に保存し、候補には含めていない。

### 導入・試験結果（この独立環境での実測）

すべてオフライン、install scriptなしで試行した。ネットワーク使用、元node_modules／distのコピー、実サービス接続、権限の無断緩和は行っていない。

| 対象 | 結果 | 分類・理由 |
|---|---|---|
| ルート npm ci --offline --ignore-scripts --no-audit --no-fund | 失敗：EPERM | node_modules配下の作成・再試行時の後片付けがOSに拒否された。TypeScript／Firestore SDKは導入できていない。依存欠落をコード不良と断定しない |
| Memberの通常npm ci | 失敗：EUSAGE | ローカルfile依存のコピー／リンク形式とnpm設定の不一致 |
| Member npm ci --offline --ignore-scripts --no-audit --no-fund --install-links=true | 成功 | 既存lockfileのコピー形式に合わせた。lockfileは無変更。元の導入済みCoreは使わず、独立環境内Coreから導入 |
| TimeTrip npm ci --offline --ignore-scripts --no-audit --no-fund --install-links=false | 失敗：EPERM | 独立環境内Workflowへのローカルリンク作成が拒否された |
| Core既存試験 | 3 PASS / 0 FAIL / 0 SKIP | 独立環境から実行 |
| DB Builder既存試験 | 7 PASS / 0 FAIL / 0 SKIP | 公開入口を通して独立環境から実行 |
| Member既存試験 | 3 PASS / 0 FAIL / 0 SKIP | コピー形式での導入後に実行 |
| Migration管理試験 | 28 PASS / 0 FAIL / 1 SKIP（全29） | junction作成のOS権限制約。以前の29 PASSを今回の結果に流用しない |
| ルート回帰のJSのみの部分集合 | 72 PASS / 0 FAIL / 0 SKIP | definitions、job-catalog、template-runner、exam-job-classes、exam-jobs、workflow-runtime、gui-definition-transitionsの7試験ファイル |
| Build・TypeScript型検査 | 未実行 | lockfileで導入するTypeScriptが欠落。元のコンパイラ・生成済みdist・グローバル導入を代用しない |
| Workflow／TimeTrip試験、公開API／依存検査 | 未実行 | ビルドと必要依存・リンクが未成立。前回20／17／8 PASSを再現済みとは扱わない |
| ルートnpm test全体 | 未実行 | Build前提が未成立。72 PASSは全体529件の代替ではない |
| Migration再検証 | コマンド失敗 | DB 7・Core 3・Member 3はPASS。time／workflow／public-apiの3グループはINPUT_MISSINGで実行拒否。アサーション失敗とは区別する |
| Emulator依存試験 | 未実行 | ローカルJARの存在だけを確認。SDK・主要Buildが未成立なのでEmulatorは起動しない |
| 旧配布物を使う配布試験 | 未実行 | 旧tgzとGitメタデータが独立環境にない。元tgzや元リポジトリの.gitへ暗黙に接続しない |

Core／DB／Memberの13 PASSはMigration再検証でも再実行されているため、別の独立した試験数として加算しない。元作業ツリーの26登録・25 VERIFIED／既存58 PASSの証跡は変更していない。独立環境での再検証後は6 VERIFIED・20 COPIED、移植元SOURCE_MISSING 10件となった。兄弟リポジトリをコピーしていないため移植元の現在状態は照合不能であり、元作業ツリーでの移植元検証と分けて扱う。

### 修正・残条件とコミット判定

現時点の判定は**不可（独立再現検証が未完了のため）**。155候補の不整合や実装不良が確定した判定ではない。以下を解消・検証してから再判定する。

1. OS・実行環境：ルート依存の作成とTimeTripローカルリンク、junction試験に必要な条件。権限追加の可否を利用者へ報告・確認し、未承認のまま制限環境外で実行しない。ネットワーク禁止は維持する。オフラインcache不足が判明した場合も別途報告する。
2. lockfile・依存関係：Memberは`--install-links=true`を明示する再現手順で解決した。現時点ではpackage-lockの再生成やソース変更は不要。TimeTripのリンク形式はクラス同一性の契約なので、通すためにコピー形式へ切り替えない。
3. 兄弟リポジトリ：Migrationの移植元照合とexam-progress-adapter試験には外部の読取り前提がある。HEAD＋155候補だけの環境ではそこまでの再現保証はできない。旧道場から実装・データをこっそり補充しない。
4. 旧配布物：保存・取得方法とSHA検証が必要。旧tgzを候補へ無断追加しない。配布生成器のGit HEAD参照については、候補外の未コミット成果を含めない独立したGitメタデータの準備、または生成器の契約変更の判断が必要。Gitメタデータ不在を埋めるため元.gitへ依存させない。
5. Git管理対象の不足・テスト実装：HEAD＋候補のファイル構成自体には不足を検出していない。ただし主要依存を導入できておらず、Build後にしか判明しない不足・不具合は未評価。PASSへ補完せず、次回の主要確認として残す。

元作業ツリーへの今回の反映は、この引継ぎ追記とMember導入コマンドの明文化だけ。独立環境で書き換えられたRegistry・証跡や失敗したnode_modulesは戻さない。既存のソース、lockfile、配布物、5保留文書、Migrationの承認は維持する。Stage・Commit・Pushは一切行っていない。

次回はこの節と`logs/baseline-audit/manifest.json`の配置・ハッシュを確認し、権限条件の明示確認後、同じオフライン条件で依存導入から再開する。Member用は上記コピー形式のコマンド、TimeTrip用は既存リンク形式を使う。完了後にBuild・型検査→各Unit→公開API／依存検査→Migration管理・再検証→ルート全回帰の順で確認し、未実行分を埋める。本節の不可判定を、単に過去のPASSを再掲して変更しない。

<details>
<summary>確定した基準点候補155ファイル（HEADとの差分対象・5保留文書を除外）</summary>

```text
demo/exam-application/app.js
demo/exam-application/application.cjs
demo/exam-application/definition.json
demo/exam-application/index.html
demo/exam-application/job-forms.cjs
demo/exam-application/style.css
docs/EXPERIMENT_012_JOB_EXECUTION.md
docs/EXPERIMENT_013_SQLITE.md
docs/EXPERIMENT_014_JOB_PERSISTENCE.md
docs/EXPERIMENT_015_SAVED_RUN_DIAGNOSIS.md
docs/EXPERIMENT_016_RESUME.md
docs/EXPERIMENT_017_LEASE_FENCING.md
docs/EXPERIMENT_018_EXTERNAL_EFFECTS.md
docs/EXPERIMENT_019_A_DIFF_SURVEY.md
docs/EXPERIMENT_019_B_ADAPTER_CONNECTION.md
docs/EXPERIMENT_019_C1_RUNTIME_PERSISTENCE_DESIGN.md
docs/EXPERIMENT_019_C2_FIRESTORE_EMULATOR.md
docs/EXPERIMENT_019_D_DEMO_INTEGRATION_PLAN.md
docs/EXPERIMENT_020_A_EXAM_WORKFLOW_DEMO.md
docs/EXPERIMENT_020_B_FIRESTORE_PERSISTENCE.md
docs/EXPERIMENT_021_A_INTEGRATION_READINESS.md
docs/EXPERIMENT_021_B_DOJO_UNIT_INTEGRATION.md
docs/EXPERIMENT_021_C1_TEST_ISSUES.md
docs/EXPERIMENT_021_C2_EXAM_WORKFLOW_DESIGN.md
docs/EXPERIMENT_021_C3_EXAM_WORKFLOW_CONNECTION.md
docs/EXPERIMENT_022_A_CONTRACT_ALIGNMENT.md
docs/EXPERIMENT_022_B1_R_HISTORY_UNKNOWN.md
docs/EXPERIMENT_022_B1_SQLITE_LEASE_STABILITY.md
docs/EXPERIMENT_022_B2_WAITING_CONTRACT.md
docs/EXPERIMENT_022_B3_WAITING_RESUME.md
docs/EXPERIMENT_022_B4_FIRESTORE_WAITING.md
docs/EXPERIMENT_022_B5_UNIT_RELEASE_CANDIDATE.md
Frwk_Units/Core/package.json
Frwk_Units/Core/src/Flow.js
Frwk_Units/Core/src/StorageId.js
Frwk_Units/DB/Builder/package.json
Frwk_Units/DB/Builder/src/portable-data-definition-builder.mjs
Frwk_Units/DB/Builder/src/portable-data-definition-core.mjs
Frwk_Units/DB/Builder/src/Schema_Renderer_Firestore.js
Frwk_Units/DB/Builder/tests/verify-portable-data-definition-builder.mjs
Frwk_Units/DB/Builder/tests/verify-portable-data-definition-core.mjs
Frwk_Units/DB/Builder/tests/verify-portable-data-definition-firestore-mapping.mjs
Frwk_Units/Member/package-lock.json
Frwk_Units/Member/package.json
Frwk_Units/Member/schema/Member.yml
Frwk_Units/Member/src/MemberObject.js
Frwk_Units/TimeTrip/docs/README.md
Frwk_Units/TimeTrip/package-lock.json
Frwk_Units/TimeTrip/package.json
Frwk_Units/TimeTrip/src/SystemContext.js
Frwk_Units/TimeTrip/src/TimeApplicationCore.js
Frwk_Units/TimeTrip/src/TimeTrip.js
Frwk_Units/TimeTrip/src/TimeTripCore.js
Frwk_Units/TimeTrip/tests/timetrip.test.cjs
Frwk_Units/Workflow/docs/README.md
Frwk_Units/Workflow/package.json
Frwk_Units/Workflow/src/Check.ts
Frwk_Units/Workflow/src/CJobForm.ts
Frwk_Units/Workflow/src/CWorkflow.ts
Frwk_Units/Workflow/src/index.ts
Frwk_Units/Workflow/tests/workflow.test.cjs
Frwk_Units/Workflow/tools/build.cjs
Frwk_Units/Workflow/tsconfig.json
Migration/package.json
Migration/README.md
Migration/registry.json
Migration/reports/latest.json
Migration/reports/status.md
Migration/src/cli.mjs
Migration/src/network-guard.cjs
Migration/src/registry.mjs
Migration/src/reporter.mjs
Migration/src/scanner.mjs
Migration/src/status.mjs
Migration/src/verifier.mjs
Migration/tests/assets/core.test.cjs
Migration/tests/assets/member.test.cjs
Migration/tests/assets/timetrip.test.cjs
Migration/tests/management.test.mjs
Migration/tests/public-api.test.cjs
Migration/tools/inspect-api.cjs
package-lock.json
package.json
src/adapters/exam-progress/adapter.cjs
src/adapters/job-execution/diagnostic.cjs
src/adapters/job-execution/external.cjs
src/adapters/job-execution/history-observation.cjs
src/adapters/job-execution/ownership.cjs
src/adapters/job-execution/resume.cjs
src/adapters/job-execution/simpledb.cjs
src/adapters/mock-exam/simpledb.cjs
src/adapters/mock-notification/service.cjs
src/adapters/simpledb/database.cjs
src/adapters/workflow-firestore/composition.cjs
src/adapters/workflow-firestore/emulator.cjs
src/adapters/workflow-firestore/exam-application.cjs
src/adapters/workflow-firestore/store.cjs
src/adapters/workflow-firestore/waiting.cjs
src/adapters/workflow-history/simpledb.cjs
src/adapters/workflow-waiting/lifecycle.cjs
src/adapters/workflow-waiting/sqlite.cjs
src/prototype/definition.ts
src/prototype/diagnosis.ts
src/prototype/job-form.ts
src/prototype/mock-exam.ts
src/prototype/workflow.ts
tests/exam-application-browser.cjs
tests/exam-application-demo.test.cjs
tests/exam-application-persistence.test.cjs
tests/exam-persistence/host.cjs
tests/exam-progress-adapter.test.cjs
tests/exam-progress-adapter/offline.cjs
tests/external-effects.test.cjs
tests/external-effects/host.cjs
tests/history-unknown.test.cjs
tests/job-execution-sqlite.test.cjs
tests/job-form-check-branch.test.cjs
tests/job-form-cmrp.test.cjs
tests/job-form-execution.test.cjs
tests/job-form-loop.test.cjs
tests/job-form-post-failure.test.cjs
tests/job-form-sqlite.test.cjs
tests/job-run-diagnosis.test.cjs
tests/job-run-lease.test.cjs
tests/job-run-lease/host.cjs
tests/job-run-resume.test.cjs
tests/job-run-resume/child.cjs
tests/sqlite-diagnostic-retry.test.cjs
tests/unit-release/child.cjs
tests/unit-release/consumer.ts
tests/unit-release/public.test.cjs
tests/unit-release/scenario.cjs
tests/workflow-concurrency.test.cjs
tests/workflow-definition.test.cjs
tests/workflow-exceptions.test.cjs
tests/workflow-firestore-waiting.test.cjs
tests/workflow-firestore-waiting/child.cjs
tests/workflow-firestore-waiting/scenario.cjs
tests/workflow-firestore.test.cjs
tests/workflow-firestore/child.cjs
tests/workflow-firestore/scenario.cjs
tests/workflow-unit-package.test.cjs
tests/workflow-waiting.test.cjs
tests/workflow-waiting/child.cjs
tests/workflow-waiting/scenario.cjs
tools/exam-application-demo.cjs
tools/package-workflow-unit.cjs
tools/run-exam-persistence-tests.cjs
tools/test-unit-release.cjs
tools/workflow-unit/firestore.cjs
tools/workflow-unit/firestore.d.ts
tools/workflow-unit/waiting.cjs
tools/workflow-unit/waiting.d.ts
tsconfig.prototype.json
tsconfig.workflow-unit.json
```

</details>

### 権限追加承認後の追検証（2026-11-11）

利用者から「オフライン導入のローカル権限追加」の明示許可を受け、上記と同じ独立環境への依存導入だけを制限環境外で再実行した。ネットワーク使用、元node_modules／distの借用、元作業ツリーのソース・lockfile変更はない。前節の初回失敗結果は履歴として維持し、以下を現在の評価とする。

| 対象 | 追検証の結果 |
|---|---|
| ルート依存 | lockfileに基づくnpm ci --offline --ignore-scripts --no-audit --no-fundで119パッケージ導入成功 |
| TimeTrip依存 | 同条件に--install-links=falseを加え、独立環境内Core／Workflowへのローカルリンク2件を導入成功 |
| lockfile・解決先 | ルート・Member・TimeTripの3 lockfileは全て不変。TypeScriptとFirestore SDKが独立環境内node_modulesへ解決されることを確認 |
| Build | ルート、Workflow UnitともPASS |
| TypeScript型検査 | PrototypeとWorkflow UnitのnoEmit検査PASS |
| Core／DB Builder／Member | 前節の独立環境での3／7／3 PASSを維持。Migration再検証でも再実行してPASS |
| Workflow／TimeTrip | 20／17 PASS |
| 公開API利用試験・静的依存検査 | 8 PASS、検査器エラー・警告0 |
| Migration再検証 | 6グループ全てPASS、計58件、失敗・SKIP 0 |
| 追加のWAITING／SQLite診断、UNKNOWN | 49 PASS、8 PASS |
| ルートの非HTTP回帰 | コンパイル済みPrototype／Ticketを含む18試験ファイル・290 PASS、失敗・SKIP 0。前節の72件を含むので加算しない |
| ルートnpm test全体 | 制限環境内で試行し、HTTP系の失敗と進行停止を観測して中断。全529件PASSとは扱わない |
| HTTP失敗の単独診断 | GUI例外試験1件はfetch failed。純粋なlocalhost通信の診断でもconnect EACCES 127.0.0.1を実測し、OS通信制約を確認 |
| Migration管理 | 現権限では前節の28 PASS・junction 1 SKIP。追加の試験権限なしに29 PASSへ読み替えない |

Migrationの独立環境側も25 VERIFIED・1 COPIEDとなった。ただし兄弟リポジトリの移植元SOURCE_MISSING 10件は残る。元作業ツリーのRegistry・証跡や承認へは反映していない。58件には各Unit試験が含まれており、上表を重複加算しない。

配布生成器用に独立したGitメタデータをローカルbare cloneで用意する試行も行ったが、Gitの子プロセスがMSYS名前付きオブジェクトの権限エラーで失敗し、メタデータは作成できなかった。Stage・Commit・Pushや元.gitの書換えは行っていない。旧配布物なし／Gitメタデータなしという配布試験の制限は継続する。Emulator JARとSDKは存在するが、localhost通信の条件が未成立なのでEmulatorを起動していない。

現在の判定は**条件付き可能（コミット直前の検証ゲートは保留）**。155候補だけで主要Build・Unit・公開API・Migration検証は再現できた。一方、ルート全回帰、junction拒否の実測、Gitメタデータを含む配布試験、旧配布物・兄弟リポジトリを要する試験は完了していない。localhost通信と一時領域junctionを使う試験の追加権限を別途確認中であり、依存導入の許可を全試験の制限解除へ拡大解釈しない。許可がなければ未再現として報告し、承認が得られた範囲だけ再試行する。

次回はまずlocalhost回帰の権限回答を確認し、許可後に同じ独立環境でルートnpm testとMigration管理試験を再実行する。外部ネットワーク・実サービスは禁止のままとする。配布物・兄弟リポジトリ・Emulatorの前提は別途管理し、全て再現済みと主張しない。元作業ツリーへの反映は引き続きこの引継ぎ資料のみ、155候補・保留5文書・完了承認falseを維持している。

### ローカル回帰の追加許可後・監査最終結果（2026-11-11）

利用者から「ローカル回帰・junction試験の権限追加」の明示許可を受けた。同じ独立環境で再実行し、初回のEACCESやSKIPを結果から消さず、失敗原因と権限条件を明記して解消を確認した。**この節を本監査の最新評価とし、前節の不可・条件付き可能は途中経過として保持する。**

| 検証 | 独立環境での最終結果 |
|---|---|
| Build・型検査 | ルート／Workflow UnitのBuild、Prototype／Workflow UnitのnoEmit型検査PASS |
| Core／DB Builder／Member／Workflow／TimeTrip | 3／7／3／20／17 PASS（計50） |
| 公開API利用・静的依存検査 | 8 PASS、検査器エラー・警告0 |
| Migration再検証 | 上記50＋8の計58 PASS、失敗・SKIP 0 |
| Migration管理 | 29 PASS、失敗・SKIP 0。junction拒否も実測 |
| ルートnpm test全体 | 529 PASS、失敗・SKIP 0。初回のHTTP失敗・中断後、許可された同一ソースで再実行 |
| Job／SQLite／診断／再開／Leaseの追加回帰 | 213 PASS |
| WAITING／SQLite診断、UNKNOWN | 49 PASS、8 PASS |
| 現行配布生成の試験 | 2 PASS。追加回帰は213＋49＋8＋2の計272件で、これらの内訳を再加算しない |
| 合成外部副作用Mock／Memory HTTPデモ | 64 PASS。実通知・実決済・実データは利用しない |
| Firestore Emulator | 永続化デモ・C2・WAITINGの3試験ファイル、計65 PASS、失敗・SKIP 0 |
| Emulator停止確認 | 所有子プロセスの終了を待ち、停止後の接続拒否とMemory／本番への非フォールバックを確認（E-stop PASS） |

最初の72／290件という部分集合はルート529件に含まれる。Unit試験・公開API試験とMigration再検証58件も同じ試験を再実行しており、独立した総数として重複加算しない。試験のアサーション・期待値・タイムアウトを緩和して通したものではない。Emulator故障注入には長時間を要したケースもあり、その実測ログを保持している。

Emulatorの前提はJava 21、ローカルFirestore Emulator v1.21.0、lockfile由来SDK。JARのSHA-256は`c3d3680a89d946a90a027365ea14c26c6472a162bcf37f099bbb1ebd66d25e8e`。サーバーは127.0.0.1だけで起動し、demo-arch026-c2の合成データ・試験ごとのnamespaceを使った。資格情報・実プロジェクト設定を試験プロセスから除き、旧道場、本番／DEV、外部サービスへ接続していない。試験終了後にEmulatorを停止した。既存SDKのdeprecation警告は出力されたが、依存バージョンを無断更新していない。

配布生成に必要なGitメタデータは、bare cloneのMSYSエラーを避け、独立環境内にGit初期化した後、元リポジトリからobjectsだけを通常コピーして用意した。HEADは対象commitへ固定し、commitオブジェクトの実在を照合した。元のindex／config／hooksはコピーせず、hardlink／alternatesによる元objectsへの暗黙依存もない。元リポジトリのGit状態変更や、新しいStage・Commit・Pushは行っていない。これは試験用メタデータであり、候補外の未コミットコードを追加したものではない。

独立環境で新規生成した`arch026-workflow-unit-0.3.0-framework.3.tgz`のSHA-256は`f2a71fd1ebe888dc0928db9ef7cc60dccc3d40d0c3c8ef7fe1bd1044af4b6d86`で、保全中の同版と一致した。元tgzを試験環境へコピーしたのではなく、生成後に読み取り比較した。元配布物の上書き・削除はない。Git HEADが変わる次の配布では、前述の版固定・新バージョン採用手順を守る。

未実施は、旧版0.1.0-experiment.021.1のtgzを必要とする旧新互換の配布単体試験、兄弟リポジトリの投影モジュールを必要とするexam-progress-adapter試験、実ブラウザE2Eである。旧tgz・兄弟コード・既存ブラウザ用パッケージを候補外から無断補充していない。これらは今回のローカル基準点再現と切り分け、配布承認・旧道場統合完了・全業務機能の検証済みとは報告しない。

**最終判定：コミット可能（155ファイルのFramework開発基準点として）。** HEAD＋確定候補だけから、lockfileに基づく導入、主要Build・型検査、全Unit、公開API、Migration、ルート全回帰、ローカル永続化と現行配布生成を再現できた。追加実装やlockfile再生成は不要で、元への必要な反映はMember導入フラグの明文化と本監査結果の追記のみだった。未実施の外部前提・Member Schema等の未完了項目・SOURCE_MISSING 10件という独立環境の出自照合制限は、基準点の既知範囲として明示して残す。

これはコミット実施の許可ではない。候補155件・保留5文書を維持し、利用者が次に明示指示したときだけ、確定一覧との照合、Stage後の差分・件数・check、コミット後の状態確認へ進む。本セッションでは元の作業ツリーにStage・Commit・Pushしていない。Migrationの26件中25 VERIFIED、Member Schema 1件未検証、承認全件false、skip 0を維持する。元のRegistry・検証証跡へ独立環境の結果を上書きしていない。
