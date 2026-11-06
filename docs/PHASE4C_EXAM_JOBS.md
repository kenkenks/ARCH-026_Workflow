# Phase 4C — 審査用の実JOB（ローカル検証）

この実行手順はPhase 4C-2以降の現行keyword/class対応に更新している。

## 目的と責務
- `gui/exam-jobs.js` が業務項目の定義、検証、記録を管理する。WorkflowRuntime は業務項目を解釈しない。
- `exam.dateAgreement` / `CExamDateAgreementJob`：審査日、開始時刻、場所、確定者を登録する。
- `exam.resultRegistration`：受審者、受審級・段位、合否、判定者、講評を登録する。
- JOB実行時、未登録なら WAITING、登録済みなら COMPLETED を返す。実際の道場システムへの書込みは行わない。

## GUI操作
1. `npm install`（初回）、`npm run gui` で起動する。
2. JOBカタログで次の組を有効登録する。実装クラス名も一致させる。
   - `exam.dateAgreement` → `CExamDateAgreementJob`
   - `exam.resultRegistration` → `CExamResultRegistrationJob`
3. `src/definitions/exam-two-jobs.phase4c.example.json` をワークフロー編集のJSON読込で読み込み、検証・保存する。
4. チケットを下書き発行→提出→ひな型 `exam-two-jobs-demo / draft-1` で実行開始する。
5. S001は審査日・開始時刻・場所・確定者の4項目を入力して「JOB情報を登録」→「1工程実行」。入力未登録時はWAITING、登録後はCOMPLETEDとなる。S002でも受審者・級段位・合否・判定者（講評は任意）を登録し、S003 ENDまで進める。

## 制限
- JOB固有の記録はサーバーのメモリのみ。再起動すると消失する。DB連携は次工程。
- その他のJOBは通常実行ではHandler未解決として拒否する。明示的DEMOでのみ模擬実行を許可し、Ticketは完了させない。CHECKは手動判定、イベントルートは未対応。
- 実行用の`exam-two-jobs.phase4c.example.json`は上記2つの現行keywordを使用する。大きな設計サンプル`exam-workflow.example.json`の日程合意工程も同じkeywordだが、イベントや未実装業務を含むため通し実行用ではない。
- 既存GUIカタログ・保存済み定義は自動更新しない。既存データを上書きせず、新しいDraft/試験用領域で現行keyword/classを照合する。
- COMPLETEDはローカルJob/工程の状態であり、道場システムへの保存や承認完了を保証しない。P1-2では通常/DEMOを分離し、結果・履歴・表示にモードと模擬処理を残す。詳細は `WORKFLOW_RUNTIME_PHASE4B.md` を参照。
- 既存の審査サンプルを通し実行できるようになったわけではない。
- UIのブラウザ実操作確認は未実施。

## 回帰試験

`node --test tests/exam-jobs.test.cjs tests/exam-job-classes.test.cjs tests/workflow-runtime.test.cjs`。
旧試験の入力待機、必須拒否、登録後完了、工程・実行単位の分離を維持し、現行keyword/classとサンプルの整合も検証する。
