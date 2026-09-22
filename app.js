const DERIV_URL =
  "wss://api.derivws.com/trading/v1/options/ws/public";

const MARKETS = [
  ["Volatility 10", "R_10"],
  ["Volatility 10 (1s)", "1HZ10V"],
  ["Volatility 25", "R_25"],
  ["Volatility 25 (1s)", "1HZ25V"],
  ["Volatility 50", "R_50"],
  ["Volatility 50 (1s)", "1HZ50V"],
  ["Volatility 75", "R_75"],
  ["Volatility 75 (1s)", "1HZ75V"],
  ["Volatility 100", "R_100"],
  ["Volatility 100 (1s)", "1HZ100V"]
];

const CONFIRMATION_WINDOW = 10;
const REQUIRED_CONFIRMATIONS = 8;
const STRONG_CONFIDENCE = 75;
const COOLDOWN_TICKS = 15;
const BACKTEST_COUNT = 500;

let socket = null;
let selectedSymbol = "R_10";
let liveTicks = 0;
let reqId = 5000;

const state = {};

const liveResults = {
  signals: 0,
  wins: 0,
  losses: 0,
  history: [],
  pending: []
};


MARKETS.forEach(([name, symbol]) => {
  state[symbol] = {
    name,
    symbol,
    digits: [],
    quotes: [],
    lastDigit: null,
    available: null,
    error: null,

    over: {
      lastStrong: false,
      cooldown: 0
    },

    under: {
      lastStrong: false,
      cooldown: 0
    },

    backtest: {
      over: null,
      under: null
    }
  };
});

function $(id) {
  return document.getElementById(id);
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function digitFromQuote(quote) {
  const text = String(quote);
  const parts = text.split(".");

  if (parts.length < 2) {
    return Number(text.slice(-1));
  }

  return Number(parts[1].slice(-1));
}

function setupName(setup) {
  return setup === "over" ? "OVER 2" : "UNDER 7";
}

function rates(data) {
  const digits = data.digits;

  if (!digits.length) {
    return {
      over: 0,
      under: 0
    };
  }

  const overHits = digits.filter(d => d > 2).length;
  const underHits = digits.filter(d => d < 7).length;

  return {
    over: (overHits / digits.length) * 100,
    under: (underHits / digits.length) * 100
  };
}

function confirmation(data, setup) {
  const recent =
    data.digits.slice(-CONFIRMATION_WINDOW);

  if (recent.length < CONFIRMATION_WINDOW) {
    return {
      hits: 0,
      total: recent.length,
      rate: 0
    };
  }

  const hits =
    setup === "over"
      ? recent.filter(d => d > 2).length
      : recent.filter(d => d < 7).length;

  return {
    hits,
    total: recent.length,
    rate: (hits / recent.length) * 100
  };
}

function entryDigit(data, setup) {
  const digits = data.digits;

  if (digits.length < 20) {
    return null;
  }

  const eligible =
    setup === "over"
      ? [3, 4, 5, 6, 7, 8, 9]
      : [0, 1, 2, 3, 4, 5, 6];

  const recent50 = digits.slice(-50);
  const recent10 = digits.slice(-10);

  let best = null;

  eligible.forEach(digit => {
    const totalCount =
      digits.filter(d => d === digit).length;

    const recent50Count =
      recent50.filter(d => d === digit).length;

    const recent10Count =
      recent10.filter(d => d === digit).length;

    const lastIndex =
      digits.lastIndexOf(digit);

    const recency =
      lastIndex >= 0
        ? clamp(
            1 -
              (digits.length - 1 - lastIndex) /
                Math.max(1, digits.length),
            0,
            1
          )
        : 0;

    const totalRate =
      (totalCount / digits.length) * 100;

    const recent50Rate =
      (recent50Count / recent50.length) * 100;

    const recent10Rate =
      (recent10Count / recent10.length) * 100;

    const score =
      totalRate * 0.30 +
      recent50Rate * 0.30 +
      recent10Rate * 0.20 +
      recency * 100 * 0.10 +
      (setup === "over" && digit > 2
        ? 10
        : setup === "under" && digit < 7
        ? 10
        : 0);

    if (!best || score > best.score) {
      best = {
        digit,
        score,
        totalRate,
        recent50Rate,
        recent10Rate
      };
    }
  });

  return best;
}

function getSetupSignal(data, setup) {
  const minimum =
    Number($("sampleSize")?.value || 500);

  if (data.digits.length < Math.min(minimum, 100)) {
    return {
      setup,
      status: "WAIT",
      confidence: 0,
      rate: 0,
      confirmation: 0,
      entry: null
    };
  }

  const r = rates(data);
  const setupRate = r[setup];

  const alt =
    setup === "over" ? r.under : r.over;

  const confirm =
    confirmation(data, setup);

  const margin =
    clamp(setupRate - alt, 0, 100);

  const confidence =
    clamp(
      setupRate * 0.40 +
        confirm.rate * 0.45 +
        margin * 0.15,
      0,
      100
    );

  const threshold =
    Number($("threshold")?.value || 75);

  const strong =
    setupRate >= threshold &&
    confirm.hits >= REQUIRED_CONFIRMATIONS &&
    confidence >= STRONG_CONFIDENCE;

  let status = "NO ENTRY";

  if (strong) {
    status = "STRONG ENTRY";
  } else if (
    setupRate >= threshold ||
    confirm.hits >= 5
  ) {
    status = "WAIT";
  }

  return {
    setup,
    status,
    confidence,
    rate: setupRate,
    confirmation: confirm.hits,
    entry: strong
      ? entryDigit(data, setup)
      : null
  };
}

function getBothSignals(data) {
  return {
    over: getSetupSignal(data, "over"),
    under: getSetupSignal(data, "under")
  };
}

function backtestSetup(digits, setup) {
  if (digits.length < 100) {
    return null;
  }

  const start =
    Math.max(
      50,
      digits.length - BACKTEST_COUNT
    );

  let predictions = 0;
  let hits = 0;

  for (let i = start; i < digits.length - 1; i++) {
    const previous = digits.slice(
      0,
      i
    );

    if (previous.length < 50) {
      continue;
    }

    const recent =
      previous.slice(-10);

    const success =
      setup === "over"
        ? recent.filter(d => d > 2).length
        : recent.filter(d => d < 7).length;

    if (success < 8) {
      continue;
    }

    predictions++;

    const next = digits[i];

    const won =
      setup === "over"
        ? next > 2
        : next < 7;

    if (won) {
      hits++;
    }
  }

  if (!predictions) {
    return null;
  }

  return {
    predictions,
    hits,
    accuracy:
      (hits / predictions) * 100
  };
}

function updateBacktest(data) {
  if (data.digits.length < 100) {
    return;
  }

  data.backtest.over =
    backtestSetup(data.digits, "over");

  data.backtest.under =
    backtestSetup(data.digits, "under");
}

function applyCooldown(data, setup, signal) {
  const tracker = data[setup];

  if (tracker.cooldown > 0) {
    tracker.cooldown--;
  }

  if (
    signal.status === "STRONG ENTRY" &&
    tracker.cooldown === 0
  ) {
    tracker.lastStrong = true;
    tracker.cooldown = COOLDOWN_TICKS;
  } else {
    tracker.lastStrong = false;
  }

  return signal;
}

function recordSignal(symbol, setup, signal) {
  if (!signal || signal.status !== "STRONG ENTRY" || !signal.entry) {
    return;
  }

  liveResults.signals++;

  liveResults.pending.push({
    symbol,
    setup,
    entry: signal.entry.digit
  });

  if (liveResults.pending.length > 100) {
    liveResults.pending.shift();
  }
}

function evaluatePendingSignals(symbol, digit) {
  if (!liveResults.pending.length) {
    return;
  }

  const remaining = [];

  liveResults.pending.forEach(signal => {
    if (signal.symbol !== symbol) {
      remaining.push(signal);
      return;
    }

    const won =
      signal.setup === "over"
        ? digit > 2
        : digit < 7;

    if (won) {
      liveResults.wins++;
    } else {
      liveResults.losses++;
    }

    liveResults.history.unshift({
      ...signal,
      result: won ? "WIN" : "LOSS",
      resultDigit: digit
    });
  });

  liveResults.pending = remaining;

  if (liveResults.history.length > 20) {
    liveResults.history.length = 20;
  }

  renderLiveResults();
}

function renderLiveResults() {
  const signals = $("resultSignals");
  const wins = $("resultWins");
  const losses = $("resultLosses");
  const rate = $("resultWinRate");
  const container = $("signalResults");

  if (!signals || !wins || !losses || !rate || !container) {
    return;
  }

  signals.textContent = liveResults.signals;
  wins.textContent = liveResults.wins;
  losses.textContent = liveResults.losses;

  const completed =
    liveResults.wins + liveResults.losses;

  rate.textContent =
    completed > 0
      ? `${((liveResults.wins / completed) * 100).toFixed(1)}%`
      : "—";

  if (!liveResults.history.length) {
    container.innerHTML =
      '<div class="no-entry">🟡 No completed live signals yet.</div>';
    return;
  }

  container.innerHTML =
    liveResults.history
      .map(item => `
        <div class="message">
          <b>${MARKETS.find(m => m[1] === item.symbol)?.[0] || item.symbol}</b>
          —
          ${item.setup === "over" ? "OVER 2" : "UNDER 7"}
          —
          Entry: <b>${item.entry}</b>
          —
          Result digit: <b>${item.resultDigit}</b>
          —
          <b>${item.result}</b>
        </div>
      `)
      .join("");
}

function processTick(symbol, quote) {
  const data = state[symbol];

  if (!data) {
    return;
  }

  const digit = digitFromQuote(quote);

  if (!Number.isFinite(digit)) {
    return;
  }

  data.quotes.push(Number(quote));
  data.digits.push(digit);

  const sample =
    Number($("sampleSize")?.value || 500);

  if (data.digits.length > sample) {
    data.digits.shift();
  }

  if (data.quotes.length > sample) {
    data.quotes.shift();
  }

  data.lastDigit = digit;
  liveTicks++;

  // Resolve signals from the previous tick before creating
  // a new signal from the current tick.
  evaluatePendingSignals(symbol, digit);

  const signals = getBothSignals(data);

  signals.over =
    applyCooldown(
      data,
      "over",
      signals.over
    );

  signals.under =
    applyCooldown(
      data,
      "under",
      signals.under
    );

  // Record only newly released STRONG ENTRY signals.
  if (data.over.lastStrong) {
    recordSignal(symbol, "over", signals.over);
  }

  if (data.under.lastStrong) {
    recordSignal(symbol, "under", signals.under);
  }

  if (
    data.digits.length % 50 === 0
  ) {
    updateBacktest(data);
  }

  renderTable();
  renderActiveEntries();
  renderSelected();
  renderSummary();
  renderLiveResults();
}

function requestHistory(symbol, id) {
  if (!socket ||
      socket.readyState !== WebSocket.OPEN) {
    return;
  }

  socket.send(
    JSON.stringify({
      ticks_history: symbol,
      count: 500,
      end: "latest",
      style: "ticks",
      req_id: id
    })
  );
}

function connect() {
  if (socket) {
    try {
      socket.close();
    } catch (e) {}
  }

  $("connectionBadge").textContent =
    "CONNECTING";

  $("connectionBadge").className =
    "badge waiting";

  socket =
    new WebSocket(DERIV_URL);

  socket.onopen = () => {
    console.log("DERIV WEBSOCKET CONNECTED");

    $("connectionBadge").textContent =
      "CONNECTED";

    $("connectionBadge").className =
      "badge connected";

    socket.send(
      JSON.stringify({
        active_symbols: "brief",
        req_id: ++reqId
      })
    );
  };

  socket.onmessage = event => {
    let msg;

    try {
      msg = JSON.parse(event.data);
    } catch (error) {
      console.log(
        "INVALID DERIV MESSAGE",
        event.data
      );
      return;
    }

    if (msg.error) {
      console.log(
        "DERIV ERROR:",
        msg.error
      );

      const req =
        msg.echo_req || {};

      if (req.ticks) {
        const symbol = req.ticks;

        if (state[symbol]) {
          state[symbol].error =
            msg.error.message ||
            "Subscription error";

          state[symbol].available =
            false;
        }
      }

      renderTable();
      renderActiveEntries();
      renderSelected();
      return;
    }

    if (
      msg.msg_type ===
      "active_symbols"
    ) {
      const available =
        new Set(
          (msg.active_symbols || [])
            .map(
              x =>
                x.underlying_symbol ||
                x.symbol
            )
        );

      MARKETS.forEach(
        ([name, symbol], index) => {
          state[symbol].available =
            available.has(symbol);

          if (
            state[symbol].available
          ) {
            socket.send(
              JSON.stringify({
                ticks: symbol,
                subscribe: 1,
                req_id:
                  1000 + index
              })
            );

            requestHistory(
              symbol,
              2000 + index
            );
          }
        }
      );

      renderTable();
      return;
    }

    if (
      msg.msg_type ===
      "history"
    ) {
      const symbol =
        msg.echo_req?.ticks_history;

      if (!symbol || !state[symbol]) {
        return;
      }

      const prices =
        msg.history?.prices || [];

      state[symbol].quotes =
        prices.map(Number);

      state[symbol].digits =
        state[symbol].quotes
          .map(digitFromQuote)
          .filter(Number.isFinite);

      if (
        state[symbol].digits.length
      ) {
        state[symbol].lastDigit =
          state[symbol].digits[
            state[symbol].digits.length - 1
          ];
      }

      updateBacktest(
        state[symbol]
      );

      renderTable();
      renderActiveEntries();
      renderSelected();
      renderSummary();

      return;
    }

    if (
      msg.msg_type === "tick"
    ) {
      const symbol =
        msg.tick?.symbol;

      const quote =
        msg.tick?.quote;

      if (
        symbol &&
        quote !== undefined
      ) {
        processTick(
          symbol,
          quote
        );
      }

      return;
    }
  };

  alert("DERIV WEBSOCKET ERROR - check internet connection or Deriv endpoint");socket.onerror = error => {
    console.log(
      "DERIV WEBSOCKET ERROR:",
      error
    );

    $("connectionBadge").textContent =
      "CONNECTION ERROR";

    $("connectionBadge").className =
      "badge error";
  };

  socket.onclose = event => {
    console.log(
      "DERIV WEBSOCKET CLOSED:",
      event.code,
      event.reason
    );

    $("connectionBadge").textContent =
      "DISCONNECTED";

    $("connectionBadge").className =
      "badge error";
  };
}

function renderSummary() {
  const marketCount =
    MARKETS.filter(
      ([name, symbol]) =>
        state[symbol].available !== false
    ).length;

  if ($("marketCount")) {
    $("marketCount").textContent =
      marketCount;
  }

  if ($("liveTicks")) {
    $("liveTicks").textContent =
      liveTicks;
  }
}

function signalClass(signal) {
  if (signal.status === "STRONG ENTRY") {
    return "setup-strong";
  }

  if (signal.status === "WAIT") {
    return "setup-wait";
  }

  return "setup-no";
}

function renderTable() {
  const body =
    $("marketTableBody");

  if (!body) {
    return;
  }

  body.innerHTML = "";

  MARKETS.forEach(
    ([name, symbol]) => {
      const data = state[symbol];

      const signals =
        getBothSignals(data);

      const tr =
        document.createElement("tr");

      tr.onclick = () => {
        selectedSymbol = symbol;

        if ($("marketSelect")) {
          $("marketSelect").value =
            symbol;
        }

        renderSelected();
      };

      const status =
        data.error
          ? "ERROR"
          : data.available === false
            ? "UNAVAILABLE"
            : "LIVE";

      const td = content => {
        const cell =
          document.createElement("td");

        cell.innerHTML = content;

        return cell;
      };

      tr.appendChild(
        td(`<strong>${name}</strong>`)
      );

      tr.appendChild(
        td(`<span class="live-status">${status}</span>`)
      );

      tr.appendChild(
        td(data.digits.length)
      );

      tr.appendChild(
        td(`${rates(data).over.toFixed(1)}%`)
      );

      tr.appendChild(
        td(`${rates(data).under.toFixed(1)}%`)
      );

      tr.appendChild(
        td(
          `<span class="${signalClass(
            signals.over
          )}">${signals.over.status}</span>`
        )
      );

      tr.appendChild(
        td(
          signals.over.entry
            ? signals.over.entry.digit
            : "—"
        )
      );

      tr.appendChild(
        td(
          `${signals.over.confidence.toFixed(0)}%`
        )
      );

      tr.appendChild(
        td(
          `<span class="${signalClass(
            signals.under
          )}">${signals.under.status}</span>`
        )
      );

      tr.appendChild(
        td(
          signals.under.entry
            ? signals.under.entry.digit
            : "—"
        )
      );

      tr.appendChild(
        td(
          `${signals.under.confidence.toFixed(0)}%`
        )
      );

      body.appendChild(tr);
    }
  );
}

function renderActiveEntries() {
  const box =
    $("activeEntries");

  if (!box) {
    return;
  }

  box.innerHTML = "";

  let count = 0;

  MARKETS.forEach(
    ([name, symbol]) => {
      const data = state[symbol];

      const signals =
        getBothSignals(data);

      ["over", "under"].forEach(
        setup => {
          const signal =
            signals[setup];

          if (
            signal.status !==
            "STRONG ENTRY"
          ) {
            return;
          }

          count++;

          const entry =
            signal.entry;

          const card =
            document.createElement("div");

          card.className =
            "entry-card";

          const backtest =
            data.backtest[setup];

          const accuracy =
            backtest
              ? `${backtest.accuracy.toFixed(1)}%`
              : "—";

          card.innerHTML = `
            <div class="entry-main">
              <strong>${name}</strong>
              <span>${setupName(setup)}</span>
            </div>

            <div class="entry-stats">
              <span>
                Entry Digit:
                <b>${entry ? entry.digit : "—"}</b>
              </span>

              <span>
                Confidence:
                <b>${signal.confidence.toFixed(0)}%</b>
              </span>

              <span>
                Setup Rate:
                <b>${signal.rate.toFixed(1)}%</b>
              </span>

              <span>
                Confirmation:
                <b>${signal.confirmation}/10</b>
              </span>

              <span>
                Backtest:
                <b>${accuracy}</b>
              </span>
            </div>
          `;

          box.appendChild(card);
        }
      );
    }
  );

  if ($("activeSetups")) {
    $("activeSetups").textContent =
      count;
  }

  if (!count) {
    box.innerHTML = `
      <div class="no-entry">
        🟡 No strong entries at the moment.
        Waiting for independent OVER 2 or UNDER 7 confirmation.
      </div>
    `;
  }
}

function renderSelected() {
  const data =
    state[selectedSymbol];

  if (!data) {
    return;
  }

  const signals =
    getBothSignals(data);

  if ($("selectedTitle")) {
    $("selectedTitle").textContent =
      data.name;
  }

  if ($("selectedSetup")) {
    $("selectedSetup").textContent =
      `OVER 2: ${signals.over.status} | UNDER 7: ${signals.under.status}`;
  }

  if ($("selectedEntryDigit")) {
    const overEntry =
      signals.over.entry?.digit ?? "—";

    const underEntry =
      signals.under.entry?.digit ?? "—";

    $("selectedEntryDigit").textContent =
      `OVER: ${overEntry} | UNDER: ${underEntry}`;
  }

  if ($("selectedEntryRate")) {
    $("selectedEntryRate").textContent =
      `OVER: ${signals.over.confidence.toFixed(0)}% | UNDER: ${signals.under.confidence.toFixed(0)}%`;
  }

  if ($("selectedLastDigit")) {
    $("selectedLastDigit").textContent =
      data.lastDigit ?? "—";
  }

  renderDistribution(data);
  renderRecent(data);
}

function renderDistribution(data) {
  const box =
    $("digitDistribution");

  if (!box) {
    return;
  }

  const counts =
    Array(10).fill(0);

  data.digits.forEach(d => {
    if (d >= 0 && d <= 9) {
      counts[d]++;
    }
  });

  const total =
    data.digits.length || 1;

  box.innerHTML =
    counts
      .map(
        (count, digit) => `
          <div class="digit-item">
            <span>${digit}</span>
            <b>${count}</b>
            <small>${(
              (count / total) *
              100
            ).toFixed(1)}%</small>
          </div>
        `
      )
      .join("");
}

function renderRecent(data) {
  const box =
    $("recentSequence");

  if (!box) {
    return;
  }

  box.textContent =
    data.digits
      .slice(-30)
      .join(" ");
}

function bindControls() {
  if ($("marketSelect")) {
    $("marketSelect").addEventListener(
      "change",
      e => {
        selectedSymbol =
          e.target.value;

        renderSelected();
      }
    );
  }

  [
    "sampleSize",
    "threshold"
  ].forEach(id => {
    if ($(id)) {
      $(id).addEventListener(
        "change",
        () => {
          MARKETS.forEach(
            ([name, symbol]) => {
              state[symbol].backtest.over =
                null;

              state[symbol].backtest.under =
                null;
            }
          );

          renderTable();
          renderActiveEntries();
          renderSelected();
        }
      );
    }
  });
}

function initialise() {
  bindControls();

  renderTable();
  renderActiveEntries();
  renderSelected();
  renderSummary();

  connect();
}

window.addEventListener(
  "load",
  initialise
);
