# 對話模式

目標：既有 agent 不重啟、不另開 session，將 terminal 畫面之外的結構化
對話紀錄投影到手機閱讀器。這是自製輕量 JSONL reader，參考
[herdr-acp mirror 的架構與格式](https://github.com/penso/herdr-gpui/blob/main/crates/herdr-acp/README.md)，
**不是安裝 herdr-gpui、不是實作 ACP，也沒有接管既有 agent。**

## 已驗證／尚待驗證

- 合成 Claude/Codex JSONL：使用者訊息、agent 回覆、思考摘要、工具紀錄分類。
- Codex 只讀 response_item，避免 event_msg 重複；明確標成 commentary 的訊息折疊。
- Claude 略過 sidechain、依 uuid 去重；thinking/tool blocks 折疊。
- 手機瀏覽器：折疊／展開、滿版、8–24px 閱讀字體、保留草稿、傳送與控制按鍵、HTML 當純文字。
- 原有 relay/PTY 測試通過；未為此重啟任何真實 agent。
- 真實 CLI 格式會隨版本變更；更新後請重新驗證映射與顯示。

## Agent 主機設定

只支援直接在 agent 主機 本機跑的 bridge。`--remote` / `--machine` 不會讀取本機
其他 session 的檔案。先選一個已有 Claude 或 Codex 的 pane，確定它的
session ID 與實際 JSONL 檔案。不要用最近修改時間猜 session。

用編輯器在 agent 主機 建立 `transcript-map.json`，替換下面三個 placeholder：

```json
{
  "YOUR_PANE_ID": {
    "agent": "codex",
    "sessionId": "EXACT_AGENT_SESSION_ID",
    "path": "/absolute/path/to/the/exact-session.jsonl"
  }
}
```

Claude 的 `agent` 填 `claude`。每個 pane 都需明確映射。設定檔只能由 VDI
端提供，瀏覽器不能傳入檔案路徑。不要把真實對話或映射提交 Git。

只停止 Python bridge，不停止 herdr 或 agent，然後更新並重開：

```sh
curl -fS https://relay.example.com/client.py -o herdr-remote-client.py
chmod 600 transcript-map.json
env -u HERDR_SESSION -u HERDR_SOCKET_PATH \
  python3 herdr-remote-client.py \
  --server https://relay.example.com --id workstation --label workstation \
  --transcript-map ./transcript-map.json
```

沿用原本 client token。新 client 上線後，網頁重新整理、選該 pane、將排版
切為「對話」。舊 client / 未映射 pane 會顯示說明，不自動改讀其他來源。

## 安全邊界與限制

- 讀取本機設定的單一檔案；拒絕末端符號連結與非一般檔案。
- 從有限大小的 header 驗證 session ID，讀取最近 2 MiB；未完成 JSON 行等待下次。
- 最多保留 100 個項目，回應項目約 60 KiB；過長文字截短。未知紀錄略過。
- 不抓取圖片／網址、不執行 HTML、不顯示加密的推理內容；只顯示 log 本來提供的文字摘要。
- 映射是人工指定的歷史來源，**不會驗證 live PID／pane 現在是否仍是同一 agent**。
  pane 重用或 agent 換 session 時，需重新確認映射。對話模式可傳送、新視窗及控制按鍵，操作目標是目前選取的 live pane，並非歷史 session。
  授權狀態仍需切回「保留分行」查看即時畫面。
- 歷史工具紀錄不是可操作的授權要求，blocked 時提醒查看原始 pane。
- Claude 的一般 assistant 文字不一定有 final/commentary 標記；不靠文字猜測刪掉回覆。
- Relay 本身提供 HTTP；跨網路部署請配置 HTTPS 反向代理，參考 README。

## 測試

```sh
npm test
python3 -m unittest discover -s test -p '*_test.py'
```

## Devin CLI

支援已驗證的 Devin CLI `3000.11.92` 本機 `sessions.db` 格式，以 SQLite
`mode=ro` 及唯讀交易取得明確指定 session 的主對話鏈。只沿 `main_chain_id`
追溯父節點，略過其他分支、system 訊息與 reasoning 欄位；工具紀錄維持折疊，
不執行資料庫中的 HTML 或命令。最多追溯 100 個節點、讀取 2 MiB 訊息，
回應仍受約 60 KiB 上限限制。這是版本相關的本機格式，不是 Devin 公開 API。

映射範例（實際映射留在 client 本機，不提交 Git）：

```json
{
  "YOUR_PANE_ID": {
    "agent": "devin",
    "sessionId": "EXACT_DEVIN_SESSION_ID",
    "path": "/home/USER/.local/share/devin/cli/sessions.db",
    "cwd": "/absolute/workspace/path"
  }
}
```

配置時以 Devin 程序的 `HERDR_PANE_ID` 與開啟的 `session_locks/*.lock`
交叉確認 session，不能只靠 cwd、最新修改時間或可能過期的 herdr session 標記。
此映射不會自動跟隨 `/clear` 或切換 session；切換後須重新確認映射。
對話隨資料庫提交更新，不保證逐字串流。既有 session 不必開啟 `--export` 或重啟。
