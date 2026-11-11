# 実験019-B：桜風館・審査進捗投影の最小Adapter接続

## 1. 結果

両システムのCoreを変更せず、既存の審査進捗投影をARCHのCJobForm／CJob／CWorkflowから実行できた。公開成果物を後続Checkが参照し、TRUE／FALSEの両方を実行した。

**既存779件＋追加41件＝820 PASS／0 FAIL**。npm test 529件、実験009〜019-Bの別実行291件。Build、型検査、JS構文検査、差分チェックもPASS。

成立範囲は合成入力を使うローカル接続である。Firestore・DAO・実認証・Cloud Run・実データ・外部サービスは接続していない。

## 2. 実装前の根拠確認

019-A報告書の接続候補を、道場側の現物ソースで再確認した。

| 確認項目 | 現物の結果 |
|---|---|
| ファイル | 隣接リポジトリ`clasp_道場サポ/cloud/attendance/progress-summary.cjs` |
| 使った公開関数 | `projectAttendanceProgress({member, attendanceRows, standard, rankOption})` |
| その他のexport | `isProgressAttendanceActive`、`normalizeProgressDate` |
| Module | CommonJS、`module.exports` |
| 必要DAO／Repository | なし。必要な読取結果を引数で受け取る |
| 実行時依存 | 同ファイル内の正規化関数、Date／Map／Set等の標準JS |
| 認証・権限 | この純粋投影にはない。実データを取得する呼出元の責任 |
| 暗黙のFirestoreアクセス | require／import／fetch／SDK初期化なし |
| 副作用 | 入力から新しい投影結果を生成。DB、通信、Job／STORY起動なし |

道場側`cloud/attendance/progress-firestore.cjs`は別の読取Adapterであり、今回はロードしない。`cloud/api/server.cjs`、GAS Job、STORY Runner、Firebase Adminも生成しない。

最初にWorkflowを介さないAdapter単体呼出しを行い、合成入力の3／5／0回が計算されることを確認した。その後にJobFormとWorkflowを接続した。道場側の変更を必要とする箇所はなかった。

## 3. 接続ファイルと依存方向

```text
tests/exam-progress-adapter.test.cjs（ローカルComposition）
  ├─ 実在する道場モジュールを明示require
  ├─ projectAttendanceProgressをAdapterへ注入
  └─ CWorkflow
       └─ 訪問時に新しいCJob
            └─ 共有CJobForm
                 └─ ExamProgressAdapter.evaluate
                      └─ 道場の既存projectAttendanceProgress
                           └─ 合成factsのみ
```

- ARCH側追加：`src/adapters/exam-progress/adapter.cjs`。
- 既存実行経路：`src/prototype/workflow.ts:CWorkflow/CJob/CCheckJob/CMemoryHistoryStore`、`src/prototype/job-form.ts:createMemoryProductShelf`。
- 接続先：道場`cloud/attendance/progress-summary.cjs:projectAttendanceProgress`。

Adapter自体は関数注入だけを受け、パス、fs、環境変数、SDK、DAOを参照しない。試験Compositionだけが、確認済みの隣接リポジトリのソースを直接参照する。ファイルがない場合は`DOJO_PROJECTION_SOURCE_NOT_FOUND`で停止し、別実装やMockへ置換しない。業務処理のコピー・再実装はしていない。

今回の参照はローカル実験用であり、単独cloneで道場リポジトリなしに動く配布packageを完成させたものではない。公開範囲や固定Versionを伴う配布方法は019-C以降の検討対象。

## 4. 入力契約

Adapterの実験用入力：

```js
{
  memberId: 'T001',
  facts: {
    member: {member_id: 'T001', status: '有効', /* 元の投影が使うMember項目 */},
    attendanceRows: [/* 元の出席DTO */],
    standard: {/* 論理審査基準 */},
    rankOption: {/* 論理級段位情報 */}
  }
}
```

memberIdは非空stringで、member.member_idのstringとtrim後に一致することを要求する。Member.statusは明示string、attendanceRowsは配列、member／standard／rankOptionはオブジェクトとする。元の省略可能なカウント・日付等は既存投影へ渡して判断させる。

- facts=null、またはmember=nullは、呼出元が明示した「対象なし」。技術的な読取失敗をnullに変換してよいという契約ではない。
- facts未指定やJobForm入力キー欠落は、入力未取得として拒否する。
- 数値IDや不一致IDを文字列化して補正しない。
- 元の引数へは独立コピーを渡す。入力の取り違えや後続処理からの変更を避ける。

今回はSnapshotを直接入力し、DAOによるデータ取得処理は実装していない。

## 5. 出力契約

結果はWorkflow状態と異なる、Adapter出力のタグで区別する。

```js
{ kind: 'PROJECTED', memberId, progress: {
  currentRank, currentRankId,
  carriedTrainingCount, recordedTrainingCount, trainingCount,
  requiredTrainingCount, remainingTrainingCount,
  trainingDays, requiredTrainingDays, remainingTrainingDays,
  examinationReady
}}
{ kind: 'NOT_FOUND', memberId }
{ kind: 'BUSINESS_REJECTED', memberId, reason: 'PROGRESS_INPUT_UNAVAILABLE' }
```

PROJECTEDは既存投影のsnake_case項目をcamelCaseへ投影するだけである。カウント、残数、日数、審査可否をAdapter内で計算し直さない。審査可否は元の`examination_ready`をそのまま使う。

元の結果についてok=true、ID一致、boolean・有限な非負数・許容null等を検査する。異常な結果を正常な成果物へ変換しない。会員氏名・連絡先・備考・出席明細全体はWorkflow出力へ渡さない。

## 6. 契約変換規則

| 状況 | Adapterの扱い | この実験のWorkflow |
|---|---|---|
| 正常投影・examination_ready=true | PROJECTED／examinationReady=true | TRUE→完了Job |
| 正常投影・examination_ready=false | PROJECTED／examinationReady=false | FALSE→確認対象Job。正常な業務上の否定 |
| facts／memberが明示null | NOT_FOUND。投影は呼ばない | FALSE→確認対象Job |
| 入力構造を検査済みで既存投影がPROGRESS_INPUT_UNAVAILABLEを送出 | BUSINESS_REJECTED。現行入口では有効対象外のMember等 | FALSE→確認対象Job |
| 未取得・型不正・ID不一致 | ExamProgressError | FAILED／ERROR、成果物未公開 |
| INVALID_PROGRESS_COUNT／DATE／DURATION／ATTENDANCE | INVALID_SOURCE_DATAと既知sourceCode | FAILED／ERROR、成果物未公開 |
| その他の同期例外・Promise reject・非Error例外 | PROJECTION_FAILED | FAILED／ERROR、成果物未公開 |
| ok:false、未知DTO、UNKNOWN形式、結果ID不一致 | INVALID_PROJECTION_RESULT | FAILED／ERROR、成果物未公開 |

本入口は同期関数だが、Adapterはawaitで呼ぶため、同じ入出力契約のPromiseを返す注入先も扱えることを試験した。元の実装を非同期化してはいない。

技術例外のメッセージ、内部パス、stackをそのまま公開しない。公開するのは固定Adapterコードと既知の業務Validationコードだけ。`UNKNOWN`という文字列を見て、道場側STORYのUNKNOWNやARCH外部要求台帳のUNKNOWNへ自動変換しない。本純粋投影の正常出力にはその契約がないため、未知DTOとして拒否する。

NOT_FOUND／BUSINESS_REJECTEDをFALSEへ進めるのは、本実験のCompositionで明示した確認方針であり、CoreやAdapterが全Workflow共通の遷移ルールとして固定したものではない。

## 7. 合成データと既存業務ルール

すべて試験用に新しく作成した。実会員・実出席・実基準は取得していない。IDはT001〜T003、氏名・級段位・枠はSYNTHラベル、日付は2099年の架空日付。元の契約が「出席稽古枠」を数えるため、概念例のExam recordsを審査結果件数として扱わず、attendanceRowsへ変換した。

試験の基本基準は、入力standardに与えた架空の「必要稽古数5、必要稽古日数2」。道場の実運用基準ではない。

| Member | 有効出席枠 | 稽古日数 | 残枠 | examination_ready | Workflow分岐 |
|---|---:|---:|---:|---|---|
| T001 | 3 | 3 | 2 | false | FALSE→確認対象 |
| T002 | 5 | 5 | 0 | true | TRUE→完了 |
| T003 | 0 | 0 | 5 | false | FALSE→確認対象 |

基本例のほか、既存の次のルールを簡略化せずに確認した。

- 同日・同枠は重複加算せず、同日の別枠と異なる稽古日数は区別する。
- 別Memberや取消行を対象進捗へ加算しない。
- 級段位起算日前の稽古枠除外、繰越、個別の必要稽古数を反映する。
- 必要稽古数に達しても必要日数に達しなければfalseとなる。
- 基準未設定なら可否を捏造しない。元の必要数0／残数null／falseを維持する。
- 不正な日付、負の繰越、不正時間、型外の出席行は元のValidationで拒否される。

## 8. CJobForm・CWorkflowの実測

`createExamProgressForm()`はname／collect／makeだけを持つ凍結オブジェクト。collectはProductReaderの入力キーを読み、makeがAdapterを呼ぶ。任意recordは省略し、内部成果の保持とpostは既存CJobが実行する。

```text
10: exam-progress Job
  ↓ 公開キー examProgress
20: examination-ready Check
  ├ TRUE  → 30: complete
  └ FALSE → 40: review-target
                    ↓
                50: END
```

T002の実履歴は10 DONE→20 TRUE→30 DONE→50 DONE、T001／T003は10 DONE→20 FALSE→40 DONE→50 DONE。すべてCOMPLETEDとなり、投影成果物の公開回数は各1回だった。

同じJobFormを逐次・並行の両方で共有し、実行ごとに新しいCJobが生成された。並行時は投影の待機・解放を制御してA先／B先の両完了順を検査し、入力、成果物、Job状態、runId別履歴の混在がないことを確認した。

技術例外や不正データではJob／WorkflowがFAILED、履歴はERRORのみとなり、Check・分岐Jobは呼ばれず、投影成果物も公開されなかった。

## 9. 実サービス非接続の検証

`tests/exam-progress-adapter/offline.cjs`を独立したNodeプロセスで実行した。

- fetch、HTTP／HTTPS、Socket接続を禁止するガード。
- Firebase／Google SDKの読込禁止、元投影以外の追加依存の読込禁止。
- 実在する道場投影をロードし、Adapter→CJob→CWorkflowを実行。

実測はworkflowStatus=COMPLETED、trainingCount=5、networkAttempts=0、sdkAttempts=0、projectionDependencies=0。Firebase Admin初期化、Cloud Run設定、認証情報、DAOインスタンス、業務用環境変数は不要だった。

これは純粋投影への接続だけの結果である。将来の実データ取得で認証や本人・先生・admin認可を省略してよいことを意味しない。

## 10. 追加試験と回帰

追加41件はAdapter単体3例、実業務ルール、CJobForm、Workflow両分岐、対象なし、業務拒否、型・識別子、Validation、同期／非同期例外、UNKNOWN拒否、参照独立性、逐次／並行独立性、オフラインガード、元ファイル非変更を検証した。

```text
npm test
node --test --test-concurrency=1 tests/job-form-post-failure.test.cjs tests/job-form-check-branch.test.cjs tests/job-form-loop.test.cjs tests/job-form-execution.test.cjs tests/job-form-sqlite.test.cjs tests/job-execution-sqlite.test.cjs tests/job-run-diagnosis.test.cjs tests/job-run-resume.test.cjs tests/job-run-lease.test.cjs tests/external-effects.test.cjs tests/exam-progress-adapter.test.cjs
npx tsc -p tsconfig.prototype.json --noEmit
```

npm testはBuildを含み529 PASS、別集合は291 PASS、合計820 PASS／0 FAIL。JS構文検査は新規Adapter・試験・子プロセスfixtureを対象に行った。道場側の試験やBuildは実行していない。

AdapterはCJSで、既存CJobFormの構造に適合することを実行試験で確認した。道場JSの入出力全体をTypeScriptで静的型検査する仕組みを新設したものではない。

## 11. 変更ファイル・非侵襲性

今回の新規ファイルは4件のみ。

1. `src/adapters/exam-progress/adapter.cjs`
2. `tests/exam-progress-adapter.test.cjs`
3. `tests/exam-progress-adapter/offline.cjs`
4. 本書

両Core、道場Job／DAO／STORY／元投影、既存SimpleDB／Schema、既存試験、package.json、019-A報告書を変更しない。業務計算式のコピーも行わない。従来の未コミット・未追跡成果を維持し、今回分をステージしない。

作業終了時の照合では、着手時から存在した選択対象のコード・文書等（ARCH側137ファイル、道場側744ファイル）のSHA-256がすべて一致した。両リポジトリの既存Git状態も一致し、今回の差分は上記新規4件だけ。ステージ済みファイルはない。

## 12. 未解決事項

- 隣接リポジトリを明示参照する実験用Compositionであり、独立配布用の共通packageや固定Commit供給は未確定。
- 対象なしは合成Snapshotの明示nullで検証した。実DAOの未取得・認可拒否・タイムアウトを分類する読取Adapterは未実装。
- 既存投影の未知例外は安全な技術失敗へ変換する。将来の業務エラー追加時は変換契約を再確認する必要がある。
- CMRPは既存4工程のまま。prepare／cleanup、Firestore保存、実運用Workflow統合を追加していない。
- 実際のMemberの全項目や個人情報は出力しない方針だが、実データ導入時には取得権限・保持範囲・監査を別途設計する。

## 13. 実験019-Cへの引継ぎ提案

次の候補は`createFirestoreProgressReader(fakeCore)`による読取契約の検証。既存readById／queryEqual／readPageへFakeだけを注入し、ページング、上限、不完全読取、対象なし、認可前提、DTO縮約を確認する。実Firestore・公開API追加・DAO変更へ自動的に進まない。

もう一つの判断事項は、道場側の業務コードを公開ARCHへコピーせず、ローカル参照からどの供給・Version固定方式へ進めるかである。今回の成功を、両Coreの統一やCloud RunへのSQLite直接移植の根拠にはしない。

実験019-Bの結果報告時点で停止し、019-C・ステージ・Commit・Push・Deployは行わない。
