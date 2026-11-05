# Phase 4A: JOB / CHECK 実行契約の検証

追加: `gui/workflow-runtime.js`、`tests/workflow-runtime.test.cjs`。

- JOBキーワードから実装済みハンドラを解決し、COMPLETED / WAITING / FAILEDを受領する。
- CHECKはPASS / WAIT / REJECT / ERRORを受領し、差戻し先に遷移する。
- JOB固有の入力項目・出力項目はWorkflowに定義しない。
- 実装未登録JOBは実行できない。待機時は完了履歴を作らない。
- この段階のCHECK結果は外部から明示的に与えるテスト用契約。自動判定、永続化、イベントルート、GUI接続、チケット連動は未実装。
- 既存の `gui/server.js` のPhase 3実行経路は変更しない。

検証: `node --test tests/workflow-runtime.test.cjs`。

次工程: 実JOB実装登録、CHECK判定提供者、再開トークンと永続化、既存GUIとの統合。再開時の重複実行・二重確定を防ぐこと。
