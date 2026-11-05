# Phase 4C — 審査用の実JOB（ローカル検証）

## 目的と責務
- `gui/exam-jobs.js` が業務項目の定義、検証、記録を管理する。WorkflowRuntime は業務項目を解釈しない。
- `exam.date`：審査日、開始時刻、場所、確定者を登録する。
- `exam.resultRegistration`：受審者、受審級・段位、合否、判定者、講評を登録する。
- JOB実行時、未登録なら WAITING、登録済みなら COMPLETED を返す。実際の道場システムへの書込みは行わない。

## GUI操作
1. `npm install`（初回）、`npm run gui` で起動する。
2. JOBカタログで `exam.date` と `exam.resultRegistration` を `CJob` として有効登録する。
3. `src/definitions/exam-two-jobs.phase4c.example.json` をワークフロー編集のJSON読込で読み込み、検証・保存する。
4. チケットを下書き発行→提出→ひな型 `exam-two-jobs-demo / draft-1` で実行開始する。
5. S001の業務フォームを入力して「JOB情報を登録」→「1工程実行」。S002でも同様に入力し、S003 ENDまで進める。

## 制限
- JOB固有の記録はサーバーのメモリのみ。再起動すると消失する。DB連携は次工程。
- その他のJOBは引き続き模擬実行。CHECKは手動判定、イベントルートは未対応。
- `exam.date` は既存サンプルにあるキーワードを使用する。`exam.resultRegistration` は今回新設するキーワードで、既存サンプルにはまだ組み込んでいない。
- 既存の審査サンプルを通し実行できるようになったわけではない。
- UIのブラウザ実操作確認は未実施。
