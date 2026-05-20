# 📈 Stock Tracker — VOO / VTI / QQQ

本機美股即時追蹤儀表板，支援價格走勢圖與價格警報（Windows 桌面通知 + 音效 + 全螢幕彈出）。

## 快速啟動

```bash
npm install
npm start
```

瀏覽器開啟 http://localhost:3000

## 功能

- 即時報價（每 60 秒自動更新，15 分鐘延遲）
- 當日走勢圖 / 5日 / 1月 / 3月
- 每支股票可設定高點 / 低點警報
- 觸發時：Windows 系統通知 + 音效 + 全螢幕彈出提示

## 資料來源

Yahoo Finance（免費，無需 API Key）

## 技術棧

Node.js · Express · WebSocket · Chart.js · yahoo-finance2 · node-notifier
