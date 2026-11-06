# Definition Migration 第1段階

対象は `prototype-workflow/1` の不変なWorkflow定義。JSONとSimpleDBを実Adapterで検証する。
Coreは既存DefinitionRepositoryのget/addだけを利用し、保存先名・SQL・ファイルパスを参照しない。
将来の保存先も同じ契約とエラー分類を満たすAdapterをCompositionへ注入する。

## APIと責務

`src/migration/definition.ts`:

- `classifyDefinition`: 純粋なCREATE / ALREADY_EQUAL / CONFLICT / REJECT判定。既存ValidatorとRegistry名照合を利用。factoryやJobを実行しない。
- `canonicalDefinition` / `definitionFingerprint`: Validatorの返す固定項目順の論理定義をJSON化し、SHA-256を計算する。工程配列を並べ替えない。Web Cryptoを使う（Node 24）。物理JSONの空白・プロパティ順には依存しない。
- `planDefinitionMigration`: manifest重複をI/O前に拒否し、両端を読込、指紋付き計画を返す。型上もgetのみ受け取り、addを呼ばない。
- `executeDefinitionMigration`: 元指紋を照合し、先の現在状態を再判定。create-only追加、読戻し、再構築検証。最初の失敗で停止し、処理済み項目とstoppedAtを返す。

Manifest（実装コードの配布・実装版管理は含まない）:

```json
{"manifestVersion":1,"definitions":[{"definitionId":"example","definitionVersion":"v1"}]}
```

必要Job/Checkは保存定義のjobId/checkIdから取得し、注入Registryと照合する。
Executorは追加前および読戻し後に既存reconstructWorkflowを呼び、factoryの返値も検証する。
factoryは副作用のない構築処理とする。Migration中はworkflow.run / Job.execute / Check.evaluateを呼ばない。
履歴Storeは再構築検証専用で、実行履歴を保存・移行しない。

## プログラムからの使用

Build後のCommonJS例（Repository接続と終了は呼出元が所有する）:

```js
const {planDefinitionMigration, executeDefinitionMigration} =
  require('./dist/src/migration/definition');
const plan = await planDefinitionMigration(manifest, source, destination, registry);
console.log(JSON.stringify(plan, null, 2)); // Dry Run、書込なし
// 明示的な適用は別の呼出し:
const result = await executeDefinitionMigration(plan, source, destination, registry);
console.log(JSON.stringify(result, null, 2));
```

計画と結果は通常のJSONオブジェクト。永続化先・保存期間は呼出元で決める。
永続的なMigration台帳、署名・認可トークンとしての計画は今回作らない。

## CLI

```text
npm run build
node tools/definition-migration.cjs dry-run ./binding.cjs ./manifest.json
node tools/definition-migration.cjs apply ./binding.cjs ./plan.json
```

dry-runの標準出力をUTF-8でplan.jsonへ保存し、内容を確認してapplyへ渡す。
binding.cjsは利用者が指定する信頼済みのローカルCompositionコード（設定データとしてダウンロードしたコードを実行しない）。
`module.exports = async () => ({source, destination, registry, close})` を返す。
JSON AdapterまたはSimpleDB Adapterを生成し、closeで所有接続を閉じる。
SimpleDBのinitializeは事前の明示的な準備として行い、bindingの通常接続で自動初期化しない。
JSON Adapterの既存constructorは保存directoryを作成し得る。Dry Runは対象定義のaddゼロを保証するもので、Compositionの資源準備まで無書込にする仕組みではない。
Coreには環境選択分岐を追加しない。CLIは終了時にcloseを呼び、内部例外本文を表示しない。
終了コード0は成功、2は判定拒否・適用停止またはcleanup失敗、1は入力/実行入口の失敗。

## 競合・障害・再実行

- CREATEのみadd。既存同一内容はALREADY_EQUAL、異なる内容はCONFLICTで停止する。
- 計画後に先が変化すれば再判定。元の内容指紋が変わればSOURCE_CHANGEDで停止。
- 並行AddのDEFINITION_ALREADY_EXISTSは読戻して一致/衝突を判定し、再送しない。
- OUTCOME_UNKNOWNおよび未分類add例外は自動再送せず停止。reconciliationは事後の状態照合であり、その操作が成功した証明ではない。一致してもstatusを成功へ変えない。
- 確定成功のadd後に検証が失敗した場合はFAILEDとconfirmedAdded=trueを返す。自動削除しない。
- 途中まで成功した定義を保持する。原因解消後、新しいDry Runを生成し、ALREADY_EQUALを無書込で通過して再適用する。
- REJECT計画は適用しない。元定義・Registry等を訂正して計画を再生成する。
- 結果には固定分類と指紋、識別子を記録し、元の例外メッセージ・パス・stackを混入させない。

移行元/先はRepository契約に従うことを前提とする。読込から追加までの間に元が外部から直接改変される事象を、get/addだけで原子的に防ぐことはできない。
適用時点の再読込スナップショットを移行する。Snapshot分離・署名付き計画・全件原子性は保証しない。
順序付きの項目ごとの結果だけを返し、未処理項目はplanとstoppedAtから識別する。

## 検証・範囲

`npm run test:migration`。JSON→SQLite／逆方向、再実行、衝突、元/先の変化、並行Add、障害注入、CLI、再構築・TRUE/FALSE実行同等性を検証する。
`npm test`にも含む。既存Adapter契約試験は変更しない。
本実装はSchema変換、SQLite物理Migration、Firestore/GAS Adapter、Job/Check配布、実装版照合、Ticket/Instance/履歴移行を含まない。
