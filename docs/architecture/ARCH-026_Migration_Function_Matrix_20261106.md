# ARCH-026 マイグレート機能仕様・環境別対応マトリックス

- 整理日：2026-11-06
- 対象：ARCH-026（Local JSON／SimpleDB）および道場システム（GAS／Firestore）
- 根拠：既存機能調査とSimpleDB実装報告。**実装・試験済みの機能と、移行機構として接続済みであることは区別する。**
- ARCH-026調査時HEAD：`16f3dbc91170694b9e47371ede17acc5d77adbd9`

## 凡例

| 記号 | 意味 |
|---|---|
| ✅ 完了 | その環境・用途で実装・検証済み（他環境との接続を保証しない） |
| 🟡 一部 | 既存機能はあるが、対象・保証・統合範囲が限定される |
| 🟠 設計 | 設計案のみ、動作する実装なし |
| ❌ 未完 | 必要な機能が未実装、または移行機構として未接続 |
| — 対象外 | その環境単独では対象にならない／適用しない |
| ❔ 要確認 | 調査報告だけでは判断できない |

> **列の読み方**：「JSON」「SimpleDB」はARCH-026側、「GAS」「Firestore」は道場側の現存機能。セルの「完了」は、その環境における個別機能の実装状況であり、ARCH→道場のマイグレートが完成した意味ではない。

## 1. 機能 × 環境 対応マトリックス

| ID | 機能・仕様 | Local JSON（ARCH） | SimpleDB / SQLite（ARCH） | GAS / Spreadsheet（道場） | Firebase / Firestore（道場） | 横断Migration | 備考・残課題 |
|---|---|---|---|---|---|---|---|
| F01 | Workflow定義の保存・読込 | ✅ 完了 | ✅ 完了 | ❌ 未完 | ❌ 未完 | 🟡 一部 | JSON↔SimpleDBの移行完了。Firestore／GASのDefinition Repository Adapterなし |
| F02 | 定義のID＋Versionによる不変・create-only追加 | ✅ 完了 | ✅ 完了 | 🟡 一部 | 🟡 一部 | ❌ 未完 | GAS appendは原子的重複拒否不足。Firestore低レベルCoreには条件付き作成があるがDefinition Adapter未実装 |
| F03 | Workflow定義の検証・再構築 | ✅ 完了 | ✅ 完了 | ❌ 未完 | ❌ 未完 | 🟡 一部 | ARCH側Validator／Registry／再構築は実装済み。道場側の実行境界未接続 |
| F04 | Workflow定義のTRUE／FALSE実行 | ✅ 完了 | ✅ 完了 | ❌ 未完 | ❌ 未完 | 🟡 一部 | JSON↔SimpleDB移行後の実行同等性を検証。道場接続は未完 |
| F05 | 移行対象manifest（ID／Version／依存） | ✅ 完了 | ✅ 完了 | ❌ 未完 | ❌ 未完 | 🟡 一部 | ID/Versionをmanifestで選択、依存は定義から導出しRegistry照合。実装版照合なし |
| F06 | Classifier（CREATE／ALREADY_EQUAL／CONFLICT／REJECT） | ✅ 完了 | ✅ 完了 | 🟡 一部 | 🟡 一部 | 🟡 一部 | 論理定義全体の比較をローカル両方向で検証。道場側はMember用途のみ |
| F07 | Planner／Dry Run（無書込の移行計画） | ✅ 完了 | ✅ 完了 | 🟡 一部 | 🟡 一部 | 🟡 一部 | Workflow用API/CLI完成、addゼロ試験。Compositionの資源準備は別 |
| F08 | Executor（適用・読戻し照合） | ✅ 完了 | ✅ 完了 | 🟡 一部 | 🟡 一部 | 🟡 一部 | ローカルDefinition create-only移行を検証。Firestore/GAS未接続 |
| F09 | 移行先の同一ID＋Version内容一致／衝突判定 | ✅ 完了 | ✅ 完了 | ❌ 未完 | 🟡 一部 | 🟡 一部 | ローカルは一致無書込/衝突停止。道場の既存ID skip経路は未改修 |
| F10 | 移行後の読戻し・定義内容・実行同等性検証 | ✅ 完了 | ✅ 完了 | 🟡 一部 | 🟡 一部 | 🟡 一部 | Executor再構築と試験でのTRUE/FALSE同等性。Migrationは業務Jobを実行しない |
| F11 | 移行結果記録・指紋・再実行管理 | 🟡 一部 | 🟡 一部 | 🟡 一部 | 🟡 一部 | 🟡 一部 | 指紋付き計画と項目別結果を返却・CLI表示。永続台帳/保持期間は未対応 |
| F12 | 計画後の変更検出／適用直前再検証 | ✅ 完了 | ✅ 完了 | 🟡 一部 | 🟡 一部 | 🟡 一部 | 元指紋照合と先の再判定。get後の外部直接改変を原子的には防がない |
| F13 | 途中失敗後の安全な再実行 | ✅ 完了 | ✅ 完了 | 🟡 一部 | 🟡 一部 | 🟡 一部 | ローカルで新計画から再照合・再実行、結果不明の自動再送なし。全件原子性なし |
| F14 | 一般データのコピー・変換 | ❌ 未完 | ✅ DemoItem完了 | 🟡 一部 | 🟡 一部 | 🟡 一部 | SimpleDB専用Data DB間でDemoItem v1→v2を検証。任意業務モデル・JSON一般データ・Firestore接続は未対応 |
| F15 | Ticket／Instance／履歴の永続化・移行 | ❌ 未完 | ❌ 未完 | ❔ 要確認 | ❔ 要確認 | ❌ 未完 | ARCHに型・メモリ実装あり。永続化契約・移行手順は未整備。道場側の該当実装は未確認 |
| F16 | 物理DB／表構造のSchema Migration | — 対象外 | 🟡 一部 | 🟡 一部 | ❔ 要確認 | ❌ 未完 | SQLiteは物理版識別のみ、変更実行なし。GAS Memberヘッダー変更は実装済み |
| F17 | Workflow論理Schemaのバージョン変換 | ❌ 未完 | ❌ 未完 | ❌ 未完 | ❌ 未完 | 🟠 設計 | 既存Versionを上書きせず新Version登録する方針 |
| F18 | PDD／物理Schema投影 | — 対象外 | — 対象外 | 🟡 一部 | 🟡 一部 | 🟡 一部 | Member用途のPDD・Firestore投影は存在。Workflowトポロジー検証とは別 |
| F19 | Job／Checkのコード・依存モジュール配布 | ❌ 未完 | ❌ 未完 | 🟡 一部 | 🟡 一部 | ❌ 未完 | 道場側に環境別成果物生成あり。ただしWorkflow実装の移植・依存解決は未実装 |
| F20 | Job／Check Registry・実装版照合 | ✅ 完了 | ✅ 完了 | ❌ 未完 | ❌ 未完 | ❌ 未完 | ARCHでFactory登録・未知識別子拒否。道場側Compositionへの接続と実装版識別が必要 |
| F21 | コード参照変更 | — 対象外 | — 対象外 | 🟡 一部 | 🟡 一部 | 🟡 一部 | 道場側にMember用文字列参照置換あり。モジュール移植ではない |
| F22 | 環境別ビルド・配置 | — 対象外 | — 対象外 | 🟡 一部 | 🟡 一部 | 🟡 一部 | `tools/target.mjs`あり。Migration Dry Runと同義ではない |
| F23 | リリースrollback／DBデータ復旧 | — 対象外 | — 対象外 | ❔ 要確認 | 🟡 一部 | ❌ 未完 | Cloud Run Revision切替は可能。DBデータrollbackは別問題 |
| F24 | DemoItem保存・Revision付きCAS更新 | ❌ 未完 | ✅ 完了 | ❌ 未完 | ❌ 未完 | 🟡 一部 | 論理collection＋ID、create-only、同内容Revision更新、単一/別プロセス競合試験。Definitionとは別の新規DB系列 |
| F25 | Data用Classifier／Planner／Dry Run | ❌ 未完 | ✅ 完了 | ❌ 未完 | ❌ 未完 | 🟡 一部 | CREATE/UPDATE/NO_OP/CONFLICT/REJECT、更新許可＋期待先状態、元先Revision/指紋。DemoItem限定 |
| F26 | Data用Executor・読戻し・再実行 | ❌ 未完 | ✅ 完了 | ❌ 未完 | ❌ 未完 | 🟡 一部 | 適用直前再検証、CAS、commit/応答障害、結果不明の非再送、新計画による再実行 |
| F27 | Data Migrationファイル記録 | — 対象外 | ✅ 完了 | ❌ 未完 | ❌ 未完 | 🟡 一部 | PLAN/INTENT/RESULT/SUMMARY、runId/計画指紋/元先Revision/検証/停止位置/未処理対象。DBとの原子性・自動resume・保持期間管理なし |

### セル評価の注意

- F06〜F13の「GAS／Firestore 一部」は**道場システムの既存Member移行・コピー処理**に対する評価であり、Workflow Definition Migrationが実装済みという意味ではない。
- F16のGAS「一部」は**Memberヘッダー変更**に限定する。SQLiteの`user_version`確認は物理Schema移行の実行機能ではない。
- F20のARCH側「完了」は**ローカルRegistryの検証**に限定し、実装コードの配布を意味しない。
- F14/F24〜F27の「完了」は**新規専用DBのDemoItem用途**に限定する。既存Definition DBへの自動upgrade、任意データ・参照関係、SQLite物理Migrationを実装した意味ではない。

## 2. 移行元 → 移行先 対応マトリックス

| 移行経路 | Workflow定義 | 一般業務データ | Schema変更 | Job／Check実装・登録 | 総合状況 |
|---|---|---|---|---|---|
| Local JSON → SimpleDB | ✅ 完了 | ❌ 未完 | — 対象外 | — 対象外 | 第1段階：定義・再実行・実行同等性を検証 |
| SimpleDB → Local JSON | ✅ 完了 | ❌ 未完 | — 対象外 | — 対象外 | 第1段階：同じMigration Coreで逆方向も検証 |
| SimpleDB専用Data DB → SimpleDB専用Data DB | — 対象外 | ✅ DemoItem完了 | ✅ 論理変換のみ | — 対象外 | フェーズ2：name→label、CAS更新、記録・再実行。物理DDL変更なし |
| SimpleDB → Firestore | ❌ 未完 | ❌ 未完 | ❔ 要確認 | ❌ 未完 | Firestore Definition Adapterと道場側実行環境接続が必要 |
| Local JSON → Firestore | ❌ 未完 | ❌ 未完 | ❔ 要確認 | ❌ 未完 | 同上 |
| GAS → Firestore | ❌ 未完 | 🟡 一部 | 🟡 一部 | ❌ 未完 | **会員データ用コピーは既存**。Workflow移行ではない |
| Firestore → Firestore | ❌ 未完 | 🟡 一部 | 🟡 一部 | — 対象外 | Memberデータ変換のPlanner／Executorあり |
| GAS → GAS | ❌ 未完 | — 対象外 | 🟡 一部 | — 対象外 | Memberヘッダー変更を確認 |

> 経路の「未完」は**移行処理の状態**を表す。JSON／SimpleDBそれぞれの保存・読込が完成していることとは矛盾しない。

## 3. 対応状況サマリー

| 分類 | 現状 | 次に必要な作業 |
|---|---|---|
| 保存Adapter | JSON・SimpleDB完了、Firestore・GASのDefinition Adapter未完 | Firestoreは後工程で追加 |
| Workflow定義移行 | ✅ ローカル双方向完了／他環境未完 | Firestore Adapter・道場側の受入境界 |
| 一般データ移行 | ✅ SimpleDB DemoItem／🟡 他用途 | 他モデル・保存先への適用範囲と参照整合性を別途設計 |
| Schema移行 | 🟡 GAS Member用途のみ一部対応 | SQLite物理Schema変更、Workflow論理Schema変換 |
| モジュール移行 | ❌ 未完 | Job／Checkの配布単位・依存・Registry・実装版整合 |
| 実行状態・履歴移行 | ❌ 未完 | Ticket／Instance／履歴の永続化から設計 |
| 復旧・再実行 | ✅ ローカル定義の再照合・再実行／他用途は一部 | 永続台帳・他環境の障害検証 |

## 4. 管理上の未決事項

1. Definition Migrationの永続記録と保持期間。Dataは初回ファイル記録を実装済み、保持期間管理は未対応。
2. DemoItem以外の一般データ移行・参照関係をどの範囲で扱うか。初期Data契約はread/add/CAS write。
3. Job／Checkの実装版・依存関係・配布単位。
4. FirestoreのWorkflow定義保存形式と道場側の受入境界。
5. Ticket／Instance／履歴を移行対象に含めるタイミング。
6. 第1段階の複数件移行は全体原子性を保証対象外とする。将来の要件追加は別判断。

## 5. 根拠・更新ルール

- ARCH実装：`src/prototype/definition.ts`、`src/ports/contracts.ts`、`src/adapters/workflow-definition/local-file.cjs`、`src/adapters/workflow-definition/simpledb.cjs`、`src/adapters/simpledb/database.cjs`。
- 道場既存：`work/gas2firebase-copy.cjs`、`work/plan-member-firestore-migration.cjs`、`work/execute-member-firestore-migration.cjs`、`gas/28_PddMemberMigrationRunner.js`、`tools/target.mjs`など。
- 設計ドラフト：`Migration_Generalization_Basic_Design_v0.1.md`（Classifier／Planner／Executor。実装ではない）。
- 調査時検証：道場側Member Migration関連 **14 PASS／0 FAIL**（外部接続なし）。SimpleDB実装時ARCH全回帰 **130 PASS／0 FAIL**。これらは統合Migrationの実行試験ではない。
- 各機能の状態変更時は、**対象環境・対象データ・テスト証拠・コミットID・未解決事項**を更新する。未実装・設計のみを「完了」と記録しない。

### Definition Migration 第1段階 検証記録（2026-11-06）

- 実装：`src/migration/definition.ts`、`tools/definition-migration.cjs`。利用方法は`docs/DEFINITION_MIGRATION.md`。
- `npm run test:migration`：20 PASS / 0 FAIL。JSON↔SQLite、内容/Schema/依存拒否、Dry Run addゼロ、変更検出、並行Add、障害・応答喪失、途中失敗・再実行、CLI、移行後再構築と分岐同等性。
- `npm test`：150 PASS / 0 FAIL（既存HTTP試験のloopback listen権限を許可して実行）。Ticket/Runtime追加回帰：11 PASS / 0 FAIL。
- 基準HEAD：`16f3dbc`。本工程は未コミット・レビュー待ち。マトリックス/Inventoryは作業前から未追跡、Inventoryは今回変更しない。
- F01〜F13の横断欄は全保存先対応を意味しない。Firestore/GASのDefinition Adapter、実装配布・版照合、永続Migration台帳、Schema変換、Ticket/Instance移行は未対応。

### Data Migration フェーズ2 検証記録（2026-11-06）

- 実装：`src/data/demo-item.ts`、`src/migration/data.ts`、`src/adapters/data/{simpledb,file-journal}.cjs`。仕様は`docs/DATA_MIGRATION.md`。
- `npm run test:data-migration`：23 PASS / 0 FAIL。Repository/CAS、判定5種、Schema変換、変更検出、保存/commit/応答/記録障害、途中失敗・再実行、別プロセス競合・読込、再接続を検証。
- `npm test`：173 PASS / 0 FAIL（既存HTTP試験のloopback listen権限を許可）。既存Definition Migration20件を含む。Ticket/Runtime追加回帰：11 PASS / 0 FAIL。
- 基準HEAD：`b9634dd`。フェーズ2は未コミット・レビュー待ち。
- 物理判断：Data専用application_id `0x41524441` / user_version `1`の新規DB。既存Definition DBは移行不要・無変更。相互誤接続拒否と既存ファイル不変を試験。
- 全件原子性、DB＋Journalの原子性、確定後自動Rollback、Firestore/GAS、Ticket/Instance、物理Schema Migrationは対象外。
