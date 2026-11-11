# TimeTrip

内部モジュールは`src/TimeTripCore.js`。日時取得・取得元判定・設定検証・保存の既存処理を提供し、CJobFormを継承しない。旧`TimeTravel.js`からファイル名だけを変更し、内容は同一。公開サブパス`@arch026/timetrip/time`は維持し、新ファイルへ解決する。旧ファイル名の互換モジュールは設けない。ApplicationのgetSystemContext／getTimeTravel／saveTimeTravelという正式API名は変更しない。Migrationの移植元は旧道場の実ファイル`shared/TimeTravel.js`のまま、移植先だけを新名称へ更新する。

改名時の検証：TimeTrip 17 PASS（公開サブパス・旧ファイル不在の確認1件を追加）、Workflow Unit 20 PASS、Migration再検証50 PASS。Build・型検査・JS構文検査を確認。下記の統合時件数は前回作業の記録として保持する。

`@arch026/timetrip/job`の`TimeTrip`は`@arch026/workflow`のCJobFormを継承する。

```js
const {TimeTrip}=require('@arch026/timetrip/job');
const trip=new TimeTrip(dao, {
  enabled:true, now:'2099-07-09T10:00:00+09:00', target_month:'2099-07'
}, {timezone:'Asia/Tokyo', clock:()=>new Date()});
const before=await trip.today(); // Job実行を必要としない
await trip.execute();          // 既存DAOへ日時取得元を設定・記録
const after=await trip.now();
```

第2引数省略時のJob入力はシステム日時（enabled:false）。構築時には保存しない。設定入力を値として捕捉し、collectで実行別にコピーする。makeは既定の受渡し、recordは既存Application.saveTimeTravelに委譲し、検証失敗（ok:false）をINVALID_TIME_SETTINGとしてJobへ通知する。prepare・cleanupは基底の空処理、postは既定の公開処理を使う。CWorkflowのjobにそのまま渡せる。同一定義でもコンテキストは訪問ごとに独立する。

nowはDate、todayはyyyy-MM-dd、targetMonthは既存の対象月文字列を返す。同期DAOなら同期値、非同期DAOならPromiseを返す。いずれも取得の都度SystemContextを読み直す。JobのREADY／FAILED／COMPLETEDを参照しない。getSystemContext／getTimeTravel／saveTimeTravelの3 APIも委譲で維持する。既存パッケージrootのcreateApplication、/time、/contextは変更しない。

保存はTIME_TRAVEL_ENABLED、DEBUG_DATE、DEBUG_TARGET_MONTHの順。既存DEBUGは変更しない。対象月は既存どおりyyyy-MMという形式検証のみ（2099-99も受理）、日時は既存Date判定を維持する。これを厳格化する場合は別途仕様判断が必要。

不正入力は保存前に拒否される。ただしDAOが途中で失敗すると、既存の非Transaction保存契約により一部の設定が保存される可能性がある。cleanupは設定のロールバックを行わない。同じ設定DAOへの競合書込を直列化する仕組みは追加していない。日時APIはその時点の保存済み設定を観測し、不正な保存データや読取障害は既存エラーとして伝える。Job失敗後も必ず正しい日時を返す、という保証はしない。

## 開発・検証

Workflow UnitをビルドしてからTimeTripの依存をローカル導入する。Framework内ではWorkflowへのローカルリンクを使用し、CJobFormのクラス同一性を保つ。Coreも明示的なローカルリンクとし、npmのロック定義に一致させる。Migrationは両依存のリンク先を照合し、宣言した正本の内容をハッシュ対象にする。異なるWorkflowパッケージのクラスを混在させない。テストは解決先とクラス同一性も検査する。

`npm test --prefix Frwk_Units/TimeTrip`で新規13件と既存4件を実行する。旧道場の元ファイルは変更しない。Migrationでは新規クラス・テスト・本資料をNEWとして登録し、既存3ファイルの移植元基準は維持する。

ローカルリンク生成はWindowsの実行権限が必要になる場合がある。今回の初回インストールは制限環境でEPERMとなり、ローカルリンク作成が可能な環境で再実行した。最終的に`npm ci --prefix Frwk_Units/TimeTrip --offline --ignore-scripts --no-audit --no-fund --install-links=false`でロックからの再導入を確認した。既存Coreのソースは変更していない。

統合時の試験：TimeTrip 16 PASS、Workflow Unit 20 PASS（既存18件＋prepare 2件）、既存npm test 529 PASS、既存Workflow／SQLite／WAITING／Lease／UNKNOWN／パッケージ試験272 PASS、Migration管理29 PASS。Migration再検証は全5グループ49 PASS。Firestore等の外部サービスは利用しない。旧配布物は保持し、6工程版の互換配布候補はworkflow-unit 0.3.0-framework.3とする。今回パッケージを公開・導入先更新していない。
