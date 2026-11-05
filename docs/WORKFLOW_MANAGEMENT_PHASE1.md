# ARCH-026 ワークフロー管理・編集 Phase 1

- `npm run gui` で起動。画面上部にひな型一覧・工程・イベントルート編集を追加。
- JSON定義の検証、ローカル保存、読込、複製、削除、JSON入出力を実装。
- 保存先: `gui/data/definitions/`（ローカル、Git対象外）。既存の `src/definitions/` のサンプルは変更しない。
- 同一 ID + version の保存は拒否。画面で既存定義を読み込んだ場合のみ確認後上書きできる。
- 現段階では `WorkflowDefinition` の JSON 構造を扱う。GUIからの実行、公開・廃止の状態管理、実行履歴永続化、Firestore連携は未実装。
- `src/core/engine.ts` と `src/core/validation.ts` は未実装のまま。今回のGUI検証は `gui/workflow-definitions.js` で実施し、後続でCoreへ統合する。
- 注意: ローカル試作のため認証・認可はなく、公開ネットワークに接続しないこと。
- テスト: `npm test`。
