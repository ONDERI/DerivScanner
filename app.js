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
  name, symbol, digits: [], quotes: [], lastDigit: null, available: null, error: null
});

let socket = null;
let selectedSymbol = MARKETS[0][1];
let totalTicks = 0;

const $ = id => document.getElementById(id);
const sampleSize = () => Number($("sampleSize").value);
const threshold = () => Number($("signalThreshold").value);

function escapeHtml(v){return String(v).replace(/[&<>"']/g,m=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#039;"}[m]));}

function digitFromQuote(q){
  const s = String(q);
  const m = s.match(/(\d)$/);
  return m ? Number(m[1]) : null;
}

function rates(data){
  const arr=data.digits, n=arr.length;
  if(!n) return {over:0,under:0};
  return {
    over: arr.filter(d=>d>2).length/n*100,
    under: arr.filter(d=>d<7).length/n*100
  };
}

/* Entry digit selector:
   - only digits valid for the selected setup are considered
   - combines full-sample frequency, recent-100 frequency and
     recency weighting
   - this is a statistical candidate, not a prediction guarantee */
function entryDigit(data, setup){
  if(!setup || !data.digits.length) return {digit:null,score:0};
  const eligible = setup==="OVER 2" ? [3,4,5,6,7,8,9] : [0,1,2,3,4,5,6];
  const all=data.digits;
  const recent=all.slice(-Math.min(100,all.length));
  let best={digit:null,score:-1};

  eligible.forEach(d=>{
    const allFreq=all.filter(x=>x===d).length/all.length;
    const recentFreq=recent.filter(x=>x===d).length/recent.length;
    let recency=0;
    for(let i=0;i<recent.length;i++){
      if(recent[i]===d) recency += (i+1);
    }
    const maxRecency = recent.length*(recent.length+1)/2 || 1;
    const recencyScore=recency/maxRecency;
    const score=(allFreq*0.50)+(recentFreq*0.30)+(recencyScore*0.20);
    if(score>best.score) best={digit:d,score};
  });
  return {digit:best.digit,score:best.score*100};
}

function getSignal(data){
  if(data.digits.length < sampleSize()) return {setup:null,rate:0,entry:null};
  const r=rates(data);
  let setup=null, rate=0;
  if(r.over>=threshold() && r.over>r.under){setup="OVER 2";rate=r.over;}
  else if(r.under>=threshold() && r.under>r.over){setup="UNDER 7";rate=r.under;}
  const entry=entryDigit(data,setup);
  return {setup,rate,entry};
}

function processTick(symbol, quote){
  const d=state[symbol];
  const digit=digitFromQuote(quote);
  if(digit===null) return;
  d.lastDigit=digit;
  d.quotes.push(quote);
  d.digits.push(digit);
  if(d.digits.length>2000){d.digits.shift();d.quotes.shift();}
  totalTicks++;
  $("liveTicks").textContent=totalTicks;
  renderTable();
  if(symbol===selectedSymbol) renderSelected();
}

function renderTable(){
  const tbody=$("marketTable");
  let active=0;
  tbody.innerHTML=MARKETS.map(([name,symbol])=>{
    const d=state[symbol];
    const r=rates(d);
    const sig=getSignal(d);
    if(sig.setup) active++;
    let status=d.error ? "ERROR" : d.available===false ? "UNAVAILABLE" : d.digits.length ? "LIVE" : "WAITING";
    return `<tr>
      <td>${escapeHtml(name)}</td>
      <td class="${status==="LIVE"?"setup-over":"waiting"}">${status}</td>
      <td>${d.digits.length}</td>
      <td>${r.over.toFixed(1)}%</td>
      <td>${r.under.toFixed(1)}%</td>
      <td class="${sig.setup==="OVER 2"?"setup-over":sig.setup==="UNDER 7"?"setup-under":"waiting"}">${sig.setup||"WAIT"}</td>
      <td class="entry-digit">${sig.entry?.digit ?? "—"}</td>
      <td>${sig.entry?.digit!=null ? sig.entry.score.toFixed(1)+"%" : "—"}</td>
    </tr>`;
  }).join("");
  $("activeSetups").textContent=active;
}

function renderSelected(){
  const d=state[selectedSymbol], sig=getSignal(d), r=rates(d);
  $("selectedTitle").textContent=(d.name||selectedSymbol)+" Analysis";
  $("selectedSetup").textContent=sig.setup||"WAIT";
  $("selectedEntryDigit").textContent=sig.entry?.digit ?? "—";
  $("selectedEntryRate").textContent=sig.entry?.digit!=null ? sig.entry.score.toFixed(1)+"%" : "—";
  $("selectedLastDigit").textContent=d.lastDigit ?? "—";

  $("digitDistribution").innerHTML=Array.from({length:10},(_,i)=>{
    const count=d.digits.filter(x=>x===i).length;
    const pct=d.digits.length ? count/d.digits.length*100 : 0;
    return `<div class="digit-box"><b>${i}</b><small>${count} (${pct.toFixed(1)}%)</small></div>`;
  }).join("");

  $("recentSequence").textContent=d.digits.slice(-40).join("  ") || "—";
  if(d.error) $("analysisMessage").textContent=d.error;
  else if(d.available===false) $("analysisMessage").textContent="Deriv did not advertise this symbol as available. The scanner will not treat it as a valid live market.";
  else if(sig.setup){
    $("analysisMessage").textContent=`${sig.setup} setup detected. Statistical candidate entry digit: ${sig.entry.digit}. Candidate score: ${sig.entry.score.toFixed(1)}%.`;
  } else {
    $("analysisMessage").textContent=`Waiting for a ${threshold()}% setup using ${sampleSize()} ticks. Over 2: ${r.over.toFixed(1)}%, Under 7: ${r.under.toFixed(1)}%.`;
  }
  $("recentTicks").textContent=d.quotes.slice(-20).map(q=>String(q)).join("  |  ") || "—";
}

function connect(){
  if(socket) socket.close();
  socket=new WebSocket(DERIV_URL);
  $("connectionBadge").textContent="CONNECTING";
  $("connectionBadge").className="badge waiting";

  socket.onopen=()=>{
    $("connectionBadge").textContent="CONNECTED";
    $("connectionBadge").className="badge connected";
    socket.send(JSON.stringify({active_symbols:"brief",req_id:100}));
  };

  socket.onmessage=e=>{
    let msg;
    try{msg=JSON.parse(e.data)}catch{return;}

    if(msg.error){console.log("DERIV ERROR:",msg.error);
      const req=msg.echo_req||{};
      if(req.ticks){
        const s=req.ticks;
        if(state[s]){state[s].error=msg.error.message||"Subscription error";state[s].available=false;}
      }
      renderTable(); renderSelected(); return;
    }

    if(msg.msg_type==="active_symbols"){
      const available=new Set((msg.active_symbols||[]).map(x=>x.underlying_symbol||x.symbol));
      MARKETS.forEach(([name,symbol],i)=>{
        state[symbol].available=available.has(symbol);
        if(state[symbol].available){
          socket.send(JSON.stringify({ticks:symbol,subscribe:1,req_id:1000+i}));
        }else{
          state[symbol].error="Symbol not returned by active_symbols.";
        }
      });
      renderTable(); renderSelected(); return;
    }

    if(msg.msg_type==="tick" && msg.tick){
      processTick(msg.tick.symbol, msg.tick.quote);
    }
  };

  socket.onclose=()=>{
    $("connectionBadge").textContent="DISCONNECTED";
    $("connectionBadge").className="badge disconnected";
  };
  socket.onerror=()=>{
    $("connectionBadge").textContent="ERROR";
    $("connectionBadge").className="badge disconnected";
  };
}

function clearData(){
  totalTicks=0;
  MARKETS.forEach(([name,symbol])=>{
    state[symbol].digits=[];state[symbol].quotes=[];state[symbol].lastDigit=null;state[symbol].error=null;
  });
  $("liveTicks").textContent="0";
  renderTable();renderSelected();
}

$("connectBtn").addEventListener("click",connect);
$("clearBtn").addEventListener("click",clearData);
$("sampleSize").addEventListener("change",()=>{renderTable();renderSelected();});
$("signalThreshold").addEventListener("change",()=>{renderTable();renderSelected();});$("marketSelect").addEventListener("change",e=>{
  selectedSymbol=e.target.value;
  renderSelected();
});

$("marketTable").addEventListener("click",e=>{
  const row=e.target.closest("tr");
  if(!row) return;
  const name=row.cells[0]?.textContent;
  const found=MARKETS.find(x=>x[0]===name);
  if(found){selectedSymbol=found[1];renderSelected();}
});

renderTable();
renderSelected();
