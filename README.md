# Observer Trade Board

Interaktive Trading-Seite fuer den Observer-Feed unter `http://100.93.6.111:8080`.

## Start

```bash
npm install
npm run dev
```

Danach im Browser oeffnen:

```text
http://localhost:5173
```

## Was die Seite macht

- Holt automatisch Daten von `/status`, `/trades` und `/sessions`
- Zeigt Session-KPIs wie PnL, Win Rate, Buys, Sells und offene Positionen
- Baut pro Token einen TradingView-Style-Chart mit Buy-/Sell-Markern
- Berechnet `Average Buy`, `Average Sell`, realized PnL und Open Amount
- Bietet Token- und Wallet-Filter

## API-URL aendern

Oben im UI kannst du die API-Base-URL aendern. Du kannst entweder die Base-URL wie
`http://100.93.6.111:8080` oder direkt einen Endpoint wie
`http://100.93.6.111:8080/status` eintragen. Die App normalisiert das automatisch.

## Build

```bash
npm run build
```
