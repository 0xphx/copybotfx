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
const STORAGE_KEY = "observer-trade-board:settings";
const ALL_WALLETS = "__ALL_WALLETS__";

const state = {
  baseUrl: DEFAULT_BASE_URL,
  refreshMs: 10000,
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
          offene Positionen und rendert das Ganze als TradingView-Style-Chart.
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
          <div class="small-note">Klick auf einen Token fuer den Detailchart</div>
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
    const nextBaseUrl = normalizeBaseUrl(
      document.querySelector("#base-url").value || DEFAULT_BASE_URL,
    );
    state.baseUrl = nextBaseUrl;
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
    state.refreshMs = Number(parsed.refreshMs) || 10000;
    state.autoRefresh = parsed.autoRefresh !== false;
  } catch {
    state.baseUrl = DEFAULT_BASE_URL;
    state.refreshMs = 10000;
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
    const availableTokenIds = new Set(tokenStats.map((entry) => entry.token));

    if (!preserveSelection || !state.selectedToken || !availableTokenIds.has(state.selectedToken)) {
      state.selectedToken = tokenStats[0]?.token ?? null;
      state.selectedWallet = ALL_WALLETS;
    }

    const walletsForToken = getWalletOptionsForToken(state.selectedToken);
    if (!walletsForToken.includes(state.selectedWallet)) {
      state.selectedWallet = ALL_WALLETS;
    }

    state.lastSync = new Date();
  } catch (error) {
    state.error = error instanceof Error ? error.message : "Unbekannter Fehler";
  } finally {
    state.isLoading = false;
    render();
    updateStatus();
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
  const container = document.querySelector("#chart-container");
  state.chart = createChart(container, {
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
  if (!state.chart) {
    return;
  }

  state.chart.timeScale().fitContent();
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
  const grid = document.querySelector("#summary-grid");
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
      value: `${summary.openPositions}`,
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

  grid.innerHTML = cards
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
    .map((token) => {
      const isSelected = token.token === state.selectedToken;
      return `
        <button class="token-row ${isSelected ? "is-selected" : ""}" data-token="${token.token}">
          <div class="token-row-top">
            <strong>${shortToken(token.token)}</strong>
            <span class="${token.realizedPnl >= 0 ? "text-profit" : "text-loss"}">${formatCurrency(
              token.realizedPnl,
            )}</span>
          </div>
          <div class="token-row-bottom">
            <span>${token.tradeCount} Trades</span>
            <span>${token.walletCount} Wallets</span>
            <span>Avg Buy ${formatPrice(token.avgBuy)}</span>
          </div>
        </button>
      `;
    })
    .join("");

  list.querySelectorAll("[data-token]").forEach((button) => {
    button.addEventListener("click", () => {
      state.selectedToken = button.dataset.token;
      state.selectedWallet = ALL_WALLETS;
      render();
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

function renderTradeTable(trades) {
  const rows = document.querySelector("#trade-rows");
  const label = document.querySelector("#trade-count-label");

  label.textContent = `${trades.length} Eintraege`;

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
          <td class="${Number(trade.pnl_eur || 0) >= 0 ? "text-profit" : "text-loss"}">${formatNullableCurrency(
            trade.pnl_eur,
          )}</td>
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

  state.priceLines.forEach((line) => state.candleSeries.removePriceLine(line));
  state.priceLines = [];

  if (!trades.length) {
    state.candleSeries.setData([]);
    state.seriesMarkers?.setMarkers([]);
    state.volumeSeries.setData([]);
    return;
  }

  const candles = buildCandles(trades);
  const volume = buildVolumeSeries(trades);
  const markers = trades.map((trade) => ({
    time: toUnixSeconds(trade.timestamp),
    position: trade.side === "BUY" ? "belowBar" : "aboveBar",
    color: trade.side === "BUY" ? "#28d391" : "#ff647d",
    shape: trade.side === "BUY" ? "arrowUp" : "arrowDown",
    text: `${trade.side} ${formatPrice(trade.price_eur)}`,
  }));

  state.candleSeries.setData(candles);
  state.seriesMarkers?.setMarkers(markers);
  state.volumeSeries.setData(volume);

  if (stats.avgBuy) {
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

  if (stats.avgSell) {
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
    const time = Math.floor(toUnixSeconds(trade.timestamp) / 60) * 60;
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

  return Array.from(buckets.values());
}

function buildVolumeSeries(trades) {
  const buckets = new Map();

  for (const trade of trades) {
    const time = Math.floor(toUnixSeconds(trade.timestamp) / 60) * 60;
    const value = Number(trade.value_eur || 0);
    const color = trade.side === "BUY" ? "rgba(40, 211, 145, 0.55)" : "rgba(255, 100, 125, 0.55)";
    const current = buckets.get(time) ?? { time, value: 0, color };
    current.value += value;
    current.color = color;
    buckets.set(time, current);
  }

  return Array.from(buckets.values());
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

  if (Math.abs(price) >= 1) {
    return `${price.toFixed(4)} EUR`;
  }

  if (Math.abs(price) >= 0.01) {
    return `${price.toFixed(6)} EUR`;
  }

  if (Math.abs(price) >= 0.0001) {
    return `${price.toFixed(8)} EUR`;
  }

  return `${price.toExponential(3)} EUR`;
}

function formatDateTime(value) {
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
