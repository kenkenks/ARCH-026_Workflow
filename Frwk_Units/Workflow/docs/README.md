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
