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

---

## 第 2 輪開發（2026-05-21）｜LINE Bot 串接 & 每日開盤前日報

### 完成功能

**LINE Bot 即時警報推播**
- 建立 LINE Official Account（Stock Alert Bot，`@235jvsce`）
- 透過 LINE Developers Console 啟用 Messaging API
- 警報觸發時同時發送 LINE 推播訊息，格式：
  ```
  📈 VOO 價格警報！
  ────────────────
  突破高點 🟢
  現價：$680.00
  目標：$678.00
  時間：下午 10:30
  ```
- 憑證存於本機 `config.json`（gitignored，不上傳）

**每日開盤前自動日報（node-cron 排程）**
- 週一至週五自動執行，報告包含：
  - 每支股票現價
  - 近 5 日走勢百分比
  - 距高/低點警報的距離（%），並以燈號標示風險：
    - 🔴 ≤ 2%（危險）
    - 🟡 ≤ 5%（注意）
    - 🟢 > 5%（安全）
- 排程時間（台灣時區）：
  - 夏令（3-11月）：每天 **21:00**（美股 9:30PM 開盤前 30 分鐘）
  - 冬令（11-3月）：每天 **22:00**（美股 10:30PM 開盤前 30 分鐘）
- 手動測試端點：`GET /api/report/test`

### 遇到的困難與解決方案

**問題：LINE Official Account 建立流程改版**
- 症狀：LINE Developers Console 已無法直接建立 Messaging API channel，要求先建 LINE Official Account
- 解法：
  1. 至 LINE Official Account Manager 建立帳號
  2. 在「設定 → Messaging API」頁面啟用並連結 Provider
  3. 再回到 LINE Developers Console 取得 Channel Access Token 與 User ID

**問題：LINE User ID 位置不直觀**
- 症狀：使用者誤將 Bot basic ID（`@235jvsce`）當作 User ID
- 說明：
  - **Bot basic ID**（`@235jvsce`）= Bot 的公開搜尋 ID
  - **User ID**（`Ue47e...`）= 你個人帳號的唯一識別碼，在 Basic settings 頁籤最底部

---

## 第 3 輪開發（2026-07-21）｜跌破警戒基準線 & 切換週期崩潰修正

### 完成功能

**主圖表橘色警戒基準線**
- 在主走勢圖上，依每檔在左側設定的「🔻跌破」低點水位（`alerts.json` 的 `low`），畫出一條橘色（`#ff9500`）虛線基準線，並標上「警戒 $xxx」標籤
- y 軸範圍自動延伸涵蓋警戒線（`suggestedMin`），即使現價還在水位上方一段距離，基準線仍看得到，方便目測距離
- 以 Chart.js inline plugin（`afterDatasetsDraw`）實作，直接在 canvas 上畫線，不需額外載入 annotation 套件
- 切換股票 / 週期、或改動低點後自動重繪（`maybeRedrawWarning()` 用 `lastWarnKey` 判斷是否真的變動，避免每 60 秒 tick 都重載）

### 遇到的問題與解決方案

**問題：切換到 6月 / 1年 圖表卡住不更新**
- 症狀：點右上角「6月」「1年」，按鈕變成 active，但圖表完全沒換資料，X 軸還停在今日盤中時間。切「今日 → 5日」等任何一次切換後就壞掉，只有第一次載入的 1d 正常。
- Console 兩個接連的錯誤：
  ```
  [chart] Cannot read properties of undefined (reading 'getPixelForValue')
  [chart] Canvas is already in use. Chart with ID '0' must be destroyed...
  ```
- **根因（連鎖反應）：**
  1. 切換週期時流程為「先 `mainChart.destroy()` 銷毀舊圖 → 再 `new Chart()` 建新圖」
  2. `destroy()` 過程中 Chart.js 會做最後一次繪製，此時 y 軸（`chart.scales.y`）已被拆除變成 `undefined`
  3. 新加的警戒線 plugin 在 `afterDatasetsDraw` 讀 `chart.scales.y.getPixelForValue()` → 丟出例外
  4. 例外中斷了 `destroy()`，舊圖表殘留佔用 canvas；接著 `new Chart()` 報 "Canvas already in use" 建不起來
  5. 畫面就卡在原本的 1d 資料 → 表面上看起來是「切 6月/1年沒反應」
  - 第一次載入 1d 沒有舊圖要銷毀，不會觸發，所以只有**切換**才壞。
- **解法（2 處）：**
  1. **plugin 防呆**：`afterDatasetsDraw` 開頭檢查 `chart.scales.y` 與 `chart.chartArea`，還沒建立或已被拆除就直接 return，杜絕在銷毀過程丟例外
  2. **強化銷毀**：建新圖前用 `Chart.getChart(canvas)` 抓出 canvas 上任何殘留實例一併 `destroy()`，並用 `try/catch` 包住，徹底避免 "Canvas already in use"
  ```javascript
  // plugin 防呆
  afterDatasetsDraw(chart) {
    const yScale = chart.scales && chart.scales.y;
    if (!yScale || !chart.chartArea) return;
    ...
  }

  // 強化銷毀（取代原本只判斷 mainChart 的寫法）
  const stale = mainChart || (window.Chart && Chart.getChart(canvas));
  if (stale) { try { stale.destroy(); } catch (_) {} }
  mainChart = null;
  ```
- **驗證：** 用瀏覽器實測，今日↔5日↔1月↔6月↔1年 來回切換全部正常更新，X 軸正確顯示日期，橘色警戒線持續正確貼在對應水位，console 零錯誤。

**關鍵收穫：** 自訂 Chart.js plugin 在 `afterDatasetsDraw` 等 hook 內存取 `chart.scales` / `chart.chartArea` 時，一定要先判斷是否存在——因為 `destroy()`、resize、重建等生命週期階段都可能觸發繪製，而該階段 scales 可能尚未建立或已被拆除。plugin 只要丟例外，就會連帶讓 `destroy()` 中斷、canvas 被殘留實例佔死。

---

## 技術架構

```
stock-tracker/
├── server.js          # Express + WebSocket + Yahoo Finance v8 + LINE Bot + node-cron
├── public/
│   └── index.html     # 單頁 Dashboard（Chart.js + WebSocket client）
├── alerts.json        # 持久化警報設定（gitignored）
├── config.json        # LINE Bot 憑證（gitignored，不上傳）
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
- [x] LINE Bot 警報推播
- [x] 每日開盤前走勢日報
- [x] 主圖表跌破警戒基準線（橘色）
- [ ] 自動交易腳本接入（待評估有 API 的券商，如 Interactive Brokers）
- [ ] 多股票自訂追蹤清單
- [ ] 警報歷史紀錄
- [ ] 開機自動啟動
