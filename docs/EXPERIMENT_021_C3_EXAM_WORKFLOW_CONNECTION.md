# 実験021-C3：実装停止記録

2026-11-09。実装は未着手。C3完了報告ではない。

## 停止理由

021-C2で、既存の審査申請・承認・差し戻しの業務契約を確認できず、既存構想の「先生が対象者を登録」と要求候補の「会員が申請」の対応も未確定と分かった。また固定Unitに保存・復元可能な通常WAITING契約はなく、既存020デモのLIMIT_REACHED流用は今回禁止されている。

ユーザー指定の停止条件「既存審査業務の仕様が不明確」「Workflow Unitの変更が不可避」に抵触する可能性があるため、独断のMock契約やCore変更で成立させない。Application層での待機を別途認めるか、ARCH側で待機契約を検討するか判断が必要。

## 保全・検証

- 使用予定Unitは0.1.0-experiment.021.1。ARCH生成済archive・道場vendor・導入済manifest/内容一致を再確認済み。SHA-256は`e7f97e55ed2da17adf32cb7358df39c816ed7e929ea4c7dee1b87d0aafda34c4`。
- 新しい道場JobForm／Definition／API／Mockは追加していない。既存021-Bも変更していない。
- 既存Core・認証・業務・DB・未コミット成果・Inventory等は保全。
- 今回の再現試験と結果は021-C1報告。既存892件、パッケージ試験、021-B Emulator統合、新審査申請試験は今回未実施。前回PASSを今回実行したものとして報告しない。
- Emulatorは今回起動していない。Lease試験の一時SQLite・子プロセスのみ使用し、各fixtureは終了済み。
- 今回の成果物は021-C1／C2／C3の3報告書のみ。観測用コード・ログは無視対象logs/.build内の一時成果。Stage／Commit／Push／Deployなし。

## 次工程への引継ぎ

先に業務開始主体と合成デモ契約、通常待機の意味を確定する。WebConnect試験は既知／未知actionを分離する修正案、Lease試験は診断read-only接続のBUSY/LOCKED分類・有限再読込と決定的競合試験案をレビューする。Unit収録機構を改修する場合はARCHでのみ行い、新Version・新SHA・回帰の後に道場へ配布する。今回の固定Unitを道場側で直接改変しない。
