# 実験018：外部副作用・冪等性・二重実行防止

## 結果

既存742件＋追加37件＝**779 PASS／0 FAIL**。npm test 529件、実験009〜018の別実行250件。Build・型検査・JS構文検査・差分チェックを実施した。

ローカル模擬通知サービスに対し、要求IDの先行保存、同一IDの重複効果防止、成功後の記録失敗からの照会回復、非冪等サービスの結果不明時の再送拒否を確認した。実メール、決済、実際の外部API、GUI、Firestore、道場システムのデータは使用していない。

## 作業前調査と責務

- `CJob.execute()`はcollect→make→record→postを実行する。recordはまずJob内部へ成果を保持し、postで完成品置き場へ公開する。prepare／cleanupは未実装であり、今回も追加しない。
- `reconstructWorkflow()`はJobForm工程への訪問ごとにCJobを生成する。`SQLiteJobRunStore.onCreate`がUUIDのjobExecutionIdとrun／step／iterationの対応を保存する。
- 実験014の保存はcheckpoint時点の観測である。外部呼出し中の実際のJob工程と、DBの最後のJob状態が一致するとは限らない。
- 実験015の診断はSnapshot・履歴・Job・成果物を読み、実験016は確定LIMIT_REACHED境界だけを再開する。FAILED／RUNNINGを勝手に再実行しない。
- 実験017の`fencedTransaction()`は履歴DBとATTACHした所有権DBを同じ同期Transactionで扱う。外部サービスまで同じTransactionに含めることはできない。

この境界を保ち、`ExternalOperations`を小さなAdapterとして追加した。CWorkflow／CJob／CJobFormの実装、遷移意味論、既存のJob・成果物保存Schemaは変更しない。

## 保存領域

### Workflow側

所有権管理DBの新規Version 3（既存application_id `0x41525243`）に`external_requests`を追加した。既存Version 1／2を自動変更しない。

```js
api.initializeResumeControl(controlFile, historyFile, {
  lease: true, effects: true, leaseMs: 30000,
});
const options = {historyFile, definitionFile, controlFile, runId,
                 lease: true, effects: true};
```

| 列 | 意味 |
|---|---|
| request_id | 外部要求UUID、主キー |
| run_id / job_execution_id / operation_key | 論理操作の一意キー |
| service_id / idempotent | 呼出し対象と宣言された冪等性契約 |
| payload_json / payload_hash | 正規化JSONとSHA-256 |
| state | PREPARED／IN_FLIGHT／CONFIRMED／UNKNOWN／REJECTED |
| attempt_no | 同じ要求IDの送信試行番号 |
| result_json | 検証済み外部応答 |
| diagnostic_code | 固定された安全な診断コード |

IDは新しい論理操作だけに生成し、外部呼出し前に保存する。同じrun・jobExecutionId・operationKeyの再取得は同じIDを返す。内容・サービス・冪等性契約が違えば`EXTERNAL_REQUEST_CONFLICT`で拒否する。JobForm名だけで要求IDを共有しない。反復による新しいJobも別IDとなる。

JSONオブジェクトのキー順に依存しない比較を行い、配列順序は維持する。有限数等のJSONで保持できる値だけを受け入れる。

### 模擬外部サービス側

`MockNotificationService`はWorkflow側DBを使わず、二つの独立した永続ファイルを持つ。

- 受信DB：`receipts`。受信した要求ID・ハッシュ・内容を追記する。
- 通知DB：`notifications`と`results`。通知が発生した事実と確定応答を保存する。

受信記録があることは通知発生の証明ではない。受信DBと通知DBの一括原子性は保証しない。通知DB内では、要求IDによる既存結果の確認・通知記録・結果保存を一つのSQLite Transactionで行う。複数Nodeからの同一ID送信でも、冪等モードでは通知は1件だけとなる。

同じIDで内容が違う要求は拒否し、最初の結果を上書きしない。非冪等モードでは同じID・内容でも通知が増えることを実測し、結果照会も非対応とした。

模擬サービスの副作用はSQLiteへの通知記録そのものである。この原子性を、実メール送信等へ一般化していない。

## 実行契約

```js
const {ExternalOperations} = require('./src/adapters/job-execution/external.cjs');
const operations = new ExternalOperations(options, ownership);
try {
  const prepared = operations.prepare({jobExecutionId, operationKey: 'notify-result',
    serviceId: client.id, idempotent: client.idempotent, payload});
  const confirmedOrRejected = await operations.dispatch(prepared, client);
} finally {
  operations.close();
}
```

呼出し側は`CONFIRMED`と`REJECTED`を区別する。REJECTEDは確定した拒否であり、成功や通信結果不明に変換しない。

1. `prepare()`が所有権・Lease・世代と、Jobが対象runに存在することを確認する。
2. 要求IDと内容をPREPAREDとして原子的に保存する。
3. `dispatch()`が初期送信資格と永続状態を検証し、IN_FLIGHT・試行番号を先に保存する。
4. 送信直前に所有権を再確認してから、Transaction外で`client.send()`を呼ぶ。
5. 要求ID・内容ハッシュ・状態・通知ID／拒否コードを検証し、別のFenced Transactionで結果を保存する。

新しくprepareに成功した戻り値だけが、プロセス内の一度限りの初期送信資格を持つ。これは初回呼出しの資格を絞る補助であり、永続的な冪等性の根拠ではない。永続的な状態遷移と外部サービス側の原子的重複判定が必要である。

**保存済みPREPAREDを読み直しただけでは初期送信を許可しない。** 成功応答が失われたprepareやプロセス再起動では、保存状態だけで未送信を断定せず、照会を要求する。

送信障害や不正応答はUNKNOWN。結果保存が失敗した場合は`EXTERNAL_RESULT_SAVE_UNKNOWN`を返し、保存上IN_FLIGHTまたは確定済み状態が残り得る。保存に失敗した事実を上書きするための自動再送は行わない。

## 照会・明示再送

```js
const observed = await operations.reconcile(savedRequestId, client);
// UNKNOWNのままなら成功・未実行とは断定しない。
// 宣言と実証済みの冪等性契約がある場合だけ、明示再送を選べる。
const retried = await operations.resend(savedRequestId, client);
```

`reconcile()`は結果照会だけを行い、通知を送信しない。結果が見つかれば、元の要求ID・内容を照合してWorkflow側台帳を確定する。照会失敗、または結果なしならUNKNOWNを維持する。結果なしは未実行の証明ではない。

`resend()`は冪等性対応かつUNKNOWNの場合だけ明示的に許可する。保存された同じID・内容を使い、新IDを生成しない。CONFIRMED／REJECTEDは保存済み結果を返し、送信しない。非冪等サービスには再送しない。自動リトライはない。

確定済み結果は、矛盾する遅着応答で上書きしない。別試行開始後の古い応答・障害が新試行の結果を上書きしないよう試行番号を照合する。

## CMRPとの接続

試験では、完成品置き場へのpost用Adapterで外部要求を準備・送信し、成功後に既存の完成品公開へ渡した。JobFormは通知DBや所有権DBへ依存せず、collect／make／recordの順序も変更しない。今回の要求準備はpost内の外部呼出し前処理であり、正式なprepare工程を新設したものではない。

外部要求台帳は通常の内部成果・公開成果とは別の技術記録である。通知成功後にpostが例外終了した試験では、WorkflowはFAILED、履歴はERRORとなる一方、外部台帳のCONFIRMEDと通知記録は残った。業務結果FAILの審査データも正常な通知対象として処理できた。

## 診断・再開との接続

`inspectExternal()`は読取専用で、外部要求専用の分類を返す。通常のWorkflow状態や実験015の診断分類を新状態へ置換しない。

| 外部側の観測 | 外部診断・操作 |
|---|---|
| 全要求CONFIRMED、または要求なし | CLEAR。Workflow側の判断は別途必要 |
| PREPARED／IN_FLIGHT／UNKNOWN、冪等性対応 | REVIEW_REQUIRED、照会候補 |
| 非冪等・結果不明 | REVIEW_REQUIRED、手動確認・自動再送禁止 |
| REJECTED | REVIEW_REQUIRED、拒否内容の判断が必要 |
| 内容ハッシュ・結果・Job参照の破損 | INCONSISTENT |

不正な内容による新しい要求「試行」は拒否し、正常な既存要求を汚染しない。保存内容自体の不一致とは区別する。

`effects:true`の`inspect()`はWorkflow診断と外部診断を併記し、外部CLEAR以外ではready=falseとする。実行開始Transactionでも外部台帳とJob参照を再確認するため、inspect後に未確定要求が追加されても再開しない。

外部モックを含むCompositionは、旧来のsideEffectFree宣言の代わりに`externalEffects: 'LEDGER_CONTROLLED_MOCK'`を明示する。任意の副作用を安全と証明する宣言ではなく、全呼出しをこの台帳・模擬サービス契約へ限定する呼出元の責任である。

外部結果の回復と、Job／Workflowの復旧は別操作。結果照会はJobを実行せず、Workflow履歴も増やさない。結果確定後でもWorkflowがFAILED／RUNNINGなら、実験016の拒否条件を維持する。今回はFAILEDなJobの巻戻しや飛越しを実装していない。

## Lease・Fencingの成立範囲と限界

要求準備・IN_FLIGHT保存・結果保存・照会結果保存は、実験017と同じowner／UUID／世代／Lease検証とTransactionを使う。Takeover後の旧Hostは保存更新を受理されない。準備後に待機した旧Hostが復帰しても、新たな送信開始前の検証で拒否する。

ただし、最後のローカル確認後と外部受信の間には原子的な境界がない。外部サービスはWorkflowのLeaseやFencing Tokenを検証しない。旧Hostの送信が外部へ到達する可能性を実測した。

この試験では新Hostの明示再送と旧Hostの遅着送信で受信が2件になったが、冪等サービスの通知記録は1件だった。旧Hostの結果保存は拒否された。非対応サービスなら同じ仕組みでは重複効果を防げない。WorkflowだけでExactly-onceを保証していない。

## 障害注入と追加37試験

- 要求保存前、PREPAREDの確定応答喪失、IN_FLIGHT保存失敗：外部呼出しゼロ。
- 外部受信前／受信後／効果確定直後／応答喪失：UNKNOWNを保存し、成功・未送信と断定しない。
- 外部成功後の結果保存失敗：IDを復元して別所有者が照会・確定。通知数は増えない。
- ローカル結果COMMIT後の応答喪失：既存CONFIRMEDを照合し、再送しない。
- 非冪等サービスの応答喪失／結果保存失敗：UNKNOWN、手動確認理由を保持、再送拒否。
- 同一IDへの内容不一致：外部サービスも拒否し、元の結果を保持。
- 独立した複数Nodeサービスプロセスから同時送信：受信2、通知1、同じ保存済み結果。
- 通知後にHostを強制終了：台帳IN_FLIGHTから、新Hostが元IDを照会し復元。
- Takeover後の旧Host復帰：送信前検証による拒否と、検証後の到達可能性の両方を確認。
- 別run・同じJobFormの反復：要求IDと通知を実行単位で分離。
- post成功／成功通知後のpost例外、業務FAILと技術ERRORの分離。
- 不正応答、孤立Job参照、保存内容破損、再開直前の未確定要求追加を拒否。
- 外部診断の読取専用性と、返却診断に通知本文を含めないことを確認。

```text
npm test
node --test --test-concurrency=1 tests/job-form-post-failure.test.cjs tests/job-form-check-branch.test.cjs tests/job-form-loop.test.cjs tests/job-form-execution.test.cjs tests/job-form-sqlite.test.cjs tests/job-execution-sqlite.test.cjs tests/job-run-diagnosis.test.cjs tests/job-run-resume.test.cjs tests/job-run-lease.test.cjs tests/external-effects.test.cjs
```

ファイル間の回帰試験は直列に実行した。各競合試験内のPromise待機・複数Node同時送信・Host強制終了は実際に行う。試験DBは専用の一時ディレクトリだけに作成し、既存データは変更しない。

## 変更ファイルと引継ぎ

変更：

- `src/adapters/job-execution/ownership.cjs`：明示作成用管理Schema Version 3。
- `src/adapters/job-execution/resume.cjs`：外部診断・限定モック宣言・実行直前の再確認。

新規：

- `src/adapters/job-execution/external.cjs`：要求台帳、送信、照会、明示再送、専用診断。
- `src/adapters/mock-notification/service.cjs`：独立した受信DB／通知DBを使う模擬サービス。
- `tests/external-effects.test.cjs`、`tests/external-effects/host.cjs`。
- 本書。

道場システム組込み前には、実サービスの冪等キー有効期間・結果照会・内容不一致契約、認証情報の管理、宛先や個人情報の保護、要求保持と監査、手動照合手順、FAILED／RUNNINGからの復旧判断、既存管理DBの明示Migrationを別途設計する必要がある。

今回の模擬サービスは要求IDと結果を期限なしで保持する。実メールの外部効果とDB結果の原子性、外部副作用全般のExactly-once、分散Transaction、自動補償、GUI手動確認は未対応。これらを成立済みとはせず、実験018の報告時点で停止する。
