# Stock Tracker — 開發日誌與問題排解記錄

**作者：Willie Lin**
本機美股即時追蹤儀表板（VOO / VTI / QQQ），支援價格走勢圖與可持久化的價格警報。

---

## 第 1 輪開發（2026-05-20）｜專案初建 & 資料源除錯

### 完成功能
- Node.js + Express + WebSocket 伺服器架構
- 每 60 秒自動抓取報價並透過 WebSocket 推送前端
- Chart.js 走勢圖（今日 / 5日 / 1月 / 3月）
- 價格警報（高/低點設定），觸發時全螢幕彈出 + 音效 + Windows 桌面通知
- 警報設定永久寫入 `alerts.json`，重啟伺服器自動載入

---

## 遇到的問題與解決方案

### 問題 1：yahoo-finance2 v2 被 Yahoo 封鎖
**症狀：**
```
Unexpected token T in JSON at position 0
```
所有 `quote()` 與 `chart()` 呼叫全部失敗，Yahoo Finance 回傳非 JSON 內容（疑似 Terms of Service 攔截頁面）。

**嘗試的修法：**
1. 升級到 `yahoo-finance2@v3` → 需要 Node.js >= 22，使用者為 Node 18，不相容
2. 嘗試 `new YahooFinance()` 實例化語法 → 同樣因版本不符失敗

**最終解法：**
完全移除 `yahoo-finance2` 套件，改用 Node.js 內建 `https` 模組直接呼叫 Yahoo Finance 原生 API：
```javascript
// 報價：從 chart meta 讀取（不需驗證）
https://query1.finance.yahoo.com/v8/finance/chart/${sym}?interval=1d&range=1d

// 走勢圖
https://query1.finance.yahoo.com/v8/finance/chart/${sym}?interval=${interval}&range=${range}
```
帶入適當的 `User-Agent` / `Referer` headers，繞過封鎖。

**關鍵收穫：** `/v8/finance/chart` 的 `meta` 欄位包含 `regularMarketPrice`、`regularMarketOpen`、`regularMarketDayHigh` 等完整報價資訊，不需額外呼叫 `/v7/finance/quote`（該 endpoint 已需要 OAuth 驗證）。

---

### 問題 2：3 個月走勢圖空白
**症狀：** 切換到「3月」後圖表完全空白，其他時段正常。

**根因：**
- `yahoo-finance2` v2 的 `historical()` 函式已被 Yahoo 棄用並重導向 `chart()`
- 重導向後資料結構不一致，導致解析失敗

**解法：**
換用直接 HTTP 呼叫後，以 `range=3mo&interval=1d` 參數請求 `/v8/chart`，回傳 63 筆日線資料，問題解決。

---

### 問題 3：網頁偶發全灰卡頓（freezing）
**症狀：** 頁面偶爾變成全灰色，瀏覽器無響應數秒。

**根因：**
1. 每次 WebSocket 收到更新（每 60 秒），`renderStockList()` 用 `innerHTML =` 重建整個 DOM，包含 `<canvas>` 元素
2. Chart.js 在 canvas 被移除前未正確呼叫 `.destroy()`，造成記憶體泄漏
3. 舊 chart 實例殘留 + 新實例不斷建立，導致 GPU 記憶體耗盡觸發瀏覽器 GC 暫停
4. 左側 sparkline 每次更新都重建，加劇問題

**解法：**
- **DOM 更新策略**：只更新 `textContent`，絕不重建 `innerHTML`。左側卡片在頁面載入時用 `buildLeft()` 建立一次，後續只改文字節點
- **移除 sparkline**：左側卡片拿掉 canvas，根本解決 Chart.js 重建問題
- **圖表並行保護**：加入 `chartBusy` 旗標，防止 chart load 並發執行
- **關閉動畫**：`animation: false`，避免 Chart.js 動畫在背景持續佔用 CPU

```javascript
// 修前（每次 tick 重建 DOM + chart）
el.innerHTML = `...<canvas class="card-spark">...`;
canvas._chart.destroy();
canvas._chart = new Chart(...);

// 修後（只更新文字）
priceEl.textContent = `$${q.price.toFixed(2)}`;
chgEl.textContent   = `${arrow} ${chg}`;
```

---

### 問題 4：Vercel CLI 引擎不相容（相關：股票追蹤器以外的專案）
**背景：** 本機 Node.js 為 v18.20.4，Vercel CLI v47+ 要求 Node 20+，v54+ 要求 Node 22+。

**解法：** 繞過 CLI，改用 Vercel REST API `POST /v13/deployments` 搭配 `gitSource` 參數直接觸發部署。

---

## 技術架構

```
stock-tracker/
├── server.js          # Express + WebSocket + 直接呼叫 Yahoo Finance v8 API
├── public/
│   └── index.html     # 單頁 Dashboard（Chart.js + WebSocket client）
├── alerts.json        # 持久化警報設定（gitignored）
├── package.json
└── 啟動股票追蹤器.bat  # 雙擊啟動捷徑
```

## 啟動方式
```
雙擊 啟動股票追蹤器.bat
瀏覽器開啟 http://localhost:3000
```

## 資料來源
Yahoo Finance `/v8/finance/chart`（免費、無需 API Key、15 分鐘延遲）

## 未來規劃
- [ ] 自動交易腳本接入（待評估有 API 的券商，如 Interactive Brokers）
- [ ] 多股票自訂追蹤清單
- [ ] 警報歷史紀錄
- [ ] 開機自動啟動
