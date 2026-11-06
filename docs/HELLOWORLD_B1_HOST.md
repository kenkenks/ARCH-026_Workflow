# HelloWorld-B 工程2: Node HTTP Host

開発専用。127.0.0.1限定であり、本番公開用Hostではない。Host・Dispatch・Compositionのみを追加し、UI・静的ファイル配信・Fetch Host・Firestoreは含まない。

## 配置と依存方向

| ファイル | 責務 |
| --- | --- |
| `src/hello-host/dispatch.ts` | 正規化済みcredential/payloadから資格検証、要求検証、認可、Core呼出し、Result生成。Node・Storage API依存なし |
| `src/adapters/hello-node/host.cjs` | Node受信、byte制限、Host/Origin、HTTP対応、接続管理・停止 |
| `src/composition/hello-b1.cjs` | B1 EnvironmentBinding、slot別静的Capability、既存StorageとCoreの注入 |
| `tools/hello-b1.cjs` | 開発用起動とready/stopのIPC・signal入口 |
| `tests/hello-host.test.cjs` | 実HTTP、Composition、純粋dispatch、IPC・drain・異常終了検証 |

Dispatchの入力は`{credential: string|null, payload: unknown}`、出力は既存Result型。IncomingMessage/ServerResponse/Socket/ファイルパス/環境変数を受け取らない。工程5のHostは同じDispatchへ正規化した情報を渡せる。CoreとRepositoryの契約は変更していない。

## 利用

`npm run hello:b1 -- <保存ディレクトリ>`。または`npm run build`後に`node tools/hello-b1.cjs <保存ディレクトリ>`。引数省略時は`runtime-data/hello-b1`。originは動的portを含むready JSONで表示される。

プログラムからは`startB1({applicationId:'hello-world',host:{provider:'node-http',options:{port:0}},storage:{provider:'local-file',options:{directory}},auth:{mode:'anonymous'}})`を呼び、`origin`と冪等な`stop()`を受け取る。手動signalに加えて、子プロセスIPCの`{type:'stop'}`でWindowsから正常停止できる。ready通知はlisten完了後のみ。

既定はOrigin必須。Browserを使わないテストだけが`host.options.allowMissingOrigin: true`を明示する。Nodeのfetchから既存HTTP Clientを使う場合、fetch注入側でOriginを付けるか、明示的にこの非Browser設定を選ぶ。ClientやCoreを環境に合わせて書き換えない。

## HTTP・認証認可

- `POST /api/hello`、application/jsonのみ。chunkの実byte数で64KiBを制限し、Content-Lengthだけを信頼しない。JSON・UTF-8不正を400、過大bodyを413、媒体型を415、methodを405、pathを404で拒否。
- listenは127.0.0.1のみ。Hostを起動originのauthorityと一致させ、Originは完全一致。重複Host/Origin/Authorizationを拒否。CORS許可・Cookie認証・任意ファイル配信なし。
- 不正transportはCoreへ渡さない。Dispatchは資格検証→要求構造検証→操作認可→Coreの順。unknown入力と共有Validatorを使い、principalをpayloadから受け取らない。
- 匿名開発モードはwriter principal。fakeモードは公開可能なfixture資格`fixture-reader`と`fixture-writer`だけを認識し、欠落・不明資格は401。readerのAdd/Writeは403。これは実認証ではない。
- 成功200、入力400、未認証401、認可403、Write未存在404、重複/CAS409、利用不可/成否不明503、内部/Schema/破損500。wireは固定codeだけを返し、内部例外・stack・診断をserializeしない。
- 結果も64KiB以内。保存後に成功Resultが大きすぎる場合、Add/WriteはOUTCOME_UNKNOWN、ReadはINTERNAL。保存成功済みでも小さな失敗Resultへ変換し、暗黙rollback・再送しない。

## 構成・Capability

host slotはjson-http/authn-boundary/authz-boundary/loopback-only、storage slotはatomic-create/revision-write/restart-persistenceをversion 1として提供する。追加の`requires.host` / `requires.storage`はslotごとに照合し、不足はStorage open前にUNSUPPORTED_CONFIGURATION。

設定→能力→Storage open→既存Core生成→Dispatch生成→Host listen→readyの順。AのCompositionを置換しない。起動失敗時は取得した資源を逆順に終了し、元のエラー分類を維持してcleanup失敗を固定診断ラベルへ分離する。Capability宣言は実動作保証とは別で、実HTTP・既存契約テストで検証する。

## 停止と保証範囲

正常stopは新規受付停止、受理済み要求・書込のdrain、接続終了、Storage closeの順。正常終了後にowner.lockが解放される。クライアント切断はCore操作をrollbackしない。

stopTimeoutMs（既定30秒）を超えた場合は接続を閉じOUTCOME_UNKNOWNで停止失敗を返す。処理中のStorageを早期closeせず、lockは維持する。強制終了や停止失敗後の完全復旧・自動lock解除は保証しない。運用者は処理完了・保全を確認して対応し、成功と決めつけない。

Node HostとCompositionは既存方針に合わせCJS、純粋Dispatchはstrict TypeScript。Node CJSは構文検査と実HTTPテスト、Dispatchは既存BuildとES2022/DOM型検査の対象。全HostのTypeScript化や新規型パッケージ導入は今回行わない。

## 検証

`npm run test:host`。既存Client経由の3操作、raw HTTPの不正入力、Origin/Host、認証拒否時のCore/Repository呼出しゼロ、能力不足、再起動、listen失敗cleanup、保存中stopのdrain、Windows子プロセスIPCを検証する。

実HTTP試験は127.0.0.1への接続権限が必要。sandboxでEACCESになる場合は実装失敗と混同せず、ローカル接続が許可された環境で実行する。Emulatorや外部ネットワークへは接続しない。別件exam-jobsの既存FAILは変更しない。

2026-11-06検証：工程2の20テスト、Communicationの32テスト、Aの31テストを含む`npm test`全99件がPASS。Ticket/Runtime追加回帰11件もPASS。空の一時出力先へのクリーンBuild全12成果物が通常distと一致し、既存Core・Schema・Repository契約・A Adapter/共通テスト・CommunicationソースがHEADと一致することを確認した。Node CJS構文検査と純粋Dispatchの型検査も成功。
