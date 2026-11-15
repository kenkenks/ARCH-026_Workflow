# Workflow Unit

Frameworkの正本はこのUnitの`src/`。旧`src/prototype/workflow.ts`は同じ実装を再公開し、二重のWorkflowエンジンを持たない。

## 公開契約

Node.js 24、CommonJS、TypeScript宣言付き。実行時の外部依存・DB接続はない。`npm run build`、`npm test`をUnitディレクトリで実行する。ビルドにはTypeScript 5.9が必要（単独環境では開発依存をインストールする）。

```ts
import {CJobForm, CWorkflow, CMemoryHistoryStore, createMemoryProductShelf} from '@arch026/workflow';
class Example extends CJobForm<void, number> {
  constructor() { super('example'); }
  protected make() { return 10; }
}
const shelf = createMemoryProductShelf();
const workflow = new CWorkflow([
  {no: 1, job: new Example(), products: shelf, artifactKey: 'X'}
], new CMemoryHistoryStore());
await workflow.run('run-1', 1);
```

`CJobForm.execute(context?)`がprepare→collect→make→record→post→cleanupを実行する。不要なフェーズは基底実装を使える。prepareはcollect前にawaitし、失敗時もcleanupを実行する。旧CJobは従来どおりprepareなしの互換経路を維持する。定義を共有し、実行ごとの状態は`createExecutionContext()`で作る別コンテキストに保持する。同一コンテキストの再使用は拒否する。サブクラスが自身のフィールドへ実行固有データを保存すると並行独立性を損なうため、入力・成果はコンテキスト／実行別Shelfに置く。

collectは読取専用Shelf、各フェーズはコンテキストを受け取る。makeの結果を複製し、record成功後に内部成果として確定する。postの既定動作は指定Shelf・キーへの公開。Shelfとキーは両方指定するか、両方省略する。`getRecorded(context)`は独立コピー、`getExecutionState(context)`は状態・工程を返す。これは揮発性の実行情報であり、Job途中の復元契約ではない。

## エラーと終了

実行開始後はフェーズの成否にかかわらずcleanupを一度実行する。cleanupも失敗した場合、先行エラーがあればそれを優先し、二次エラーは`getCleanupWarning(context)`でのみ取得できる。cleanup単独失敗はFAILED。cleanup前の公開を取り消さない。postの部分公開・ロールバック・再試行は提供しない。内部例外やcleanup警告をHTTPへそのまま公開しない。

CWorkflowは各訪問で新しいコンテキストを渡す。Check、後方遷移、LIMIT_REACHED、WAITING、ERROR/DONE履歴は既存実装を維持する。WAITINGは工程間の確定境界。CAS・操作ID・Lease解放／再取得は既存`IWaitingHistoryStore`の責務で、単純な`CMemoryHistoryStore`だけでは安全なWAITING再開を提供しない。既存Memory／SQLite／Firestore Adapterは旧互換入口を通じ同一クラスを利用できるが、本作業では外部サービス接続試験を行わない。

## 互換入口と配布

旧`CJob`、`CDummyJob`、`bindJobForm()`を維持する。CJobは共通CMRP処理へ委譲し、旧オブジェクト定義・単一使用・最終工程postという契約を保つ。旧`src/prototype/job-form.ts`の型名CJobFormは互換用構造型。継承可能なクラスは本Unitからimportする。旧Registryの`jobs`入口は新クラスも受け付ける。

Frameworkパッケージは`@arch026/workflow@0.1.1`。旧Firestore等を含む配布パッケージ生成器は互換入口の移設先コードも収録し、既存不変版を上書きしないよう`@arch026/workflow-unit@0.3.0-framework.3`を使う。作業中に生成したframework.1も上書きしない。公開・道場側導入は今回行わない。

## Migration

移設元2ファイルと新規ファイルをRegistryのorigin（MIGRATED／NEW）で区別する。移設元は互換入口として残すため、作業前SHAはprovenanceに保持し、sourceBaselineは移設後の互換入口SHAを記録する。検証はソース・ビルド設定・生成JS・テスト・互換入口のハッシュに結び付ける。ビルド入力印が古い場合はUnit試験が失敗する。完了承認は自動付与しない。

## 配備時の検証範囲

既存npm test 529件、追加の既存Workflow系272件（Memory／SQLite WAITING、Lease、Fencing、UNKNOWN、パッケージ試験を含む）、合成業務・外部副作用Mock・Memory HTTPデモ105件を検証した。新Unitは18件、Migration管理28件、従来移植資産17件。Firestore Emulator・実Firestore・実ブラウザは今回実行しない。

初回の制限環境内でのnpm testは進行停止のため中断し、ローカルHTTP試験を実行可能な環境で再実行した。途中のRegistry型判定コンパイル失敗は修正済み。Migrationのjunction作成試験は制限環境で1件SKIPとなったため、実行可能な環境で28件すべて再検証した。SQLite保存UNKNOWNの設計上の制限を解決済みとは扱わない。

## TimeTrip統合時の追記

6工程の設計記述に合わせ、prepareをネイティブCJobFormへ追加した。位置づけに関する過去の未確定記述を削除せず、今回の要求に基づく最小の実行フック追加とする。既存18件を変更せずprepareの順序・失敗後cleanupの2件を追加（計20件）。

## 第3工程：案B＋Dの設計決定履歴（2026-11-12）

本節はチャットで行ったRegistry・Adapter境界調査と案D実現可能性調査、およびその後の利用者の決定を記録する。案Dの既存調査ファイルは確認できなかったため、本資料へ集約する。上記の現行API・実装説明や過去の検証結果を置き換えるものではない。今回は文書追記のみであり、実装・テスト・配布物生成は行っていない。

### 決定：案B＋Dを基本方針とする

- 案B（共通機能の正式Workflow Unitへの整理）＋案D（Builder主導・責務分離型）を基本方針とする。具体的なモジュール配置・公開サブパス・別Unit化の要否は未確定。
- DefinitionはJSON等の宣言的な形式を正規形式とする。Workflowの構成は利用者・開発者が決定し、BuilderはそのDefinitionに従ってWorkflowを構築する。
- Registryは定義・Job等の登録と検索、Factoryは生成を担当する。BuilderはDefinitionを解釈し、Registry・Factoryを利用して構成を組み立てる。
- CWorkflowは構築済みWorkflowの実行順序・分岐・状態遷移を制御する器であり、Builderではない。Definition解析やRegistry検索、Workflow構成の決定を担わせない。
- Jobの訪問ごとの生成には既存のFactory方式を活用する。構築済みのFactoryを実行時に呼び出す現行経路と、Definitionを解釈して構築する責務を区別する。Factory呼出しの配置・公開契約の詳細は次回検討とし、今回変更しない。
- CJobFormはCMRPによる個別処理、Checkは実行結果に基づく遷移判定、Adapterは保存先等の環境差異の吸収、Diagnosisは実行・保存状態の整合性と再開可能性の診断を担当する。
- `reconstructWorkflow()`等の現行実装を出発点とする。新しい実行エンジンや不要な階層を一から作る決定ではない。

### 調査で確認済みの現状と今後の差分

| 項目 | 確認済みの実装 | 今後必要な整理・未実装部分 |
| --- | --- | --- |
| Definition／Builder | `src/prototype/definition.ts`の`validatePrototypeDefinition()`、`reconstructWorkflow()`、`loadWorkflow()`が検証・名前解決・構築・読込を提供 | 責務別の分割と正式Unitへの配置・公開契約の整理は未実施 |
| Registry／Factory | 同ファイルの`WorkflowRegistry`はFactory Map。Checkと通常Jobは構築時、旧JobFormのCJobは訪問時Factoryで生成 | 定義登録とFactory登録の公開境界、Shelf・onCreate等の実行別情報との分離、実装Version固定は未確定 |
| CWorkflow | 本Unitの`src/CWorkflow.ts`が正本。Definition・Registry・具体DBを直接参照せず、`createJob()`呼出しと訪問ごとのContext生成を行う | Factory方式を維持した責務境界と、ネイティブCJobFormのRegistry接続を整理する必要がある |
| CMRP | 本Unitの`src/CJobForm.ts`は6工程と実行別Context、Shelfの読取・公開を提供 | 旧CJob依存の観測・永続化・再開接続が、そのまま6工程対応するわけではない |
| Diagnosis／保存 | `src/prototype/diagnosis.ts`は純粋診断。SQLite読取は`src/adapters/job-execution/diagnostic.cjs`へ分離。履歴・WAITING Portと各Adapterが存在 | DiagnosisとSQLite Job Schemaには旧4工程前提が残る。WAIT制御証跡との対応、6工程観測の契約整理が必要 |
| GUI／旧配布 | GUIは手動advance・明示END・多値Checkの別契約。旧配布生成器はPrototypeとUnit正本・一部Adapterを収録 | GUIを暗黙変換しない。互換入口・旧配布の維持範囲は未決定。既存アーカイブは保全する |

### 決定：成果物の配置はWorkflow側の責務とする

- Workflow実行インスタンスごとに成果物管理領域を設け、デフォルトは共通成果物台とする。
- Definitionで名前付き成果物箱を指定できる方向とし、明示指定がある場合はその指定を優先する。配置先指定がなければデフォルトの共通成果物台へ配置する。
- 後続Jobは必要な成果物を`collect`で取得する。Job間の自動的な直接受け渡しは前提としない。
- ここでいうWorkflow側の責務を、CWorkflowクラスが成果物の内容・DBアクセスをすべて保持する意味とはしない。担当モジュールと実行Contextへの接続は未決定。

現行のProductShelf、Stepのproducts／artifactKey、CJobFormのcollect／postは利用可能な既存素材である。一方、実行ごとの管理領域の自動用意、Definitionによる名前付き成果物箱とデフォルト配置規則は、現行の公開契約として実装済みとは扱わない。

未決定事項は、成果物の識別方法、箱の指定形式と解決方法、循環時の上書き・世代・履歴、格納タイミング、永続化方法、復元時の対応である。今回これらを確定しない。

### 独立した設計課題：イベント機構

道場システムでは、出席登録・会費回収・View更新を直接依存させず、必要な情報を連携させたい。この背景を持つイベント機構は、Workflowとは独立した設計課題として扱う。

- Workflowは実行インスタンス単位のスコープを持ち、イベント機構はWorkflowを横断する連携を扱う方向とする。
- イベント機構とCJobFormの関係、イベント発行・購読・Workflow起動方法は未決定。
- **CJobFormのpost工程はイベント機構側の検討課題とする。** 現時点ではpostを削除・再定義せず、実装変更もしない。prepare→collect→make→record→post→cleanupの6工程を維持する。
- 上記の「postの既定動作はShelfへの公開」は現行実装の説明として残す。新しい成果物配置方針との接続、およびイベント機構との責務関係は今後の検討事項であり、postをイベント発行専用へ変更する決定ではない。

#### 追加決定：EventによるWorkflow起動

以下は上記の未決定事項の一部について、今回の設計協議で決定した更新である。上記は検討経緯として残し、現在の基本方針は本項に従う。実装済み機能を宣言するものではなく、今回は文書のみ更新する。

Eventは、あらかじめ登録されたWorkflowをイベント発生時に起動するための機構とする。EventとWorkflowの対応関係を登録でき、Event発生時には対応するWorkflowの起動を要求する。EventはJobを直接実行せず、Workflowの内部構成も意識しない。Jobが1つでもWorkflowを実行単位とする。将来的には従来のバッチ処理もWorkflowによる実行へ置き換えることを想定するが、今回の実装・置換対象ではない。

| 構成要素 | 責務 |
| --- | --- |
| Event | Workflowの起動契機を管理する |
| CWorkflow | Jobの実行順序・分岐・循環など、Workflowの実行を制御する |
| CJob | Workflowを構成する処理単位 |
| CMRP collect | Jobが必要とする情報を取得する |

本項のCJobは今回の協議における処理単位の表記であり、既存のCJob廃止・CJobFormへの責務整理に関する判断を上書きしたり、新たにクラスの存廃を決定したりするものではない。

#### 不採用：Event通知による業務データの運搬

Event通知に業務データを添付して運搬する仕組みは採用しない。collectとの責務重複、Event機構の複雑化、Workflow間のデータ依存増加、データ取得経路の複数化による管理の煩雑化を避ける。必要な業務情報は、起動されたWorkflow内のJobがcollectで取得する。

Event種別や対象を特定するための最小限の識別情報は今後の設計課題とする。識別情報と業務データの運搬は区別し、具体的な項目・形式・取得への結び付け方は今回決めない。

#### 検討中：postとEvent通知

CMRPのpost工程をEvent通知の有力候補とする。想定する関係は次のとおりであり、正式な通知担当工程・実行契約を確定したものではない。

```text
Workflow A
  └─ Job：prepare → collect → make → record → post → cleanup
                                             │ Event通知候補
                                             ▼
                                         Event機構
                                             │ 起動要求
                                             ▼
                                         Workflow B
                                             └─ Jobのcollectで必要情報を取得
```

postをEvent通知の正式な担当工程とするか、通知の登録・配送方法、通知失敗時の扱い、重複通知・重複起動への対策、Workflow実行インスタンスの生成方法は未決定。postの削除・再定義・実装変更は行わず、CMRP 6工程を維持する。現行のShelf公開動作との関係も、実装を先取りせず今後整理する。

#### Workflow成果物管理との境界

Workflow内の成果物はWorkflow側で管理し、デフォルトの共通成果物台と明示指定された名前付き成果物箱を利用する既存方針を維持する。後続Jobはcollectで必要な成果物を取得する。EventはWorkflow間の成果物運搬を担当しない。Workflow成果物管理とEvent機構は独立した責務とする。上記の成果物管理方針の実装状況・詳細未決定事項も維持する。

#### Event機構の未決定事項

1. EventとWorkflow Definitionの登録形式。
2. Event識別子と対象識別情報の扱い。
3. Event発生時のWorkflow実行インスタンス生成。
4. Event通知の永続化の必要性。
5. Event通知失敗時の再試行。
6. 重複通知・重複起動の防止。
7. post工程との正式な関係。
8. Eventの外部発行元への対応。

今回これらの方式は確定せず、新しい公開API・通知基盤・保存Schemaは定義しない。

### 次回の実装検討候補（実装承認ではない）

1. Definition検証・Registry・Builder・読込の境界と、既存Factoryの訪問時呼出し契約を具体化する。
2. 実行別の成果物領域、デフォルト台・名前付き箱の指定と解決、collectへの接続を検討する。
3. 6工程の観測・診断・保存／再開契約、既存GUI・旧配布への影響を整理する。
4. イベント機構とpostの関係は独立課題として検討し、未決定の詳細を実装で先取りしない。

この順序は再開候補であり、未決定事項の採用方式・実装範囲・互換性方針を新たに確定するものではない。

## Builder正式Unit化・第1段階の実装結果

本節は上記の調査・設計履歴を残したまま、その後に完了した実装を記録する。上記表の「正式Unitへの配置・公開は未実施」等は調査当時の状態であり、Definition／Registry／Builderの正本移設とルート公開については本節が現在の状態を示す。成果物管理・Event等の未実装事項は更新しない。

### 正本と責務

- `src/Definition.ts`：既存Definition DTO・検証と、Builderに必要な最小のRepository契約。
- `src/WorkflowRegistry.ts`：既存のJob／Check／旧JobForm登録・Factory契約。
- `src/WorkflowBuilder.ts`：既存reconstructWorkflow()の処理を再利用した、関数中心の独立Builderモジュール。新しいBuilderクラスは導入していない。
- `src/index.ts`：既存ルート入口`@arch026/workflow`から上記を公開する。
- リポジトリの`src/prototype/definition.ts`：正式Unitの3モジュールを再exportする互換入口。既存呼出し元の一括import変更は行っていない。

```text
Workflow Definition
        │
        ▼
WorkflowBuilder ── WorkflowRegistry参照・名前解決
        │          Stepと訪問時Factoryを構築
        ▼
     CWorkflow
        ├─ Job訪問時Factory呼出し・実行Context生成
        ├─ Check評価
        ├─ 分岐・循環
        └─ WAITING／LIMIT_REACHED・履歴保存・再開
```

BuilderはWorkflowを構築し、Jobを実行しない。CWorkflowは構築済みの構成を実行する。CWorkflow／CJobForm／Checkのソースと実行アルゴリズムは変更していない。registry.jobsは構築時生成、jobFormsは訪問時生成、Checkは構築時生成・訪問時評価を維持する。循環時の新しい旧CJob生成、未訪問時の生成防止、ネイティブCJobFormの訪問別Context、WAITING／LIMIT_REACHED再開、保存履歴と訪問番号の継続契約も維持する。

### 正式公開API

以下は実際のルートexportである。型はTypeScript宣言として公開され、実行時の値ではない。

| 区分 | 公開名・契約 |
| --- | --- |
| 定義Schema定数 | DEFINITION_SCHEMA_VERSION = prototype-workflow/1、WAITING_DEFINITION_SCHEMA_VERSION = prototype-workflow/2 |
| 定義型 | SavedStep、PrototypeDefinition。JOB／CHECK_BOOL／WAITの既存構造を維持し、新フィールドは追加していない |
| エラー・検証 | DefinitionError(code: string)、validateDefinitionKey(value: unknown): asserts value is string、validatePrototypeDefinition(input: unknown): PrototypeDefinition |
| Registry関連型 | ReconstructionContext、JobFormRegistration、JobVisitContext、WorkflowRegistry |
| Repository型 | DefinitionRepository<TDefinition = PrototypeDefinition>。get(id, version): Promise<TDefinition \| null>、add(definition): Promise<void> |
| 構築 | reconstructWorkflow(input: unknown, registry: WorkflowRegistry, store: IWorkflowHistoryStore, continuation?: {history: readonly TraceEntry[]})。戻り値は{definition: PrototypeDefinition, workflow: CWorkflow, startStepNo: number} |
| 読込・構築 | loadWorkflow(repository: DefinitionRepository<PrototypeDefinition>, id: string, version: string, registry: WorkflowRegistry, store: IWorkflowHistoryStore)。戻り値は上記構築結果のPromise |

loadWorkflow()はgetで読み込み、未存在をDEFINITION_NOT_FOUND、要求ID・Versionと保存値の不一致をDEFINITION_IDENTITY_MISMATCHとして拒否する。reconstructWorkflow()は全登録名の確認後にFactoryを呼び、未登録Job／Check、曖昧な登録、無効なFactoryの既存エラーを維持する。旧Prototype入口の関数・エラークラス・検証関数は、同一ビルド内で正式モジュールと同じ参照を再公開する。別ビルドのパッケージ間でクラス同一性を自動保証する意味ではない。

Repositoryは構造的に適合する既存実装を引き続き利用できる。Builderが直接使うのはgetであり、公開契約として既存のaddも維持する。正式UnitからPrototypeや未実装Core、具体的なDB Adapterへの逆依存はない。旧ポートファイル全体をUnitへ移してはいない。

### 前回実装時の検証結果

次表は前回の実装・検証セッションの結果であり、今回の資料整合に伴う再実行とは区別する。重複して実行される試験を含むため単純加算しない。

| 検証 | 前回結果 |
| --- | --- |
| Workflow Unit | 28 PASS |
| Factory・SQLite・WAITING・再開等 | 148 PASS |
| Definition・互換入口 | 20 PASS |
| 配布 | 4 PASS |
| ルート回帰 | 541 PASS |
| Migration管理 | 30 PASS |
| 影響したMigration検証（Workflow／TimeTrip／公開API） | 53 PASS |
| Build・型検査・独立パッケージの実行と型利用 | PASS |

前回、制限環境内のルート回帰は完走せず中断、Migration管理は29 PASS・junction作成拒否による1 SKIPだった。その後、許可されたローカルHTTP／junction試験権限で再実行し、上表の541 PASS／30 PASS（FAIL・SKIP 0）を確認した。Firestore Emulator試験は未実施であり、成功扱いしない。

### 配布・最終整合と対象外

旧配布生成器は正本の3モジュールを収録し、不要になった旧Port／Core宣言のコピーを除去した。クリーンBuild出力との照合と独立した一時展開環境での利用を検証した。最終配布候補は`@arch026/workflow-unit@0.3.0-framework.5`、SHA-256は`0f991280852155698d67077dcfba8b7836ef54b9a14fee2e82c45bd6351319bf`。途中生成のframework.4を含め既存アーカイブは上書きしない。正式Unitの既存package設定は`@arch026/workflow@0.1.1`のままであり、この記録はリリース・利用先導入の承認ではない。

前回のMigrationは30登録・29 VERIFIED・完了承認0で、編集中だった本READMEの検証済みSHAは保留した。今回の資料更新後は、既存verifierが実ファイル・依存指紋・成功結果を確認した場合のみSHAを更新する。最新状態は`Migration/reports/status.md`と`latest.json`を参照し、過去の結果は更新前証跡に保持する。今回の再実行結果は完了報告と最新証跡で確認し、上表の前回結果と混同しない。

名前付き成果物箱、共通成果物台の新しい管理規則、Event登録・通知・Workflow起動機構、postとEvent通知の正式な関係、Job／Check実装Version固定、DiagnosisのCMRP 6工程対応は未実装・未決定のまま。案B＋D、成果物配置とEventの設計決定、CMRP 6工程は変更していない。

## Workflow成果物管理 Stage 1 — Memory実装（2026-11-12）

本節は上記の未実装記録を更新する実装結果である。案BのArtifactManagerを正式Unitに追加し、既存Memory Shelfを実行インスタンスごとの共通台・名前付き箱として利用する。Event・永続化・新しい成果物配送規則は実装していない。

### 公開APIと接続

正式ルート`@arch026/workflow`からArtifactManager、ArtifactReadPort、ARTIFACT_DEFINITION_SCHEMA_VERSION、NativeJobFormRegistrationを利用できる。

- `new ArtifactManager(boxes?: readonly string[], defaultShelf?: ProductShelf)`：defaultは予約名。省略時は独立したShelfを生成する。
- `hasBox(name): boolean`、`reader(name = 'default'): ProductReader`、`shelf(name = 'default'): ProductShelf`、`readPort(): ArtifactReadPort`。
- 読取Portは`hasBox(name)`と`box(name = 'default')`のみを提供する。各boxはhas/getだけを公開し、putを公開しない。ShelfのstructuredClone、has/getの既存意味を維持する。
- `bindRun`／`assertResume`は実行境界向けinternalメソッドであり、業務処理からの利用入口ではない。

Registryの新しい`nativeForms`は`Map<jobId, {form: CJobForm<unknown,unknown>, artifactKey: string}>`。正式Formは再利用し、訪問ごとに独立したExecutionContextを生成する。旧registry.jobsの構築時生成、jobFormsの訪問時生成とonCreate、Checkの構築時生成・訪問時評価は従来どおりである。

Builderは構造検証・登録検査をFactory呼出し前に実施し、管理領域とStep出力先を接続する。構築結果の`artifacts`が管理領域である。Contextの`products`は共通台への互換入口、`outputProducts`は既定postの公開先、`artifacts`は名前付き箱の読取Portとなる。FormはWorkflow全体やArtifactManagerを保持しない。

```typescript
// collect(products, context)内。返値の型・業務検証はFormが担当する。
const value = context.artifacts?.box('review').get('X');
```

### Definition Schema

既存/1・WAITING対応/2を変更せず、`prototype-workflow/3`を追加した。依頼書の文字列`"2"`は提案例であり、既存の版規則に合わせた追加版とする。旧Schemaは新フィールドを引き続き拒否する。

```json
{
  "schemaVersion": "prototype-workflow/3",
  "definitionId": "artifact-example",
  "definitionVersion": "1",
  "startStepId": "produce",
  "artifactBoxes": ["review"],
  "steps": [
    {"stepId":"produce","stepNo":10,"kind":"JOB","jobId":"sample.produce","output":{"box":"review"},"nextStepId":"consume"},
    {"stepId":"consume","stepNo":20,"kind":"JOB","jobId":"sample.consume"}
  ]
}
```

/3はartifactBoxes必須（空配列可）。JOBのoutputは任意で、指定時は宣言済み箱またはdefaultだけを許可する。未宣言・重複・空名・不正型・未知フィールドを拒否する。出力先省略時はdefault。箱名とartifactKeyは別の識別子である。/3のJOBはnativeForms登録のみ対応し、旧CJob／構造型Form・同名の重複登録はUNSUPPORTED_ARTIFACT_JOBとして生成前に拒否する。旧経路への名前付き取得対応は未実装で、暗黙のdefault書込は行わない。

### CMRPと実行独立性

prepare → collect → make → record → post → cleanupの6工程、execute(context)のPromise<void>、業務Repository注入を維持し、initは追加していない。record成功後の内部成果と、postによる共有公開は別の境界である。既定postだけが解決済みShelfへartifactKeyで公開する。post上書き時に既定公開を自動追加しない。record失敗では非公開、post公開後の失敗・cleanup失敗では公開を取り消さない。同じ箱・同じキーは上書きする。

同じDefinitionからの各構築は独立した管理領域を持つ。同一Formの並行利用・循環はContextで分離する。明示的な既存共有Shelf注入（registry.jobForms.products）はdefaultに限り維持する。独立したrunIdには新しい管理領域・構築結果を用いる。同一管理領域の別runId利用はARTIFACT_RUN_MISMATCHで拒否する。

### WAITING／LIMIT_REACHEDと配布

同一プロセス内で同じ管理領域を保持する再開に対応する。同じworkflowのresume／resumeWaitingは領域を保持する。再構築する場合はreconstructWorkflowの第5引数に元のartifactsを渡す（第4引数continuationは既存の履歴契約）。loadWorkflowには第6引数として渡せる。履歴だけを渡した再構築、未使用の新領域からのresumeはARTIFACT_RESTORE_UNSUPPORTEDで拒否し、WAITING claim前に停止する。

プロセス再起動後の箱復元・JSONからの復元は保証しない。Snapshotや既存Store保存はShelf永続化ではない。SQLite／WAITING StoreのSchemaは変更していない。旧SchemaのデフォルトShelf再開経路は変更していない。

正式パッケージの一時pack・展開環境で、新APIの実行と型利用を試験する。旧workflow-unit生成器は新しい内部モジュールを収録し、保全済みアーカイブを上書きしないよう候補を`0.3.0-framework.6`へ更新した。旧配布ルートのCJobForm構造型契約を新しい実装基底クラスへ置換する変更は行っていない。

### 今回の検証と残課題

Unitは旧28件＋新18件の46 PASS。Definition・CMRP・Factory・SQLite・WAITING／再開関連181 PASS、配布6 PASS（正式パッケージの独立実行・型利用を含む）。Build・型検査もPASS。試験には重複があり単純加算しない。最終Migration状態はMigration/reports/status.mdを参照する。

後続課題は成果物の永続化・再起動復元、旧構造型Formへの名前付き読取対応である。Event機構・postとの正式な関係・Diagnosisの6工程対応等の従来課題は未変更。

Migration初回検証では別プロセス復元拒否試験が既存の子プロセス禁止ガードによりFAILとなった。ガードは変更せず、この1件を通常の配布試験へ移した。初回証跡はMigration/reports/history/artifact-stage1-first-verification.jsonに保持し、最新再検証と区別する。

## Artifact Snapshot Stage 2-1（2026-11-13）

Stage 1のMemory管理に、全箱SnapshotとCodecを追加した。SQLite保存・Workflow再開接続は未実装のままである。CWorkflow、CJobForm、CMRP6工程、executeの戻り値は変更していない。

### 正式API

- `manager.createSnapshot(): ArtifactSnapshot`
- `ArtifactManager.fromSnapshot(input: unknown, declaredBoxes?: readonly string[]): ArtifactManager`
- `validateArtifactSnapshot(input: unknown): ArtifactSnapshot`
- 型：ArtifactSnapshot、EncodedArtifactValue
- 定数：ARTIFACT_SNAPSHOT_FORMAT_VERSION、ARTIFACT_SNAPSHOT_CODEC_VERSION

既存hasBox／reader／shelf／readPortは維持する。fromSnapshotはインプレースrestoreSnapshotの代わりに、全検証後に新しいManagerを返す。失敗時に既存Managerや入力Snapshotを変更しない。宣言箱の引数を指定した場合、default以外の箱集合を完全一致で検証する。Definition ID／Version照合は本APIの責務ではない。

復元ManagerはrunId未結合であり、Stage 1のassertResumeによる拒否を解除しない。SnapshotにはrunId・Definition・Lease・Workflow履歴を含めない。これらとの結合・検証済み再開はStage 2-2の対象である。

### Snapshot形式

```json
{
  "formatVersion": "artifact-snapshot/1",
  "codecVersion": "artifact-json/1",
  "boxes": [
    {"name":"default","entries":[
      {"key":"applicant","encodedValue":{"type":"string","value":"山田"}},
      {"key":"unset","encodedValue":{"type":"undefined"}}
    ]},
    {"name":"review","entries":[]}
  ]
}
```

全箱・空箱を含み、default必須。箱名とキーを辞書順（UTF-16コード単位の比較）で正規化する。オブジェクトのプロパティも同様に正規化し、配列順は維持する。同じ現在値から同じJSONを生成する。未登録キーはentryなし、登録済みundefinedは明示タグで区別する。

EncodedArtifactValueは次の再帰的な判別共用体である。

- `{type: 'undefined'}`／`{type: 'null'}`
- `{type: 'boolean', value: boolean}`／`{type: 'string', value: string}`
- `{type: 'number', value: 有限number | '-0'}`（負のゼロだけ文字列タグ）
- `{type: 'array', value: EncodedArtifactValue[]}`
- `{type: 'object', value: {key: string, value: EncodedArtifactValue}[]}`

概念案のtype=jsonではなく、全階層を型付きにして入れ子のundefined等のJSON変換損失とタグ衝突を防ぐ。NaN／Infinity／BigInt／Date／Map／Set／Function／Symbol／循環参照・非対応オブジェクトを拒否する。Codec入力の疎配列、余分な配列プロパティ、accessor、Symbolキー、非列挙プロパティも拒否する。Snapshot内の未知フィールド、重複箱／キー、不明Version、不正タグも拒否する。

復元オブジェクトはObject.definePropertyで自有データプロパティを構築する。__proto__／constructor／prototypeもsetterとして実行せず、データとして保持する。深さ128、単一値の探索100000ノード、各配列100000要素、Snapshot全体100000entryを上限とする。入力getterやtoJSONはCodecから呼び出さない。

既存ShelfのstructuredClone契約は維持する。SnapshotはShelfが現に保持する値を符号化するため、put時の既存structuredCloneによる変換まで逆算するものではない。Memoryでは扱えてもCodec非対応の値が残る場合、Snapshot生成を失敗させる。

### 所有Shelfと外部共有Shelf

Manager所有のShelfは既存Memory Shelfを利用し、成功したputのキーを管理する。値はShelfから読み、Snapshot側と参照を分離する。明示注入したdefault Shelfは、空の場合や既存Memory Shelfの場合も、外部共有ShelfとしてSnapshot生成時にARTIFACT_SNAPSHOT_EXTERNAL_SHELFで拒否する。外部Shelfの内部Mapを探索せず、通常の共有Memory動作は維持する。

### 配布・検証

正式ルートでAPI・型を公開し、独立パッケージ展開環境でJSON往復・型利用を確認する。旧配布生成器はArtifactSnapshot内部モジュールを収録する。保全済みframework.6等を上書きせず、新候補framework.7を使用する。正式Unitの既存バージョンと依存設定は変更していない。

専用20試験＋既存46試験のUnit計66件を実行する。Migrationの既存32資産を保全し、新しいCodecと専用試験をNEW登録する。最新検証・指紋はMigration/reports/latest.json、状態はstatus.mdを参照する。COMPLETE承認は行わない。

### Stage 2-1 入力検証の安全性修正（2026-11-13）

最終レビューで、配列サブクラスのmap getterが呼び出され、Snapshotが受理される欠陥を確認した。従来の66 PASSや34 VERIFIEDはこの欠陥を検出していなかった検証履歴として残す。

修正後は、入力配列をArray.prototype直下の通常配列に限定し、length・各インデックスの自有データ記述子を確認する。入力のmap／forEach等のメソッド・iterator・インデックスgetterを利用しない。プレーン／null-prototypeオブジェクトも、反射で取得した自有データ記述子から一時データへ取り込み、元入力のプロパティを直接読まない。各階層のアクセサ、非標準プロトタイプ、配列サブクラスは拒否する。Codecの入れ子構造と、fromSnapshotの任意declaredBoxes引数も同じ境界で検証する。

fromSnapshotは検証後の独立した正規化データだけで復元し、元Snapshotのgetterやiteratorを参照しない。既存Managerは変更せず、復元品はrunId未結合のまま。Snapshot／CodecのVersion・公開API・undefined／負のゼロ表現・CMRP・Workflow制御は変更しない。

Proxyはサポート対象外である。getPrototypeOf／ownKeys／getOwnPropertyDescriptor自体がProxy trapを実行し得るため、任意のProxyについて副作用ゼロや必ず拒否できることは保証しない。透過的Proxyが通過する場合もある。通常のJSON.parse結果と通常のデータオブジェクト・配列が入力契約であり、本検証は不正コードのsandboxではない。

安全性12試験を既存Snapshot専用ファイルへ追加し、getter呼出し回数0、継承iterator非実行、入れ子アクセサ、宣言リスト、Factoryの非破壊性、正常往復、参照独立性を検証する。Proxyの反射trapが発生し得ることも明示的に試験する。独立パッケージでもmap getterの非実行を確認する。保全済みframework.7を上書きせず、配布試験の候補はframework.8へ更新する。

## Stage 2-2A：SQLite Artifact Checkpoint保存（2026-11-13）

既存WaitingHistoryStoreの保存経路にArtifact Snapshotを統合した。既存のwaiting_runs(run_id, state_json)、SQLite user_version=1、row.schemaVersion=1は変更せず、テーブル追加・Open時Migrationも行わない。別Storeは追加していない。

### Checkpointと公開Port

IWorkflowHistoryStoreに任意の`saveCheckpoint(workflow: RunSnapshot, artifacts: ArtifactSnapshot): void | Promise<void>`を追加した。ArtifactManagerを持つCWorkflowは、対応Storeの場合に限り、既存persist境界でcreateSnapshotを呼び、このPortへ両Snapshotを渡す。保存失敗時にsaveへフォールバックしない。未対応Memory StoreやArtifactManagerを持たない旧Workflowは従来のsaveを利用する。

Snapshot取得は開始時・各Job/Check完了後・FAILED・WAITING・LIMIT_REACHED等の既存保存境界で行う。recordの内部成果を直接読まず、Managerの公開済みShelfだけを対象とする。post公開後失敗やcleanup失敗でも、公開済み成果はFAILED Checkpointに残る。

### state_jsonの追加形式

既存rowのDefinition識別、snapshot、revision、owner、operations、activeOperationId等を維持し、保存対応経路では次のcheckpointを追加する。

```text
checkpoint:
  formatVersion: workflow-checkpoint/1
  workflowSnapshot: root snapshotと同値
  artifactSnapshot: artifact-snapshot/1 / artifact-json/1
  revision: root revisionと同値
  operationIdentifier: root activeOperationIdと同値
```

旧Checkpointはcheckpointフィールドなし、新Checkpointは上記明示形式で区別する。Artifact Snapshotは正式Validatorを再利用し、独自に再定義しない。Checkpoint識別はrunId＋revision、operationIdentifierは既存のSTART/RESUME操作IDであり、保存ごとの新しい操作IDを導入したものではない。Definition ID／Version／Digestは既存Store設定を保存する。BuilderのDefinition実体とのDigest照合はStage 2-2Bで行い、今回新たに保証したことにしない。

### Transactionと障害

WaitingHistoryStore.saveCheckpointはArtifact Snapshotを先に検証・分離してから既存保存処理へ入り、SQLite Backendの同じBEGIN IMMEDIATE内で所有権・fence・lease・Revision・履歴整合性を検証する。WorkflowSnapshot・ArtifactSnapshot・Revision・操作完了記録・WAITING lease解放をstate_jsonの一回の更新とCOMMITで確定する。

Snapshot生成／Validatorエラーは書込Transactionに進まない。BEGIN失敗、Transaction内失敗、COMMIT結果不明は既存分類を維持し、CWorkflowのHISTORY_SAVE_OUTCOME_UNKNOWNを弱めない。OUTCOME_UNKNOWNの後はStoreをpoisonedとし書込を拒否する。読戻し一致は観測結果であり、応答喪失を成功へ置き換えない。業務DB・通知等の外部副作用をRollbackしたという保証はない。lease検査は既存Transaction内の時刻契約を維持し、commit瞬間の有効性まで新たに保証するものではない。

### 読戻しと互換性

低レベルWaitingHistoryStore.readCheckpoint()はDefinition識別、WorkflowSnapshot、正式Validatorで検証したArtifactSnapshot、Revision、操作ID、ownerを返す検証用の独立DTOである。Manager復元・runId結合・claimは行わない。root snapshotとcheckpoint.workflowSnapshot、Revision、activeOperationIdの一致も読込時に確認する。

新Checkpointに対するSnapshotなしsave、旧productsへのput、旧データからの暗黙昇格を拒否する。新CheckpointのclaimWaiting/claimLimitはARTIFACT_CHECKPOINT_RESUME_UNSUPPORTEDで書込前に拒否する。旧Checkpointのoperation再送・WAITING/LIMIT_REACHED再開・旧CJob経路は維持する。旧バイナリへ新Checkpointを渡すダウングレード互換性は保証しない。

本機能はWAITING SQLite経路が対象で、低レベルMemoryLifecycleBackendでも同じ原子的状態更新ロジックを利用する。公開MemoryWaitingStore WrapperやFirestore Adapterへ新機能を展開していない。既存の明示共有ShelfによるMemory実行は維持するが、SQLite Checkpoint生成で外部Shelfが拒否された場合、Memoryへ自動切替しない。

### 配布・後続工程

正式Unitの型付きPortと、独立パッケージでのCheckpoint呼出しを検証する。旧配布候補を上書きせずframework.9を利用する。SQLite自体を旧配布パッケージへ混入させない。

Stage 2-2Bへ残すもの：別プロセス再開、Definitionと保存内容の照合、検証済みManager復元、runId結合、Revision再検証とclaim接続。新Checkpointの再開ガードは2-2B実装まで維持する。Snapshot/Codec Schema、CMRP6工程、Job公開境界、既存SQLite再開機構、Eventは変更していない。

### Stage 2-2A：Checkpointと操作履歴の整合性修正（2026-11-13）

レビューで再現した3件（操作Revision不一致、WAITINGに対するRUNNING操作、操作Snapshotの待機理由不一致）は、Checkpointとroot rowの照合だけでは検出できなかった。操作履歴の確定Revisionを単に1以上・row Revision以下とする既存範囲検査では、同じ確定世代の証明にならなかった。

保存処理から確認した正式な意味は、checkpoint.operationIdentifier＝row.activeOperationId＝現在の実行操作のIDである。「最後に確定した過去操作」を選択する識別子ではない。START／RESUMEはRUNNING操作を作り、各RUNNING保存でrow/checkpoint Revisionだけを進める。WAITING／LIMIT_REACHED／COMPLETED／FAILED保存では、同じTransactionで操作をFINISHEDにし、確定RevisionとWorkflowSnapshotを記録してownerをRELEASEDにする。

共通のvalidateCheckpointConsistency(row)を読込時のvalidateと、保存処理の確定前から呼ぶ。操作はIDで一意に特定できなければ拒否する。RUNNING Checkpointはowner ACTIVE・操作RUNNING・確定Snapshot/Revisionなしを要求する。確定済みCheckpointはowner RELEASED・操作FINISHED・operation.revision＝checkpoint.revision＝row.revision、および操作Snapshot＝Checkpoint Snapshot＝row Snapshotを要求する。

Snapshotは既存のDTO検証に通し、既存isDeepStrictEqualで比較する。プロパティ順は無関係だが、Step・状態・履歴・WAITING理由/世代/次工程・failure等は比較対象になる。Artifact Snapshotは既存ValidatorでVersion・構造・箱/キー重複等を検査する。Definitionの箱宣言実体はこのStoreにないため、その照合はStage 2-2Bへ残す。

不整合は既存DATA_CORRUPTで拒否する。新Checkpoint内の不正な保存Snapshotから生じた入力エラーも、読込境界ではDATA_CORRUPTへ揃える。旧Checkpointには新規必須項目や新しいエラー分類を適用しない。read／load／readCheckpoint／更新前検証は同じ経路を利用し、不正データを自動採用・修復しない。新Checkpointの再開拒否は維持する。

回帰試験は修正前に既存23 PASS・新規3 FAILを記録し、修正後は3件すべてPASS。追加検証途中ではエラー分類差で38 PASS・1 FAILとなり、分類を修正した。これらのログと更新前証跡はMigrationのhistoryへ保全する。追加16試験を含むCheckpoint試験39件で、欠落・重複操作、不明Version、Snapshot欠落/不正、プロパティ順、RUNNING中間状態、DB非変更、Store/Workflow経由の再開拒否も検証する。

保存Transaction、Revision更新、lease解放、UNKNOWNガード、SQLite Schema、CMRP、Artifact Snapshot Schema、Manager公開APIは変更していない。保全済みframework.9を上書きしないため、配布候補はframework.10とする。Stage 2-2Bは未実装のままである。

## Stage 2-2B：SQLite Checkpointの復元・明示的再開（2026-11-15）

本節が現在の実装状態である。上記Stage 1／2-1／2-2Aの「復元・新Checkpoint再開は未実装／拒否」は当時の履歴として保持する。旧APIによる新Checkpointの暗黙再開は引き続き拒否し、以下の専用入口だけを接続した。

### 正式入口と責務

- `restoreWorkflowCheckpoint(definition, registry, store)`：正式Unit／Prototype互換入口から公開する非同期Builder関数。`prototype-workflow/3`を検証し、StoreからCheckpointを取得してDefinitionを照合した後、既存`ArtifactManager.fromSnapshot(snapshot, definition.artifactBoxes)`と`reconstructWorkflow()`を呼ぶ。戻り値は既存の構築結果（definition／workflow／startStepNo／artifacts）に`checkpoint`を加えたもの。claimやJob実行はしない。
- `CWorkflow.resumeCheckpoint(checkpoint, request, maxExecutions=100, beforeStep?)`：既存実行ループへ接続する。WAITING／LIMIT_REACHEDの実行位置と構築済み工程の整合性を確認し、Storeでclaimが成功した場合だけManagerをrunIdへ結合して継続する。CMRP6工程・Factory・Check評価・履歴の訪問番号・公開済み成果物の保存境界は維持する。
- `IArtifactCheckpointStore`：既存History Portを拡張し、`readCheckpoint()`、`validateCheckpointDefinition(checkpoint, definition)`、`claimCheckpoint(checkpoint, definition, artifacts, request)`を定義する。`ArtifactWorkflowCheckpoint`と`CheckpointResumeRequest`も型公開する。Definition解釈とDigest照合はBuilder／Store側に置き、CWorkflowは具体的なSQLiteやDefinition解析に依存しない。
- `WaitingHistoryStore`：既存SQLite BackendのTransaction、Revision／lease／operation履歴を再利用する。SQLテーブル、DDL、user_version、Checkpoint／Artifact Snapshot形式は変更しない。別のRunnerやCheckpoint Storeは追加しない。

要求はWAITINGなら`{kind:'WAITING', operation:{runId, operationId, expectedWaitGeneration, expectedRevision, result}}`、LIMIT_REACHEDなら`{kind:'LIMIT_REACHED', operationId, expectedRevision}`とする。LIMITにも明示的なIDとRevisionが必須で、既存`claimLimit()`を経由する。WAITINGは既存`claimWaiting()`を経由する。これらの旧APIを単独で呼んで新Checkpointのガードを解除することはできない。

### Definition・Snapshot照合

Definition ID／Version／Digestの全一致を必須とする。Digestは既存Firestore composition/storeと同じ「`validatePrototypeDefinition()`後の`JSON.stringify()`をSHA-256」の契約を利用する。SQLite側の`definitionDigest(input)`も同じ計算を公開する。新しい正規化方式や照合省略オプションは導入しない。登録時に別方式で作ったDigestは、今回の厳密照合では利用できない。

保存箱集合はDefinitionの宣言＋defaultと完全一致させる。未宣言箱・欠落・重複・不明Codec／形式は拒否する。既存Validatorと復元Factoryにより空箱・明示undefined・参照独立性を維持する。取得したDefinitionやCheckpointで宣言を上書きしない。

### claim・runId結合

1. 読み込み、整合性／Definition／全箱検証、未結合Manager復元、既存Builderによる構築。
2. 新規claim時はSQLite Transaction内で現在rowを再読込し、Revision、Checkpoint全体（Snapshot・成果物・操作ID・ownerを含む）、Definition、要求世代、状態、lease RELEASEDを照合する。Revision一致だけでは許可しない。
3. 新しいowner/token/fence、RUNNING操作、Revision、SnapshotとCheckpointの識別情報を同じTransactionで更新する。WAITINGでは確定操作結果をinputへ保存し、保存済みnextStepへ進む。LIMITでは保存済みcurrentStepを継続する。
4. 成功応答後、claim待機中にManagerが変更されていないことも確認し、CWorkflow内部だけからrunIdを結合する。復元Managerの通常`bindRun()`は`ARTIFACT_CLAIM_REQUIRED`で拒否する。内部結合関数は正式ルートexportに含めない。

Workflow／Storeは信頼するアプリケーション構成要素であり、任意コードの改変・偽造Storeに対するセキュリティsandboxではない。公開契約上のclaim省略・任意runId結合経路は提供しない。

### 状態・冪等性・障害

WAITING／LIMIT_REACHEDだけが新規実行claimの候補である。RUNNING／FAILEDを自動再実行せず、COMPLETEDも実行再開しない。ACTIVE leaseは期限切れでもこの経路では自動takeoverしない。旧Checkpointの再開契約は変更しない。

同一操作IDのFINISHED receiptは永続化済みSnapshotを読み取り専用で返し、claim・Manager結合・Job再実行を行わない。異なる要求内容は`OPERATION_CONFLICT`、未確定操作は`OPERATION_IN_PROGRESS`。これは完了済みWorkflowの実行再開を意味しない。既存履歴は消去しない。

破損は`DATA_CORRUPT`、Definition不一致は`DEFINITION_CONFLICT`、Revision変更は`REVISION_CONFLICT`、owner競合は`CLAIM_BUSY`、読込後のCheckpoint／成果物変化は`RESUME_STATE_CHANGED`で停止する。追加の入口識別には`CHECKPOINT_NOT_FOUND`／`CHECKPOINT_NOT_RESUMABLE`／`ARTIFACT_CLAIM_REQUIRED`を利用する。claim結果不明は既存`OUTCOME_UNKNOWN`、Job後の保存結果不明は`HISTORY_SAVE_OUTCOME_UNKNOWN`を維持する。自動修復・Memoryフォールバック・不明状態からの自動再試行は行わない。

claim直後の終了ではRUNNINGと操作RUNNINGが残り、手動調査が必要となる。外部副作用とCheckpoint保存の原子性は保証しない。副作用後に保存失敗しても副作用をRollback済みと扱わず、同じ操作で再実行しない。

### ローカル検証と配布

`node --test tests/workflow-artifact-resume.test.cjs`は一時SQLiteを使う同一プロセス契約試験。`node --test tests/workflow-artifact-resume-process.test.cjs`は実際のforkプロセス間で保存／終了／復元／競合／claim後終了／応答喪失／副作用後保存失敗を検証する。fixtureは合成データのみで実サービスを利用しない。

Migrationのguarded検証は前者だけを実行し、後者と子プロセスfixtureは入力指紋に含める。子プロセス禁止・ネットワーク禁止ガードは緩和しない。実プロセス試験の実行結果は別証跡とし、guard内で実行したように扱わない。

配布生成器の互換パッケージにも復元Builderを公開する。既存30配布ファイルと途中生成候補framework.11を上書きせず、最終候補は`0.3.0-framework.12`とする。SQLite Backend自体の独立配布は従来どおり対象外。Firestore、包括的障害注入、外部DB Transaction統合はStage 2-2Bに含まない。

### Stage 2-2B：実行直前の所有権検証修正（2026-11-15）

最終レビューで、claim成功後の`beforeStep()`待機中にleaseが失効すると、後続Jobが実行されてから保存時にLEASE_EXPIREDとなる欠陥を再現した。前節までの試験結果は修正前の記録であり、Job実行前のstale Host拒否を保証していたとは扱わない。旧stale Host試験は保存拒否のみを確認していた。

History Portへ任意の`assertCanExecuteStep(snapshot: RunSnapshot): void | Promise<void>`と`requiresExecutionOwnership`宣言を追加した。SQLiteのWaitingHistoryStoreは必須宣言を持ち、復元用`IArtifactCheckpointStore`では検証メソッドを必須とする。未接続・実行途中の切断は拒否する。Memory専用History Storeや未対応の旧AdapterへSQLite依存を追加せず、新しいRunnerは設けない。

既存ループ内で、任意`beforeStep`の直前、同Hook終了後の訪問時Factory呼出し直前、Factory生成後のJob／Check評価直前に検証する。Hookは従来の実行前処理のままとし、所有権検証の代用にしない。BuilderでのJob／Check構築タイミングは変更しない。構築用Factoryに業務副作用を持たせる契約は導入せず、実行時の処理を上記境界で保護する。

WaitingHistoryStoreはclaim時に操作IDをHost内へ記録する。`assertCanExecuteStep()`はSQLite Backendの`inspect()`でTransaction内の現在rowとSQLite由来の時刻を読み、runId、owner ID／token／fence／ACTIVE、lease期限、Host保持Revision、claim時操作IDと現在操作ID、操作RUNNING、Workflow RUNNING、実行位置・履歴等のSnapshot一致を確認する。保存・lease更新・Revision更新・claim・owner変更を行わない。inspectは既存SimpleDB Transactionを使う読取処理で、SQL Schema／DDLは変更しない。

検証エラーは正式公開の`WorkflowExecutionOwnershipError`で通知する。原因がLEASE_EXPIRED／FENCED／REVISION_CONFLICT／OPERATION_CONFLICT等なら`EXECUTION_OWNERSHIP_REFUSED`・outcome REFUSED、DB接続障害・検証結果不明・PERSISTENCE_UNCERTAIN等なら`EXECUTION_OWNERSHIP_UNKNOWN`・outcome UNKNOWNとする。元の原因コードはcauseに保持する。Portの初期未接続は`EXECUTION_OWNERSHIP_REQUIRED`。不正状態ではJob／Check／後続Hookを呼ばず、失効した資格でFAILED保存を試みない。自動再試行・Memoryへの切替・無断再claim・runId再結合も行わない。既存の保存結果UNKNOWN契約は変更しない。

**実行直前検証は検証時点の所有権を確認するだけであり、外部副作用を原子的に保護しない。** 検証後やJob実行中にlease失効・所有権変更が起こる余地は残る。外部システム側の冪等性・fencing token・Transaction連携が必要であり、包括的な障害評価はStage 2-2Cへ残す。今回それらを実装したとは扱わない。

専用試験は`node --test tests/workflow-execution-ownership.test.cjs`。元の再現ケースを修正前FAILとして残し、修正後は実行件数0・SQLiteのLEASE_EXPIRED・Checkpoint非進行を確認する。実際の新Host claim後の旧Host実行／保存拒否、Revision／操作変更、Check／Hook／Factory境界、DB障害とUNKNOWN、Memory互換性も確認する。既存別プロセス試験にはlease失効時の実行件数0を追加した。保全済み候補を上書きせず、修正版の配布候補は`0.3.0-framework.13`とする。
