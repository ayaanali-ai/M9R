import type { TerminalProvider } from "@/lib/local-terminal-protocol";
import { providerLabel } from "@/lib/provider-adapter-config";

const PROVIDER_META: Record<string, { label: string; command: string; mark: string; accent: string; surface: string; terminal: string; ink: string; muted: string }> = {
  codex: { label: "Codex", command: "codex", mark: "⌁", accent: "#F2EFE9", surface: "#f7f7f5", terminal: "#101211", ink: "#171717", muted: "#6b6b67" },
  "claude-code": { label: "Claude", command: "claude", mark: "A", accent: "#d97757", surface: "#f5f0e8", terminal: "#171411", ink: "#2d2926", muted: "#776d66" },
  "grok-build": { label: "Grok Build", command: "grok", mark: "G", accent: "#4b74ff", surface: "#f2f4f8", terminal: "#0d111a", ink: "#17191d", muted: "#69707c" },
};

export function renderLocalProviderWorkspace(provider: TerminalProvider, nonce: string, bridgePort = 43117, providerCommand?: string): string {
  const meta = PROVIDER_META[provider] ?? {
    label: providerLabel(provider),
    command: provider,
    mark: provider.charAt(0).toUpperCase() || "A",
    accent: "#7c6cff",
    surface: "#f4f3f8",
    terminal: "#111117",
    ink: "#191923",
    muted: "#6b6877",
  };
  const config = JSON.stringify({ provider, bridgePort, ...meta, command: providerCommand ?? meta.command }).replaceAll("<", "\\u003c");
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width,initial-scale=1" />
  <title>${meta.label} in M9R</title>
  <link rel="stylesheet" href="/assets/xterm.css" />
  <style nonce="${nonce}">
    :root { color-scheme: light; font-family: Inter, ui-sans-serif, system-ui, sans-serif; background:${meta.surface}; color:${meta.ink}; }
    * { box-sizing:border-box; }
    html,body { width:100%; height:100%; margin:0; overflow:hidden; }
    body { display:grid; grid-template-rows:52px 34px minmax(0,1fr); background:${meta.surface}; }
    header { display:flex; align-items:center; gap:12px; padding:0 16px; border-bottom:1px solid rgb(0 0 0 / .10); }
    .mark { width:28px; height:28px; display:grid; place-items:center; border:1px solid color-mix(in srgb,${meta.accent} 55%,transparent); border-radius:8px; background:color-mix(in srgb,${meta.accent} 10%,${meta.surface}); color:${meta.accent}; font:700 14px/1 ui-monospace,monospace; }
    .identity { min-width:0; }
    .identity strong { display:block; font-size:13px; letter-spacing:-.01em; }
    .identity span,.status { color:${meta.muted}; font:500 10px/1.3 ui-monospace,monospace; text-transform:uppercase; letter-spacing:.08em; }
    .status { margin-left:auto; display:flex; align-items:center; gap:7px; }
    .dot { width:7px; height:7px; border-radius:50%; background:${meta.accent}; box-shadow:0 0 0 3px color-mix(in srgb, ${meta.accent} 14%, transparent); }
    .rail { display:flex; align-items:center; gap:10px; padding:0 16px; border-bottom:1px solid rgb(0 0 0 / .08); color:${meta.muted}; font:500 10px/1 ui-monospace,monospace; }
    .rail strong { color:${meta.ink}; font-weight:650; }
    .rail button { margin-left:auto; border:1px solid rgb(0 0 0 / .16); border-radius:6px; background:transparent; color:${meta.ink}; padding:5px 9px; font:600 10px/1 ui-monospace,monospace; cursor:pointer; }
    .rail button:hover { background:rgb(0 0 0 / .05); }
    main { min-height:0; padding:10px; background:linear-gradient(${meta.surface},color-mix(in srgb,${meta.surface} 91%,${meta.accent})); }
    #terminal { width:100%; height:100%; overflow:hidden; border:1px solid color-mix(in srgb,${meta.accent} 18%,rgb(0 0 0 / .22)); border-radius:9px; background:${meta.terminal}; padding:10px; box-shadow:0 12px 32px rgb(0 0 0 / .10); }
    .xterm { height:100%; }
    @media (prefers-reduced-motion:reduce) { * { scroll-behavior:auto !important; } }
  </style>
</head>
<body>
  <header>
    <div class="mark" aria-hidden="true">${meta.mark}</div>
    <div class="identity"><strong>${meta.label}</strong><span>Local provider workspace</span></div>
    <div class="status"><span class="dot"></span><span id="status">Connecting</span></div>
  </header>
  <div class="rail"><strong id="mode">Workspace</strong><span id="detail">Real local session under M9R control</span><button id="new-session" type="button">New session</button></div>
  <main><div id="terminal" aria-label="${meta.label} local workspace terminal"></div></main>
  <script src="/assets/xterm.js"></script>
  <script nonce="${nonce}">
    const CONFIG=${config};
    const terminal=new Terminal({cursorBlink:true,fontFamily:'Cascadia Mono,Consolas,ui-monospace,monospace',fontSize:13,lineHeight:1.18,scrollback:5000,theme:{background:CONFIG.terminal,foreground:'#e9ecef',cursor:CONFIG.accent,selectionBackground:'#334155',black:'#1b1f24',red:'#ef6b73',green:'#59d99b',yellow:'#f3bd5b',blue:'#6ca8e6',magenta:'#c792ea',cyan:'#61d5ca',white:'#d5d9de',brightBlack:'#69717a',brightWhite:'#ffffff'}});
    terminal.open(document.getElementById('terminal'));
    const status=document.getElementById('status'); const mode=document.getElementById('mode'); const detail=document.getElementById('detail');
    let socket=null,current=null,currentInteractive=false,sessions=[];
    const resize=()=>{ const host=document.getElementById('terminal'); const cols=Math.max(40,Math.floor((host.clientWidth-20)/8)); const rows=Math.max(12,Math.floor((host.clientHeight-20)/16)); terminal.resize(cols,rows); if(socket?.readyState===1&&current&&currentInteractive) socket.send(JSON.stringify({type:'resize',sessionId:current,cols,rows})); };
    new ResizeObserver(resize).observe(document.getElementById('terminal'));
    function attach(session){ current=session.id; currentInteractive=session.interactive!==false; mode.textContent=session.source==='resident'?'Delegated assignment':'Interactive session'; detail.textContent=session.source==='resident'?'Bounded grant '+String(session.grantId||'').slice(0,8):session.cwd; socket.send(JSON.stringify({type:'attach',sessionId:session.id})); terminal.clear(); resize(); terminal.focus(); }
    function choose(next){ sessions=next.filter(s=>s.provider===CONFIG.provider); const resident=sessions.find(s=>s.source==='resident'&&s.status==='running'); const selected=sessions.find(s=>s.id===current); if(resident&&selected?.source!=='resident') return attach(resident); if(selected?.status==='running') return; const running=sessions.find(s=>s.status==='running'); if(running) return attach(running); current=null; currentInteractive=false; mode.textContent='Workspace ready'; detail.textContent='Start a real '+CONFIG.label+' session'; }
    function spawnProvider(){ if(socket?.readyState!==1)return; current=null; socket.send(JSON.stringify({type:'spawn',provider:CONFIG.provider,cwd:'.',cols:terminal.cols,rows:terminal.rows})); }
    function connect(){ status.textContent='Connecting'; socket=new WebSocket('ws://127.0.0.1:'+CONFIG.bridgePort+'/terminal',['oathlock-terminal-v1','oathlock-provider.'+CONFIG.provider]); socket.onopen=()=>{status.textContent='Connected';socket.send(JSON.stringify({type:'list'}));}; socket.onmessage=(event)=>{const message=JSON.parse(String(event.data)); if(message.type==='ready'||message.type==='sessions')choose(message.sessions||[]); if(message.type==='spawned'&&message.session){attach(message.session);setTimeout(()=>socket.send(JSON.stringify({type:'input',sessionId:message.session.id,data:CONFIG.command+'\\r'})),120);} if(message.type==='output'&&message.sessionId===current)terminal.write(message.data||''); if(message.type==='error')terminal.writeln('\\r\\n\\x1b[31m'+(message.error||'Runtime error')+'\\x1b[0m');}; socket.onclose=()=>{status.textContent='Offline';setTimeout(connect,1500);}; socket.onerror=()=>{status.textContent='Unavailable';}; }
    terminal.onData(data=>{if(socket?.readyState===1&&current&&currentInteractive)socket.send(JSON.stringify({type:'input',sessionId:current,data}));});
    document.getElementById('new-session').addEventListener('click',spawnProvider);
    connect(); setTimeout(()=>{if(!current)spawnProvider();},500); resize();
  </script>
</body>
</html>`;
}
