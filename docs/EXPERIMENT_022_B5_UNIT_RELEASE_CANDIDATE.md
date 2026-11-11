# 実験022-B5 Workflow Unit配布候補

実施日: 2026-11-09。対象はARCH-026のみ。判定は **CONDITIONAL（開発環境・Firestore Emulator限定）**。桜風館への導入、Stage、Commit、Push、Deployは実施していない。

## 1. 固定成果物と再現性

|項目|結果|
|---|---|
|パッケージ|`@arch026/workflow-unit@0.2.0-experiment.022.4`|
|ファイル|`runtime-data/workflow-unit/arch026-workflow-unit-0.2.0-experiment.022.4.tgz`|
|サイズ|29,067 bytes|
|SHA-256|`0001f061d763dfcd219c677d635104e4278982ec02293d523b05c6be24a1b691`|
|manifest SHA-256|`4970bdf2f3606e1c809ddb640b3ebcad97fd2c2d94b83f9c23de419f0317f028`|
|生成元HEAD|`26f22fdcafb1276f8a32d31629cef52759436d03`（未コミット成果を含む）|

同名`.tgz.json`に配布ファイルごとのSHAを記録した。HEADだけでは未コミット成果を識別できないため、manifestの入力・配布ファイルハッシュとtarball SHAを併用する。再生成でも同じSHAとなることを確認した。生成処理は同一バージョンで内容が異なる成果物の上書きを拒否する。

既存022.2にはB4 WAITING Adapterが含まれないため、そのバージョンを再利用しなかった。初回候補022.3は互換性確認で不足が判明したため保全し、022.4を最終候補とした。

|保全した版|サイズ|SHA-256|
|---|---:|---|
|0.1.0-experiment.021.1|20,237|`e7f97e55ed2da17adf32cb7358df39c816ed7e929ea4c7dee1b87d0aafda34c4`|
|0.2.0-experiment.022.2|24,273|`676c4f5eaa41667ed9f247866e5a5e8bffba451c2822a04ecf90093dd786dfc2`|
|0.2.0-experiment.022.3（非採用）|28,980|`11aec62cdf405919888120c2c0ec812685fbac1dfba25536a9733130e367db7a`|

## 2. 公開API・配布範囲

ルートの実行時公開APIは次の20件に限定した。

```
WorkflowValidationError CWorkflowTask CJob CDummyJob CCheckJob CSequenceBool
WorkflowRunError CMemoryHistoryStore CWorkflow CWorkflowMonitor
createMemoryProductShelf bindJobForm
DEFINITION_SCHEMA_VERSION WAITING_DEFINITION_SCHEMA_VERSION DefinitionError
validateDefinitionKey validatePrototypeDefinition reconstructWorkflow loadWorkflow
diagnoseSavedRun
```

`CJobForm`はTypeScriptの契約であり、実行時クラスではない。既存CJobとcollect→make→record→post、Checkの意味、LIMIT_REACHED再開を変更していない。prepare/cleanupやCREATEDを今回新設していない。

サブパス`/waiting`は`MemoryWaitingStore`と型付き永続化契約を公開する。`/firestore`は既存の`connectEmulator / validateEnvironment / leaseValid / PersistenceError / fail / Timestamp / FieldValue / FirestoreExperimentStore / hash / createExecution`に`FirestoreWaitingStore`を追加する。旧版の偶発的公開APIだった`fail`も互換性のため非推奨として保持した。`/manifest`から配布manifestを参照できる。

新しいStore facadeは内部backend、worker、所有権credential、故障注入hookを公開しない。productsは凍結した登録・取得の能力だけを返す。exports mapによって内部へのdeep importを拒否する。既存の公開クラスを削除して完全な秘匿化を図る変更は行っていない。

配布対象はprototypeのworkflow/job-form/definition/diagnosisのビルドと宣言、Port・共通型の宣言、Firestoreのemulator/store/composition/waiting、Memory用lifecycleと公開facade。未実装`src/core/WorkflowEngine`の実行コード、SQLite、SimpleDB、GUI、道場業務処理は含めない。

## 3. 依存関係と実行環境

- Node.js `>=24 <25`、CommonJS、TypeScript ES2022。ES Modulesからのdefault importも実測した。
- 外部実行時依存は`@google-cloud/firestore` **9.3.1固定**。推移依存は導入先lockで固定する。独立試験では122パッケージをoffline導入し、同じlockでnpm ciも成功した。
- TypeScript 5.9.3、strict、NodeNext、`skipLibCheck:false`で配布宣言とSDK宣言を検査した。
- Node標準機能（crypto/util等）を利用する。SQLiteパッケージ・node:sqliteのロードを禁止した状態でも全配布試験が成功した。
- Cloud Runで使用可能なNode 24向けパッケージ形式だが、Cloud Runビルド・Deployは未検証。現在のFirestore AdapterはEmulator専用であり、本番Firestore対応を保証しない。

## 4. 独立配布物試験

`npm run test:unit-release`（`tools/test-unit-release.cjs`）は、生成tarballと旧tarballをARCH外の新しい一時ディレクトリへコピーし、file依存としてインストールする。テスト・型検査とも導入済みパッケージを利用し、ARCHソースをimportしない。NODE_PATH等を除去し、モジュールのロード先が独立環境内であることも検査する。SDK・TypeScriptもその環境へ導入する。

最終試験は **26 PASS / 0 FAIL**。

|試験|確認した保証|
|---|---|
|P01–P04|配布manifest全ファイルSHA、公開API、私有領域、SQLite非混入、CJS/ESM、strict型検査|
|P05–P07|実際のCWorkflow/CJob/CJobForm、Memory WAITING保存、Lease解放、TRUE/FALSE、再開、重複・内容変更・古い世代・Revision拒否|
|P08|旧版公開API互換、逐次・Check・LIMIT_REACHEDの動作比較|
|P09–P12|Firestore WAITING保存・復元、Lease解放、再開、重複照合、世代・Revision拒否、再待機|
|P13–P15|stale HostのFENCED拒否、別プロセス復元・再開、2子プロセス競合の勝者最大1件|
|P16–P18|WAITING保存応答喪失、claim応答喪失、UNKNOWN照合・封印、無条件再実行防止|
|P19–P26|旧COMPLETED/LIMIT_REACHED/RUNNING/FAILED読込・再開条件、保存領域分離、未知Schema拒否、本番設定拒否、旧Unitの新WAITING拒否|

Firestoreは専用の合成project・loopback Emulatorのみ使用。所有権検証と保存の既存トランザクション境界を維持する。故障注入はSDKトランザクションの実commit後に応答だけ失わせる方式で行い、Coreを置換していない。APPLIEDの観測対象がclaimの場合、Job完了を意味しない。実行中の同一操作を再送してもJobは再実行しない。Leaseのcommit時点有効性を新たに証明したとは主張しない。

最終証跡: `runtime-data/unit-release-evidence-1794214647221.json`。導入先は`%TEMP%/arch026-unit-release-3ABPI7`。consumer lock SHAは`7a7649b802172198acd654e3f89b4d35760971172ab01e12a5359ff715557c93`。lock、consumer設定、試験ログを`runtime-data/release-evidence-022.4-1794215016485/`にも保全した。試験用Emulatorは停止済み。証跡ディレクトリはignoredであり、将来配布する際はtarball・sidecarとともに別途保管する。

### 初回失敗と対応（省略しない）

022.3の初回smokeは6 PASS / 3 FAILだった。

1. Node16型解決ではSDK推移依存google-auth-library→gtokenのESM宣言がTS1479となった。Node24に対応するNodeNextへ独立試験設定を修正した。skipLibCheckによる隠蔽、依存の強制ダウングレードはしていない。
2. 旧firestore公開`fail`が新版whitelistから欠落していた。配布facade・宣言へ非推奨APIとして戻し、上書きせず022.4を生成した。
3. smoke選択式がEmulator開始前にP09まで選択していた。P01–P08だけに修正した。EMULATOR_REQUIREDによる拒否そのものは正しい挙動だった。

その後022.4は23件PASS、試験追加後の最終26件もPASS。同じ試験の再実行やsmokeを最終件数へ二重加算していない。

## 5. 全回帰・静的検査

|集合|PASS|ログ（logs/以下）|
|---|---:|---|
|npm test|529|022b5-npm-test.log|
|実験追加回帰|291|022b5-extra-regression.log|
|WAITING/診断・UNKNOWN|57|022b5-waiting-regression.log|
|Memory等|27|022b5-memory-regression.log|
|Firestore既存45＋B4 20|65|022b5-firestore-regression.log|
|従来パッケージ試験|2|022b5-package-regression.log|
|既存合計|**971**|FAIL 0|
|今回の独立配布物試験|**26**|022b5-isolated-release-result.log|
|最終合計|**997**|**FAIL 0**|

Build、prototype型検査、追加CJSのJS構文検査、git diff --checkも成功。Firestore依存試験を未実施でPASSとしたものはない。

## 6. 旧版・旧データの互換性

公開APIは旧版を実物インストールして比較した。既存run/resume/Checkの呼出しと戻り値を維持し、新規`resumeWaiting`とWAITING DTO/Portを追加する。再開操作はrunId・operationId・expectedWaitGeneration・expectedRevision・resultを持ち、保存済み同一操作は結果照合し再実行しない。異なる内容の同じID、古い世代、Revision不一致は拒否する。認可は呼出元責務。

|旧データ|実測した扱い|
|---|---|
|旧Definition v1|既存経路で利用可能。全業務定義の一般的互換性までは保証しない|
|旧COMPLETED|新legacy Adapterで読込可能。再開拒否|
|旧LIMIT_REACHED|合成・副作用なしfixtureで読込と安全な次工程再開を確認。完了済みAを再実行せずBのみ実行|
|旧RUNNING / FAILED|読込可能。自動再開拒否|
|未知schemaVersion=99|拒否。変換・自動補正しない|
|旧runs→新waitingRuns|別領域・別プロトコル。自動移行なし。変換設計が必要|
|新WAITING→旧Unit|拒否を確認。新版実行のdowngradeは不可|
|その他SQLite/Ticket等の旧データ|今回の配布互換試験対象外・未検証|

legacy形式とWAITING lifecycle形式は、同じschemaVersion数値でも同一形式ではない。新Storeが旧runIdを未取得として返すことを「旧実行が存在しない」証明にせず、実行ごとの版・プロトコル・保存領域を固定する。旧/newから生成したJob/Check実体を混用せず、選択したUnitで定義から再構築する。旧データは変更していない。

## 7. SQLite UNKNOWNと配布判定

022-B1-Rの履歴保存UNKNOWNの根本原因は**未解明のまま**。今回の回帰成功は原因解消の証明ではない。保存結果不明を成功扱いせず、poison・状態照合・明示的判断によって自動再実行を防止する。新配布物にSQLite実装は入らないため、そのSQLite固有障害の直接影響は配布物の実行対象外だが、ARCH開発基盤全体の残存リスクとして引き継ぐ。

**CONDITIONAL**の理由は、主要機能・独立配布・既存971回帰がPASSし、固定版とSHAを確認できた一方、SQLite UNKNOWN原因未解明、旧形式からWAITINGへの移行未実装、Emulator専用Adapter、実認証接続・本番Cloud Run未検証が残るため。開発環境で専用保存領域・合成データ・認可付き呼出し・UNKNOWN時の停止を守る限定導入は可能と判断する。本番利用READYとはしない。Fencing破綻や二重実行などの重大な新不整合は今回の試験では認めず、BLOCKEDとはしない。

## 8. 桜風館への導入手順案（今回は実施しない）

1. 旧版と既存lock・検証設定を保全し、新tarballとsidecarを版付きで搬入する。SHAと全manifestを照合する。
2. 固定file依存・lockを更新する。既存`cloud/workflow/unit.cjs`の旧ファイル名/ハッシュ検証、およびvendor配置設定を一体で更新する。依存だけを変更して検証を迂回しない。Unit本体を編集・コピー管理しない。
3. Node24でnpm ciし、既存API互換試験、配布同一性、権限拒否、WAITING、重複・競合、別プロセス復元、UNKNOWNを道場側Adapter経由で確認する。本試験のconsumer lockは旧版比較用aliasとTypeScriptを含むテスト用であり、道場lockをそのまま置換する用途ではない。
4. 旧実行はlegacy経路、新WAITING実行は専用namespaceに分離する。既存実行の自動移行や業務画面切替を行わない。認証・権限・業務Checkは道場側に残す。
5. 本番接続を許可しない開発設定で判定を再確認する。未確定事項を解消するまで本番Firestore/Cloud Runへ展開しない。

## 9. 今回の変更と引継ぎ

既存ファイルへの今回差分は`tools/package-workflow-unit.cjs`と`package.json`（単体試験入口）。追加は`tools/workflow-unit/{waiting,firestore}.{cjs,d.ts}`、`tools/test-unit-release.cjs`、`tests/unit-release/{scenario.cjs,child.cjs,consumer.ts,public.test.cjs}`、本報告書。合計12ファイル。Core・既存Adapter・道場側コードを今回変更していない。開始時から存在する多数の未コミット成果は今回の変更件数に含めない。

次工程へは、固定tarball・sidecar・consumer lockと試験証跡、旧/新プロトコル分離、SQLite UNKNOWN未解明、Emulator限定保証を引き継ぐ。022-Cへの着手は行わず、本報告時点で停止する。
