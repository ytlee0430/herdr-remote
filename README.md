# Herdr Remote

從手機或桌面瀏覽器，閱讀並操作既有的 [herdr](https://herdr.dev/) pane、
Codex、Claude Code 與 Devin CLI。介面以繁體中文為主。

```text
瀏覽器 ── HTTP(S) / WebSocket ── Relay
                                 ↑
                     Python bridge 主動連出
                                 ↓
                       已運行的 herdr session
```

Relay 不需要 SSH 進入 agent 主機。此專案可供個人或可信任團隊自行架設；
目前不是多租戶服務，沒有使用者／workspace 層級的權限隔離。

## 功能

- Pane 搜尋、最近輸出／等待回覆／名稱排序，Workspace／Git Worktree 篩選。
- 對話模式（預設）、智慧重排、保留分行、原始行寬；滿版閱讀與 8–24px 字體。
- 對指定 pane 傳送 prompt、Enter、Esc、Tab、方向鍵及 Ctrl+C。
- **Model**：開啟 agent 的原生 `/model` 選單，從網頁選擇模型與 effort。
  也可在網站直接輸入 `/model`。會檢查原生輸入區，避免把既有草稿一起送出。
- **＋新視窗／啟動 Agent**：選來源 workspace／worktree 與 pane，沿用工作目錄。
- **關閉 Pane**：確認後結束該 pane 的程式；不刪除 Git worktree 檔案。
- xterm.js 完整終端；至少 120 欄，手機可橫向捲動。
- 瀏覽器重新整理保留裝置、pane 與排版；未送出草稿只保留在當前頁面記憶體。

## 需求

| 位置 | 需求 |
|---|---|
| Relay 主機 | Node.js 20+、npm；支援 HTTP(S) 與 WebSocket 的網路 |
| Agent 主機 | Python 3.9+、macOS／Linux／WSL、已安裝且運行中的 herdr |
| Agent | 自行安裝、登入 Codex／Claude Code／Devin CLI；本專案不提供帳號或模型 |
| 瀏覽器 | 支援 WebSocket 的現代瀏覽器 |
| 執行完整測試 | Google Chrome、Git、C 編譯器，以及 herdr 執行檔 |

已使用 herdr 0.9.5 驗證。原生 Windows client 尚未支援；可使用 WSL。
Python bridge 只使用標準函式庫，不需要 pip 套件。

## 快速開始：同一台主機

取得專案後，在專案根目錄執行：

```sh
npm ci
HOST=127.0.0.1 PORT=3000 npm start
```

開啟 `http://127.0.0.1:3000`。第一次啟動會建立權限為 `0600` 的
`.credentials.json`。在本機用編輯器查看，不要提交、貼到聊天或放進網址：

- `browserPassword`：網站登入密碼。
- `clientToken`：bridge 的連線憑證，與登入密碼不同。

在另一個終端啟動 bridge；使用與 herdr 相同的 OS 使用者：

```sh
python3 client.py --server http://127.0.0.1:3000 --id local --label '本機'
```

於 `Client token (hidden):` 輸入 `clientToken`，再於網站選擇裝置並連線。
需要指定既有 session 時，加上 `--session YOUR_SESSION`；`--herdr /path/to/herdr`
可指定執行檔。bridge 不會替一般使用者自動建立新的 herdr session。
若尚無 session，請先在另一個本機終端啟動 herdr。

若只是要測試整套功能，可使用會建立獨立測試 session 的
[本機測試 launcher](LOCAL-TEST.md)。

**首次使用若看到「尚未設定對話來源」**：先選「保留分行」操作；
結構化對話需要另行設定 [transcript map](CONVERSATION.md)。

## 從另一台主機／手機連線

Relay 的 `HOST`、`PORT`、`CREDENTIALS_FILE` 可透過環境變數指定。
為相容既有部署，未設定時是 `0.0.0.0:443`；這仍是 **HTTP，不是 HTTPS**。
上面的快速開始刻意使用本機回環位址與非特權 port。

跨網路使用前，請在 relay 前方配置 HTTPS 反向代理，並支援 `/terminal`
的 WebSocket 升級及保留 Host header。Relay 本身不建立 TLS 憑證。
將以下 `relay.example.com` 替換為自己的 HTTPS 網址：

```sh
curl --fail --show-error https://relay.example.com/client.py -o herdr-remote-client.py
python3 herdr-remote-client.py \
  --server https://relay.example.com --id workstation --label '工作站' \
  --session YOUR_SESSION
```

client 只需主動連出，沒有 inbound VDI port 要開。
HTTP(S) proxy 依 Python urllib 的環境變數處理。
此服務使用共用密碼及共用 client token，請只提供給可信任的操作者。

### 既有 SSH／saved machine

若 bridge 本機的 herdr session 與目標主機不同：

```sh
python3 client.py --server https://relay.example.com --id remote --remote lab-server
# 或使用已有的 herdr saved machine：
python3 client.py --server https://relay.example.com --id remote --machine YOUR_MACHINE
```

`--remote` 使用既有非互動 SSH 驗證，不安裝 herdr 或修改 SSH 設定。
`--machine` 不可同時搭配 `--remote` 或 `--session`。
這兩種模式僅提供 pane 操作，停用完整終端與本機 transcript 讀取。
需要結構化對話時，將 bridge 放在 agent 真正運行的主機。

## 日常使用

### Workspace／Worktree 與新 pane

清單的篩選器可選全部、一般 workspace、Git worktree 或指定 workspace。
分支與 checkout 路徑來自 herdr，最多每 30 秒更新；不因分支名稱而假定它是 worktree。

「＋新視窗」及「啟動 Agent」可選來源 workspace，再選要沿用工作目錄的 pane。
實際建立的是該 workspace 的新 tab/root pane，不會建立新的 Git worktree，
也不會強制切換原生終端的焦點。

目前啟動選單的命令如下；其中 Codex 會略過 approvals 與 sandbox，
僅應在你願意授予該權限的環境使用：

| 選項 | 命令 |
|---|---|
| Shell | 只建立 shell |
| Devin | `devin` |
| Codex | `codex --dangerously-bypass-approvals-and-sandbox` |
| Claude | `claude --allow-dangerously-skip-permissions` |

新 agent 先使用終端文字模式；對話來源須另行映射。
關閉 pane 會結束其中的 shell／agent，確認視窗會列出目標，送出前也會核對 terminal ID。
關閉、啟動或傳送逾時時不要直接重試，先更新清單與檢查原始畫面。

### 對話與 Model

[對話設定](CONVERSATION.md)說明 Codex／Claude JSONL 與 Devin SQLite 的映射。
對話紀錄是歷史投影；輸入及控制按鍵仍作用於目前的 live pane。
授權要求請查看「保留分行」或完整終端，歷史工具紀錄不能當作目前的授權介面。

Model 使用即時終端選單，不內建模型清單。點選項目後按「確認」，
方向鍵可切換更多選項與 effort；Codex 第二層選單會留在相同視窗。
CLI 介面格式改版可能需要更新 parser。遇到不熟悉的格式，請改用原始終端。

### 更新與重啟

1. 停止 Python bridge，保留 herdr 與 agent。
2. 更新專案／下載新的 `client.py`。
3. 用原本的 session、client ID、token 與 transcript map 重啟 bridge。
4. 等待重連並重新整理網站；原註冊過期可能需最多 45 秒。

需要新 relay 功能時也須重啟 `npm start`。登入狀態只存在 relay 記憶體中，
relay 重啟後需重新登入。沒有安裝開機自啟服務。
可用 `--token-file /private/path/client.token` 避免互動輸入，並將該檔案權限設為 `0600`。
新版關閉 pane 功能要求 `mobile-v3` client。

## 限制與排查

- 一台 client 同時間只允許一個網站控制端；不會默默踢掉另一個使用者。
- 網站的 pane 選取與 herdr 完整終端焦點是分開的。看不到新 pane 時，
  確認裝置／session／workspace／tab 是否相同。
- 終端文字讀取不是完整歷史：每次最多約 300 行／24,000 字元。
- 對話映射不會自動追蹤 `/clear`、重啟後的新 session 或 pane 移動。
- 智慧重排在 working 時顯示 Working；保留分行可看即時終端輸出。
- macOS／Linux 已驗證；不同 herdr／agent 版本與遠端 SSH 環境仍需實測。
- 本機測試 session 只是設定隔離，不是 OS 安全沙箱。
- 登入密碼能控制連線 client 的終端，沒有檔案系統或命令層級隔離。
- 本專案尚未指定 LICENSE；對外發布前請由維護者決定授權方式。

## 開發與驗證

```sh
npm ci
npm test
TEST_HERDR_BINARY=/absolute/path/to/herdr npm test
python3 -m unittest discover -s test -p '*_test.py'
```

不設定 `TEST_HERDR_BINARY` 時，真實 herdr 整合測試會略過。
測試使用合成對話、暫存憑證與獨立設定；包括目標 pane 傳送、Model UI、
workspace/worktree 建立來源、關閉確認、唯讀 transcript 與終端轉送。

| 檔案 | 用途 |
|---|---|
| `relay.mjs` | HTTP、登入、WebSocket 與 client long polling |
| `client.py` | herdr bridge、pane 操作及對話 reader |
| `public/mobile.*`、`controls.css`、`text-layout.js` | 現行手機介面 |
| `scripts/local-test.py` | 獨立本機測試 launcher |
| `server.mjs`、`public/index.html/app.js/style.css` | 舊實驗入口，`npm start` 不使用 |

## 分享前檢查

不要分享 `.credentials.json`、token、真實對話、資料庫、日誌、transcript map
或 `.local-test/`。這些檔案已列入 `.gitignore`，但忽略規則不會移除已存在的 Git 歷史。
推送前仍應檢查要推送的分支及 commit 作者資料，勿將本機私人歷史一起推送。
