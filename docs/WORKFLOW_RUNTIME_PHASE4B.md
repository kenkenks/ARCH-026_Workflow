# Phase 4B — GUI と WorkflowRuntime の接続

## 対応範囲
- チケットからひな型を選択すると WorkflowRuntime を生成する。
- JOB工程は明示的な模擬ハンドラーで完了させる（業務処理は実行しない）。
- CHECK_FINAL / CHECK_PROVISIONAL / CHECK_WAIT は画面で PASS / REJECT / WAIT / ERROR を手動指定する。
- 差戻し・ループ・待機・再評価・履歴表示・工程表示に対応する。
- チケット完了は実行の COMPLETED と連動する。
- 既存の固定4工程デモは維持する。

## 制限
- イベントルートを含むひな型は実行開始前に拒否する。既存の `exam-workflow.example.json` はイベントルートを含むため、そのままでは実行できない。イベントルートを外した複製を用意して試すこと。
- JOBは全て模擬処理であり、審査日程確定・結果登録等は実施しない。
- CHECKの結果はユーザー手動指定であり、実業務判定ではない。
- 自動実行ボタンはひな型実行時は無効。1工程ずつ進める。
- 実行状態とチケットはサーバーメモリ上のみ。再起動で消える。
- 日時表示のUTC/JST変換問題は未対応。
- 複数チケットの同時実行、永続化、イベントルート、実JOB、実CHECKは今後の工程。

## 確認手順
1. `npm install` → `npm run gui`。
2. JOBカタログに使うJOBキーワードを `CJob` / 有効として登録。
3. イベントルートのないJOB・CHECK・ENDを含むひな型を作成・保存。
4. チケットを下書き発行→提出→実行開始、ひな型を選択。
5. 1工程実行、CHECK工程ではPASS/REJECT/WAIT/ERRORを選択して進める。
6. モニターの現在工程、履歴、待機状態、完了状態を確認する。

## テスト
`npm test` および `node --test tests/workflow-runtime.test.cjs`
