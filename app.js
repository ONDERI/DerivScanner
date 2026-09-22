const DERIV_URL = "wss://api.derivws.com/trading/v1/options/ws/public";

const MARKETS = [
  ["Volatility 10","R_10"],["Volatility 10 (1s)","1HZ10V"],
  ["Volatility 25","R_25"],["Volatility 25 (1s)","1HZ25V"],
  ["Volatility 50","R_50"],["Volatility 50 (1s)","1HZ50V"],
  ["Volatility 75","R_75"],["Volatility 75 (1s)","1HZ75V"],
  ["Volatility 100","R_100"],["Volatility 100 (1s)","1HZ100V"]
];

const state = {};

MARKETS.forEach(([name,symbol]) => state[symbol] = {
  name,
  symbol,
  digits: [],
  quotes: [],
  lastDigit: null,
  available: null,
  error: null,

  lastStrongSetup: null,
  cooldown: 0,
  backtest: null
});

let socket = null;
let selectedSymbol = MARKETS[0][1];
let totalTicks = 0;

const $ = id => document.getElementById(id);
const sampleSize = () => Number($("sampleSize").value);
const threshold = () => Number($("signalThreshold").value);

/* Confirmation settings */
const CONFIRMATION_WINDOW = 10;
const REQUIRED_CONFIRMATIONS = 8;
const STRONG_CONFIDENCE = 75;
const COOLDOWN_TICKS = 15;
const BACKTEST_COUNT = 500;

function escapeHtml(v){
  return String(v).replace(/[&<>"']/g,m=>({
    "&":"&amp;",
    "<":"&lt;",
    ">":"&gt;",
    '"':"&quot;",
    "'":"&#039;"
  }[m]));
}

function digitFromQuote(q){
  const s = String(q);
  const m = s.match(/(\d)$/);
  return m ? Number(m[1]) : null;
}

/* Basic setup rates */
function rates(data){
  const arr = data.digits;
  const n = arr.length;

  if(!n) return {over:0,under:0};

  return {
    over: arr.filter(d=>d>2).length/n*100,
    under: arr.filter(d=>d<7).length/n*100
  };
}

/* Count recent confirmations */
function confirmation(data, setup){
  const recent = data.digits.slice(-CONFIRMATION_WINDOW);

  if(recent.length < CONFIRMATION_WINDOW){
    return {
      supported: 0,
      total: recent.length,
      rate: 0,
      confirmed: false
    };
  }

  let supported = 0;

  if(setup === "OVER 2"){
    supported = recent.filter(d => d > 2).length;
  }

  if(setup === "UNDER 7"){
    supported = recent.filter(d => d < 7).length;
  }

  return {
    supported,
    total: recent.length,
    rate: supported / recent.length * 100,
    confirmed: supported >= REQUIRED_CONFIRMATIONS
  };
}

/* Entry digit selector */
function entryDigit(data, setup){
  if(!setup || !data.digits.length){
    return {digit:null,score:0};
  }

  const eligible =
    setup === "OVER 2"
      ? [3,4,5,6,7,8,9]
      : [0,1,2,3,4,5,6];

  const all = data.digits;
  const recent = all.slice(-100);

  let best = {
    digit:null,
    score:-1
  };

  eligible.forEach(d=>{
    const allFreq =
      all.filter(x=>x===d).length / all.length;

    const recentFreq =
      recent.length
        ? recent.filter(x=>x===d).length / recent.length
        : 0;

    let recency = 0;

    for(let i=0;i<recent.length;i++){
      if(recent[i]===d){
        recency += i+1;
      }
    }

    const maxRecency =
      recent.length * (recent.length+1) / 2 || 1;

    const recencyScore =
      recency / maxRecency;

    const score =
      (allFreq * 0.50) +
      (recentFreq * 0.30) +
      (recencyScore * 0.20);

    if(score > best.score){
      best = {
        digit:d,
        score
      };
    }
  });

  return {
    digit:best.digit,
    score:best.score * 100
  };
}

/*
  Main confirmation engine.

  It does NOT issue a strong entry merely because the
  full sample percentage is high.
*/
function getSignal(data){

  if(data.digits.length < sampleSize()){
    return {
      state:"WAIT",
      setup:null,
      rate:0,
      confidence:0,
      entry:null,
      confirmation:null,
      reason:"Not enough ticks"
    };
  }

  const r = rates(data);

  /*
    Candidate setup from the full sample.
    We still require the selected setup to be stronger
    than the alternative.
  */
  let setup = null;
  let rate = 0;

  if(
    r.over >= threshold() &&
    r.over > r.under
  ){
    setup = "OVER 2";
    rate = r.over;
  }
  else if(
    r.under >= threshold() &&
    r.under > r.over
  ){
    setup = "UNDER 7";
    rate = r.under;
  }

  if(!setup){
    return {
      state:"NO ENTRY",
      setup:null,
      rate:Math.max(r.over,r.under),
      confidence:0,
      entry:null,
      confirmation:null,
      reason:"No dominant setup"
    };
  }

  const conf = confirmation(data,setup);

  /*
    Confidence combines:
      50% full sample rate
      30% recent confirmation
      20% margin over alternative setup
  */
  const alternative =
    setup === "OVER 2" ? r.under : r.over;

  const margin =
    Math.max(0, Math.min(100, rate - alternative));

  const confidence =
    (rate * 0.50) +
    (conf.rate * 0.30) +
    (margin * 0.20);

  const entry = entryDigit(data,setup);

  /*
    Strong signal requires BOTH:
      1. high confidence
      2. 8/10 recent confirmation
  */
  if(
    confidence >= STRONG_CONFIDENCE &&
    conf.confirmed
  ){

    return {
      state:"STRONG ENTRY",
      setup,
      rate,
      confidence,
      entry,
      confirmation:conf,
      reason:"Strong multi-tick confirmation"
    };
  }

  /*
    There is evidence, but it is not strong enough.
  */
  if(
    rate >= threshold() ||
    conf.supported >= 5
  ){

    return {
      state:"WAIT / UNCLEAR",
      setup,
      rate,
      confidence,
      entry:null,
      confirmation:conf,
      reason:"Setup exists but confirmation is insufficient"
    };
  }

  return {
    state:"NO ENTRY",
    setup:null,
    rate,
    confidence,
    entry:null,
    confirmation:conf,
    reason:"Weak evidence"
  };
}

/*
  Walk-forward back-test.

  Each historical point is tested using only the ticks
  that existed BEFORE the next tick. This avoids using
  future ticks to decide the past signal.
*/
function backtestDigits(digits){

  if(!digits || digits.length < sampleSize()+1){
    return {
      tested:0,
      signals:0,
      correct:0,
      accuracy:0
    };
  }

  let signals = 0;
  let correct = 0;

  for(
    let i=sampleSize();
    i<digits.length-1;
    i++
  ){

    const history = digits.slice(0,i);

    const fakeData = {
      digits:history
    };

    const sig = getSignal(fakeData);

    if(sig.state !== "STRONG ENTRY"){
      continue;
    }

    signals++;

    const nextDigit = digits[i];

    let success = false;

    if(sig.setup === "OVER 2"){
      success = nextDigit > 2;
    }

    if(sig.setup === "UNDER 7"){
      success = nextDigit < 7;
    }

    if(success){
      correct++;
    }
  }

  return {
    tested:digits.length - sampleSize(),
    signals,
    correct,
    accuracy:
      signals
        ? correct/signals*100
        : 0
  };
}

/* Process live tick */
function processTick(symbol, quote){

  const d = state[symbol];

  const digit = digitFromQuote(quote);

  if(digit === null) return;

  d.lastDigit = digit;

  d.quotes.push(quote);
  d.digits.push(digit);

  if(d.digits.length > 2000){
    d.digits.shift();
    d.quotes.shift();
  }

  totalTicks++;

  $("liveTicks").textContent = totalTicks;

  /*
    Reduce cooldown by one tick.
  */
  if(d.cooldown > 0){
    d.cooldown--;
  }

  /*
    Evaluate the signal.
  */
  const sig = getSignal(d);

  /*
    Cooldown prevents repeated identical signals.
  */
  if(
    sig.state === "STRONG ENTRY" &&
    d.cooldown > 0 &&
    d.lastStrongSetup === sig.setup
  ){
    sig.state = "WAIT / UNCLEAR";
    sig.entry = null;
    sig.reason = "Cooldown active";
  }

  /*
    Start cooldown when a genuine new strong signal appears.
  */
  if(
    sig.state === "STRONG ENTRY" &&
    sig.setup !== d.lastStrongSetup
  ){
    d.lastStrongSetup = sig.setup;
    d.cooldown = COOLDOWN_TICKS;
  }

  renderTable();

  if(symbol === selectedSymbol){
    renderSelected();
  }
}

/* Render market table */
function renderTable(){

  const tbody = $("marketTable");

  let active = 0;

  tbody.innerHTML = MARKETS.map(([name,symbol])=>{

    const d = state[symbol];
    const r = rates(d);
    const sig = getSignal(d);

    if(sig.state === "STRONG ENTRY"){
      active++;
    }

    let status =
      d.error
        ? "ERROR"
        : d.available === false
          ? "UNAVAILABLE"
          : d.digits.length
            ? "LIVE"
            : "WAITING";

    let stateClass = "waiting";

    if(sig.state === "STRONG ENTRY"){
      stateClass = "setup-over";
    }
    else if(sig.state === "NO ENTRY"){
      stateClass = "setup-under";
    }

    return `<tr>
      <td>${escapeHtml(name)}</td>

      <td class="${
        status==="LIVE"
          ? "setup-over"
          : "waiting"
      }">${status}</td>

      <td>${d.digits.length}</td>

      <td>${r.over.toFixed(1)}%</td>

      <td>${r.under.toFixed(1)}%</td>

      <td class="${stateClass}">
        ${sig.state}
      </td>

      <td>
        ${sig.state==="STRONG ENTRY" && sig.setup
          ? sig.setup
          : "—"}
      </td>

      <td class="entry-digit">
        ${
          sig.state==="STRONG ENTRY"
            ? sig.entry?.digit ?? "—"
            : "—"
        }
      </td>

      <td>
        ${
          sig.state==="STRONG ENTRY"
            ? sig.confidence.toFixed(1)+"%"
            : "—"
        }
      </td>

    </tr>`;

  }).join("");

  $("activeSetups").textContent = active;
}

/* Render selected market */
function renderSelected(){

  const d = state[selectedSymbol];

  const sig = getSignal(d);

  const r = rates(d);

  $("selectedTitle").textContent =
    (d.name || selectedSymbol) + " Analysis";

  $("selectedSetup").textContent =
    sig.state;

  $("selectedEntryDigit").textContent =
    sig.state==="STRONG ENTRY"
      ? sig.entry?.digit ?? "—"
      : "—";

  $("selectedEntryRate").textContent =
    sig.state==="STRONG ENTRY"
      ? sig.confidence.toFixed(1)+"%"
      : "—";

  $("selectedLastDigit").textContent =
    d.lastDigit ?? "—";

  $("digitDistribution").innerHTML =
    Array.from({length:10},(_,i)=>{

      const count =
        d.digits.filter(x=>x===i).length;

      const pct =
        d.digits.length
          ? count/d.digits.length*100
          : 0;

      return `
        <div class="digit-box">
          <b>${i}</b>
          <small>
            ${count} (${pct.toFixed(1)}%)
          </small>
        </div>
      `;

    }).join("");

  $("recentSequence").textContent =
    d.digits.slice(-40).join("  ") || "—";

  if(d.error){

    $("analysisMessage").textContent =
      d.error;

  }
  else if(d.available === false){

    $("analysisMessage").textContent =
      "Deriv did not advertise this symbol as available.";

  }
  else if(sig.state === "STRONG ENTRY"){

    $("analysisMessage").textContent =
      `🟢 STRONG ENTRY — ${sig.setup}. ` +
      `Confidence ${sig.confidence.toFixed(1)}%. ` +
      `${sig.confirmation.supported}/${sig.confirmation.total} ` +
      `recent ticks confirm the setup. ` +
      `Candidate digit: ${sig.entry.digit}.`;

  }
  else if(sig.state === "WAIT / UNCLEAR"){

    $("analysisMessage").textContent =
      `🟡 WAIT / UNCLEAR — ${sig.setup || "No confirmed setup"}. ` +
      `Confidence ${sig.confidence.toFixed(1)}%. ` +
      `Recent confirmation: ` +
      `${sig.confirmation?.supported || 0}/` +
      `${sig.confirmation?.total || 0}.`;

  }
  else{

    $("analysisMessage").textContent =
      `🔴 NO ENTRY — ` +
      `Over 2: ${r.over.toFixed(1)}%, ` +
      `Under 7: ${r.under.toFixed(1)}%. ` +
      `${sig.reason}.`;

  }

  $("recentTicks").textContent =
    d.quotes.slice(-20)
      .map(q=>String(q))
      .join("  |  ") || "—";
}

/*
  Request historical ticks for back-testing.
*/
function requestHistory(symbol, reqId){

  if(!socket || socket.readyState !== WebSocket.OPEN){
    return;
  }

  socket.send(JSON.stringify({
    ticks_history:symbol,
    end:"latest",
    count:BACKTEST_COUNT,
    style:"ticks",
    subscribe:0,
    req_id:reqId
  }));
}

/* Connect to Deriv */
function connect(){

  if(socket){
    socket.close();
  }

  socket = new WebSocket(DERIV_URL);

  $("connectionBadge").textContent =
    "CONNECTING";

  $("connectionBadge").className =
    "badge waiting";

  socket.onopen = ()=>{

    $("connectionBadge").textContent =
      "CONNECTED";

    $("connectionBadge").className =
      "badge connected";

    socket.send(JSON.stringify({
      active_symbols:"brief",
      req_id:100
    }));

  };

  socket.onmessage = e=>{

    let msg;

    try{
      msg = JSON.parse(e.data);
    }
    catch{
      return;
    }

    /* Handle API errors */
    if(msg.error){

      console.log(
        "DERIV ERROR:",
        msg.error
      );

      const req = msg.echo_req || {};

      if(req.ticks){

        const s = req.ticks;

        if(state[s]){

          state[s].error =
            msg.error.message ||
            "Subscription error";

          state[s].available = false;
        }
      }

      renderTable();
      renderSelected();

      return;
    }

    /* Active symbols */
    if(msg.msg_type === "active_symbols"){

      const available =
        new Set(
          (msg.active_symbols || [])
            .map(x=>x.underlying_symbol || x.symbol)
        );

      MARKETS.forEach(([name,symbol],i)=>{

        state[symbol].available =
          available.has(symbol);

        if(state[symbol].available){

          /* Live stream */
          socket.send(JSON.stringify({
            ticks:symbol,
            subscribe:1,
            req_id:1000+i
          }));

          /* Historical data for back-test */
          requestHistory(
            symbol,
            2000+i
          );

        }
        else{

          state[symbol].error =
            "Symbol not returned by active_symbols.";
        }

      });

      renderTable();
      renderSelected();

      return;
    }

    /* Historical ticks */
    if(msg.msg_type === "history" && msg.history){

      const prices =
        msg.history.prices || [];

      const digits =
        prices
          .map(digitFromQuote)
          .filter(d=>d !== null);

      const symbol =
        msg.echo_req?.ticks_history ||
        null;

      if(
        symbol &&
        state[symbol] &&
        digits.length
      ){

        state[symbol].backtest =
          backtestDigits(digits);

        console.log(
          "BACKTEST",
          symbol,
          state[symbol].backtest
        );

      }

      return;
    }

    /* Live tick */
    if(msg.msg_type === "tick" && msg.tick){

      processTick(
        msg.tick.symbol,
        msg.tick.quote
      );

    }

  };

  socket.onclose = ()=>{

    $("connectionBadge").textContent =
      "DISCONNECTED";

    $("connectionBadge").className =
      "badge disconnected";

  };

  socket.onerror = ()=>{

    $("connectionBadge").textContent =
      "ERROR";

    $("connectionBadge").className =
      "badge disconnected";

  };
}

/* Clear live data */
function clearData(){

  totalTicks = 0;

  MARKETS.forEach(([name,symbol])=>{

    state[symbol].digits = [];
    state[symbol].quotes = [];
    state[symbol].lastDigit = null;
    state[symbol].error = null;

    state[symbol].lastStrongSetup = null;
    state[symbol].cooldown = 0;
    state[symbol].backtest = null;

  });

  $("liveTicks").textContent = "0";

  renderTable();
  renderSelected();
}

$("connectBtn").addEventListener(
  "click",
  connect
);

$("clearBtn").addEventListener(
  "click",
  clearData
);

$("sampleSize").addEventListener(
  "change",
  ()=>{
    renderTable();
    renderSelected();
  }
);

$("signalThreshold").addEventListener(
  "change",
  ()=>{
    renderTable();
    renderSelected();
  }
);

$("marketSelect").addEventListener(
  "change",
  e=>{
    selectedSymbol = e.target.value;
    renderSelected();
  }
);

$("marketTable").addEventListener(
  "click",
  e=>{

    const row =
      e.target.closest("tr");

    if(!row) return;

    const name =
      row.cells[0]?.textContent;

    const found =
      MARKETS.find(
        x=>x[0]===name
      );

    if(found){

      selectedSymbol = found[1];

      renderSelected();

    }

  }
);

renderTable();
renderSelected();