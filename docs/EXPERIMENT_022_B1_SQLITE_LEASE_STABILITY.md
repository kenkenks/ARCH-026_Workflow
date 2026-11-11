# 実験022-B1：SQLite診断読取競合の修正

2026-11-09。ARCHのみ改修。開始HEADは26f22fdcafb1276f8a32d31629cef52759436d03。既存未コミット成果187ファイルのSHAとGit状態を記録し、今回の変更と分離した。道場側・既存データ・既存配布版は変更していない。

## 原因と変更

既存tests/job-run-lease.test.cjs:36は、同じSQLiteファイルの別runを2プロセスで並行再開する。diagnostic.cjsのreadOnly接続は通常SimpleDB.openのtimeoutを経由せず、PRAGMA application_id等がSQLITE_BUSY/LOCKEDになり得た。従来はHISTORY_READ_UNAVAILABLEへ丸められ、診断不能がRESUME_REFUSEDとして見えていた。C1では原例外database is locked／errcode=5を観測済み。

src/adapters/job-execution/diagnostic.cjsを変更し、ヘッダー・run読取の原SQLite codeを保持して一時ロックをHISTORY_READ_BUSYとして識別した。読取Transaction・接続を終了してから、診断入力全体を再取得する。既定は最大4試行、間隔10ms、再読込開始の総deadline150ms。設定の上限は10試行・間隔100ms・deadline1000ms。deadline後に新しい試行を開始しない。OSのスケジューリング停止まで含む厳密なwall-clock応答時間保証ではない。

上限到達時は部分DTOを捨て、run:null／空の観測配列／HISTORY_READ_BUSYを返す。Schema不一致等を一時ロックとして再試行しない。定義Repository側で一般エラーへ変換された読込不能は引き続き安全側の診断不能であり、すべてのUNAVAILABLEを再試行する実装にはしていない。

src/adapters/job-execution/resume.cjsでは、読取ロックによる診断不能をDIAGNOSTIC_READ_BUSY、claim/resumeの拒否コードをDIAGNOSTIC_UNAVAILABLEとする。保存内容の不適合は従来のRESUME_REFUSED。再読込後も既存fingerprint、所有権、claimToken、fencingToken、Lease検証をすべて実施する。write、commit、Jobの再実行は再試行しない。

## 決定的試験

新規tests/sqlite-diagnostic-retry.test.cjsは5 PASS／0 FAIL。

- 実SQLiteのBEGIN EXCLUSIVE中に読取り、再試行hookで解放して再取得成功。
- ロックを保持したまま上限に到達し、部分DTO破棄・診断不能分類・claim拒否をassert。
- Schema不一致では再試行0回。
- 回数・間隔・deadlineの設定上限を検証。
- 別プロセスが保持するロックをIPCで解放し、任意のsleep頼みでない再取得を確認。

これらは一時DBだけを使う。既存の所有権喪失・stale Host・Fencing・複数プロセス試験を含む291件も最終全件PASSした。

## 修正前後の反復結果

対象を変更・弱体化せず、各回別Nodeプロセスで実行。

| 集合 | PASS | FAIL | 内容 |
| --- | --- | --- | --- |
| 今回の修正前50回 | 48 | 2 | 26、32回目ともRESUME_REFUSED |
| 修正後の初回50回 | 49 | 1 | 25回目HISTORY_SAVE_OUTCOME_UNKNOWN |
| 修正後の追加50回 | 50 | 0 | 同じ対象試験、条件変更なし |

ログは無視対象logs/022b-before-*、022b-after-*、022b-after-isolated-*。C1の過去50回（46 PASS／4 FAIL）とは別の実行である。修正前の2件について今回は原SQLite例外を捕捉していないため、両方をロック由来と断定しない。

**修正後初回の1件は未解決。** 約3.2秒でHISTORY_SAVE_OUTCOME_UNKNOWNとなった。履歴保存・commit等の元原因は既存子fixtureの応答に残っておらず確定できない。読取拒否の改善と、保存結果不明の解消は別問題。追加50回PASSや全回帰PASSで最初のFAILを抹消しない。全負荷条件でLease試験の安定化が完了したとは判定しない。保存を自動再送する修正も行わない。

新規試験作成中にはIPC解放後の重複sendでEPIPEを1件発生させた。fixtureのcleanupを修正し、最終5件PASS。既存試験の期待値は変更していない。

## 回帰・判定

最終既存回帰はnpm test529＋追加実験291＋Memoryデモ27＋既存Emulator45＝892 PASS／0 FAIL。新規WAITINGを含む49件、パッケージ2件もPASS。初回FAIL・反復結果は別途上表のとおり。

変更はdiagnostic.cjs、resume.cjs、新規sqlite-diagnostic-retry.test.cjs。所有権実装ownership.cjsやSQLiteの通常timeout・Lease期限は変更していない。

**判定：診断読取の分類・有限再読込は実装／検証済み。ただし反復に保存結果不明FAILが残ったため、B1全体を無条件成功扱いしない。** 次に必要なのはfixtureの安全なstorageCause記録と保存境界の決定的再現であり、待機時間の引延ばしではない。
