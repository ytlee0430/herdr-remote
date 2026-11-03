# 本機測試

需求：Node.js、Python 3、Git 與已安裝的 herdr。從專案根目錄執行：

```sh
npm ci
HOST=127.0.0.1 PORT=3000 npm start
```

在另一個終端執行：

```sh
python3 scripts/local-test.py --server http://127.0.0.1:3000
```

launcher 沿用歷史相容名稱 `imac-test`，在網站顯示「iMac 本機測試」，
也可在 Linux 使用。它會建立獨立的 herdr session 與設定；已存在時沿用。
從本機 `.credentials.json` 讀取 client token。用其中的 browserPassword 登入網站，
選取上述裝置。不要分享此憑證檔。

預設對話範例來自 `test/fixtures/conversation-demo.ndjson`，是合成資料。
「保留分行」及完整終端可操作測試 shell；不會自動啟動 agent。
若 `.local-test/transcript-map.json` 已存在則優先使用其中的映射，
也可用 `--transcript-map /absolute/path/transcript-map.json` 指定。
真實 agent 的映射方式見 [對話設定](CONVERSATION.md)。

要在本機終端看到相同的 session，從專案根目錄執行：

```sh
env -u HERDR_SESSION -u HERDR_SOCKET_PATH -u HERDR_CONFIG_PATH \
  XDG_CONFIG_HOME="$PWD/.local-test/config" \
  herdr --session imac-test
```

herdr 必須可從 PATH 找到；launcher 另可尋找 `$HOME/.local/bin/herdr`。
設定、鎖定檔及日誌位於被 Git 忽略的 `.local-test/`。
同時只能執行一個 launcher；Ctrl+C 只停止 bridge，保留 herdr session。
未提供開機自啟服務。獨立設定不是 OS 沙箱，shell 仍有目前使用者的權限。

## 驗證

```sh
TEST_HERDR_BINARY=/absolute/path/to/herdr npm test
python3 -m unittest discover -s test -p '*_test.py'
```

整合測試使用暫存設定與獨立 session，只清理自己建立的資源。
