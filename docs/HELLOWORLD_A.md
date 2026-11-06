# HelloWorld-A

## 実行と配置

`npm run test:hello`でTypeScriptをBuildしてから共通・固有テストを実行する。追加パッケージ不要。ルートに`tsconfig.json`は存在しないため、既存`tsconfig.prototype.json`のincludeに独立した`src/hello/`を追加した。

| 配置 | 内容 |
| --- | --- |
| `src/hello/contracts.ts` | 非同期Repository、HelloRecord、Stored、Revision、エラー |
| `src/hello/schema.ts` | 固定論理Schemaと純粋Validator |
| `src/hello/core.ts` | Repositoryだけを注入するHelloWorld |
| `src/adapters/hello/memory.cjs` | メモリ保存 |
| `src/adapters/hello/local-file.cjs` | JSON保存と単一所有者制御 |
| `src/composition/hello.cjs` | 静的Provider選択、version付きCapability照合 |
| `tests/hello/contract.cjs` | 一組の共通契約テスト |
| `tests/hello/hello.test.cjs` | 両fixture、永続化・排他・障害・交換検証 |
| `tests/hello/child.cjs` | 別プロセス検証用入口 |

Build後のComposition使用例（環境設定はCoreへ渡さない）：

```javascript
const { createHello } = require('./src/composition/hello.cjs');
const app = await createHello({ provider: 'memory' });
// 保存先の切替は上の構成だけを変更：
// const app = await createHello({ provider: 'local-file', directory: 'runtime-data/hello' });
try {
  const added = await app.core.add({ id: 'example', message: 'hello' });
  await app.core.write({ id: 'example', message: 'updated' }, added.revision);
  console.log(await app.core.read('example'));
} finally { await app.close(); }
```

上のawaitはasync関数内で使う。再実行時の同一ID AddはALREADY_EXISTSとなり上書きしない。

必須能力はatomic-create、revision-writeのversion 1。永続化必須の場合は`required: [{ name: 'storage.restart-persistence', version: 1 }]`を構成に渡す。Memoryはこの要求を拒否する。照合は宣言の適合確認であり、実装保証の根拠は契約テストである。

## Local file保証範囲

- 正規化した実ディレクトリ内に`owner.lock`を排他作成（wx）する。PIDとランダムtokenを診断用に記録。同一領域を別プロセス・別Adapterが取得するとUNAVAILABLE、診断はLOCK_PRESENT_NO_AUTOMATIC_RECOVERY。PIDや時刻による自動奪取はしない。
- Repository呼出しを一つのPromiseキューへ直列化し、存在／Revision条件確認から保存までを同じ操作内で行う。引数を待機前に検証・複製し、外部参照で状態を変更させない。
- Schema ID、Version、定義内容のSHA-256 fingerprint、レコードとRevisionを同じJSONへ保存する。一時ファイルを同じディレクトリに排他作成し、write→FileHandle.sync→close→renameで一括置換する。変更前のJSONを先に削除しない。
- rename開始前の失敗はUNAVAILABLE。rename開始後の失敗は保守的にOUTCOME_UNKNOWNとし、そのハンドルの後続操作も拒否する。close後の再open・Readは状態照合であり元の操作成功の証明ではない。
- closeは新規受付を止め、既に受理した操作の完了を待ち、所有lockを解放する。複数回close可能。残存lockは異常終了も含め取得拒否・診断し、自動削除しない。
- 新規領域はlock以外が空の場合だけ初期化する。既存データの不正・Schema不一致は拒否し、修復・Migrationしない。読取時にも保存済みデータを検証する。

対象は同一マシン上のローカルファイルシステムで、排他作成と同一ディレクトリrenameが成立する構成。試験結果は実行環境の範囲に限る。ネットワーク共有、同期サービスによる同時変更、外部writerによるlock無視、ディレクトリ・lock差替えは非対応。複数writer共同利用は提供しない。

正常close後の別プロセス再起動を保証・試験対象とする。ファイルsyncは行うが、ディレクトリfsyncや電源断後の永続性、異常終了後の完全復旧は保証しない。一時ファイルやlockが残る可能性がある。所有者確認・保全・手動解除の運用手順は未確定であり、経過時間やPIDだけを根拠に削除しない。

## 検証と制限

A1〜A6・A9〜A11を同じ関数で両Providerへ適用する。A7は別プロセスP1/P2、A8はCoreコンストラクタ同一性とCore・Schema・契約・共通テストの前後SHA-256、A12は第二所有者・Schema不一致・破損の拒否を確認する。加えて保存前失敗とrename完了応答喪失をI/O依存注入で検証する。

既存Workflow・Ticket・GUIソースは変更しない。HelloWorld-B、通信、ブラウザ、Firestore、Host、Migrationは未実装。AdapterのCJSは既存Node検証構成に合わせ、Core・Schema・契約だけを環境非依存TypeScriptとして分離した。

2026-11-05の検証ではHelloWorld 26件、従来の標準テスト16件がPASS。Ticket・Runtimeの追加確認もPASS。標準コマンド外の`tests/exam-jobs.test.cjs`は2件中1件がFAIL（古い`exam.date`に対しhandlerが存在しない）。対象のGUI実装と同テストがHEADと同一であることを確認し、既存不整合として変更せず報告する。
