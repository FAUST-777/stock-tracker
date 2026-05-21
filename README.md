# 📈 Stock Tracker — VOO / VTI / QQQ

**by Willie Lin**

本機美股即時追蹤儀表板，支援價格走勢圖與價格警報（Windows 桌面通知 + 音效 + 全螢幕彈出）。

## 快速啟動

```bash
npm install
npm start
```

瀏覽器開啟 http://localhost:3000

或直接雙擊 `啟動股票追蹤器.bat`

## 功能

- 即時報價（每 60 秒自動更新，15 分鐘延遲）
- 走勢圖切換：今日 / 5日 / 1月 / 3月 / 6月 / 1年
- 每支股票可設定高點 / 低點價格警報
- 警報觸發：Windows 系統通知 + 音效 + 全螢幕彈出
- 警報設定持久化（`alerts.json`），重啟後自動載入

## 資料來源

Yahoo Finance `/v8/finance/chart`（免費，無需 API Key，15 分鐘延遲）

---

## 技術說明

### 後端（server.js）

| 技術 | 用途 |
|------|------|
| **Node.js v18** | 執行環境 |
| **Express** | HTTP 伺服器，提供 API 路由與靜態檔案 |
| **ws（WebSocket）** | 每 60 秒推送最新報價到瀏覽器，不需手動重整 |
| **Node.js `https` 模組**（內建） | 直接呼叫 Yahoo Finance v8 API，不依賴第三方套件 |
| **node-notifier** | 觸發 Windows 桌面系統通知 |
| **`fs` 模組**（內建） | 讀寫 `alerts.json`，持久化警報設定 |

### 前端（index.html）

| 技術 | 用途 |
|------|------|
| **原生 HTML / CSS / JavaScript** | 整個介面，無框架 |
| **WebSocket API**（瀏覽器內建） | 接收伺服器推送的即時報價 |
| **Chart.js v4** | 繪製走勢折線圖 |
| **Web Audio API**（瀏覽器內建） | 警報觸發時播放 beep 音效 |
| **CSS 變數 + Flexbox** | 深色主題 UI 排版 |

### npm 依賴（僅 3 個）

```
express       HTTP 伺服器
ws            WebSocket 伺服器
node-notifier Windows 桌面通知
```
