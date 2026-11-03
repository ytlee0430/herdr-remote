# 專案交接

這份文件描述目前程式；新的 session 不應宣稱擁有舊聊天的完整記憶。
安裝與使用見 [README](README.md)、[本機測試](LOCAL-TEST.md)及
[對話映射](CONVERSATION.md)。私人部署筆記不屬於可分享的版本。

## 目前網站功能

- `npm start` 執行 `relay.mjs`，搭配 Python `client.py` 主動連線至 relay。
- 預設對話模式可輸入；另有智慧重排、保留分行及原始行寬。
- 滿版閱讀、8–24px 字體、完整 xterm 終端、控制按鍵與 prompt 傳送。
- Model 按鈕操作即時 CLI 選單，支援原生選項與 effort。
- 可依 workspace／worktree 篩選；建立 pane 可指定來源 workspace 與 pane。
- 啟動 Devin、Codex、Claude；精確命令列於 README。
- 關閉 pane 有確認視窗及 terminal ID 核對；不刪除 worktree 檔案。

## 對話來源與限制

對話功能已移除 PoC 標示。Codex／Claude 使用明確映射的 JSONL，
Devin 使用本機 SQLite 主對話鏈。映射由 bridge 主機設定，網站不能提供路徑。
來源讀取是唯讀，但輸入操作目標是目前 live pane。
映射不驗證 live PID，也不自動追蹤換 session；授權畫面須查看原始終端。
沒有來源時顯示設定說明，不猜測其他使用者或其他 session 的紀錄。
CLI 原生選單與資料格式升級後可能需要調整 parser。

## 工程注意事項

- `server.mjs` 與舊桌面入口是歷史實驗；目前入口是 relay 與 mobile UI。
- Bridge 功能版本為 `mobile-v3`；更新 Python bridge 不需重啟 agent。
- 建立 pane 使用指定 workspace 的 tab/root pane，不強制切換原生焦點。
- Workspace metadata 有短期快取；worktree 以 herdr 回傳資料判斷。
- 保護原生輸入草稿，避免呼叫 `/model` 時一起送出。
- 一個 client 同時間只接受一個網站控制端；relay 重啟會清除登入狀態。
- 未設定 HOST／PORT 時仍使用相容預設 `0.0.0.0:443`（HTTP）。
  本機測試請使用 `HOST=127.0.0.1 PORT=3000`；跨網路需 HTTPS 代理。
- 不讀出或提交憑證、真實對話、映射及本機部署日誌。
- 不任意停止、重啟或操作不屬於測試的既有 agent／pane。

## 測試

```sh
npm ci
TEST_HERDR_BINARY=/absolute/path/to/herdr npm test
python3 -m unittest discover -s test -p '*_test.py'
git diff --check
```

未設定 TEST_HERDR_BINARY 時會略過真實 herdr 整合測試。
完整流程與如何進入同一個本機測試 session 見 LOCAL-TEST.md。

## 分享與歷史

忽略規則只保護未追蹤檔案，不會清除歷史。
分享前檢查分支內容及作者資訊，避免連同私人歷史或本機備份推送。
專案尚未指定 LICENSE，對外授權方式須由維護者決定。
