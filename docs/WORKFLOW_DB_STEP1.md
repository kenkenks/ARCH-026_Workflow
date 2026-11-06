# Workflow DB統合 工程1: 保存定義からのCWorkflow再構築

HelloWorldの追加開発は行わず、既存CJob / CCheckJob / CWorkflowを保存定義へ接続する。Instance、Ticket、再開、Firestore、GUI Runtime統合は今回の対象外。

## 保存Schema

```json
{
  "schemaVersion": "prototype-workflow/1",
  "definitionId": "example",
  "definitionVersion": "v1",
  "startStepId": "start",
  "steps": [
    {"stepId":"start","stepNo":10,"kind":"JOB","jobId":"sample.work","nextStepId":"check"},
    {"stepId":"check","stepNo":20,"kind":"CHECK_BOOL","checkId":"sample.sequence","trueStepId":"finish","falseStepId":"start"},
    {"stepId":"finish","stepNo":30,"kind":"JOB","jobId":"sample.finish"}
  ]
}
```

Schema Version、定義Version、実行IDを区別する。工程文字列IDとPrototype工程Noを両方明示し、配列順からNoを生成しない。JOBのnextStepId省略が終端。CHECK_BOOLはtrue/false双方の遷移先を必須とする。FINAL / PROVISIONAL / WAIT、イベント、END専用種別は初回の対象外であり暗黙変換しない。

純粋Validatorは必須情報、余分なfield、整数Noの重複、工程ID重複、開始・遷移先存在、到達性・終端の存在を検証する。callback、Job実体、条件オブジェクトを保存できるfieldは設けない。ID・Versionは非空文字列で、HelloWorldの64文字・文字種制限を流用しない。物理ファイル名長等のOS制約は残る。有限回で終了することまでは静的保証せず、既存CWorkflowのmaxExecutionsで制限する。

## RepositoryとJSON再利用

既存`src/ports/contracts.ts`のDefinitionRepositoryに型引数（既定は従来WorkflowDefinition）と`add(definition): Promise<void>`を追加した。`get(id,version)`の意味は維持。Prototype側は`DefinitionRepository<PrototypeDefinition>`として利用し、旧GUI定義と同じ型だと偽装しない。

LocalWorkflowDefinitionRepositoryはget/addのみを実装。定義Versionは不変とし、同一ID+Versionの追加はDEFINITION_ALREADY_EXISTS。未存在はnull。今回update/delete/listやRevision、Instance用CASを追加しない。

GUI DefinitionStoreからJSON読取・完成済み一時ファイル作成・cleanupの機構を`src/adapters/workflow-definition/json-files.cjs`へ抽出した。公開方法は分離し、GUIのwriteJsonFileは従来のrename、実行用RepositoryのcreateJsonFileはcreate-onlyのhard linkを使用する。GUIの保存形式・ファイル名・検証・上書き指定・削除・一覧は維持し、GUIへhard link必須要件を課さない。GUIの上書き指定なしの存在確認は従来と同じで、実行用Repositoryの並列create-only保証をGUIへ拡張したものではない。

### ファイル名方式と旧形式

現行Schemaの識別子検証には文字数・byte数上限がなく、非空文字列と正当なUnicodeであることだけを要求する。UTF-8の可逆エンコードでは長い識別子がOSのファイル名上限を超えるため、B案の固定長ハッシュを採用した。

filenameは`definition-<SHA-256(JSON.stringify([definitionId, definitionVersion]))>.json`。入力はUTF-8、digestは64桁の小文字hex、basenameは80文字固定。大小文字を保持した内容から計算するため、Windowsの大小文字非区別FSでもCase/case、V1/v1を区別する。JSON配列により区切り文字衝突を避け、識別子のslash・backslash・予約名等を物理名へ露出しない。保存内容側のID/Version照合も維持する。ハッシュは理論上の衝突確率をゼロにするものではなく、衝突しても既存versionを上書きしない。保存先directoryを含むパス全体のOS制限は残る。

Prototypeは専用directoryで運用する。旧encodeURIComponent形式を含め、新しいfilename規則以外の`.json`がある場合、open/add/getでLEGACY_DEFINITION_FORMATとして明示拒否する。自動移行、旧名へのfallback、上書きはしない。既存データは保全し、旧名からの移行は別工程で判断する。GUI保存領域と共有せず、GUI定義を実行用形式へ自動変換しない。

### 保存・失敗・cleanup

保存は一時ファイルをwx作成→write→fsync→close。実行用新規追加は同一ディレクトリ内のhard linkで完成済みJSONを公開し、既存versionを置換しない。実行用にはローカルFSのhard link対応が必要であり、link非対応・write/fsync等の障害は既存契約のUNAVAILABLE、既存versionへの追加はDEFINITION_ALREADY_EXISTS。ネットワーク共有・電源断復旧・ディレクトリfsyncは保証しない。固定版の追加だけなので、可変Instance用の所有lockやCASをこの仕組みで代用しない。

cleanup失敗は先行エラーのcodeを置き換えず、storageStage（OPEN_TEMP / WRITE_TEMP / SYNC_TEMP / CLOSE_TEMP / PUBLISH）とcleanupDiagnosticsの固定ラベルへ分離する。公開済みデータをcleanup失敗だけで未保存扱いにせず、Addは成功、診断はRepositoryのdiagnosticsへ記録する。cleanupに失敗した一時ファイルが残り得るが、最終JSONとして読み込まず、暗黙修復もしない。

読取後もSchemaと要求ID/Versionを検査する。不正JSON/nullはDATA_CORRUPT、Schema Version違いはSCHEMA_MISMATCH、内容ID/Version違いはDEFINITION_IDENTITY_MISMATCH。暗黙修復しない。

## 再構築境界

`src/prototype/definition.ts`のloadWorkflowがRepositoryから定義を取得し、reconstructWorkflowが純粋なSchema検証後にregistryを照合する。全Job/Check識別子の存在を確認してからfactoryを呼ぶ。

- registry.jobs: 論理Job ID → 実行環境側が登録したCJob factory。
- registry.checks: 論理Check ID → IBool factory。
- factory context: definitionId / definitionVersion / stepIdだけ。
- Check factoryから得たIBoolで既存CCheckJobを生成し、明示Noへのtrue/false遷移を渡す。
- JOB factoryがCCheckJobを返す場合や、Check factoryがevaluateを持たない場合は拒否。

registryはアプリ側のコードで構成し、ファイル内の文字列をeval/importしない。factoryは再構築だけを担当し、Jobの業務副作用はexecute内で行う。サンプルのCSequenceBoolは毎回新しく生成する。内部indexの永続化や中断再開を実装したものではない。

## 配置・検証

- `src/prototype/definition.ts`: Schema・検証・再構築・load入口。
- `src/adapters/workflow-definition/local-file.cjs`: 非同期Repository境界。
- `src/adapters/workflow-definition/json-files.cjs`: GUIと共通のJSON保存機構。
- `tests/workflow-definition.test.cjs`と同名directoryのfixture/child: 保存・別プロセス再構築・実行。

`npm run test:workflow-definition`でBuildと新規テストを実行する。既存CWorkflowの実行ループ、MemoryHistoryStore、Job/Checkの意味は変更しない。履歴は今回もMemoryのみ。保存定義を読み込めても、実行途中から再開できるとは扱わない。

回帰試験には大小文字・長い識別子の別プロセス読込、同一プロセスとbarrier付き二プロセス競合、完全JSON一件だけの公開、一時ファイル除去、write/fsync/link/cleanup故障注入、hard link非対応を模擬したGUI保存を含める。

## Draft / Publishedの今後の方針（未実装）

- Draftは編集可能。
- Published Definitionは不変。
- InstanceはPublished DefinitionのVersionを参照する。
- 使用中Publishedの物理削除は禁止、または廃止扱いとする。

現在のGUI定義を自動的にPublished扱いしない。本工程のcreate-only保存をGUI公開管理の完成とはみなさず、DraftからPublishedへの登録、利用中定義の保護、Instance保存・復元・再開は別工程とする。
