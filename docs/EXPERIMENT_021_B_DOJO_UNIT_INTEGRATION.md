# 実験021-B：桜風館 Workflow Unit統合

2026-11-09。021-Aの判断に従い、桜風館リポジトリの開発用HTTP Hostから、ARCH配布Unitを実行した。本番Cloud Runへのルート追加・接続・Deployは実施していない。既存本番入口を変更せず、既存認証・Principal・業務readerのfactoryを注入して検証した。

## 配布物・同一性

- 開発元：ARCH-026_Workflow。実行機構はsrc/prototype/。src/core/の骨格は使用しない。
- npm package：`@arch026/workflow-unit@0.1.0-experiment.021.1`。
- archive：`vendor/arch026-workflow-unit-0.1.0-experiment.021.1.tgz`（道場側）。
- SHA-256：`e7f97e55ed2da17adf32cb7358df39c816ed7e929ea4c7dee1b87d0aafda34c4`。
- manifest SHA-256：`04cd3cb50ebce548795781266c26d2c13e524ab2a29b462024d7e0f196418a0a`。
- Node24、Firestore SDK9.3.1を使用。package.jsonのfile:依存とlockで固定し、隣接ARCHパスを実行時に参照しない。

ARCHのtools/package-workflow-unit.cjsはUnit専用tsconfigでビルドし、workflow／job-form／definition／diagnosisと必要な型定義、既存Firestore Emulator Adapterを収録する。SQLite・GUI・デモ・道場固有処理を含めない。Adapterの相対参照を維持する配布レイアウトとし、Coreの互換コードを増やさない。

manifestには元ソースと収録ファイルのSHAを記録する。道場cloud/workflow/unit.cjsはarchive・manifest・全収録ファイルを検証してからロードする。元のcompiled Core／Adapterとのバイト一致、同じソースから同じarchiveの再生成、改変した検証用コピーの拒否を試験した。既存成果は未コミットなのでHEADだけを配布内容の証明にしない。ハッシュ記録は署名・信頼できる配布経路の代替ではない。

## 実装構造・業務境界

```text
道場 cloud/workflow/dev-server.cjs（127.0.0.1のみ）
  ├─ 既存 createAdminApi（合成依存注入）
  └─ Workflow API → Application Adapter → 配布Unit
       入力Job → 審査進捗Job → Check → READY／要確認Job → END
                    ↓
       既存 createFirestoreProgressReader → 合成DAO
```

実際のCWorkflow・CJobForm・CJob・Check、async CMRP、record/postを使用する。審査進捗計算は既存cloud/attendance/progress-firestore.cjsとその既存計算処理を呼び、計算式を複製していない。DAOはreadById／queryEqual／readPageの合成実装。既存Job・STORYの契約をCJobへ強制変換せず、読み取り専用の既存業務入口を使った。実承認・申請業務全体の統合は未対応。

T001は必要回数を満たす合成会員でTRUE／READY、T002は回数不足でFALSE／NEEDS_REVIEW、T003は対象なし／NOT_FOUNDとなる。いずれも合成データ。業務上の要確認・対象なしと技術的な例外を区別する。JobFormに実行固有結果を保存せず、Unitの実行生成と実行別productsを使う。

## API・認証認可

| Method・path | 入力・意味 |
| --- | --- |
| POST /api/workflow/dev/applications/DEMO21-識別子/start | JSONのmemberId（T001〜T003）、operationId（UUID v4）のみ。実行・保存 |
| GET /api/workflow/dev/applications/DEMO21-識別子 | 状態・結果・Job・Workflow履歴・操作状態・Unit識別情報を取得 |

Bearer資格の検証関数は既存verifyIdToken(token,true)契約。既存createDojoPrincipalResolverでサーバー側Accountを解決し、active teacher／admin／canAccessMemberの本人範囲を確認する。token内のmember_idをそのまま権限根拠にしない。合成Verifierでも匿名401、無権限403、無効先生403、本人・有効先生の許可を検証した。認可拒否ではApplicationを呼ばない。実Firebase Authは未接続。

開発CLIは--synthetic必須。同一Host／Originを検証し、POSTはJSON・既存64KiB本文制限。競合409、技術障害／未確定503。raw例外・stack・内部パスは公開しない。既存本番API入口を動作確認のために起動していない。

## Firestore保存構造とTransaction

projectは`demo-arch026-c2`、namespaceは`c2-`から始まる専用領域。既存C2 Adapterのroot以下にDefinitionとrunsを置く。runIdは`dojo021-申請識別子`。run head／history／jobs／artifacts／ownerは既存Adapter形式。run配下`dojo021/application`にapplicationId、memberId、operationId、要求の識別情報、Definition digest、ACCEPTED／APPLIED／UNKNOWNを記録する。会員・会費・出席の保存領域へ書かない。

1. claim後、所有権guardと未存在確認を同一Transactionで行い操作receiptをcreate。
2. Job／内部成果／公開成果／historyは既存C2の所有権guard付き保存を使用。
3. 完了時はowner・receipt・run revisionを同一Transactionで照合し、APPLIEDと所有権RELEASEDを確定。
4. 状態取得はread-only Transactionでreceipt／head／履歴／Job／成果物を読み、履歴Schema・長さ・digestを照合。

同じoperationId・memberId・actorの再送は結果照会となり、Jobや履歴を追加しない。同じ申請への異なる要求は409。複数サーバープロセスの同時操作で成功200が1件、競合409が1件となった。全Workflowを一括Transactionで実行する仕組みではない。

例外後はAPPLIEDを読戻しで観測できた場合のみ既存結果を返す。それ以外はUNKNOWN／利用不能として自動再実行しない。保存と応答の原子的保証はない。UNKNOWNからの手動回復API、自動Takeoverは未実装。Lease検証は既存C2のreadTime境界を維持し、commit時点までの有効性を新たに保証していない。

## 検証結果

| 範囲 | 結果 |
| --- | --- |
| ARCH npm test | 529 PASS／0 FAIL |
| 既存実験009〜019-Bの追加集合 | 最終291 PASS／0 FAIL |
| 020-A Memoryデモ | 27 PASS／0 FAIL |
| 020-B＋019-C2 Emulator | 45 PASS／0 FAIL |
| 既存基準合計 | 892 PASS／0 FAIL |
| Unitパッケージ試験 | 2 PASS／0 FAIL |
| 道場側新規統合試験U01〜U11 | 11 PASS／0 FAIL |
| 道場既存Admin API／Principal／進捗／WebConnectの選定集合 | 25 PASS／0 FAIL |
| 道場既存WebConnect認証境界 | 6 PASS／1 FAIL（下記） |
| 道場既存STORY902 Firestore ledgerの合成試験 | 内部assert 20/20 PASS（node:testではファイル1件） |

ARCHの291件の初回実行では、既存job-run-lease.test.cjsの「separate processes use independent run ownership and both resume」がRESUME_REFUSEDで1件FAIL。Core変更なしで単独Lease集合35件PASS、その後291件全体再実行PASS。初回の失敗原因を確定しておらず、タイミング依存の可能性は残る。最終結果だけで初回失敗を抹消しない。

Memoryデモ初回はsandbox内のHTTP待受制限で失敗し、ローカル待受可能な実行環境で27件を再検証した。Firestore回帰と新規統合試験では実際のEmulatorを起動し、停止後の接続拒否も確認した。未実施をPASSにしていない。

道場のwork/verify-webconnect-auth-boundary-step7a.cjs:82は「未接続actionは全roleで404」の期待に対して401となりFAIL。該当試験と既存WebConnect実装のハッシュは作業前と一致し、新Workflow APIを経由しない既存経路の失敗である。今回修正せず、道場側回帰全件PASSとは判定しない。work全体は実サービス接続を含み得るため一括実行していない。

新規11件は配布物一致／改変拒否、実Unit実行、TRUE・FALSE・対象なし、別プロセス再起動後取得、同一操作再送、複数プロセス競合、認証・権限・偽member claim拒否、既存API併設、SQLite非依存・本番接続設定拒否を直接assertする。Fencing・claimToken・UNKNOWN・応答喪失の既存Adapter保証は45件のEmulator回帰で確認した。新しい道場業務操作全体について未検証の保証を拡張しない。

## Build・配布・互換性

- ARCH Build／noEmit型検査／Unit宣言を使う道場側型検査が成功。
- 追加JSとtarget.mjsの構文検査、両repoのgit diff --check成功（既存の改行警告あり）。
- 道場`.build/workflow-unit-stage-*`の新規隔離領域に配布入力を構成し、固定lockでnpm ci --offline --omit=dev --ignore-scriptsを実行。archive SHA確認とdev-server moduleのロード成功。ビルド入力内に隣接ARCH参照を必要としない。
- tools/target.mjsの追加処理はWorkflow moduleとvendorを出力へ同梱するだけ。既存`.build/dev-firebase`を削除・再生成する通常target buildは、既存成果保護のため実行していない。Cloud Run実ビルド・実行、稼働環境Node/IAM、既存ビルド全経路の検証は未実施。
- 両repoの全既存ファイルを作業前後のSHAで比較し、ARCHはpackage.jsonのみ、道場はpackage.json／lock／target.mjsのみが今回の既存ファイル変更。既存Core・Adapter・業務実装・未追跡文書は変更していない。

## 変更ファイル

ARCH：package.json、tsconfig.workflow-unit.json、tools/package-workflow-unit.cjs、tests/workflow-unit-package.test.cjs、本報告書、EXPERIMENT_021_A_INTEGRATION_READINESS.md。

道場：package.json、package-lock.json、tools/target.mjs、cloud/workflow/{unit,application,api,synthetic,dev-server}.cjs、tools/{stage-workflow-unit,test-workflow-unit}.cjs、work/{verify-workflow-unit.test,workflow-unit-host}.cjs、vendorの固定tgzとSHA記録JSON。

## 起動・停止

ARCHで`npm run package:unit`。同Version内容変更は拒否されるため、Unit修正後はVersionを更新して再配布する。道場で`npm ci --ignore-scripts`後、`npm run workflow:verify`。

自動検証は道場の`npm run workflow:test`。JavaとローカルEmulator JARが必要。runnerは所有するEmulatorを起動し、専用namespaceの合成データだけを使い、子HostとEmulatorを終了する。

手動起動では、ローカルFirestore Emulatorをproject demo-arch026-c2で起動し、`$env:FIRESTORE_EMULATOR_HOST='127.0.0.1:8080'`を設定して`npm run workflow:dev`。127.0.0.1:3021で待受。POSTはOrigin http://127.0.0.1:3021、Content-Type application/json、Authorization Bearer fixture-admin（ローカル合成資格）を付ける。fixture-member／fixture-teacher／fixture-inactiveも試験用のみ。実認証情報は不要。

Ctrl+Cで受理済要求をdrainし接続を閉じる。試験fixtureはIPC closeでsignalに依存せず停止する。手動起動したEmulatorもその起動元で停止する。Emulator停止時にMemoryや本番へフォールバックしない。

## 判定と次工程への引継ぎ

021-Aの配布／開発環境統合設計は確定し、021-Bの最小Unit統合・合成データ実行・永続化・別プロセス取得・競合／権限拒否を実測した。既存道場回帰の1件FAILと本番ビルド未検証を残すため、全体の無条件合格とはしない。

次工程の判断事項は、既存認証境界試験の仕様整合、Node24のCloud Run build条件、実認証依存の注入方法、申請・承認業務全体のApplication設計、UNKNOWNの運用回復、配布物更新・承認手順。今回は実ユーザー・本番DAOへ接続せず、021-Cへ進まない。Stage／Commit／Push／Deployなし。
