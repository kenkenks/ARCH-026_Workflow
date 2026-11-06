# HelloWorld-B 工程1: Communication契約

Host・UI・Firestoreを含まない、Client PortとJSON HTTP Adapterのみの実装。

## 配置と利用

- `src/hello-client/contracts.ts`: Client Port、HelloRequest、Result、FailureCode、CredentialSource、公開用CommunicationError。
- `src/hello-client/wire.ts`: Request / Resultの純粋検証とHTTP status照合。
- `src/adapters/hello-http/client.ts`: fetch依存注入、endpoint、deadline、資格付与。Node APIへの依存なし。
- `tests/hello-client.test.cjs`: 実Hostなしのfetch注入試験。

既存HelloRecord / Stored / Revision型とSchema Validatorを使用し、既存Core / Repository / Storage Adapterは変更しない。新しいソースは既存TypeScript Buildに含める。

Build後のテスト入口は`npm run test:communication`。将来のBrowser bundleではTypeScript入口を使用し、CommonJSのdistをBrowserへ直接読み込ませない。bundleとUIは後続工程。

`createHttpClient({ endpoint, timeoutMs, fetchImpl, credentialSource })`で構成する。endpoint既定値は`/api/hello`、絶対HTTP(S) URLも同じpathの場合だけ許可。query・fragment・URL内資格は拒否。初期timeoutは30秒、要求・応答bodyはそれぞれJSON envelopeを含むUTF-8で64KiBまで。論理Schemaにmessage長制限は追加しない。

read / add / writeは一回のPOSTのみ。資格が必要ならCredentialSourceを注入し、`getCredential(false)`の結果をBearerへ付与する。nullまたは未注入なら資格headerなし。Cookieを送らず、redirectを拒否する。資格のrefreshや401再送は行わない。実認証・Host認可は未実装。

## エラーと結果の確実性

| 条件 | 公開結果 |
| --- | --- |
| 有効な200成功Result | 検証したStored。Readだけnullを許可 |
| 既知code・正しいHTTP statusの拒否Result | そのcodeのCommunicationError |
| 送信前の入力違反・body超過 | INVALID_ARGUMENT / VALIDATION_FAILED、fetchなし |
| 構成不正 | UNSUPPORTED_CONFIGURATION、fetchなし |
| 送信前の資格取得失敗・deadline | UNAVAILABLE、fetchなし |
| Readの通信失敗・timeout・body読取失敗 | UNAVAILABLE |
| Readの不正JSON・Result・HTTP矛盾 | INTERNAL |
| 応答bodyの64KiB超過・不正UTF-8 | ReadはINTERNAL、Add / WriteはOUTCOME_UNKNOWN |
| Add / Write送信後の通信失敗・timeout・不正応答 | OUTCOME_UNKNOWN |

HTTPは成功200、入力400（INVALID_ARGUMENTは405/413/415も可）、認証401、権限403、未存在404、重複・競合409、利用不可／成否不明503、内部／保存構造等の障害500を照合する。未知code、余分なwire field、異型record、空Revision、要求と異なるID、Read以外のnull成功を拒否する。

Add成功のrecordは要求recordと一致することを検証する。Writeもid・messageの一致と、応答RevisionがexpectedRevisionと異なることを確認する。Revisionは非空文字列の一致／不一致だけで判断し、数値・日時・大小比較はしない。不整合はOUTCOME_UNKNOWNとし、再送しない。Readは要求idとの一致を確認する。

応答はReadableStreamから実受信byte数を数え、Content-Lengthに依存せず上限を適用する。64KiBちょうどは許容し、超過時はreader.cancelとAbortControllerで中断する。UTF-8の文字境界をまたぐchunkはbyteを収集後にdecodeする。cancel・releaseLockの失敗／未完了が元のエラーを置換・遅延させない。timeout後に遅れて届いた応答もbodyを読み始めずcancelする。

deadlineは資格取得・fetch・body読取までを対象にし、AbortControllerとPromise raceを併用する。abortを無視する注入fetchでも呼出し側は待ち続けない。資格がdeadline後に得られても送信しない。abortはHostの取消・rollbackを保証しない。再送は一切しない。

公開例外は既知code・固定messageのみで、stackとcauseを保持しない。remote issuesは形を検証しても例外へ転記しない。raw response・秘密値・SDK例外を付加しない。Readによる事後確認は状態照合であり、元の書込成功の証明ではない。

## 検証範囲

単体テストで成功3操作、null、確定拒否、Schema、UTF-8上限、status矛盾、未知code、不正JSON・成功値、資格取得失敗、timeout、応答喪失、再送なしを確認する。実Browser・Host接続・認証認可・CORS・E2Eはこの工程の保証範囲外。既存の別件exam-jobsテスト不整合は修正しない。
