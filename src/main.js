import "./style.css";
import {
  CandlestickSeries,
  ColorType,
  CrosshairMode,
  HistogramSeries,
  createChart,
  createSeriesMarkers,
} from "lightweight-charts";

const DEFAULT_BASE_URL = "http://100.93.6.111:8080";
const GECKO_TERMINAL_BASE_URL = "https://api.geckoterminal.com/api/v2";
const STORAGE_KEY = "observer-trade-board:settings";
const ALL_WALLETS = "__ALL_WALLETS__";
const MARKET_CHART_CACHE_MS = 60_000;
const MARKET_CHART_PAGE_LIMIT = 1000;
const MARKET_CHART_MAX_REQUESTS = 180;
const MINUTE_BUCKET_SECONDS = 60;

const state = {
  baseUrl: DEFAULT_BASE_URL,
  refreshMs: 10_000,
  autoRefresh: true,
  isLoading: false,
  error: "",
  lastSync: null,
  data: {
    status: null,
    trades: [],
    sessions: [],
  },
  selectedToken: null,
  selectedWallet: ALL_WALLETS,
  chart: null,
  candleSeries: null,
  volumeSeries: null,
  seriesMarkers: null,
  marketCharts: new Map(),
  marketChartRequestId: 0,
  priceLines: [],
  refreshTimer: null,
};

const app = document.querySelector("#app");

app.innerHTML = `
  <div class="shell">
    <header class="hero panel">
      <div>
        <p class="eyebrow">Live Observer Dashboard</p>
        <h1>Buy / Sell Flow im Axiom-Stil</h1>
        <p class="hero-copy">
          Die Seite zieht automatisch Trades, berechnet Average Buy / Sell, realized PnL,
          offene Positionen und legt deine Trades auf den kompletten Marktchart des jeweiligen Tokens.
        </p>
      </div>
      <div class="status-cluster">
        <div class="live-pill" id="live-pill">Warte auf Daten</div>
        <div class="sync-text" id="sync-text">Noch kein Sync</div>
      </div>
    </header>

    <section class="panel controls">
      <form id="config-form" class="config-grid">
        <label class="field">
          <span>API Base URL</span>
          <input id="base-url" name="baseUrl" type="text" placeholder="http://100.93.6.111:8080" />
        </label>
        <label class="field">
          <span>Refresh</span>
          <select id="refresh-ms" name="refreshMs">
            <option value="5000">5 Sekunden</option>
            <option value="10000">10 Sekunden</option>
            <option value="30000">30 Sekunden</option>
            <option value="60000">60 Sekunden</option>
          </select>
        </label>
        <label class="field checkbox-field">
          <span>Auto-Refresh</span>
          <input id="auto-refresh" name="autoRefresh" type="checkbox" />
        </label>
        <div class="actions">
          <button class="button primary" type="submit">Verbinden</button>
          <button class="button" type="button" id="refresh-now">Jetzt aktualisieren</button>
        </div>
      </form>
      <div class="meta-row" id="meta-row"></div>
    </section>

    <section class="summary-grid" id="summary-grid"></section>

    <div class="dashboard-grid">
      <section class="panel token-panel">
        <div class="panel-head">
          <div>
            <p class="eyebrow">Token Explorer</p>
            <h2>Aktive Tokens</h2>
          </div>
          <div class="small-note">Klick auf einen Token fuer den kompletten Chart</div>
        </div>
        <div id="token-list" class="token-list"></div>
      </section>

      <section class="panel chart-panel">
        <div class="panel-head">
          <div>
            <p class="eyebrow">Trade Detail</p>
            <h2 id="chart-title">Kein Token gewaehlt</h2>
          </div>
          <div class="filter-row">
            <label class="field compact">
              <span>Wallet</span>
              <select id="wallet-filter"></select>
            </label>
          </div>
        </div>
        <div class="detail-grid" id="detail-grid"></div>
        <div id="chart-note" class="chart-note"></div>
        <div id="chart-container" class="chart-container"></div>
      </section>
    </div>

    <div class="bottom-grid">
      <section class="panel">
        <div class="panel-head">
          <div>
            <p class="eyebrow">Trades</p>
            <h2>Gefilterte Ausfuehrungen</h2>
          </div>
          <div class="small-note" id="trade-count-label"></div>
        </div>
        <div class="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Zeit</th>
                <th>Wallet</th>
                <th>Side</th>
                <th>Preis</th>
                <th>Amount</th>
                <th>Value</th>
                <th>PnL</th>
                <th>Grund</th>
              </tr>
            </thead>
            <tbody id="trade-rows"></tbody>
          </table>
        </div>
      </section>

      <section class="panel">
        <div class="panel-head">
          <div>
            <p class="eyebrow">Session Feed</p>
            <h2>Letzte Sessions</h2>
          </div>
          <div class="small-note">Historie vom Endpoint /sessions</div>
        </div>
        <div id="session-list" class="session-list"></div>
      </section>
    </div>
  </div>
`;

loadSettings();
syncControls();
setupChart();
bindEvents();
refreshData({ preserveSelection: true });

function bindEvents() {
  document.querySelector("#config-form").addEventListener("submit", async (event) => {
    event.preventDefault();
    state.baseUrl = normalizeBaseUrl(document.querySelector("#base-url").value || DEFAULT_BASE_URL);
    state.refreshMs = Number(document.querySelector("#refresh-ms").value);
    state.autoRefresh = document.querySelector("#auto-refresh").checked;
    saveSettings();
    scheduleRefresh();
    await refreshData({ preserveSelection: false });
  });

  document.querySelector("#refresh-now").addEventListener("click", async () => {
    await refreshData({ preserveSelection: true });
  });

  document.querySelector("#wallet-filter").addEventListener("change", (event) => {
    state.selectedWallet = event.target.value;
    render();
  });

  window.addEventListener("resize", resizeChart);
}

function loadSettings() {
  const raw = localStorage.getItem(STORAGE_KEY);
  if (!raw) {
    scheduleRefresh();
    return;
  }

  try {
    const parsed = JSON.parse(raw);
    state.baseUrl = normalizeBaseUrl(parsed.baseUrl || DEFAULT_BASE_URL);
    state.refreshMs = Number(parsed.refreshMs) || 10_000;
    state.autoRefresh = parsed.autoRefresh !== false;
  } catch {
    state.baseUrl = DEFAULT_BASE_URL;
    state.refreshMs = 10_000;
    state.autoRefresh = true;
  }

  scheduleRefresh();
}

function saveSettings() {
  localStorage.setItem(
    STORAGE_KEY,
    JSON.stringify({
      baseUrl: state.baseUrl,
      refreshMs: state.refreshMs,
      autoRefresh: state.autoRefresh,
    }),
  );
}

function syncControls() {
  document.querySelector("#base-url").value = state.baseUrl;
  document.querySelector("#refresh-ms").value = String(state.refreshMs);
  document.querySelector("#auto-refresh").checked = state.autoRefresh;
}

function scheduleRefresh() {
  if (state.refreshTimer) {
    window.clearInterval(state.refreshTimer);
    state.refreshTimer = null;
  }

  if (!state.autoRefresh) {
    return;
  }

  state.refreshTimer = window.setInterval(() => {
    refreshData({ preserveSelection: true });
  }, state.refreshMs);
}

async function refreshData({ preserveSelection }) {
  state.isLoading = true;
  state.error = "";
  updateStatus();

  try {
    const [status, tradesPayload, sessionsPayload] = await Promise.all([
      fetchJson(`${state.baseUrl}/status`),
      fetchJson(`${state.baseUrl}/trades`),
      fetchJson(`${state.baseUrl}/sessions`),
    ]);

    const trades = Array.isArray(tradesPayload.trades) ? tradesPayload.trades : [];
    trades.sort((left, right) => new Date(left.timestamp) - new Date(right.timestamp));

    state.data = {
      status,
      trades,
      sessions: Array.isArray(sessionsPayload.sessions) ? sessionsPayload.sessions : [],
    };

    const tokenStats = buildTokenStats(trades);
    const tokenIds = new Set(tokenStats.map((entry) => entry.token));

    if (!preserveSelection || !state.selectedToken || !tokenIds.has(state.selectedToken)) {
      state.selectedToken = tokenStats[0]?.token ?? null;
      state.selectedWallet = ALL_WALLETS;
    }

    const wallets = getWalletOptionsForToken(state.selectedToken);
    if (!wallets.includes(state.selectedWallet)) {
      state.selectedWallet = ALL_WALLETS;
    }

    state.lastSync = new Date();
  } catch (error) {
    state.error = error instanceof Error ? error.message : "Unbekannter Fehler";
  } finally {
    state.isLoading = false;
    render();
    updateStatus();
    void ensureSelectedTokenMarketChart();
  }
}

async function fetchJson(url) {
  const response = await fetch(url, {
    headers: {
      Accept: "application/json",
    },
  });

  if (!response.ok) {
    throw new Error(`Fetch fehlgeschlagen: ${response.status} ${response.statusText}`);
  }

  return response.json();
}

function setupChart() {
  state.chart = createChart(document.querySelector("#chart-container"), {
    autoSize: true,
    height: 430,
    layout: {
      background: {
        type: ColorType.Solid,
        color: "#07111f",
      },
      attributionLogo: true,
      textColor: "#d9ecff",
      fontFamily: "Space Grotesk, sans-serif",
    },
    grid: {
      vertLines: { color: "rgba(147, 197, 253, 0.08)" },
      horzLines: { color: "rgba(147, 197, 253, 0.08)" },
    },
    crosshair: {
      mode: CrosshairMode.Normal,
    },
    rightPriceScale: {
      borderColor: "rgba(147, 197, 253, 0.18)",
    },
    timeScale: {
      borderColor: "rgba(147, 197, 253, 0.18)",
      timeVisible: true,
      secondsVisible: true,
    },
  });

  state.candleSeries = state.chart.addSeries(CandlestickSeries, {
    upColor: "#28d391",
    downColor: "#ff647d",
    wickUpColor: "#28d391",
    wickDownColor: "#ff647d",
    borderVisible: false,
    priceLineVisible: true,
    lastValueVisible: true,
  });

  state.seriesMarkers = createSeriesMarkers(state.candleSeries, []);

  state.volumeSeries = state.chart.addSeries(HistogramSeries, {
    priceFormat: {
      type: "volume",
    },
    priceScaleId: "",
    color: "rgba(64, 169, 255, 0.45)",
  });

  state.volumeSeries.priceScale().applyOptions({
    scaleMargins: {
      top: 0.82,
      bottom: 0,
    },
  });
}

function resizeChart() {
  if (state.chart) {
    state.chart.timeScale().fitContent();
  }
}

function render() {
  const { status, trades, sessions } = state.data;
  const tokenStats = buildTokenStats(trades);
  const selectedTrades = getSelectedTrades();
  const selectedStats = buildSingleTokenStats(selectedTrades);
  const summaryStats = buildSessionSummary(trades, status);

  renderMeta(status, trades);
  renderSummary(summaryStats);
  renderTokenList(tokenStats);
  renderWalletFilter();
  renderDetailCards(selectedStats);
  renderChartNote();
  renderTradeTable(selectedTrades);
  renderSessions(sessions, status?.session_id);
  renderChart(selectedTrades, selectedStats);
}

function updateStatus() {
  const livePill = document.querySelector("#live-pill");
  const syncText = document.querySelector("#sync-text");

  if (state.isLoading) {
    livePill.textContent = "Lade Daten...";
    livePill.className = "live-pill is-loading";
  } else if (state.error) {
    livePill.textContent = "API Fehler";
    livePill.className = "live-pill is-error";
  } else {
    livePill.textContent = state.autoRefresh ? "Live verbunden" : "Manueller Modus";
    livePill.className = "live-pill is-live";
  }

  if (state.error) {
    syncText.textContent = state.error;
    return;
  }

  if (!state.lastSync) {
    syncText.textContent = "Noch kein Sync";
    return;
  }

  syncText.textContent = `Letzter Sync ${formatDateTime(state.lastSync.toISOString())}`;
}

function renderMeta(status, trades) {
  const row = document.querySelector("#meta-row");
  if (!status) {
    row.innerHTML = `<span class="error-chip">Keine Daten geladen</span>`;
    return;
  }

  const tokens = new Set(trades.map((trade) => trade.token));
  row.innerHTML = `
    <span class="meta-chip">Session ${status.session_id}</span>
    <span class="meta-chip">${tokens.size} Tokens</span>
    <span class="meta-chip">${status.wallets ?? 0} Wallets</span>
    <span class="meta-chip">${trades.length} Trades</span>
    <span class="meta-chip">Runtime ${status.runtime ?? "--"}</span>
  `;
}

function renderSummary(summary) {
  const cards = [
    {
      label: "Total PnL",
      value: formatCurrency(summary.totalPnl),
      tone: summary.totalPnl >= 0 ? "profit" : "loss",
      note: `${summary.wins} Wins / ${summary.losses} Losses`,
    },
    {
      label: "Win Rate",
      value: formatPercent(summary.winRate),
      note: `${summary.sellCount} abgeschlossene Sells`,
    },
    {
      label: "Buys vs Sells",
      value: `${summary.buyCount} / ${summary.sellCount}`,
      note: `${summary.uniqueWallets} Wallets aktiv`,
    },
    {
      label: "Open Positions",
      value: String(summary.openPositions),
      note: `${summary.uniqueTokens} Tokens im Feed`,
    },
    {
      label: "Invested",
      value: formatCurrency(summary.buyValue),
      note: "Summe aller Buys",
    },
    {
      label: "Returned",
      value: formatCurrency(summary.sellValue),
      note: "Summe aller Sells",
    },
  ];

  document.querySelector("#summary-grid").innerHTML = cards
    .map(
      (card) => `
        <article class="stat-card ${card.tone ? `is-${card.tone}` : ""}">
          <span>${card.label}</span>
          <strong>${card.value}</strong>
          <small>${card.note}</small>
        </article>
      `,
    )
    .join("");
}

function renderTokenList(tokenStats) {
  const list = document.querySelector("#token-list");

  if (!tokenStats.length) {
    list.innerHTML = `<div class="empty-state">Noch keine Trades fuer die aktuelle Session gefunden.</div>`;
    return;
  }

  list.innerHTML = tokenStats
    .map(
      (token) => `
        <button class="token-row ${token.token === state.selectedToken ? "is-selected" : ""}" data-token="${token.token}">
          <div class="token-row-top">
            <strong>${shortToken(token.token)}</strong>
            <span class="${token.realizedPnl >= 0 ? "text-profit" : "text-loss"}">${formatCurrency(token.realizedPnl)}</span>
          </div>
          <div class="token-row-bottom">
            <span>${token.tradeCount} Trades</span>
            <span>${token.walletCount} Wallets</span>
            <span>Avg Buy ${formatPrice(token.avgBuy)}</span>
          </div>
        </button>
      `,
    )
    .join("");

  list.querySelectorAll("[data-token]").forEach((button) => {
    button.addEventListener("click", () => {
      state.selectedToken = button.dataset.token;
      state.selectedWallet = ALL_WALLETS;
      render();
      void ensureSelectedTokenMarketChart({ force: false });
    });
  });
}

function renderWalletFilter() {
  const select = document.querySelector("#wallet-filter");
  const wallets = getWalletOptionsForToken(state.selectedToken);

  select.innerHTML = wallets
    .map((wallet) => {
      const label = wallet === ALL_WALLETS ? "Alle Wallets" : shortAddress(wallet);
      return `<option value="${wallet}">${label}</option>`;
    })
    .join("");

  select.value = wallets.includes(state.selectedWallet) ? state.selectedWallet : ALL_WALLETS;
}

function renderDetailCards(stats) {
  const grid = document.querySelector("#detail-grid");
  const title = document.querySelector("#chart-title");

  if (!state.selectedToken || !stats) {
    title.textContent = "Kein Token gewaehlt";
    grid.innerHTML = `<div class="empty-state">Waehle links einen Token aus, um den Detailchart zu sehen.</div>`;
    return;
  }

  title.textContent = `${shortToken(state.selectedToken)} ${state.selectedWallet === ALL_WALLETS ? "" : `| ${shortAddress(state.selectedWallet)}`}`;

  const cards = [
    {
      label: "Average Buy",
      value: formatPrice(stats.avgBuy),
      note: `${stats.buyCount} Buys`,
    },
    {
      label: "Average Sell",
      value: formatPrice(stats.avgSell),
      note: `${stats.sellCount} Sells`,
    },
    {
      label: "Realized PnL",
      value: formatCurrency(stats.realizedPnl),
      note: `Avg Exit ${formatPercent(stats.avgPnlPercent)}`,
      tone: stats.realizedPnl >= 0 ? "profit" : "loss",
    },
    {
      label: "Open Amount",
      value: formatAmount(stats.openAmount),
      note: `Position Value ${formatCurrency(stats.openValueEstimate)}`,
    },
    {
      label: "Invested / Returned",
      value: `${formatCurrency(stats.buyValue)} / ${formatCurrency(stats.sellValue)}`,
      note: `${stats.walletCount} Wallets`,
    },
    {
      label: "Preisrange",
      value: `${formatPrice(stats.minPrice)} to ${formatPrice(stats.maxPrice)}`,
      note: `Last ${formatPrice(stats.lastPrice)}`,
    },
  ];

  grid.innerHTML = cards
    .map(
      (card) => `
        <article class="detail-card ${card.tone ? `is-${card.tone}` : ""}">
          <span>${card.label}</span>
          <strong>${card.value}</strong>
          <small>${card.note}</small>
        </article>
      `,
    )
    .join("");
}

function renderChartNote() {
  const marketChart = getCurrentMarketChartEntry();
  const note = document.querySelector("#chart-note");

  if (!state.selectedToken) {
    note.innerHTML = "";
    return;
  }

  if (!marketChart || marketChart.status === "loading") {
    note.innerHTML = `
      <span class="chart-chip is-loading">Lade kompletten Marktchart fuer dieses Token...</span>
    `;
    return;
  }

  if (marketChart.status === "ready") {
    note.innerHTML = `
      <span class="chart-chip">Full 1m chart via GeckoTerminal</span>
      <span class="chart-chip">${marketChart.timeframeLabel}</span>
      <span class="chart-chip">${marketChart.poolName}</span>
      <span class="chart-chip">Marktpreis in USD</span>
      <span class="chart-chip">${marketChart.isComplete ? "Pool-Start bis jetzt" : "Nahezu kompletter Verlauf"}</span>
    `;
    return;
  }

  note.innerHTML = `
    <span class="chart-chip is-warning">Kein externer Full-Chart gefunden, Fallback auf Observer-Trades.</span>
  `;
}

function renderTradeTable(trades) {
  const rows = document.querySelector("#trade-rows");
  document.querySelector("#trade-count-label").textContent = `${trades.length} Eintraege`;

  if (!trades.length) {
    rows.innerHTML = `
      <tr>
        <td colspan="8" class="empty-cell">Keine Trades fuer den aktuellen Filter.</td>
      </tr>
    `;
    return;
  }

  const sorted = [...trades].sort((left, right) => new Date(right.timestamp) - new Date(left.timestamp));

  rows.innerHTML = sorted
    .map(
      (trade) => `
        <tr>
          <td>${formatDateTime(trade.timestamp)}</td>
          <td>${shortAddress(trade.wallet)}</td>
          <td><span class="side-pill ${trade.side === "BUY" ? "is-buy" : "is-sell"}">${trade.side}</span></td>
          <td>${formatPrice(trade.price_eur)}</td>
          <td>${formatAmount(trade.amount)}</td>
          <td>${formatCurrency(trade.value_eur)}</td>
          <td class="${Number(trade.pnl_eur || 0) >= 0 ? "text-profit" : "text-loss"}">${formatNullableCurrency(trade.pnl_eur)}</td>
          <td>${trade.reason ?? "--"}</td>
        </tr>
      `,
    )
    .join("");
}

function renderSessions(sessions, currentSessionId) {
  const list = document.querySelector("#session-list");

  if (!sessions.length) {
    list.innerHTML = `<div class="empty-state">Keine Sessions gefunden.</div>`;
    return;
  }

  list.innerHTML = sessions
    .slice(0, 12)
    .map(
      (session) => `
        <article class="session-row ${session.session_id === currentSessionId ? "is-current" : ""}">
          <div class="session-top">
            <strong>${session.session_id}</strong>
            <span>${session.trades} Trades</span>
          </div>
          <div class="session-bottom">
            <span>${formatDateTime(session.started)}</span>
            <span>${formatDateTime(session.ended)}</span>
          </div>
        </article>
      `,
    )
    .join("");
}

function renderChart(trades, stats) {
  if (!state.candleSeries || !state.volumeSeries) {
    return;
  }

  const marketChart = getCurrentMarketChartEntry();
  const hasMarketChart = marketChart?.status === "ready" && marketChart.candles.length > 0;
  const candles = hasMarketChart ? marketChart.candles : buildCandles(trades);
  const volume = hasMarketChart ? marketChart.volume : buildVolumeSeries(trades);

  state.priceLines.forEach((line) => state.candleSeries.removePriceLine(line));
  state.priceLines = [];

  if (!candles.length) {
    state.candleSeries.setData([]);
    state.seriesMarkers?.setMarkers([]);
    state.volumeSeries.setData([]);
    return;
  }

  const candleTimes = candles.map((candle) => candle.time);
  const bucketSeconds = hasMarketChart ? marketChart.bucketSeconds : 60;
  const markers = trades.map((trade) => ({
    time: findNearestCandleTime(
      floorToBucket(toUnixSeconds(trade.timestamp), bucketSeconds),
      candleTimes,
    ),
    position: trade.side === "BUY" ? "belowBar" : "aboveBar",
    color: trade.side === "BUY" ? "#28d391" : "#ff647d",
    shape: trade.side === "BUY" ? "arrowUp" : "arrowDown",
    text: `${trade.side} ${formatPrice(trade.price_eur)}`,
  }));

  state.candleSeries.setData(candles);
  state.seriesMarkers?.setMarkers(markers);
  state.volumeSeries.setData(volume);

  if (!hasMarketChart && stats?.avgBuy) {
    state.priceLines.push(
      state.candleSeries.createPriceLine({
        price: stats.avgBuy,
        color: "#28d391",
        lineWidth: 1,
        lineStyle: 2,
        axisLabelVisible: true,
        title: "Avg Buy",
      }),
    );
  }

  if (!hasMarketChart && stats?.avgSell) {
    state.priceLines.push(
      state.candleSeries.createPriceLine({
        price: stats.avgSell,
        color: "#ff647d",
        lineWidth: 1,
        lineStyle: 2,
        axisLabelVisible: true,
        title: "Avg Sell",
      }),
    );
  }

  state.chart.timeScale().fitContent();
}

async function ensureSelectedTokenMarketChart({ force = false } = {}) {
  const token = state.selectedToken;
  if (!token) {
    return;
  }

  const cached = state.marketCharts.get(token);
  const cacheAge = cached?.fetchedAt ? Date.now() - cached.fetchedAt : Number.POSITIVE_INFINITY;

  if (
    !force &&
    cached &&
    cacheAge < MARKET_CHART_CACHE_MS &&
    (cached.status === "ready" || cached.status === "error" || cached.status === "loading")
  ) {
    return;
  }

  state.marketChartRequestId += 1;
  const requestId = state.marketChartRequestId;

  state.marketCharts.set(token, {
    ...(cached ?? {}),
    status: "loading",
    fetchedAt: Date.now(),
  });

  renderChartNote();

  try {
    const marketChart = await fetchTokenMarketChart(token);
    state.marketCharts.set(token, {
      ...marketChart,
      status: "ready",
      fetchedAt: Date.now(),
    });
  } catch (error) {
    state.marketCharts.set(token, {
      status: "error",
      error: error instanceof Error ? error.message : "Kein Marktchart verfuegbar",
      fetchedAt: Date.now(),
    });
  }

  if (requestId === state.marketChartRequestId && token === state.selectedToken) {
    render();
  }
}

async function fetchTokenMarketChart(token) {
  const poolsPayload = await fetchJson(
    `${GECKO_TERMINAL_BASE_URL}/networks/solana/tokens/${encodeURIComponent(token)}/pools?page=1`,
  );

  const pools = Array.isArray(poolsPayload.data) ? poolsPayload.data : [];
  if (!pools.length) {
    throw new Error("Kein GeckoTerminal-Pool gefunden");
  }

  const pool = [...pools].sort(
    (left, right) =>
      Number(right.attributes?.reserve_in_usd || 0) - Number(left.attributes?.reserve_in_usd || 0),
  )[0];

  const poolAddress = pool.attributes?.address || pool.id?.split("_").at(-1);
  if (!poolAddress) {
    throw new Error("Pool-Adresse fehlt");
  }

  const minuteHistory = await fetchFullMinuteHistory(
    poolAddress,
    pool.attributes?.pool_created_at,
  );
  if (!minuteHistory.candles.length) {
    throw new Error("Keine OHLCV-Daten verfuegbar");
  }
  return {
    source: "geckoterminal",
    timeframeLabel: "1m full history",
    bucketSeconds: MINUTE_BUCKET_SECONDS,
    poolName: pool.attributes?.name || `Pool ${shortAddress(poolAddress)}`,
    isComplete: minuteHistory.isComplete,
    candles: minuteHistory.candles.map((entry) => ({
      time: entry.time,
      open: entry.open,
      high: entry.high,
      low: entry.low,
      close: entry.close,
    })),
    volume: minuteHistory.candles.map((entry) => ({
      time: entry.time,
      value: entry.volume,
      color:
        entry.close >= entry.open
          ? "rgba(40, 211, 145, 0.55)"
          : "rgba(255, 100, 125, 0.55)",
    })),
  };
}

function getCurrentMarketChartEntry() {
  if (!state.selectedToken) {
    return null;
  }

  return state.marketCharts.get(state.selectedToken) ?? null;
}

async function fetchFullMinuteHistory(poolAddress, poolCreatedAt) {
  const allRows = [];
  const poolStartTime = poolCreatedAt ? toUnixSeconds(poolCreatedAt) : null;
  let beforeTimestamp = null;
  let requestCount = 0;
  let isComplete = false;

  while (requestCount < MARKET_CHART_MAX_REQUESTS) {
    const url = new URL(
      `${GECKO_TERMINAL_BASE_URL}/networks/solana/pools/${poolAddress}/ohlcv/minute`,
    );
    url.searchParams.set("aggregate", "1");
    url.searchParams.set("limit", String(MARKET_CHART_PAGE_LIMIT));

    if (beforeTimestamp != null) {
      url.searchParams.set("before_timestamp", String(beforeTimestamp));
    }

    const payload = await fetchJson(url.toString());
    const rows = payload?.data?.attributes?.ohlcv_list;

    if (!Array.isArray(rows) || rows.length === 0) {
      isComplete = true;
      break;
    }

    allRows.push(...rows);
    requestCount += 1;

    const normalizedPage = normalizeOhlcvList(rows);
    const oldestTime = normalizedPage[0]?.time ?? null;

    if (oldestTime == null) {
      isComplete = true;
      break;
    }

    if (rows.length < MARKET_CHART_PAGE_LIMIT) {
      isComplete = true;
      break;
    }

    if (poolStartTime != null && oldestTime <= poolStartTime + MINUTE_BUCKET_SECONDS) {
      isComplete = true;
      break;
    }

    if (beforeTimestamp != null && oldestTime >= beforeTimestamp) {
      break;
    }

    beforeTimestamp = oldestTime;
  }

  return {
    candles: normalizeOhlcvList(allRows),
    isComplete,
  };
}

function normalizeOhlcvList(ohlcvList) {
  const ordered = [...ohlcvList].reverse();
  const merged = new Map();

  for (const row of ordered) {
    const [time, open, high, low, close, volume] = row.map(Number);
    if (!merged.has(time)) {
      merged.set(time, { time, open, high, low, close, volume });
      continue;
    }

    const current = merged.get(time);
    current.high = Math.max(current.high, high);
    current.low = Math.min(current.low, low);
    current.close = close;
    current.volume += volume;
  }

  return Array.from(merged.values()).sort((left, right) => left.time - right.time);
}

function getSelectedTrades() {
  if (!state.selectedToken) {
    return [];
  }

  return state.data.trades.filter((trade) => {
    if (trade.token !== state.selectedToken) {
      return false;
    }

    if (state.selectedWallet !== ALL_WALLETS && trade.wallet !== state.selectedWallet) {
      return false;
    }

    return true;
  });
}

function getWalletOptionsForToken(token) {
  if (!token) {
    return [ALL_WALLETS];
  }

  const wallets = new Set(
    state.data.trades
      .filter((trade) => trade.token === token)
      .map((trade) => trade.wallet),
  );

  return [ALL_WALLETS, ...Array.from(wallets)];
}

function buildSessionSummary(trades, status) {
  const buyTrades = trades.filter((trade) => trade.side === "BUY");
  const sellTrades = trades.filter((trade) => trade.side === "SELL");
  const wins = sellTrades.filter((trade) => Number(trade.pnl_eur) > 0).length;
  const losses = sellTrades.filter((trade) => Number(trade.pnl_eur) <= 0).length;
  const openPositions = buildTokenStats(trades).filter((token) => token.openAmount > 0).length;

  return {
    totalPnl: sum(sellTrades, "pnl_eur") || Number(status?.total_pnl || 0),
    winRate: sellTrades.length ? (wins / sellTrades.length) * 100 : Number(status?.win_rate || 0),
    buyCount: buyTrades.length || Number(status?.buys || 0),
    sellCount: sellTrades.length || Number(status?.sells || 0),
    wins,
    losses,
    buyValue: sum(buyTrades, "value_eur"),
    sellValue: sum(sellTrades, "value_eur"),
    uniqueWallets: new Set(trades.map((trade) => trade.wallet)).size,
    uniqueTokens: new Set(trades.map((trade) => trade.token)).size,
    openPositions,
  };
}

function buildTokenStats(trades) {
  const groups = new Map();

  for (const trade of trades) {
    const entry = groups.get(trade.token) ?? createEmptyStats();
    accumulateTrade(entry, trade);
    groups.set(trade.token, entry);
  }

  return Array.from(groups.entries())
    .map(([token, entry]) => finalizeStats(token, entry))
    .sort((left, right) => right.lastTimestamp - left.lastTimestamp);
}

function buildSingleTokenStats(trades) {
  if (!trades.length) {
    return null;
  }

  const entry = createEmptyStats();
  for (const trade of trades) {
    accumulateTrade(entry, trade);
  }

  return finalizeStats(trades[0].token, entry);
}

function createEmptyStats() {
  return {
    tradeCount: 0,
    buyCount: 0,
    sellCount: 0,
    buyValue: 0,
    sellValue: 0,
    buyAmount: 0,
    sellAmount: 0,
    realizedPnl: 0,
    pnlPercentWeighted: 0,
    pnlPercentWeight: 0,
    openAmount: 0,
    minPrice: Number.POSITIVE_INFINITY,
    maxPrice: 0,
    lastPrice: 0,
    lastTimestamp: 0,
    wallets: new Set(),
  };
}

function accumulateTrade(entry, trade) {
  const price = Number(trade.price_eur || 0);
  const value = Number(trade.value_eur || 0);
  const amount = Number(trade.amount || 0);
  const timestamp = new Date(trade.timestamp).getTime();

  entry.tradeCount += 1;
  entry.wallets.add(trade.wallet);
  entry.minPrice = Math.min(entry.minPrice, price);
  entry.maxPrice = Math.max(entry.maxPrice, price);

  if (timestamp >= entry.lastTimestamp) {
    entry.lastTimestamp = timestamp;
    entry.lastPrice = price;
  }

  if (trade.side === "BUY") {
    entry.buyCount += 1;
    entry.buyValue += value;
    entry.buyAmount += amount;
    entry.openAmount += amount;
    return;
  }

  entry.sellCount += 1;
  entry.sellValue += value;
  entry.sellAmount += amount;
  entry.realizedPnl += Number(trade.pnl_eur || 0);
  entry.openAmount -= amount;

  if (trade.pnl_percent != null) {
    entry.pnlPercentWeighted += Number(trade.pnl_percent) * Math.max(value, 1);
    entry.pnlPercentWeight += Math.max(value, 1);
  }
}

function finalizeStats(token, entry) {
  const avgBuy = entry.buyAmount > 0 ? entry.buyValue / entry.buyAmount : null;
  const avgSell = entry.sellAmount > 0 ? entry.sellValue / entry.sellAmount : null;

  return {
    token,
    tradeCount: entry.tradeCount,
    buyCount: entry.buyCount,
    sellCount: entry.sellCount,
    buyValue: entry.buyValue,
    sellValue: entry.sellValue,
    avgBuy,
    avgSell,
    realizedPnl: entry.realizedPnl,
    avgPnlPercent: entry.pnlPercentWeight > 0 ? entry.pnlPercentWeighted / entry.pnlPercentWeight : 0,
    openAmount: entry.openAmount,
    openValueEstimate: entry.openAmount * entry.lastPrice,
    minPrice: Number.isFinite(entry.minPrice) ? entry.minPrice : null,
    maxPrice: entry.maxPrice || null,
    lastPrice: entry.lastPrice || null,
    lastTimestamp: entry.lastTimestamp,
    walletCount: entry.wallets.size,
  };
}

function buildCandles(trades) {
  const buckets = new Map();

  for (const trade of trades) {
    const time = floorToBucket(toUnixSeconds(trade.timestamp), 60);
    const price = Number(trade.price_eur || 0);

    if (!buckets.has(time)) {
      buckets.set(time, {
        time,
        open: price,
        high: price,
        low: price,
        close: price,
      });
      continue;
    }

    const bucket = buckets.get(time);
    bucket.high = Math.max(bucket.high, price);
    bucket.low = Math.min(bucket.low, price);
    bucket.close = price;
  }

  return Array.from(buckets.values()).sort((left, right) => left.time - right.time);
}

function buildVolumeSeries(trades) {
  const buckets = new Map();

  for (const trade of trades) {
    const time = floorToBucket(toUnixSeconds(trade.timestamp), 60);
    const value = Number(trade.value_eur || 0);
    const color = trade.side === "BUY" ? "rgba(40, 211, 145, 0.55)" : "rgba(255, 100, 125, 0.55)";
    const current = buckets.get(time) ?? { time, value: 0, color };
    current.value += value;
    current.color = color;
    buckets.set(time, current);
  }

  return Array.from(buckets.values()).sort((left, right) => left.time - right.time);
}

function normalizeBaseUrl(value) {
  let normalized = String(value || "").trim();
  if (!normalized) {
    return DEFAULT_BASE_URL;
  }

  normalized = normalized.replace(/\/+$/, "");
  normalized = normalized.replace(/\/(status|trades|sessions|hourly)$/i, "");
  return normalized;
}

function floorToBucket(timestamp, bucketSeconds) {
  return Math.floor(timestamp / bucketSeconds) * bucketSeconds;
}

function findNearestCandleTime(targetTime, candleTimes) {
  if (!candleTimes.length) {
    return targetTime;
  }

  if (targetTime <= candleTimes[0]) {
    return candleTimes[0];
  }

  if (targetTime >= candleTimes[candleTimes.length - 1]) {
    return candleTimes[candleTimes.length - 1];
  }

  let left = 0;
  let right = candleTimes.length - 1;

  while (left <= right) {
    const mid = Math.floor((left + right) / 2);
    const value = candleTimes[mid];

    if (value === targetTime) {
      return value;
    }

    if (value < targetTime) {
      left = mid + 1;
    } else {
      right = mid - 1;
    }
  }

  const lower = candleTimes[Math.max(0, right)];
  const upper = candleTimes[Math.min(candleTimes.length - 1, left)];
  return Math.abs(targetTime - lower) <= Math.abs(upper - targetTime) ? lower : upper;
}

function shortToken(token) {
  if (!token) {
    return "--";
  }

  return `${token.slice(0, 6)}...${token.slice(-6)}`;
}

function shortAddress(address) {
  if (!address) {
    return "--";
  }

  return `${address.slice(0, 4)}...${address.slice(-4)}`;
}

function formatCurrency(value) {
  return new Intl.NumberFormat("de-DE", {
    style: "currency",
    currency: "EUR",
    maximumFractionDigits: 2,
  }).format(Number(value || 0));
}

function formatNullableCurrency(value) {
  if (value == null) {
    return "--";
  }

  return formatCurrency(value);
}

function formatPercent(value) {
  return `${Number(value || 0).toFixed(1)}%`;
}

function formatAmount(value) {
  const amount = Number(value || 0);

  if (Math.abs(amount) >= 1_000_000) {
    return amount.toLocaleString("de-DE", { maximumFractionDigits: 0 });
  }

  return amount.toLocaleString("de-DE", { maximumFractionDigits: 4 });
}

function formatPrice(value) {
  if (value == null || Number.isNaN(Number(value))) {
    return "--";
  }

  const price = Number(value);
  if (price === 0) {
    return "0.00 EUR";
  }

  const absPrice = Math.abs(price);

  if (absPrice >= 1) {
    return `${trimTrailingZeros(price.toFixed(4))} EUR`;
  }

  if (absPrice >= 0.01) {
    return `${trimTrailingZeros(price.toFixed(6))} EUR`;
  }

  if (absPrice >= 0.0001) {
    return `${trimTrailingZeros(price.toFixed(8))} EUR`;
  }

  if (absPrice >= 0.000001) {
    return `${trimTrailingZeros(price.toFixed(10))} EUR`;
  }

  return `${trimTrailingZeros(price.toFixed(14))} EUR`;
}

function trimTrailingZeros(value) {
  return value.replace(/(\.\d*?[1-9])0+$/u, "$1").replace(/\.0+$/u, "");
}

function formatDateTime(value) {
  if (!value) {
    return "--";
  }

  const date = new Date(value);
  return date.toLocaleString("de-DE", {
    day: "2-digit",
    month: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
}

function sum(entries, field) {
  return entries.reduce((total, entry) => total + Number(entry[field] || 0), 0);
}

function toUnixSeconds(value) {
  return Math.floor(new Date(value).getTime() / 1000);
}
