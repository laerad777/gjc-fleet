/** Self-contained dashboard page served by `gjc-fleet ui`; no external assets. */
export const DASHBOARD_HTML = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta name="theme-color" content="#f3f4fb">
<meta name="theme-color" content="#07080c">
<title>GJC Fleet Dashboard</title>
<style>
:root{
	--bg:#07080c;--panel:rgba(255,255,255,.035);--panel-hi:rgba(255,255,255,.06);
	--line:rgba(255,255,255,.07);--line-hi:rgba(255,255,255,.14);
	--text:#eceef3;--sub:#d0d6e2;--dim:#c0cada;
	--mint:#5eead4;--sky:#7dd3fc;--violet:#c4b5fd;--amber:#fbbf24;--rose:#fda4af;
	--ease:cubic-bezier(.22,1,.36,1);
}
*{box-sizing:border-box;margin:0;padding:0;-webkit-tap-highlight-color:transparent}
html{background:var(--bg)}
body{
	font-family:"Pretendard Variable",Pretendard,-apple-system,BlinkMacSystemFont,"SF Pro Display","Segoe UI",Roboto,sans-serif;
	color:var(--text);min-height:100vh;line-height:1.45;-webkit-font-smoothing:antialiased;
	padding:calc(18px + env(safe-area-inset-top)) 16px calc(40px + env(safe-area-inset-bottom));
	overflow-x:hidden;
}
.aurora{position:fixed;inset:0;z-index:-1;overflow:hidden;pointer-events:none}
.aurora i{position:absolute;border-radius:50%;filter:blur(90px);opacity:.34;will-change:transform}
.aurora i:nth-child(1){width:460px;height:460px;left:-140px;top:-160px;background:#2dd4bf;animation:drift1 22s ease-in-out infinite alternate}
.aurora i:nth-child(2){width:520px;height:520px;right:-200px;top:120px;background:#6366f1;animation:drift2 28s ease-in-out infinite alternate}
.aurora i:nth-child(3){width:380px;height:380px;left:20%;bottom:-220px;background:#0ea5e9;opacity:.2;animation:drift3 32s ease-in-out infinite alternate}
.aurora::after{content:"";position:absolute;inset:0;
	background-image:linear-gradient(var(--line) 1px,transparent 1px),linear-gradient(90deg,var(--line) 1px,transparent 1px);
	background-size:44px 44px;opacity:.35;
	-webkit-mask-image:radial-gradient(ellipse at 50% 0%,#000 0%,transparent 70%);mask-image:radial-gradient(ellipse at 50% 0%,#000 0%,transparent 70%)}
@keyframes drift1{to{transform:translate(120px,90px) scale(1.15)}}
@keyframes drift2{to{transform:translate(-140px,-60px) scale(.9)}}
@keyframes drift3{to{transform:translate(90px,-120px) scale(1.2)}}

.wrap{max-width:860px;margin:0 auto}
.rise{opacity:0;transform:translateY(14px);animation:rise .7s var(--ease) forwards;animation-delay:calc(var(--i,0) * 60ms)}
@keyframes rise{to{opacity:1;transform:none}}

header{display:flex;align-items:center;justify-content:space-between;margin-bottom:22px}
.brand{display:flex;align-items:center;gap:12px}
.mark{width:38px;height:38px;border-radius:12px;display:grid;place-items:center;
	background:linear-gradient(140deg,rgba(94,234,212,.22),rgba(167,139,250,.22));
	border:1px solid var(--line-hi);box-shadow:0 0 24px rgba(94,234,212,.18),inset 0 1px 0 rgba(255,255,255,.12)}
.mark svg{width:20px;height:20px}
.mark circle{animation:blink 2.4s ease-in-out infinite}
.mark circle:nth-of-type(2){animation-delay:.4s}.mark circle:nth-of-type(3){animation-delay:.8s}
@keyframes blink{0%,100%{opacity:1}50%{opacity:.35}}
h1{font-size:19px;font-weight:700;letter-spacing:-.03em}
.tagline{font-size:11.5px;color:var(--sub);letter-spacing:.02em}
.live{display:flex;align-items:center;gap:8px;font-size:12px;color:var(--sub);font-variant-numeric:tabular-nums;
	padding:7px 12px;border-radius:999px;background:var(--panel);border:1px solid var(--line);
	backdrop-filter:blur(14px);-webkit-backdrop-filter:blur(14px);transition:border-color .4s,color .4s}
.dot{position:relative;width:7px;height:7px;border-radius:50%;background:var(--mint)}
.dot::after{content:"";position:absolute;inset:-4px;border-radius:50%;border:1px solid var(--mint);animation:ping 1.8s var(--ease) infinite}
@keyframes ping{0%{transform:scale(.6);opacity:.9}100%{transform:scale(2.1);opacity:0}}
.live.down{color:var(--rose);border-color:rgba(251,113,133,.35)}
.live.down .dot{background:var(--rose)}.live.down .dot::after{border-color:var(--rose)}

.glass{background:var(--panel);border:1px solid var(--line);border-radius:18px;
	backdrop-filter:blur(18px) saturate(140%);-webkit-backdrop-filter:blur(18px) saturate(140%);
	box-shadow:inset 0 1px 0 rgba(255,255,255,.05);transition:transform .35s var(--ease),border-color .35s,background .35s}
@media(hover:hover){.glass:hover{transform:translateY(-2px);border-color:var(--line-hi);background:var(--panel-hi)}}

.runtime{position:relative;padding:18px;margin-bottom:14px;overflow:hidden}
.runtime::before{content:"";position:absolute;inset:0;border-radius:inherit;padding:1px;
	background:conic-gradient(from var(--a,0deg),transparent 0 62%,rgba(94,234,212,.75),rgba(167,139,250,.75),transparent 92%);
	-webkit-mask:linear-gradient(#000 0 0) content-box,linear-gradient(#000 0 0);-webkit-mask-composite:xor;mask-composite:exclude;
	animation:spin 7s linear infinite;pointer-events:none}
@property --a{syntax:"<angle>";inherits:false;initial-value:0deg}
@keyframes spin{to{--a:360deg}}
.eyebrow{font-size:10.5px;font-weight:600;letter-spacing:.14em;text-transform:uppercase;color:var(--sub)}
.rt-row{display:flex;align-items:flex-end;justify-content:space-between;gap:12px;margin:6px 0 14px}
.rt-ver{font-size:26px;font-weight:700;letter-spacing:-.035em;
	background:linear-gradient(90deg,#fff,var(--mint) 60%,var(--violet));-webkit-background-clip:text;background-clip:text;color:transparent}
.rt-age{font-size:11.5px;color:var(--dim);font-variant-numeric:tabular-nums;white-space:nowrap}
.chips{display:flex;flex-wrap:wrap;gap:8px}
.chip{display:inline-flex;align-items:center;gap:7px;font-size:12px;font-weight:550;padding:6px 11px;border-radius:999px;
	border:1px solid var(--line);background:rgba(255,255,255,.03);color:var(--sub);transition:color .4s,border-color .4s,background .4s}
.chip b{width:6px;height:6px;border-radius:50%;background:currentColor;box-shadow:0 0 10px currentColor}
.chip.ok{color:var(--mint);border-color:rgba(94,234,212,.28);background:rgba(94,234,212,.07)}
.chip.warn{color:var(--amber);border-color:rgba(251,191,36,.28);background:rgba(251,191,36,.07)}
.chip.bad{color:var(--rose);border-color:rgba(251,113,133,.3);background:rgba(251,113,133,.07)}
.chip.info{color:var(--sky);border-color:rgba(125,211,252,.28);background:rgba(125,211,252,.07)}

.metrics{display:grid;grid-template-columns:repeat(3,1fr);gap:10px;margin-bottom:28px}
.metric{padding:14px 14px 13px;position:relative;overflow:hidden}
.metric::after{content:"";position:absolute;left:14px;right:14px;bottom:0;height:2px;border-radius:2px;background:var(--c,var(--line-hi));opacity:.7;
	transform:scaleX(0);transform-origin:left;animation:grow 1s var(--ease) forwards;animation-delay:calc(var(--i,0) * 60ms + .25s)}
@keyframes grow{to{transform:scaleX(1)}}
.metric .k{font-size:11.5px;color:var(--sub);margin-bottom:6px}
.metric .v{font-size:27px;font-weight:700;letter-spacing:-.04em;font-variant-numeric:tabular-nums;color:var(--c,var(--text))}
.metric .v small{font-size:14px;font-weight:500;color:var(--dim);letter-spacing:0}
.bump{animation:bump .5s var(--ease)}
@keyframes bump{40%{transform:scale(1.12)}}

.sec{display:flex;align-items:baseline;justify-content:space-between;margin:0 2px 11px}
h2{font-size:14px;font-weight:650;letter-spacing:-.01em}
.count{font-size:11.5px;color:var(--dim);font-variant-numeric:tabular-nums}
.list{display:grid;gap:10px;margin-bottom:28px}
@media(min-width:680px){.list.nodes{grid-template-columns:1fr 1fr}}

.node{padding:15px 16px}
.node-top{display:flex;align-items:center;gap:12px;margin-bottom:13px}
.os{width:36px;height:36px;flex:none;border-radius:11px;display:grid;place-items:center;font-size:11px;font-weight:700;letter-spacing:.04em;
	color:var(--text);background:linear-gradient(140deg,rgba(125,211,252,.18),rgba(167,139,250,.14));border:1px solid var(--line-hi)}
.node-id{font-size:14.5px;font-weight:650;letter-spacing:-.02em;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.node-sub{font-size:11.5px;color:var(--sub);font-family:ui-monospace,SFMono-Regular,Menlo,monospace}
.node-top .chip{margin-left:auto;flex:none;padding:4px 9px;font-size:11px}
.flags{display:flex;gap:14px;font-size:11.5px;color:var(--sub);margin-bottom:11px}
.flags span{display:inline-flex;align-items:center;gap:5px}
.flags i{width:5px;height:5px;border-radius:50%;background:var(--dim)}
.flags .y{color:var(--text)}.flags .y i{background:var(--mint);box-shadow:0 0 8px var(--mint)}
.flags .n i{background:var(--rose)}
.slots{display:flex;align-items:center;gap:10px}
.bar{flex:1;height:5px;border-radius:5px;background:rgba(255,255,255,.07);overflow:hidden}
.bar u{display:block;height:100%;width:0;border-radius:inherit;text-decoration:none;
	background:linear-gradient(90deg,var(--mint),var(--sky),var(--violet));background-size:200% 100%;
	transition:width .9s var(--ease);animation:flow 2.4s linear infinite}
@keyframes flow{to{background-position:-200% 0}}
.slots em{font-style:normal;font-size:11.5px;color:var(--sub);font-variant-numeric:tabular-nums}

.task{padding:13px 16px;display:flex;align-items:center;gap:12px}
.task-main{min-width:0;flex:1}
.task-key{font-size:13.5px;font-weight:600;letter-spacing:-.01em;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.task-sub{font-size:11.5px;color:var(--sub);margin-top:2px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.task-sub code{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;color:var(--dim)}
.spin{width:10px;height:10px;border-radius:50%;border:1.5px solid currentColor;border-top-color:transparent;animation:rot .8s linear infinite}
@keyframes rot{to{transform:rotate(360deg)}}

.empty{padding:26px 16px;text-align:center;font-size:12.5px;color:var(--dim);border:1px dashed var(--line-hi);border-radius:18px}
.skel{height:76px;border-radius:18px;background:linear-gradient(100deg,var(--panel) 30%,var(--panel-hi) 50%,var(--panel) 70%);background-size:300% 100%;animation:shimmer 1.6s linear infinite}
@keyframes shimmer{to{background-position:-300% 0}}
.stale main{opacity:1;filter:saturate(.4);transition:opacity .5s,filter .5s}
footer{text-align:center;font-size:11px;color:var(--dim)}
@media(max-width:380px){.metric .v{font-size:23px}.rt-ver{font-size:22px}}
@media(prefers-reduced-motion:reduce){*,*::before,*::after{animation-duration:.01ms!important;animation-iteration-count:1!important;transition-duration:.01ms!important}}

.wrap{max-width:960px}
.runtime{padding:16px 18px;margin-bottom:22px}
.rt-row{margin:4px 0 12px}
.card{padding:16px}
.note{font-size:11.5px;color:var(--dim);margin-top:10px;line-height:1.5}
.mono{font-family:ui-monospace,SFMono-Regular,Menlo,monospace}

/* pipeline */
.pipe{padding:20px 12px 16px;margin-bottom:12px}
.flow{display:grid;grid-template-columns:repeat(7,1fr);position:relative}
.flow::before,.flow::after{content:"";position:absolute;top:18px;left:7.14%;right:7.14%;height:2px;border-radius:2px}
.flow::before{background:var(--line-hi)}
.flow::after{background:repeating-linear-gradient(90deg,var(--mint) 0 7px,transparent 7px 16px);background-size:16px 100%;opacity:0;transition:opacity .5s;animation:dash .7s linear infinite}
.flow.busy::after{opacity:.9}
@keyframes dash{to{background-position:16px 0}}
.st{display:flex;flex-direction:column;align-items:center;gap:5px;position:relative;z-index:1;min-width:0}
.st .n{width:38px;height:38px;border-radius:50%;display:grid;place-items:center;font-size:15px;font-weight:700;font-variant-numeric:tabular-nums;
	background:#0c0e14;border:1.5px solid var(--line-hi);color:var(--dim);transition:all .5s var(--ease)}
.st.seen .n{color:var(--text);border-color:rgba(94,234,212,.45)}
.st.on .n{color:#04110f;background:linear-gradient(140deg,var(--mint),var(--sky));border-color:transparent;animation:halo 1.8s ease-out infinite}
@keyframes halo{0%{box-shadow:0 0 0 0 rgba(94,234,212,.55)}100%{box-shadow:0 0 0 14px rgba(94,234,212,0)}}
.st .l{font-size:11.5px;font-weight:600;color:var(--sub)}
.st.on .l,.st.seen .l{color:var(--text)}
.st .r{font-size:10px;color:var(--dim);font-variant-numeric:tabular-nums}
.outcome{display:flex;flex-wrap:wrap;gap:7px;margin-top:16px;padding-top:14px;border-top:1px solid var(--line)}
.outcome .chip{padding:5px 10px;font-size:11.5px}
.chip.mute{color:var(--dim);border-color:var(--line);background:rgba(255,255,255,.03);opacity:1}

/* tasks */
.tk{padding:14px 16px;cursor:pointer}
.tk-head{display:flex;align-items:center;gap:10px}
.tk-key{flex:1;min-width:0;font-size:14px;font-weight:650;letter-spacing:-.015em;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.tk-head .chip{flex:none;padding:4px 9px;font-size:11px}
.tk-sub{font-size:11.5px;color:var(--sub);margin:3px 0 11px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.tk-sub b{color:var(--text);font-weight:600}
.steps{display:grid;grid-template-columns:repeat(7,1fr);gap:4px}
.steps i{height:5px;border-radius:3px;background:rgba(255,255,255,.08);transform-origin:left}
.steps i.done{background:linear-gradient(90deg,var(--mint),var(--sky));animation:fill .6s var(--ease) backwards;animation-delay:calc(var(--s) * 70ms)}
.steps i.now{background:var(--sky);animation:glow 1.1s ease-in-out infinite alternate}
.steps i.wait{background:var(--amber);opacity:.75}
.steps i.fail{background:var(--rose)}
@keyframes fill{from{transform:scaleX(0)}}
@keyframes glow{from{opacity:.35}to{opacity:1;box-shadow:0 0 10px var(--sky)}}
.steplabels{display:grid;grid-template-columns:repeat(7,1fr);gap:4px;margin-top:5px;font-size:9.5px;color:var(--dim);text-align:center;font-variant-numeric:tabular-nums}
.steplabels span.hit{color:var(--sub)}
.more{display:grid;grid-template-rows:0fr;transition:grid-template-rows .45s var(--ease)}
.more>div{overflow:hidden}
.tk.open .more{grid-template-rows:1fr}
.caret{flex:none;width:8px;height:8px;border-right:1.5px solid var(--dim);border-bottom:1.5px solid var(--dim);transform:rotate(45deg);transition:transform .35s var(--ease);margin:0 2px 3px 2px}
.tk.open .caret{transform:rotate(225deg);margin-bottom:-3px}
.blk{margin-top:14px;padding-top:12px;border-top:1px solid var(--line)}
.blk h3{font-size:10.5px;font-weight:600;letter-spacing:.12em;text-transform:uppercase;color:var(--sub);margin-bottom:8px}
.kv{display:grid;grid-template-columns:auto 1fr;gap:4px 12px;font-size:12px}
.kv dt{color:var(--dim)}.kv dd{color:var(--text);min-width:0;overflow-wrap:anywhere}
.tl{position:relative;padding-left:16px}
.tl::before{content:"";position:absolute;left:3px;top:6px;bottom:6px;width:1px;background:var(--line-hi)}
.tl li{list-style:none;position:relative;display:flex;gap:8px;align-items:baseline;font-size:12px;padding:3px 0}
.tl li::before{content:"";position:absolute;left:-16px;top:8px;width:7px;height:7px;border-radius:50%;background:#0c0e14;border:1.5px solid var(--dim)}
.tl li.key::before{border-color:var(--mint);background:var(--mint)}
.tl li.bad::before{border-color:var(--rose);background:var(--rose)}
.tl time{flex:none;color:var(--dim);font-size:11px;font-variant-numeric:tabular-nums}
.tl em{font-style:normal;color:var(--sub);min-width:0;overflow-wrap:anywhere}

/* nodes */
.nd{padding:15px 16px}
.nd-top{display:flex;align-items:center;gap:12px;margin-bottom:12px}
.nd-top .chip{margin-left:auto;flex:none;padding:4px 9px;font-size:11px}
.pips{display:flex;align-items:center;gap:6px;margin-bottom:10px}
.pips span{width:22px;height:8px;border-radius:4px;background:rgba(255,255,255,.09)}
.pips span.on{background:linear-gradient(90deg,var(--mint),var(--sky));box-shadow:0 0 10px rgba(94,234,212,.5);animation:glow 1.2s ease-in-out infinite alternate}
.pips em{font-style:normal;font-size:11.5px;color:var(--sub);margin-left:4px;font-variant-numeric:tabular-nums}
.hold{display:flex;flex-wrap:wrap;gap:6px;margin-bottom:10px}
.hold .chip{padding:4px 9px;font-size:11px;max-width:100%}
.hold .chip span{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.stats{display:grid;grid-template-columns:repeat(3,1fr);gap:8px;margin-bottom:10px}
.stats div{background:rgba(255,255,255,.03);border:1px solid var(--line);border-radius:10px;padding:7px 9px}
.stats b{display:block;font-size:16px;font-weight:700;font-variant-numeric:tabular-nums;letter-spacing:-.02em}
.stats small{font-size:10.5px;color:var(--dim)}
.meta{font-size:11px;color:var(--dim);line-height:1.6;overflow-wrap:anywhere}
.meta b{color:var(--sub);font-weight:500}

/* sessions */
.tabs{display:flex;gap:6px;overflow-x:auto;margin-bottom:10px;padding-bottom:2px;scrollbar-width:none}
.tabs::-webkit-scrollbar{display:none}
.tabs button{flex:none;font:inherit;font-size:12px;font-weight:600;color:var(--sub);background:var(--panel);border:1px solid var(--line);
	border-radius:999px;padding:7px 12px;cursor:pointer;transition:all .3s var(--ease)}
.tabs button small{font-weight:500;color:var(--dim);margin-left:5px;font-variant-numeric:tabular-nums}
.tabs button.sel{color:#04110f;background:linear-gradient(140deg,var(--mint),var(--sky));border-color:transparent}
.tabs button.sel small{color:#04110f}
.ss{padding:11px 14px;display:flex;align-items:center;gap:11px}
.ss .lamp{flex:none;width:8px;height:8px;border-radius:50%;background:var(--dim)}
.ss.live .lamp{background:var(--sky)}
.ss.st-working .lamp{background:var(--mint);box-shadow:0 0 10px var(--mint);animation:blink 1.6s ease-in-out infinite}
.ss.st-waiting_workflow .lamp,.ss.st-waiting_answer .lamp,.ss.st-waiting_permission .lamp{background:#fbbf24;box-shadow:0 0 10px #fbbf24;animation:blink 1s ease-in-out infinite}
.ss.st-stale .lamp,.ss.st-unknown .lamp{background:#f59e0b;opacity:.55}
.adm{display:flex;align-items:center;gap:8px;margin-bottom:10px;font-size:12px;color:var(--sub)}
.adm i{flex:none;width:8px;height:8px;border-radius:50%;background:var(--dim)}
.adm.open i{background:var(--mint);box-shadow:0 0 8px var(--mint)}
.adm.hold i{background:#fbbf24}
.adm b{color:var(--text,#e5e7eb);font-weight:600}
.ss-main{flex:1;min-width:0}
.ss-cwd{font-size:13px;font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;direction:rtl;text-align:left}
.ss-sub{font-size:11px;color:var(--sub);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.ss-age{flex:none;font-size:11px;color:var(--dim);font-variant-numeric:tabular-nums}
.ss .chip{padding:3px 8px;font-size:10.5px}
.list{margin-bottom:26px}

/* resources */
.res{display:grid;gap:9px;margin-bottom:11px}
.res-row{display:grid;grid-template-columns:minmax(0,auto) minmax(0,1fr);align-items:baseline;gap:4px 10px;font-size:11.5px}
.res-row label{grid-area:1/1;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.res-row label small{color:var(--dim)}
.res-row .bar{grid-area:2/1/3/3;flex:none;width:100%}
.res-row span{grid-area:1/2;text-align:right;overflow:hidden;text-overflow:ellipsis}
.res-row label{color:var(--sub)}
.res-row .bar u{background:linear-gradient(90deg,var(--mint),var(--sky));animation:none;transition:width .9s var(--ease),background .4s}
.res-row.warn .bar u{background:var(--amber)}
.res-row.hot .bar u{background:var(--rose)}
.res-row span{color:var(--text);font-variant-numeric:tabular-nums;white-space:nowrap}
.res-row span small{color:var(--dim)}
.settled .rise{animation:none;opacity:1;transform:none}
.settled .steps i.done{animation:none}
.fold{display:flex;align-items:center;gap:8px;width:100%;font:inherit;font-size:12px;font-weight:600;color:var(--sub);text-align:left;
	background:transparent;border:1px dashed var(--line-hi);border-radius:14px;padding:10px 14px;cursor:pointer;transition:color .3s,border-color .3s}
.fold:hover{color:var(--text);border-color:var(--sub)}
.fold .caret{margin-left:auto}
.fold.open .caret{transform:rotate(225deg);margin-bottom:-3px}
.folded{display:grid;grid-template-rows:0fr;transition:grid-template-rows .45s var(--ease)}
.folded>div{overflow:hidden;display:grid;gap:10px;min-width:0}
.fold.open+.folded{grid-template-rows:1fr}
.fold.open+.folded>div{padding-top:0}
.list{grid-template-columns:minmax(0,1fr)}
@media(min-width:680px){.list.nodes{grid-template-columns:repeat(2,minmax(0,1fr))}}
.folded{grid-template-columns:minmax(0,1fr);min-width:0}
.folded>div{grid-template-columns:minmax(0,1fr)}
.ss-title{font-size:13.5px;font-weight:600;letter-spacing:-.01em;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.ss-title.none{color:var(--dim);font-weight:500}
.tk-key{white-space:normal;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical}
/* Light fleet map. Legacy console tokens above stay untouched. */
body.fleet-light{background:#f3f4fb;color:#1c1733;padding:0}
body.fleet-light .aurora,body.fleet-light .wrap{display:none!important}
.fm{position:relative;z-index:1;min-height:100vh;padding:calc(22px + env(safe-area-inset-top)) 32px calc(28px + env(safe-area-inset-bottom));background-color:#f4f5fb;background-image:radial-gradient(rgba(90,80,140,.13) 1px,transparent 1.2px);background-size:22px 22px;color:#1c1733;font-family:"Avenir Next","Segoe UI",sans-serif}
.fm-top{display:flex;justify-content:space-between;align-items:flex-end;gap:28px;max-width:1120px;margin:0 auto}
.fm-brand{display:flex;align-items:center;gap:10px;font-size:12px;font-weight:750;letter-spacing:.18em;text-transform:uppercase;color:#8d89a3}
.fm-pill{display:inline-flex;align-items:center;gap:6px;letter-spacing:0;text-transform:none;font-weight:650;font-size:12px;color:#6b5670;background:#fff;border:1px solid #f0e4cc;border-radius:999px;padding:3px 9px 3px 7px}
.fm-pill i{width:7px;height:7px;border-radius:50%;background:#f5a524}
.fm-pill.is-ok{color:#176b45;border-color:#d5f0e4}.fm-pill.is-ok i{background:#1f9d62}
.fm-pill.is-bad{color:#b4233c;border-color:#ffd5de}.fm-pill.is-bad i{background:#e11d48}
.fm-link{letter-spacing:0;text-transform:none;font-size:11px;font-weight:650;color:#8d89a3}
.fm-link.is-live{color:#1f8a5b}.fm-link.is-down{color:#e11d48}
.fm-title{font-family:"Iowan Old Style",Palatino,Georgia,serif;font-size:46px;font-weight:560;letter-spacing:-.03em;line-height:1.02;margin:10px 0 0;color:#1b1533}
.fm-title em{font-style:italic}
.fm-sub{font-family:"Iowan Old Style",Palatino,Georgia,serif;font-size:22px;line-height:1.25;margin-top:6px;color:#241c3d}
.fm-sub em{color:#6d5efc;font-style:italic}
.fm-side{display:flex;flex-direction:column;align-items:flex-end;gap:8px}
.fm-metrics{display:flex;flex-wrap:wrap;justify-content:flex-end;gap:26px}
.fm-age{flex-basis:100%;justify-content:flex-end}
.fm-metric{text-align:center;min-width:74px}
.fm-metric .k{display:block;font-size:11px;font-weight:750;letter-spacing:.14em;text-transform:uppercase;color:#8d89a3}
.fm-metric b{display:block;margin-top:4px;font-family:"Iowan Old Style",Palatino,Georgia,serif;font-size:40px;font-weight:560;letter-spacing:-.03em;line-height:1;color:#1b1533}
.fm-metric.is-alert b{color:#e11d48}
.fm-age{display:inline-flex;align-items:center;gap:6px;font-size:12px;font-weight:700;letter-spacing:.08em;text-transform:uppercase;color:#b7791f}
.fm-age i{width:7px;height:7px;border-radius:50%;background:#f5a524}
.fm-banners{max-width:1120px;margin:16px auto 0}
.fm-lease{display:flex;align-items:center;justify-content:space-between;gap:16px;background:#fffaf3;border:1px solid #ffe0b8;border-radius:16px;padding:12px 16px}
.fm-lease b{display:block;color:#9a6700;font-size:14px}
.fm-lease p{color:#8a6a32;font-size:13px;margin-top:2px}
.fm-clock{font-family:"Iowan Old Style",Palatino,Georgia,serif;font-size:32px;color:#9a6700;font-variant-numeric:tabular-nums}
.fm-stage{position:relative;max-width:1120px;height:min(640px,62vh);min-height:460px;margin:18px auto 0}
.fm-stage::before{content:"";position:absolute;left:50%;top:48%;width:460px;height:460px;transform:translate(-50%,-50%);background:radial-gradient(circle,rgba(140,130,255,.2),transparent 68%);pointer-events:none}
.fm-lines{position:absolute;inset:0;z-index:1;pointer-events:none}
.fm-lines svg{width:100%;height:100%;display:block;overflow:visible}
.fm-line{fill:none;stroke-width:1.7px;vector-effect:non-scaling-stroke}
.fm-ssh-connected{stroke:#1f9d62}
.fm-ssh-stale{stroke:#e0a04a;stroke-dasharray:5 4}
.fm-ssh-unknown{stroke:#b7b4c9;stroke-dasharray:1.5 5;stroke-linecap:round}
.fm-dispatch{stroke:#6d8cff;stroke-dasharray:7 5}
.fm-gone{stroke:#c5c3d4;stroke-dasharray:1.5 6;stroke-linecap:round}
.fm-dot{stroke:none}
.fm-dot.fm-ssh-connected{fill:#1f9d62}
.fm-dot.fm-ssh-stale{fill:#e0a04a}
.fm-dot.fm-ssh-unknown{fill:#b7b4c9}
.fm-dot.fm-dispatch{fill:#6d8cff}
.fm-dot.fm-gone{fill:#c5c3d4}
.fm-hub{position:absolute;left:50%;top:50%;z-index:2;width:84px;height:84px;transform:translate(-50%,-50%);border-radius:50%;display:grid;place-items:center;background:radial-gradient(circle,#fff,#f3f0ff 72%);box-shadow:0 0 0 12px rgba(255,255,255,.72),0 0 0 26px rgba(196,186,255,.28)}
.fm-hub svg{width:42px;height:42px}
.fm-sr{position:absolute;width:1px;height:1px;padding:0;margin:-1px;overflow:hidden;clip:rect(0 0 0 0);white-space:nowrap;border:0}
.fm-queue-wrap{position:absolute;left:50%;top:calc(50% + 64px);transform:translateX(-50%);z-index:2}
.fm-queue{font-size:10px;font-weight:750;letter-spacing:.16em;text-transform:uppercase;color:#9a96ad;white-space:nowrap}
.fm-nodes{position:absolute;inset:0;z-index:3}
.fm-node{position:absolute;width:150px;transform:translate(-50%,-46px)}
.fm-drift{position:relative;width:92px;height:92px;margin:0 auto;animation:fm-drift 18s ease-in-out infinite;animation-delay:var(--delay,0s)}
@keyframes fm-drift{0%,100%{transform:translate(0,0)}50%{transform:translate(var(--dx,6px),var(--dy,-6px))}}
.fm-stage:hover .fm-drift,.fm-stage.is-paused .fm-drift{animation-play-state:paused}
.fm-node.is-down .fm-drift::before{content:"";position:absolute;inset:-12px;border:1.5px dashed #d5d2e2;border-radius:50%;pointer-events:none}
.fm-orb{width:92px;height:92px;padding:0;border-radius:50%;border:1px solid rgba(120,110,180,.14);background:#fff;box-shadow:0 12px 30px rgba(70,60,140,.1);display:grid;place-items:center;cursor:pointer}
.fm-orb svg{width:46px;height:46px}
.fm-node.is-down .fm-orb{opacity:.42;background:#f7f7fb;box-shadow:none}
.fm-count{position:absolute;top:-2px;right:-2px;z-index:2;min-width:22px;height:22px;padding:0 6px;border-radius:999px;border:2px solid #fff;background:#6d5efc;color:#fff;font-size:12px;font-weight:750;display:grid;place-items:center;box-shadow:0 4px 10px rgba(80,70,180,.28)}
.fm-count.is-risk{background:#e11d48;box-shadow:0 4px 10px rgba(225,29,72,.28)}
.fm-name{margin:8px auto 0;text-align:center;font-size:14px;font-weight:750;letter-spacing:-.02em;color:#241c3d;overflow-wrap:anywhere;width:fit-content;max-width:100%;padding:0 5px;background:#f4f5fb;border-radius:6px;position:relative;z-index:2}
.fm-os{text-align:center;font-size:11px;color:#8d89a3;width:fit-content;max-width:100%;margin:0 auto;padding:0 5px;background:#f4f5fb;border-radius:6px;position:relative;z-index:2}
.fm-node.is-down .fm-name,.fm-node.is-down .fm-os{color:#a29eb4}
.fm-badges{display:flex;flex-direction:column;align-items:center;gap:4px;margin-top:6px}
.fm-badge{display:inline-flex;align-items:center;gap:4px;border-radius:999px;padding:3px 8px;font-size:10px;font-weight:750;letter-spacing:.04em;white-space:nowrap}
.fm-badge.down{color:#e11d48;background:#ffe4ea}
.fm-badge.risk{color:#9a6700;background:#fff4d6}
.fm-badge.quiet{color:#6b657c;background:#eef0f6}
.fm-peek{display:none;position:absolute;left:50%;bottom:calc(100% + 10px);transform:translateX(-50%);width:190px;padding:10px 12px;border-radius:14px;background:#fff;box-shadow:0 12px 40px rgba(40,30,80,.14);text-align:left;z-index:5}
.fm-peek b{display:block;font-size:13px}
.fm-peek span{display:block;margin-top:2px;font-size:11px;color:#6b657c}
.fm-node.is-peek .fm-peek{display:block}
.fm-node:hover,.fm-node.is-peek{z-index:4}
.fm-orb:focus-visible,.fm-x:focus-visible{outline:2px solid #6d5efc;outline-offset:3px}
.fm-foot{max-width:1120px;margin:8px auto 0;display:flex;justify-content:space-between;align-items:flex-end;gap:18px}
.fm-legend{display:flex;flex-wrap:wrap;gap:10px 16px;align-items:center;font-size:10px;font-weight:750;letter-spacing:.12em;text-transform:uppercase;color:#8d89a3}
.fm-key{display:inline-flex;align-items:center;gap:6px}
.sw{width:28px;height:0;border-top-width:2px;border-top-style:dashed;display:inline-block}
.sw-dispatch{border-top-color:#6d8cff}
.sw-gone{border-top-color:#c5c3d4;border-top-style:dotted}
.sw-connected{border-top-color:#1f9d62;border-top-style:solid}
.sw-stale{border-top-color:#e0a04a}
.sw-unknown{border-top-color:#b7b4c9;border-top-style:dotted}
.fm-hint{font-family:"Iowan Old Style",Palatino,Georgia,serif;font-style:italic;font-size:14px;color:#8d89a3}
.fm-hint-narrow{display:none}
.fm-sheet{display:none;position:fixed;inset:0;z-index:30}
.fm-sheet.is-open{display:block}
.fm-backdrop{position:absolute;inset:0;z-index:0;background:#f4f5fb}
.fm-x{position:absolute;top:18px;right:18px;z-index:3;width:40px;height:40px;border:0;border-radius:50%;background:#fff;color:#1c1733;font-size:20px;cursor:pointer;box-shadow:0 6px 20px rgba(40,30,80,.08)}
.fm-panel{position:absolute;inset:0;z-index:1;overflow:auto;display:grid;grid-template-columns:minmax(260px,340px) minmax(0,1fr);gap:12px 56px;padding:64px 56px 40px;max-width:1080px;margin:0 auto;background:#f4f5fb}
.fm-ident-orb{position:relative;width:148px;height:148px;border-radius:50%;background:#fff;display:grid;place-items:center;box-shadow:0 16px 40px rgba(70,60,140,.1)}
.fm-ident-orb svg{width:74px;height:74px}
.fm-ident-orb.is-down{opacity:.55;background:#f7f7fb;box-shadow:none;outline:1.5px dashed #d5d2e2;outline-offset:10px}
.fm-ident-orb .fm-count{top:8px;right:8px}
.fm-ident-name{margin-top:18px;font-family:"Iowan Old Style",Palatino,Georgia,serif;font-size:48px;font-weight:560;letter-spacing:-.03em;line-height:1;color:#1b1533;overflow-wrap:anywhere}
.fm-ident-status{margin-top:8px;color:#8d89a3;font-size:14px}
.fm-ident-status.is-down{color:#e11d48}
.fm-kv{margin-top:22px;display:grid;grid-template-columns:1fr auto;gap:9px 16px;font-size:14px}
.fm-kv dt{color:#8d89a3}
.fm-kv dd{text-align:right;font-weight:650;color:#1c1733}
.fm-kv dd.is-down{color:#e11d48}
.fm-kv dd.is-closed{color:#b4233c}
.fm-alert{background:#fff7f4;border:1px solid #ffd7c8;border-radius:18px;padding:14px 16px}
.fm-alert-top{display:flex;gap:10px;align-items:flex-start}
.fm-alert-top p{color:#5c4a48;font-size:14px;line-height:1.45}
.fm-alert .fm-badge{flex:none;margin-top:2px}
.fm-rest{margin-top:10px;color:#6b5c58;font-size:14px;line-height:1.45}
.fm-lost{margin-top:10px;padding-top:10px;border-top:1px solid #ffd7c8;color:#9a6700;font-size:14px;line-height:1.45}
.fm-block{margin-top:22px}
.fm-block h3{font-size:11px;font-weight:750;letter-spacing:.14em;text-transform:uppercase;color:#8d89a3;margin-bottom:8px}
.fm-work{padding:12px 0;border-top:1px solid #eceaf3}
.fm-work-top{display:flex;align-items:baseline;gap:10px}
.fm-idx{color:#6d5efc;font-weight:750;font-size:13px}
.fm-work-top b{flex:1;min-width:0;font-size:16px;letter-spacing:-.02em}
.fm-risk-label{color:#e11d48;font-size:11px;font-weight:750;letter-spacing:.08em;text-transform:uppercase}
.fm-why{margin-top:6px;font-size:12px;color:#8d89a3}
.fm-why b{color:#3d3754;font-weight:650}
.fm-dirs{display:grid;grid-template-columns:1fr 1fr;gap:12px}
.fm-dir{padding-top:8px}
.fm-dir .k{display:block;font-size:11px;letter-spacing:.12em;text-transform:uppercase;color:#8d89a3;font-weight:750}
.fm-ssh-word{display:block;margin-top:4px;font-size:15px}
.fm-ssh-word.is-connected{color:#176b45}
.fm-ssh-word.is-stale{color:#9a6700}
.fm-ssh-word.is-unknown{color:#6b657c}
.fm-dir .s{display:block;margin-top:4px;font-size:12px;color:#8d89a3;line-height:1.4}
@media (hover:hover){.fm-node:hover .fm-peek{display:block}}
@media (max-width:760px){
.fm{padding:calc(16px + env(safe-area-inset-top)) 16px calc(20px + env(safe-area-inset-bottom))}
.fm-top{flex-direction:column;align-items:stretch;gap:0}
.fm-side{align-items:stretch;margin-top:18px}
.fm-metrics{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:8px}
.fm-age{grid-column:1 / -1;justify-content:flex-start}
.fm-metric{text-align:left;min-width:0}
.fm-metric b{font-size:34px}
.fm-title{font-size:34px}
.fm-sub{font-size:18px}
.fm-stage{height:520px;min-height:520px;margin-top:8px}
.fm-node{width:112px;transform:translate(-50%,-37px)}
.fm-drift,.fm-orb{width:74px;height:74px}
.fm-orb svg{width:36px;height:36px}
.fm-name{font-size:13px}
.fm-foot{flex-direction:column;align-items:flex-start}
.fm-hint-wide{display:none}
.fm-hint-narrow{display:block}
.fm-backdrop{background:rgba(28,23,51,.28)}
.fm-panel{inset:auto 0 0 0;left:0;right:0;width:100%;box-sizing:border-box;max-height:88vh;background:#fff;border-radius:28px 28px 0 0;box-shadow:0 -18px 50px rgba(40,30,80,.16);grid-template-columns:1fr;gap:6px;padding:22px 18px calc(24px + env(safe-area-inset-bottom));margin:0;max-width:none}
.fm-ident-head{padding-right:40px}
.fm-kv{width:100%;min-width:0}
.fm-ident-head{display:flex;align-items:center;gap:14px}
.fm-ident-orb{width:72px;height:72px;flex:none}
.fm-ident-orb svg{width:36px;height:36px}
.fm-ident-name{margin-top:0;font-size:32px}
.fm-x{top:12px;right:12px;background:#f4f5fb}
.fm-dirs{grid-template-columns:1fr}
}
@media (prefers-reduced-motion:reduce){.fm-drift{animation:none!important}}
</style>
</head>
<body class="fleet-light">
<div class="fm" id="fleet">
	<header class="fm-top">
		<div class="fm-lead">
			<div class="fm-brand">Fleet <span id="fm-pill" class="fm-pill"></span> <span id="fm-link" class="fm-link">Connecting</span></div>
			<h2 id="fm-title" class="fm-title">Reading the fleet.</h2>
			<p id="fm-sub" class="fm-sub"></p>
		</div>
		<div class="fm-side">
			<div id="fm-metrics" class="fm-metrics"></div>
		</div>
	</header>
	<div id="fm-banners" class="fm-banners"></div>
	<div id="fm-stage" class="fm-stage">
		<div id="fm-lines" class="fm-lines"></div>
		<div class="fm-hub"><span class="fm-sr">Hub</span><svg viewBox="0 0 48 48" aria-hidden="true"><circle cx="24" cy="11" r="3.2" fill="#6d5efc"/><circle cx="12" cy="34" r="3.2" fill="#6d5efc"/><circle cx="36" cy="34" r="3.2" fill="#6d5efc"/><path d="M22.2 13.4 14 31.2M25.8 13.4 34 31.2M15.2 34h17.6" fill="none" stroke="#6d5efc" stroke-width="1.6" stroke-linecap="round"/></svg></div>
		<div id="fm-queue" class="fm-queue-wrap"></div>
		<div id="fm-nodes" class="fm-nodes"></div>
	</div>
	<div class="fm-foot">
		<div class="fm-legend">
			<span class="fm-key"><i class="sw sw-dispatch"></i>Dispatching work</span>
			<span class="fm-key"><i class="sw sw-gone"></i>Gone dark</span>
			<span class="fm-key"><i class="sw sw-connected"></i>SSH connected</span>
			<span class="fm-key"><i class="sw sw-stale"></i>SSH stale, not live</span>
			<span class="fm-key"><i class="sw sw-unknown"></i>SSH unknown</span>
		</div>
		<p class="fm-hint fm-hint-wide">Hover to peek. Click to go deeper.</p>
		<p class="fm-hint fm-hint-narrow">Tap to peek. Tap again to go deeper.</p>
	</div>
	<div id="fm-sheet" class="fm-sheet"></div>
</div>
<div class="aurora"><i></i><i></i><i></i></div>
<div class="wrap">
	<header class="rise">
		<div class="brand">
			<div class="mark"><svg viewBox="0 0 24 24" fill="none" stroke="#5eead4" stroke-width="1.4"><path d="M12 5 5 18M12 5l7 13M5 18h14" opacity=".5"/><circle cx="12" cy="5" r="2.2" fill="#5eead4" stroke="none"/><circle cx="5" cy="18" r="2.2" fill="#7dd3fc" stroke="none"/><circle cx="19" cy="18" r="2.2" fill="#a78bfa" stroke="none"/></svg></div>
			<div><h1>Fleet</h1><div class="tagline">GJC nodes · task control</div></div>
		</div>
		<div class="live" id="live"><span class="dot"></span><span id="clock">Connecting</span></div>
	</header>
	<main>
		<section class="glass runtime rise" style="--i:1">
			<div class="eyebrow">Gajae Code Runtime · Hub</div>
			<div class="rt-row"><div class="rt-ver" id="rt-ver">—</div><div class="rt-age" id="rt-age"></div></div>
			<div class="chips">
				<span class="chip" id="rt-broker"><b></b><span>Broker</span></span>
				<span class="chip" id="rt-coord"><b></b><span>Coordinator</span></span>
				<span class="chip" id="rt-sess"><b></b><span>Session</span></span>
				<span class="chip" id="rt-cap"><b></b><span>Assigned</span></span>
			</div>
		</section>

		<div class="sec rise" style="--i:2"><h2>Pipeline</h2><span class="count" id="p-count"></span></div>
		<section class="glass pipe rise" style="--i:2">
			<div class="flow" id="flow"></div>
			<div class="outcome" id="outcome"></div>
			<p class="note">Unverified tasks have finished running but are waiting for supervisor verification. Verified does not mean deployed. State unknown is not a confirmed failure.</p>
		</section>
		<div class="list" id="tasks"><div class="skel"></div></div>

		<div class="sec rise" style="--i:3"><h2>Node allocation</h2><span class="count" id="n-count"></span></div>
		<div class="list nodes" id="nodes"><div class="skel"></div><div class="skel"></div></div>

		<div class="sec rise" style="--i:4"><h2>Sessions</h2><span class="count" id="s-count"></span></div>
		<div class="tabs" id="tabs"></div>
		<div class="list" id="sessions"><div class="skel"></div></div>
	</main>
	<footer class="rise" style="--i:5">Node resources every 2 s over an SSH stream · GJC responses and sessions measured every 30 s · task flow from the Fleet DB audit log</footer>
</div>
<script>
(function(){
	var $=function(id){return document.getElementById(id)};
	var esc=function(v){return String(v==null?'':v).replace(/[&<>"']/g,function(c){return{'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]})};
	var sig={},open={},folds={},tab=null,lastCheck=0,fails=0,last=null,isLive=false,lastMsg=0,wsOk=false,detailCache={},detailLoad={},detailError={},fleetSig='',sheetNode=null,peeked=null,sheetDetail={};
	var OS={darwin:'MAC',win32:'WIN',linux:'LNX'};
	var PHASE={queued:['warn','Queued'],preparing:['info','Preparing'],dispatching:['info','Dispatching'],active:['info','Running'],
		approval_required:['warn','Awaiting approval'],completed_unverified:['warn','Execution ended · awaiting supervisor verification'],succeeded:['ok','Verified · deployment separate'],
		failed:['bad','Failed'],blocked_unknown:['warn','State unknown · not a failure'],cancel_unknown:['warn','Cancel state unknown'],cancelled:['','Cancelled']};
	var EXPORT_REVIEW=['warn','Export incomplete · operator acceptance needed'];
	var RUN={preparing:1,dispatching:1,active:1},UNKNOWN={blocked_unknown:1,cancel_unknown:1};
	var SETTLE={failed_without_receipt:['bad','Failed · no execution receipt'],ended_without_receipt:['bad','Ended · no execution receipt · not a success']};
	function settleLabel(t){var s=SETTLE[t.settlement.kind]||['bad',t.settlement.kind];return t.lateReceipt?[s[0],s[1]+' · late receipt '+t.lateReceipt.status]:s}
	var DISPO={deployed:'Recorded as deployed · operator record, not verified by Fleet',superseded:'Superseded by a follow-up task · operator record, unverified discard','review-recorded':'Review result recorded · operator record, not verified by Fleet',discarded:'Discarded · operator record, unverified'};
	function unplaceable(t){return t.phase==='queued'&&!!t.placement&&t.placement.verdict==='unplaceable'}
	// result stage index matches dashboard.RESULT_STAGE_INDEX (result_saved); below that is collection stuck, not verify-wait.
	var RESULT_STAGE=5;
	function phaseLabel(t){if(unplaceable(t))return ['bad','Unplaceable · operator action needed'];if(t.phase==='archived'&&t.withdrawal)return ['mute','Archived · withdrawn by operator · never ran'];if(t.phase==='archived')return t.disposition?['mute','Archived · '+(DISPO[t.disposition.kind]||'operator record')]:['mute','Archived'];if(t.settlement&&t.phase==='failed')return settleLabel(t);if(t.phase==='completed_unverified'&&!t.executionTerminal)return t.reason==='execution_failure_reported_end_unproven'?['warn','Failure reported · end not confirmed · execution slot kept']:['warn','End not confirmed · execution slot kept'];if(t.phase==='completed_unverified'&&t.exportReview==='required')return EXPORT_REVIEW;if(t.phase==='completed_unverified'&&t.deliverable)return ['warn',t.deliverable.label];if(t.phase==='completed_unverified'&&t.executionTerminal&&(t.stageIndex==null||t.stageIndex<RESULT_STAGE))return ['warn','Execution ended · result not collected'];return PHASE[t.phase]||['info',t.phase]}
	function settleRows(t){if(!t.settlement)return '';var s=t.settlement,l=t.lateReceipt,h='<dt>Cause</dt><dd>'+esc(s.cause)+'</dd>';
		if(l){h+='<dt>Late receipt</dt><dd>'+esc(l.status)+' · <span class="mono">'+esc(String(l.digest).slice(0,12))+'</span> · '+esc(l.observedAt)+' · final result kept</dd>';
			if(l.acceptance)h+='<dt>Receipt acceptance</dt><dd>'+esc(l.acceptance.actor)+' · '+esc(l.acceptance.reason)+' · awaiting verifier</dd>';}
		else if(t.phase==='failed')h+='<dt>Late receipt watch</dt><dd>'+esc(s.lateObservationUntil)+' (deadline)</dd>';
		return h}
	var KIND={submitted:'Received',selection:'Node selected',reserved:'Node assigned',operation_intent:'Execution intent recorded',workspace_recorded:'Workspace prepared',
		session_recorded:'Session created',turn_recorded:'Turn started',observation:'State observed',abandoned_poll:'Query failed · observation not applied',stale_poll_failure:'Query failed · strictly held',
		daemon_note:'Recovery note',progress_stalled:'Progress stalled',progress_recovered:'Progress resumed',result_saved:'Result collected',verification_receipt:'Verification run',
		result_verified:'Verified',export_review_required:'Export review needed',incomplete_export_accepted:'Incomplete export accepted by operator',released:'Assignment released',unknown:'State unknown',unknown_reconciled:'Unknown resolved',blocked:'Blocked',cancel_requested:'Cancel requested',
		late_receipt_contradiction:'Late execution receipt · contradicts final result',late_receipt_conflict:'Late receipt mismatch',late_receipt_accepted:'Late receipt accepted · awaiting verifier',node_health_warning:'Warning: pinned assignment to unstable node',withdrawn:'Withdrawn from queue (operator)',
		output_head_created:'Commit creation proven (reviewable)',output_head_unproven:'Commit creation unproven (not reviewable)'};
	var KEYKIND={submitted:1,reserved:1,workspace_recorded:1,session_recorded:1,turn_recorded:1,result_saved:1,result_verified:1};
	var STATE={working:['ok','Working'],waiting_answer:['warn','Awaiting answer'],waiting_permission:['warn','Awaiting tool permission'],waiting_workflow:['warn','Awaiting workflow input'],idle:['info','Idle'],stale:['bad','No response'],unknown:['','Checking state'],ended:['','Ended']};
	var STATE_ORDER={waiting_workflow:0,waiting_answer:0,waiting_permission:1,working:2,stale:3,unknown:4,idle:5,ended:6};
	var REASON={node_capacity:'Slots full (earlier record)',global_capacity:'Global limit (earlier record)',resources_unknown:'No resource sample',resources_stale:'Resource sample stale',cpu_busy:'CPU busy',memory_low:'Low memory',disk_low:'Low disk',workspace_disk_unknown:'Workspace disk unknown',disabled:'Disabled',draining:'Draining',unreachable:'Unreachable',sdk_not_ready:'SDK not ready',model_not_ready:'Model not ready',repo_unavailable:'Repository not provided',manual_node_mismatch:'Not the designated node',os_mismatch:'OS mismatch',arch_mismatch:'Architecture mismatch',model_unavailable:'Model not provided',model_profile_unavailable:'Model profile not provided',
		node_unstable:'Node unstable',consecutive_observations:'Too few stable observations',decision_probe_required:'No measurement for this decision',no_history:'No node health record'};
	var HEALTH_DIM={reachable:'Coordinator reachability',brokerSessionListOk:'Broker session list',resourceSampleOk:'Resource sampling'};
	function reasonLabel(r){if(REASON[r])return REASON[r];if(HEALTH_DIM[r])return HEALTH_DIM[r]+' failed, recovering';if(String(r).indexOf('unobserved:')===0){var d=String(r).slice(11);return (HEALTH_DIM[d]||d)+' unobserved'}return r}
	var STAGES=['Received','Assigned','Prepared','Session','Running','Result','Verified'];

	function hms(iso){var d=new Date(iso);return isNaN(d)?'':d.toTimeString().slice(0,8)}
	function dur(ms){if(!(ms>=0))return '';var s=Math.round(ms/1000);if(s<60)return s+'s';var m=Math.floor(s/60);if(m<60)return m+'m '+(s%60)+'s';return Math.floor(m/60)+'h '+(m%60)+'m'}
	function ago(ms){if(!ms)return '';var s=Math.max(0,Math.round((Date.now()-ms)/1000));if(s<60)return s+'s ago';var m=Math.floor(s/60);if(m<60)return m+'m ago';var h=Math.floor(m/60);if(h<48)return h+'h ago';return Math.floor(h/24)+'d ago'}
	function chipEl(id,cls,label){var el=$(id);el.className='chip '+cls;el.lastElementChild.textContent=label}
	var RELEASED_UNCONFIRMED='Released by operator · session end not confirmed (may still be running on the node)';
	function chip(cls,label,lead){return '<span class="chip '+cls+'">'+(lead||'<b></b>')+'<span>'+esc(label)+'</span></span>'}
	function put(id,key,html){var s=JSON.stringify(key);if(sig[id]===s)return false;var el=$(id);if(sig[id]!==undefined)el.classList.add('settled');sig[id]=s;el.innerHTML=html;return true}

	function flowHtml(p){
		return p.stages.map(function(s){
			var cls=s.inFlight>0?'st on':s.reached>0?'st seen':'st';
			return '<div class="'+cls+'"><div class="n">'+s.inFlight+'</div><div class="l">'+esc(s.label)+'</div><div class="r">Total '+s.reached+'</div></div>';
		}).join('');
	}
	function outcomeHtml(d){
		var o=d.pipeline.outcome,s=d.summary;
		function c(cls,label,n){return '<span class="chip '+(n?cls:'mute')+'"><b></b><span>'+label+' '+n+'</span></span>'}
		return c('warn','Queued',s.queuedTasks-(s.unplaceableTasks||0))+(s.unplaceableTasks>0?c('bad','Unplaceable · operator action',s.unplaceableTasks):'')+c('info','Active',s.activeTasks)+c('warn','Awaiting approval',o.approval)+c('ok',PHASE.succeeded[1],o.succeeded)+
			c('warn',PHASE.completed_unverified[1],o.unverified)+c('warn','Execution ended · result not collected',o.resultMissing||0)+(o.unsettled>0?c('warn','Awaiting settlement',o.unsettled):'')+(o.reportsCollected!=null?c('warn','Report collected · not verification',o.reportsCollected)+c('warn','Operator-classified · report · not verification',o.reportsClassified):'')+(o.exportIncomplete>0?c('warn',EXPORT_REVIEW[1],o.exportIncomplete):'')+c('warn','Failed / state unknown',o.troubled)+c('','Cancelled',o.cancelled);
	}
	function stepsHtml(t){
		var h='';
		for(var i=0;i<7;i++){
			var cls='';
			if(i<=t.stageIndex)cls=(RUN[t.phase]&&i===t.stageIndex)?'now':'done';
			else if(i===t.stageIndex+1&&t.phase==='failed')cls='fail';
			else if(i===t.stageIndex+1&&(UNKNOWN[t.phase]||t.phase==='completed_unverified'||t.phase==='approval_required'||t.phase==='queued'))cls='wait';
			h+='<i class="'+cls+'" style="--s:'+i+'"></i>';
		}
		return h;
	}
	function taskHtml(t,i){
		var p=phaseLabel(t),t0=t.submittedAt?Date.parse(t.submittedAt):0;
		var total=t0&&t.lastEventAt?dur(Date.parse(t.lastEventAt)-t0):'';
		var expanded=!!open[t.id];
		var head='<div class="tk-head"><div class="tk-key">'+esc(t.title||t.key)+'</div>'+chip(p[0],p[1],RUN[t.phase]?'<span class="spin"></span>':'')+'<span class="caret"></span></div>'+
			'<div class="tk-sub"><b>'+(t.nodeId?esc(t.nodeId):'Unassigned')+'</b>'+(t.held?' · slot held':'')+(t.resourceReturn&&t.resourceReturn.state==='released_by_operator_unconfirmed'?' · '+RELEASED_UNCONFIRMED:'')+(t.submittedAt?' · '+hms(t.submittedAt)+' received':'')+(total?' · '+total:'')+'</div>'+
			'<div class="steps">'+stepsHtml(t)+'</div>';
		// Collapsed chrome only until expand: keeps live DOM small and defers fat selection/stages markup.
		if(!expanded){
			var deferredClosed=!t.timeline.length&&t.timelineOmitted>0,loadingClosed=!!detailLoad[t.id],errClosed=detailError[t.id];
			var closedHint=errClosed?'Failed to load history · '+esc(errClosed)+' · expand again to retry':loadingClosed?'Loading history…':deferredClosed?'Expand to load all '+t.timelineOmitted+' records':'';
			var attentionRows=(t.timelineOmitted&&t.timeline.length?'<li class=""><time></time><span>Earlier history: '+t.timelineOmitted+' omitted</span></li>':'')+t.timeline.map(function(e){
				var cls=KEYKIND[e.kind]?'key':e.kind==='blocked'||e.kind==='late_receipt_contradiction'||e.kind==='late_receipt_conflict'||e.kind==='abandoned_poll'||e.kind==='stale_poll_failure'?'bad':'';
				return '<li class="'+cls+'"><time>'+hms(e.at)+'</time><span>'+esc(KIND[e.kind]||e.kind)+(e.count>1?' ×'+e.count:'')+'</span>'+(e.detail?'<em>'+esc(e.detail)+'</em>':'')+'</li>';
			}).join('');
			var closedTl=(closedHint||attentionRows)?'<ul class="tl" style="margin:8px 0 0;padding:0 2px">'+(closedHint?'<li class="'+(errClosed?'bad':'')+'"><time></time><span>'+closedHint+'</span></li>':'')+attentionRows+'</ul>':'';
			return '<div class="glass tk rise" data-id="'+esc(t.id)+'" style="--i:'+Math.min(i,8)+'">'+head+closedTl+'</div>';
		}
		var labels=STAGES.map(function(l,k){var at=t.stages[k];return '<span class="'+(at?'hit':'')+'">'+l+(at&&t0?'<br>+'+dur(Date.parse(at)-t0):'')+'</span>'}).join('');
		var sel=t.selection,alloc='';
		if(sel){
			alloc='<dt>Selected</dt><dd>'+esc(sel.nodeId||'none')+(sel.globalFull?' · global limit reached':'')+'</dd>';
			alloc+='<dt>Excluded</dt><dd>'+(sel.exclusions&&sel.exclusions.length?sel.exclusions.map(function(x){return esc(x.nodeId)+' ('+x.reasons.map(function(r){return esc(reasonLabel(r))}).join(', ')+')'}).join(' · '):'none')+'</dd>';
		}
		if(t.placement){var pl=t.placement,near=pl.blocking[0];
			alloc+='<dt>Placement verdict</dt><dd>'+(pl.verdict==='unplaceable'?'Unplaceable · will not be placed until an operator changes settings':'Waiting for capacity · may clear on its own')+(near?' · '+esc(near.nodeId)+' ('+(pl.verdict==='unplaceable'?near.structural:near.reasons).map(function(r){return esc(reasonLabel(r))}).join(', ')+')':'')+'</dd>';
			alloc+='<dt>Verdict log</dt><dd>Rejected '+pl.rejections+' times · '+esc(pl.since)+' since · latest '+esc(pl.checkedAt)+'</dd><dt>Operator text</dt><dd>'+esc(pl.summary)+'</dd>';}
		var req=[];for(var k in t.required){var v=t.required[k];if(v!=null&&String(v)!=='')req.push(k+'='+(Array.isArray(v)?v.join(','):v))}
		alloc+='<dt>Requirements</dt><dd>'+(req.length?esc(req.join(' · ')):'none')+'</dd>';
		if(t.preferences.length)alloc+='<dt>Preferences</dt><dd>'+esc(t.preferences.join(' · '))+'</dd>';
		var ids='<dt>Key</dt><dd>'+esc(t.key)+'</dd><dt>Task</dt><dd class="mono">'+esc(t.id)+'</dd><dt>Requester</dt><dd>'+esc(t.caller)+'</dd>'+
			(t.sessionId?'<dt>Session</dt><dd class="mono">'+esc(t.sessionId)+'</dd>':'')+(t.resourceReturn?'<dt>Resource return</dt><dd>'+(t.resourceReturn.state==='returned'?'Returned · session end confirmed by the latest query':esc(RELEASED_UNCONFIRMED+' · released by '+t.resourceReturn.operator+' · reason '+t.resourceReturn.reason))+'</dd>':'')+(t.turnId?'<dt>Turn</dt><dd class="mono">'+esc(t.turnId)+'</dd>':'')+
			(t.resultStatus?'<dt>Result</dt><dd>'+(t.phase==='completed_unverified'?esc(p[1]):t.verified?PHASE.succeeded[1]:t.settlement?esc(settleLabel(t)[1]):t.executionTerminal?esc(t.resultStatus)+' · unverified':'Last observed '+esc(t.resultStatus)+' · end not confirmed')+'</dd>':'')+settleRows(t)+(t.reason?'<dt>Reason</dt><dd>'+esc(t.reason)+'</dd>':'');
		if(t.withdrawal)ids+='<dt>Withdrawal</dt><dd>'+esc(t.withdrawal.actor)+' · '+esc(t.withdrawal.reason)+' · '+esc(t.withdrawal.at)+' · nothing sent to the node</dd>';
		if(t.archivedFrom)ids+='<dt>State before archive</dt><dd>'+esc(t.archivedFrom.phase)+'</dd><dt>Original reason</dt><dd>'+esc(t.archivedFrom.reason||'none')+'</dd>';
		if(t.disposition){var d=t.disposition;ids+='<dt>Disposition</dt><dd>'+esc(DISPO[d.kind]||d.kind)+'</dd>'+(d.commit?'<dt>Commit (operator statement, unverified)</dt><dd class="mono">'+esc(d.commit)+'</dd>':'')+(d.supersededBy?'<dt>Superseding task</dt><dd class="mono">'+esc(d.supersededBy)+'</dd>':'')+(d.subject?'<dt>Review subject</dt><dd>'+esc(d.subject)+'</dd><dt>Verdict (operator record)</dt><dd>'+(d.verdict==='clean'?'no issues':'issues found')+'</dd>':'')+'<dt>Disposition reason</dt><dd>'+esc(d.reason)+'</dd><dt>Disposed by</dt><dd>'+esc(d.actor)+'</dd><dt>Disposed at</dt><dd>'+esc(d.at)+'</dd><dt>Meaning</dt><dd>operator record · not verified by Fleet (full record via show)</dd>';}
		var deferred=!t.timeline.length&&t.timelineOmitted>0,loading=!!detailLoad[t.id],err=detailError[t.id];
		var tlHint=err?'Failed to load history · '+esc(err)+' · expand again to retry':loading?'Loading history…':deferred?'Expand to load all '+t.timelineOmitted+' records':'';
		var tl=(tlHint?'<li class="'+(err?'bad':'')+'"><time></time><span>'+tlHint+'</span></li>':'')+
			(t.timelineOmitted&&t.timeline.length?'<li class=""><time></time><span>Earlier history: '+t.timelineOmitted+' omitted</span></li>':'')+t.timeline.map(function(e){
			var cls=KEYKIND[e.kind]?'key':e.kind==='blocked'||e.kind==='late_receipt_contradiction'||e.kind==='late_receipt_conflict'||e.kind==='abandoned_poll'||e.kind==='stale_poll_failure'?'bad':'';
			return '<li class="'+cls+'"><time>'+hms(e.at)+'</time><span>'+esc(KIND[e.kind]||e.kind)+(e.count>1?' ×'+e.count:'')+'</span>'+(e.detail?'<em>'+esc(e.detail)+'</em>':'')+'</li>';
		}).join('');
		return '<div class="glass tk rise open" data-id="'+esc(t.id)+'" style="--i:'+Math.min(i,8)+'">'+head+
			'<div class="more"><div><div class="steplabels">'+labels+'</div>'+
			'<div class="blk"><h3>Allocation</h3><dl class="kv">'+alloc+'</dl></div>'+
			'<div class="blk"><h3>Identity</h3><dl class="kv">'+ids+'</dl></div>'+
			'<div class="blk"><h3>History '+(deferred?t.timelineOmitted:t.timeline.length)+'</h3><ul class="tl">'+tl+'</ul></div></div></div></div>';
	}
	function fold(name,label,inner){
		var opened=!!folds[name];
		// Lazy: do not mount folded cards until the operator opens the section (DOM was ~46k with all cards).
		return '<button class="fold'+(opened?' open':'')+'" data-fold="'+name+'"><span>'+label+'</span><span class="caret"></span></button><div class="folded"><div>'+(opened?inner:'')+'</div></div>';
	}
	/* Immediate list: held/running/queued/approval/unknown/unverified, settlement/late-receipt attention,
	 * and any live attention timeline rows. Plain succeeded/failed/cancelled go in the lazy fold. */
	function needsImmediate(t){return !!(t.held||RUN[t.phase]||t.phase==='queued'||t.phase==='approval_required'||UNKNOWN[t.phase]||t.phase==='completed_unverified'||t.settlement||t.lateReceipt||(t.timeline&&t.timeline.length))}
	function isDone(t){return !needsImmediate(t)}
	function tasksHtml(tasks,archived,omit,omitArchived){
		if(!tasks.length&&!archived.length)return '<div class="empty">No tasks have been received in this hub DB yet</div>';
		var live=tasks.filter(function(t){return !isDone(t)}),done=tasks.filter(isDone);
		var h=live.length?live.map(taskHtml).join(''):'<div class="empty">No tasks in progress</div>';
		if(omit>0)h+='<div class="empty">Omitted '+omit+' older finished tasks from the list · held, active, queued, awaiting-verification and state-unknown tasks are all shown</div>';
		if(done.length)h+=fold('tasks','Result / state check tasks '+done.length,folds.tasks?done.map(taskHtml).join(''):'');
		if(archived.length)h+=fold('archived','Archived tasks '+archived.length+(omitArchived>0?' · '+omitArchived+' earlier omitted':''),folds.archived?archived.map(taskHtml).join(''):'');
		else if(omitArchived>0)h+='<div class="empty">'+omitArchived+' archived tasks omitted because of the list limit</div>';
		return h;
	}
	function withDetail(t){
		var d=detailCache[t.id];
		return d?Object.assign({},t,{timeline:d.timeline,timelineOmitted:d.timelineOmitted,stages:d.stages||t.stages,selection:d.selection!==undefined?d.selection:t.selection,title:d.title||t.title}):t;
	}
	// Do not key on timelineOmitted: live cards defer most rows (omitted>0) while /api/task returns the
	// full timeline (omitted 0). Including omitted made every WS refresh look stale and re-fetched forever.
	function detailStamp(t){return (t.lastEventAt||'')+'|'+(t.phase||'')+'|'+(t.held?'1':'0')}
	function needsLiveDetail(t){return !!(t.held||RUN[t.phase]||t.phase==='queued'||t.phase==='approval_required'||UNKNOWN[t.phase]||(t.phase==='completed_unverified'&&!t.executionTerminal))}
	function findTask(id){return (last&&last.tasks||[]).concat(last&&last.archivedTasks||[]).filter(function(t){return t.id===id})[0]}
	function loadDetail(id){
		if(!last||detailLoad[id])return;
		var row=findTask(id);if(!row)return;
		var stamp=detailStamp(row),cached=detailCache[id];
		if(cached&&cached.stamp===stamp&&!detailError[id])return;
		if(!row.timeline.length&&!(row.timelineOmitted>0)&&cached)return;
		detailLoad[id]=1;delete detailError[id];render(last);
		fetch('/api/task/'+encodeURIComponent(id),{cache:'no-store'}).then(function(r){
			if(!r.ok)throw new Error('Server response '+r.status);
			return r.json();
		}).then(function(t){
			detailCache[id]={timeline:t.timeline||[],timelineOmitted:t.timelineOmitted||0,stages:t.stages,selection:t.selection,title:t.title,stamp:detailStamp(Object.assign({},row,{lastEventAt:t.lastEventAt,phase:t.phase,held:t.held}))};
			delete detailLoad[id];delete detailError[id];if(last)render(last);
		}).catch(function(err){
			delete detailLoad[id];
			detailError[id]=err&&err.message?String(err.message):'Request failed';
			if(last)render(last);
		});
	}
	function refreshOpenDetails(){
		if(!last)return;
		Object.keys(open).forEach(function(id){
			if(!open[id])return;
			if(detailError[id])return; // keep the fail banner until the operator clicks to retry
			var row=findTask(id);if(!row)return;
			if(!detailCache[id]||needsLiveDetail(row))loadDetail(id);
		});
	}
	function probeChip(n){
		var p=n.probe;
		if(!p)return chip('','Checking','<span class="spin"></span>');
		if(!p.probed)return p.resources&&p.resources.ok?chip('info','Host responding'):chip('','Not sampled');
		if(!p.ok)return chip('bad','No response');
		return chip('ok','Response '+(p.elapsedMs!=null?(p.elapsedMs/1000).toFixed(1)+'s':''));
	}
	function gb(n){return n>=1099511627776?(n/1099511627776).toFixed(1)+'TB':(n/1073741824).toFixed(n>=10737418240?0:1)+'GB'}
	function meter(label,pct,text,m){
		var w=Math.max(0,Math.min(100,pct||0)),cls=w>=90?' hot':w>=75?' warn':'';
		return '<div class="res-row'+cls+'" data-m="'+m+'"><label>'+label+'</label><div class="bar"><u style="width:'+w.toFixed(1)+'%"></u></div><span>'+text+'</span></div>';
	}
	function resHtml(n){
		var r=n.resources;
		if(!r)return isLive?'<div class="res"><div class="skel" style="height:58px;border-radius:10px"></div></div>':'';
		if(!r.ok)return '<div class="meta" style="margin-bottom:10px"><b>Resources</b> '+esc(r.error||'Measurement failed')+'</div>';
		var cores=' <small>/ '+(r.physicalCores!=null?r.physicalCores+' cores · ':'cores unknown · ')+(r.threads||r.cores)+'threads</small>';
		var cpu=(r.cpuPct==null?'Measuring':Math.round(r.cpuPct)+'%')+(r.load1!=null?' <small>· load '+r.load1.toFixed(2)+'</small>':'')+cores;
		var h=meter('CPU',r.cpuPct,cpu,'cpu');
		if(r.memTotal)h+=meter('Memory',r.memUsed/r.memTotal*100,gb(r.memUsed)+' <small>/ '+gb(r.memTotal)+(r.memReclaimed?' · host reclaimed '+gb(r.memReclaimed):'')+'</small>','mem');
		(r.disks||[]).forEach(function(d,i){h+=meter('Disk <small>'+esc(d.path)+'</small>',d.used/d.total*100,gb(d.total-d.used)+' free <small>/ '+gb(d.total)+'</small>','disk'+i)});
		return '<div class="res">'+h+'</div>';
	}
	/* Update a node's meters in place so bars slide to the new value instead of being rebuilt. */
	function applyRes(n){
		var all=document.querySelectorAll('#nodes [data-res]'),el=null;
		for(var i=0;i<all.length;i++)if(all[i].getAttribute('data-res')===n.id)el=all[i];
		if(!el)return;
		var html=resHtml(n);
		if(el.__html===html)return;
		el.__html=html;
		var tmp=document.createElement('div');tmp.innerHTML=html;
		var next=tmp.querySelectorAll('.res-row'),cur=el.querySelectorAll('.res-row');
		if(!next.length||next.length!==cur.length){el.innerHTML=html;return}
		for(var k=0;k<next.length;k++){
			cur[k].className=next[k].className;
			cur[k].querySelector('u').style.width=next[k].querySelector('u').style.width;
			cur[k].querySelector('span').innerHTML=next[k].querySelector('span').innerHTML;
			cur[k].querySelector('label').innerHTML=next[k].querySelector('label').innerHTML;
		}
	}
	function nodeHtml(n,i){
		var a=n.admission,adm;
		var idle=n.heldNotRunning>0?' · unreturned <b>'+n.heldNotRunning+'</b>':'';
		if(!a)adm='<div class="adm"><i></i><span>Resource sampling off · held <b>'+n.currentLoad+'</b>'+idle+'</span></div>';
		else adm='<div class="adm '+(a.open?'open':'hold')+'"><i></i><span>'+(a.open?'<b>New assignments open</b>':'<b>New assignments held</b> · '+esc(a.reasons.map(function(r){return reasonLabel(r)}).join(', ')))+' · held <b>'+n.currentLoad+'</b>'+idle+'</span></div>';
		var state=!n.enabled?'Disabled':n.draining?'Draining':'';
		var hold=n.holding.length?'<div class="hold">'+n.holding.map(function(t){var p=phaseLabel(t);return chip(p[0],t.key+' · '+p[1],RUN[t.phase]?'<span class="spin"></span>':'')}).join('')+'</div>':'';
		var unconfirmed=(n.possiblyRunning||[]).length?'<div class="hold">'+n.possiblyRunning.map(function(t){return chip('warn',t.key+' · '+RELEASED_UNCONFIRMED)}).join('')+'</div>':'';
		var ex=[];for(var r in n.exclusions)ex.push(esc(reasonLabel(r))+' ×'+n.exclusions[r]);
		var h=n.health,nh='';
		if(h)nh='<div class="adm nh '+(h.stable?'open':'hold')+'"><i></i><span>'+(h.stable?'<b>Node stable</b>':'<b>Node unstable</b> · '+esc(h.failingDimensions.map(reasonLabel).join(', ')))+' · stable observations <b>'+h.consecutiveGood+'/'+h.required+'</b>'+
			(h.lastFailure?' · last failure '+esc(ago(h.lastFailure.at)):'')+' · '+(h.gating==='enforce'?'applied to auto-assignment':'monitoring only · not applied to auto-assignment')+
			((h.neverObservable||[]).length?' · <b>'+esc(h.neverObservable.map(function(d){return HEALTH_DIM[d]||d}).join(', '))+' unobservable</b> · permanently excluded from auto-assignment once applied':'')+'</span></div>';
		var p=n.probe,meta='';
		if(p&&p.ok)meta+='<b>Measured</b> '+esc(p.version||'')+(p.sessionsOk?' · sessions '+p.liveSessions+' active / '+p.totalSessions:p.sessionsError?' · session query failed: '+esc(p.sessionsError):'')+'<br>';
		else if(p&&p.error)meta+='<b>GJC</b> '+esc(p.error)+'<br>';
		meta+='<b>Registered</b> SDK '+(n.sdkReady?'ready':'not ready')+' · model '+(n.modelReady?'ready':'not ready')+(state?' · '+state:'')+
			(n.modelProfiles.length?'<br><b>Profiles</b> '+esc(n.modelProfiles.join(', ')):'')+(ex.length?'<br><b>Excluded</b> '+ex.join(' · '):'');
		return '<div class="glass nd rise" style="--i:'+i+'">'+
			'<div class="nd-top"><div class="os">'+esc(OS[n.os]||n.os)+'</div><div style="min-width:0"><div class="node-id">'+esc(n.id)+'</div><div class="node-sub">'+esc(n.os)+' · '+esc(n.arch)+'</div></div>'+probeChip(n)+'</div>'+
			adm+nh+hold+unconfirmed+'<div data-res="'+esc(n.id)+'">'+resHtml(n)+'</div>'+
			'<div class="stats"><div><b>'+n.assignedTotal+'</b><small>Total assigned</small></div><div><b>'+n.succeeded+'</b><small>'+PHASE.succeeded[1]+'</small></div><div><b>'+n.troubled+'</b><small>Failed / state unknown</small></div></div>'+
			'<div class="meta">'+meta+'</div></div>';
	}
	function sessHtml(n){
		var p=n.probe;
		if(!p)return '<div class="skel"></div>';
		if(!p.probed)return '<div class="empty">Sessions were not queried — '+esc(p.error||'')+'</div>';
		if(!p.ok)return '<div class="empty">No node response — '+esc(p.error||'')+'</div>';
		if(!p.sessionsOk)return '<div class="empty">Session query failed — '+esc(p.sessionsError||'')+'</div>';
		if(!p.sessions.length)return '<div class="empty">No sessions</div>';
		function row(s,i){
			var title=s.taskTitle||s.taskKey||s.title,dir=String(s.cwd||'').split(/[\\\\/]/).filter(Boolean).slice(-2).join('/').replace(/([0-9a-f]{8})-[0-9a-f-]{27,}/g,'$1…');
			var st=STATE[s.state]||null;
			return '<div class="glass ss rise'+(s.live?' live':'')+(s.state?' st-'+esc(s.state):'')+'" style="--i:'+Math.min(i,8)+'"><span class="lamp"></span><div class="ss-main">'+
				'<div class="ss-title'+(title?'':' none')+'">'+esc(title||'No conversation yet')+'</div>'+
				'<div class="ss-sub">'+esc(dir||'(no path)')+'</div></div>'+
				(s.live&&st?chip(st[0],st[1]+(s.pending>1?' '+s.pending:''),s.state==='working'?'<span class="spin"></span>':''):'')+
				(s.taskKey?chip('info','Fleet'):'')+'<span class="ss-age">'+ago(s.lastHeartbeatAt)+'</span></div>';
		}
		var live=p.sessions.filter(function(s){return s.live}).sort(function(a,b){return (STATE_ORDER[a.state]??9)-(STATE_ORDER[b.state]??9)}),ended=p.sessions.filter(function(s){return !s.live});
		var h=live.length?live.map(row).join(''):'<div class="empty">No active sessions</div>';
		var rest=p.totalSessions-p.liveSessions;
		if(ended.length)h+=fold('sess','Ended sessions '+rest+(rest>ended.length?' · showing latest '+ended.length+' only':''),ended.map(row).join(''));
		return h;
	}

	/* Fleet map: draw only fields the state payload already has. Never open SSH, probes, or a second socket. */
	var MAC='<svg viewBox="0 0 48 48" aria-hidden="true"><rect x="7" y="8" width="34" height="22" rx="3" fill="none" stroke="#2c2848" stroke-width="1.7"/><path d="M18 36h12M24 30v6" fill="none" stroke="#2c2848" stroke-width="1.7" stroke-linecap="round"/></svg>';
	var WIN='<svg viewBox="0 0 48 48" aria-hidden="true"><path fill="#2c2848" d="M8 10.5 20 8.8v13H8v-11.3zm14-2.2L40 6v15.8H22V8.3zM8 24.2h12V38L8 36.2V24.2zm14 .2H40V42l-18-2.4V24.4z"/></svg>';
	var TUX='<svg viewBox="0 0 48 48" aria-hidden="true"><ellipse cx="24" cy="27" rx="12" ry="14" fill="#2a2740"/><ellipse cx="24" cy="30" rx="7" ry="8" fill="#fff"/><circle cx="20" cy="22" r="1.4" fill="#fff"/><circle cx="28" cy="22" r="1.4" fill="#fff"/><ellipse cx="24" cy="26.5" rx="2.1" ry="1.3" fill="#f5a524"/><ellipse cx="13.5" cy="30" rx="4" ry="2.2" fill="#2a2740"/><ellipse cx="34.5" cy="30" rx="4" ry="2.2" fill="#2a2740"/><ellipse cx="18" cy="40" rx="4" ry="1.5" fill="#f5a524"/><ellipse cx="30" cy="40" rx="4" ry="1.5" fill="#f5a524"/></svg>';
	var GENERIC='<svg viewBox="0 0 48 48" aria-hidden="true"><circle cx="24" cy="24" r="8" fill="none" stroke="#2c2848" stroke-width="1.7"/></svg>';
	var OSNAME={darwin:'macOS',win32:'Windows',linux:'Linux'};
	var BUBBLE=['#5b6cff','#6d5efc','#0f9f6e','#7c6cf0'];
	var DRIFT=[[7,-6],[-5,8],[6,5],[-8,-4],[4,-7],[-6,3],[8,2],[-3,7]];
	var EYES={failed:1,needs_confirmation:1,approval_required:1,unplaceable:1,collect_result:1,verify_result:1};
	var ATTN={running:'In flight',queued:'Queued',failed:'Failed',needs_confirmation:'At risk',approval_required:'Needs approval',unplaceable:'Unplaceable',collect_result:'Collect result',verify_result:'Verify result',settled:'Settled'};
	function osIcon(os){if(os==='darwin')return MAC;if(os==='win32')return WIN;if(os==='linux')return TUX;return GENERIC}
	function osPretty(n){return (OSNAME[n.os]||n.os||'Unknown')+' · '+(n.arch||'unknown')}
	function num(v){return typeof v==='number'&&isFinite(v)?v:0}
	function plural(n,word){return n+' '+word+(n===1?'':'s')}
	function layoutMobile(){if(typeof matchMedia!=='function')return false;try{return matchMedia('(max-width: 760px)').matches}catch(e){return false}}
	function coarse(){if(typeof matchMedia!=='function')return false;try{return matchMedia('(max-width: 760px)').matches||matchMedia('(pointer: coarse)').matches}catch(e){return false}}
	function nodeDown(n){if(!n||typeof n.id!=='string')return false;if(n.reachable===false)return true;var p=n.probe;return !!(p&&p.probed&&p.ok===false)}
	function taskRisk(t){if(!t)return false;if(t.attention)return t.attention==='needs_confirmation';return t.phase==='blocked_unknown'||t.phase==='cancel_unknown'}
	function taskEyes(t){if(!t)return false;if(t.attention)return !!EYES[t.attention];if(t.phase==='failed'||t.phase==='blocked_unknown'||t.phase==='cancel_unknown'||t.phase==='approval_required'||t.phase==='completed_unverified')return true;return t.phase==='queued'&&!!(t.placement&&t.placement.verdict==='unplaceable')}
	function tasksFor(d,id){return (d.tasks||[]).filter(function(t){return t&&t.nodeId===id})}
	function riskCount(d,n){return assigned(d,n).filter(taskRisk).length}
	function linkFor(d,id){var links=d.sshLinks||[];for(var i=0;i<links.length;i++)if(links[i]&&links[i].nodeId===id)return links[i];return null}
	function dirStatus(dir){var s=dir&&dir.status;if(s==='observed'||s==='stale')return s;return 'not_checked'}
	function sshClass(status){if(status==='observed')return 'fm-ssh-connected';if(status==='stale')return 'fm-ssh-stale';return 'fm-ssh-unknown'}
	function sshWords(status){if(status==='observed')return 'Connected';if(status==='stale')return 'Stale';return 'Unknown'}
	function sshShort(status){if(status==='observed')return 'Connected';if(status==='stale')return 'Stale, not live';return 'Unknown'}
	function sshWordClass(status){if(status==='observed')return 'is-connected';if(status==='stale')return 'is-stale';return 'is-unknown'}
	function points(count,mobile){var start=mobile?-Math.PI/2:-3*Math.PI/4,rx=mobile?33:36,ry=mobile?34:30,out=[];for(var i=0;i<count;i++){var ang=start+i*2*Math.PI/Math.max(count,1);out.push({x:50+Math.cos(ang)*rx,y:50+Math.sin(ang)*ry})}return out}
	function nfmt(v){return (Math.round(v*100)/100).toFixed(2)}
	function shorten(x1,y1,x2,y2,a,b){var dx=x2-x1,dy=y2-y1,len=Math.sqrt(dx*dx+dy*dy)||1;if(a+b>len*0.62){var scale=len*0.62/(a+b);a*=scale;b*=scale}return {x1:x1+dx/len*a,y1:y1+dy/len*a,x2:x2-dx/len*b,y2:y2-dy/len*b}}
	function arc(x1,y1,x2,y2,bend){var mx=(x1+x2)/2,my=(y1+y2)/2,dx=x2-x1,dy=y2-y1,len=Math.sqrt(dx*dx+dy*dy)||1,cx=mx+(-dy/len)*bend,cy=my+(dx/len)*bend;return {d:'M'+nfmt(x1)+' '+nfmt(y1)+' Q '+nfmt(cx)+' '+nfmt(cy)+' '+nfmt(x2)+' '+nfmt(y2),cx:cx,cy:cy,x1:x1,y1:y1,x2:x2,y2:y2}}
	function qMid(a){var t=0.55,u=1-t;return {x:u*u*a.x1+2*u*t*a.cx+t*t*a.x2,y:u*u*a.y1+2*u*t*a.cy+t*t*a.y2}}
	function stageSize(){var el=$('fm-stage'),w=1000,h=560;if(el&&typeof el.getBoundingClientRect==='function'){var r=el.getBoundingClientRect();if(r&&r.width>80&&r.height>80){w=r.width;h=r.height}}return {w:Math.round(w),h:Math.round(h)}}
	function drawLine(mark,attrs,bend,xPct,yPct,size){var narrow=size.w<760,hubTrim=narrow?46:64,nodeTrim=narrow?34:50,bow=narrow?bend*0.45:bend,x2=xPct/100*size.w,y2=yPct/100*size.h,s=shorten(size.w/2,size.h/2,x2,y2,hubTrim,nodeTrim),a=arc(s.x1,s.y1,s.x2,s.y2,bow),p=qMid(a);return '<path class="fm-line '+mark+'" '+attrs+' d="'+a.d+'"/>'+'<circle class="fm-dot '+mark+'" cx="'+nfmt(p.x)+'" cy="'+nfmt(p.y)+'" r="3.2"/>'}
	function attentionLabel(t){if(t.attention&&ATTN[t.attention])return ATTN[t.attention];if(taskRisk(t))return 'At risk';if(t.phase==='active'||t.phase==='preparing'||t.phase==='dispatching')return 'In flight';if(t.phase==='queued')return 'Queued';return 'Task'}
	function workName(t){if(t.title)return String(t.title);if(t.key)return String(t.key);return 'Held work'}
	function lostCopy(t){var name=t.key||t.title;if(!name)return 'A task on this node stays held. Its outcome is unknown, so it stays held for you. Nothing is re-sent or re-placed.';return String(name)+' stays held. Its outcome is unknown, so it stays held for you. Nothing is re-sent or re-placed.'}
	function taskReason(t){if(t.selection&&t.selection.reason)return t.selection.reason;var extra=t.id&&sheetDetail[t.id];return extra&&extra.reason}
	function whyBits(t){var bits=[];if(t.required&&typeof t.required.nodeId==='string'&&t.required.nodeId)bits.push('Input names '+t.required.nodeId);var reason=taskReason(t);if(reason)bits.push(reasonLabel(reason));return bits}
	function assigned(d,n){var tasks=tasksFor(d,n.id).slice(),seen={};tasks.forEach(function(t){if(t.id)seen[t.id]=1});(n.holding||[]).forEach(function(h){if(!h||(h.id&&seen[h.id]))return;tasks.push(h)});(n.possiblyRunning||[]).forEach(function(h){if(!h||(h.id&&seen[h.id]))return;tasks.push({id:h.id,key:h.key,phase:'active',held:false,possibly:true})});return tasks}
	function probeStamp(n){var p=n.probe;if(!p||p.probed!==true||p.ok!==false||typeof p.checkedAt!=='string'||!p.checkedAt)return NaN;var ms=Date.parse(p.checkedAt);return isNaN(ms)?NaN:ms}
	function spanAge(ms){var s=Math.max(0,Math.round((Date.now()-ms)/1000));if(s<60)return s+'s';var m=Math.floor(s/60);if(m<60)return m+' min';var h=Math.floor(m/60);if(h<48)return h+' h';return Math.floor(h/24)+' d'}
	function clock(sec){sec=Math.max(0,Math.round(sec));var m=Math.floor(sec/60),s=sec%60;return m+':'+(s<10?'0':'')+s}
	function leaseNums(d){var lease=d&&d.hubLease;if(!lease||typeof lease.remainingSeconds!=='number'||!isFinite(lease.remainingSeconds))return null;return lease}
	function headline(nodes,downCount,flying){var up=nodes.length-downCount;if(!nodes.length)return {pill:'Empty',mode:'',title:'No nodes registered.',sub:'Nodes appear here when the hub has them.'};if(downCount&&(up>0||flying>0))return {pill:'Degraded',mode:'',title:'Degraded, <em>still running.</em>',sub:'<em>'+plural(flying,'task')+' in flight</em>, '+plural(downCount,'node')+' down'};if(downCount)return {pill:'Unreachable',mode:'bad',title:'Nodes unreachable.',sub:plural(downCount,'node')+' not answering'};return {pill:'Running',mode:'ok',title:'Fleet running.',sub:'<em>'+plural(flying,'task')+' in flight</em>'}}
	function fleetKey(d){var mobile=layoutMobile(),box=stageSize();var nodes=(d.nodes||[]).map(function(n){return [n&&n.id,n&&n.os,n&&n.arch,n&&n.reachable,n&&n.enabled,n&&n.draining,n&&n.currentLoad,n&&n.heldNotRunning,n&&n.probe&&[n.probe.ok,n.probe.probed],n&&n.succeeded,n&&n.troubled,n&&n.assignedTotal]});var tasks=(d.tasks||[]).map(function(t){return [t&&t.id,t&&t.nodeId,t&&t.phase,t&&t.attention,t&&t.key,t&&t.title,t&&t.held,t&&t.selection&&t.selection.reason,t&&t.required&&t.required.nodeId]});var links=(d.sshLinks||[]).map(function(x){return [x&&x.nodeId,x&&x.hubToNode&&x.hubToNode.status,x&&x.nodeToHub&&x.nodeToHub.status]});var lease=leaseNums(d);return JSON.stringify({nodes:nodes,tasks:tasks,links:links,active:d.summary&&d.summary.activeTasks,queued:d.summary&&d.summary.queuedTasks,lease:lease&&[lease.remainingSeconds,lease.renewedSecondsAgo],age:typeof d.healthDataAgeSeconds==='number'?d.healthDataAgeSeconds:null,peek:peeked,mobile:mobile,box:box})}
	function paintFleet(d){
		var nodes=(d.nodes||[]).filter(function(n){return n&&typeof n.id==='string'&&n.id});
		var summary=d.summary||{};
		var flying=num(summary.activeTasks),queued=num(summary.queuedTasks);
		var downCount=nodes.filter(nodeDown).length;
		var head=headline(nodes,downCount,flying);
		var eyes=(d.tasks||[]).filter(taskEyes).length;
		var pill=$('fm-pill');pill.className='fm-pill'+(head.mode?' is-'+head.mode:'');pill.innerHTML='<i></i><span>'+esc(head.pill)+'</span>';
		$('fm-title').innerHTML=head.title;
		$('fm-sub').innerHTML=head.sub;
		var metrics='<div class="fm-metric"><span class="k">In flight</span><b>'+flying+'</b></div>'+'<div class="fm-metric"><span class="k">Queued</span><b>'+queued+'</b></div>'+'<div class="fm-metric'+(eyes>0?' is-alert':'')+'"><span class="k">Needs eyes</span><b>'+eyes+'</b></div>';
		if(typeof d.healthDataAgeSeconds==='number'&&isFinite(d.healthDataAgeSeconds))metrics+='<div class="fm-age"><i></i>Health data stale <b>'+Math.max(0,Math.round(d.healthDataAgeSeconds))+'s old</b></div>';
		$('fm-metrics').innerHTML=metrics;
		var banners='',lease=leaseNums(d);
		if(lease){var renewed=typeof lease.renewedSecondsAgo==='number'&&isFinite(lease.renewedSecondsAgo)?'Renewed '+Math.max(0,Math.round(lease.renewedSecondsAgo))+'s ago. ':'';banners='<div class="fm-lease"><div><b>Hub lease expiring</b><p>'+esc(renewed)+'A standby can take over once it lapses.</p></div><div class="fm-clock">'+clock(lease.remainingSeconds)+'</div></div>'}
		$('fm-banners').innerHTML=banners;
		$('fm-queue').innerHTML=queued>0?'<span class="fm-queue">Queue · '+queued+' waiting</span>':'';
		var mobile=layoutMobile(),pts=points(nodes.length,mobile),size=stageSize(),svg='<svg viewBox="0 0 '+size.w+' '+size.h+'" width="100%" height="100%" preserveAspectRatio="none">',html='';
		nodes.forEach(function(n,i){
			var pt=pts[i],down=nodeDown(n),risk=riskCount(d,n),load=typeof n.currentLoad==='number'?n.currentLoad:0;
			var link=linkFor(d,n.id),outS=link?dirStatus(link.hubToNode):'not_checked',inS=link?dirStatus(link.nodeToHub):'not_checked';
			var bubble=down&&risk>0?risk:load,drift=DRIFT[i%DRIFT.length];
			if(load>0)svg+=drawLine('fm-dispatch','data-kind="dispatch" data-link="'+esc(n.id)+'"',28,pt.x,pt.y,size);
			if(down)svg+=drawLine('fm-gone','data-kind="gone" data-link="'+esc(n.id)+'"',-28,pt.x,pt.y,size);
			if(link){
				svg+=drawLine(sshClass(outS),'data-kind="ssh" data-dir="hub-to-node" data-link="'+esc(n.id)+'" data-status="'+outS+'"',12,pt.x,pt.y,size);
				svg+=drawLine(sshClass(inS),'data-kind="ssh" data-dir="node-to-hub" data-link="'+esc(n.id)+'" data-status="'+inS+'"',-12,pt.x,pt.y,size);
			}
			var count=bubble>0?'<span class="fm-count'+(down&&risk>0?' is-risk':'')+'"'+(down&&risk>0?'':' style="background:'+BUBBLE[i%BUBBLE.length]+'"')+'>'+bubble+'</span>':'';
			var badges='';
			if(down)badges+='<span class="fm-badge down">Down · unreachable</span>';
			else if(n.enabled===false)badges+='<span class="fm-badge quiet">Disabled</span>';
			else if(n.draining)badges+='<span class="fm-badge quiet">Draining</span>';
			if(risk>0)badges+='<span class="fm-badge risk">'+risk+' task'+(risk===1?'':'s')+' at risk</span>';
			html+='<div class="fm-node'+(down?' is-down':' is-up')+(peeked===n.id?' is-peek':'')+'" data-node="'+esc(n.id)+'" data-down="'+(down?'1':'0')+'" data-inflight="'+load+'" style="left:'+nfmt(pt.x)+'%;top:'+nfmt(pt.y)+'%">'+
				'<div class="fm-peek"><b>'+esc(n.id)+'</b><span>'+esc(osPretty(n))+'</span><span>SSH out · '+esc(sshShort(outS))+'</span><span>SSH in · '+esc(sshShort(inS))+'</span><span>'+load+' running</span></div>'+
				'<div class="fm-drift" style="--dx:'+drift[0]+'px;--dy:'+drift[1]+'px;--delay:'+(-i*2.4)+'s"><button type="button" class="fm-orb" aria-label="Open '+esc(n.id)+'">'+osIcon(n.os)+'</button>'+count+'</div>'+
				'<div class="fm-name">'+esc(n.id)+'</div><div class="fm-os">'+esc(osPretty(n))+'</div>'+(badges?'<div class="fm-badges">'+badges+'</div>':'')+'</div>';
		});
		svg+='</svg>';
		$('fm-lines').innerHTML=nodes.length?svg:'';
		$('fm-nodes').innerHTML=html||'<p class="fm-os" style="position:absolute;left:50%;top:68%;transform:translateX(-50%)">No nodes registered</p>';
	}
	function sshDetail(dir,status,inbound,down){
		var bits=[];
		if(status==='not_checked')bits.push('Not checked');
		if(status==='stale')bits.push('Not a live connection');
		if(status==='observed')bits.push(inbound?'Fresh node-to-hub observation':'Fresh hub-to-node observation');
		if(inbound&&status!=='observed')bits.push('No reverse SSH is claimed');
		if(down&&status!=='observed')bits.push('Node is dark, no probe');
		if(dir&&typeof dir.checkedAt==='string'&&dir.checkedAt){var ms=Date.parse(dir.checkedAt);if(!isNaN(ms))bits.push('Checked '+ago(ms))}
		return bits.join('. ');
	}
	function kvRow(label,value,cls){return '<dt>'+esc(label)+'</dt><dd'+(cls?' class="'+cls+'"':'')+'>'+esc(value)+'</dd>'}
	function newWork(n){if(!n.admission)return '';if(n.admission.open)return 'Open';var reasons=(n.admission.reasons||[]).map(reasonLabel);if(n.reachable===false||reasons.indexOf('Unreachable')!==-1)return 'Closed, unreachable';return reasons.length?'Closed, '+reasons.join(', '):'Closed'}
	function healthLine(n,down){if(down)return 'Down, unreachable';if(n.health&&n.health.stable===true)return 'Stable';if(n.health&&n.health.stable===false)return 'Unstable';if(n.probe&&n.probe.ok)return 'Responding';if(n.probe&&n.probe.probed===false)return 'Not sampled';return 'No probe yet'}
	function readyLine(n){if(n.sdkReady&&n.modelReady)return 'Ready';if(n.sdkReady===false&&n.modelReady===false)return 'Not ready';if(n.sdkReady===false)return 'SDK not ready';if(n.modelReady===false)return 'Model not ready';return ''}
	function sheetHtml(d,n){
		var down=nodeDown(n),risk=riskCount(d,n),load=typeof n.currentLoad==='number'?n.currentLoad:0;
		var link=linkFor(d,n.id),outDir=link&&link.hubToNode,inDir=link&&link.nodeToHub,outS=link?dirStatus(outDir):'not_checked',inS=link?dirStatus(inDir):'not_checked';
		var bubble=down&&risk>0?risk:load;
		var stamp=probeStamp(n);
		var status=down?(isNaN(stamp)?'Down, no probe has answered':'Down, last check '+ago(stamp)):osPretty(n);
		var rows=kvRow('OS',osPretty(n));
		if(typeof n.currentLoad==='number')rows+=kvRow('Running',String(n.currentLoad));
		if(typeof n.heldNotRunning==='number')rows+=kvRow('Held',String(n.heldNotRunning));
		var ready=readyLine(n);if(ready)rows+=kvRow('SDK / model',ready);
		var work=newWork(n);if(work)rows+=kvRow('New work',work,work.indexOf('Closed')===0?'is-closed':'');
		rows+=kvRow('Health',healthLine(n,down),down?'is-down':'');
		rows+=kvRow('Tasks at risk',String(risk),risk>0?'is-down':'');
		if(typeof n.assignedTotal==='number')rows+=kvRow('Lifetime tasks',String(n.assignedTotal));
		if(typeof n.succeeded==='number'&&typeof n.troubled==='number')rows+=kvRow('Wins / trouble',n.succeeded+' / '+n.troubled);
		if(n.enabled===false)rows+=kvRow('Node','Disabled');
		else if(n.draining)rows+=kvRow('Node','Draining');
		var alert='';
		if(down){
			var lead=isNaN(stamp)?'Unreachable. No probe has answered.':'Unreachable for '+spanAge(stamp)+'. No probe has answered since.';
			var others=(d.nodes||[]).filter(function(o){return o&&o.id!==n.id});
			var othersBusy=others.some(function(o){return (o.currentLoad||0)>0});
			var othersUp=others.some(function(o){return !nodeDown(o)});
			var rest=othersBusy?'The rest of the fleet keeps working and new tasks avoid this node.':othersUp?'The rest of the fleet stays up and new tasks avoid this node.':'';
			var lost=assigned(d,n).filter(taskRisk).map(function(t){return '<p class="fm-lost">'+esc(lostCopy(t))+'</p>'}).join('');
			alert='<div class="fm-alert"><div class="fm-alert-top"><span class="fm-badge down">Down</span><p>'+esc(lead)+'</p></div>'+(rest?'<p class="fm-rest">'+esc(rest)+'</p>':'')+lost+'</div>';
		}
		var works=assigned(d,n).map(function(t,i){
			var bits=whyBits(t),riskRow=taskRisk(t);
			var why=bits.length?'<p class="fm-why">Why here</p><p class="fm-why"><b>'+esc(bits.join(' · '))+'</b></p>':'';
			var tag=t.possibly?'Possibly still running':attentionLabel(t);
			return '<article class="fm-work"><div class="fm-work-top"><span class="fm-idx">'+String(i+1).padStart(2,'0')+'</span><b>'+esc(workName(t))+'</b>'+(riskRow?'<span class="fm-risk-label">At risk</span>':'<span class="fm-why">'+esc(tag)+'</span>')+'</div>'+why+'</article>';
		}).join('');
		var workBlock=works?'<div class="fm-block"><h3>Assigned work · '+assigned(d,n).length+'</h3>'+works+'</div>':'<div class="fm-block"><h3>Assigned work · 0</h3><p class="fm-why">Nothing is assigned on this node.</p></div>';
		var ssh='<div class="fm-block"><h3>SSH with the hub</h3><div class="fm-dirs">'+
			'<div class="fm-dir" data-ssh-out="'+outS+'"><span class="k">Hub to node</span><b class="fm-ssh-word '+sshWordClass(outS)+'">'+sshWords(outS)+'</b><span class="s">'+esc(sshDetail(outDir,outS,false,down))+'</span></div>'+
			'<div class="fm-dir" data-ssh-in="'+inS+'"><span class="k">Node to hub</span><b class="fm-ssh-word '+sshWordClass(inS)+'">'+sshWords(inS)+'</b><span class="s">'+esc(sshDetail(inDir,inS,true,down))+'</span></div>'+
			'</div></div>';
		var count=bubble>0?'<span class="fm-count'+(down&&risk>0?' is-risk':'')+'">'+bubble+'</span>':'';
		return '<div class="fm-backdrop" data-close="1"></div>'+
			'<div class="fm-panel" role="dialog" aria-modal="true" aria-label="'+esc(n.id)+'">'+
			'<button type="button" class="fm-x" data-close="1" aria-label="Close">×</button>'+
			'<div class="fm-ident"><div class="fm-ident-head"><div class="fm-ident-orb'+(down?' is-down':'')+'">'+osIcon(n.os)+count+'</div><div><div class="fm-ident-name">'+esc(n.id)+'</div><div class="fm-ident-status'+(down?' is-down':'')+'">'+esc(status)+'</div></div></div><dl class="fm-kv">'+rows+'</dl></div>'+
			'<div class="fm-sheet-main">'+alert+workBlock+ssh+'</div></div>';
	}
	function paintSheet(d){
		var n=null,nodes=d.nodes||[];
		if(sheetNode){for(var i=0;i<nodes.length;i++)if(nodes[i]&&nodes[i].id===sheetNode)n=nodes[i];if(!n)sheetNode=null}
		var html=n?sheetHtml(d,n):'';
		var el=$('fm-sheet'),cls='fm-sheet'+(n?' is-open':'');
		if(el.__html===html&&el.className===cls)return;
		el.__html=html;el.className=cls;el.innerHTML=html;
	}
	function renderFleet(d){
		if(!d)return;
		var key=fleetKey(d);
		if(fleetSig!==key){fleetSig=key;paintFleet(d)}
		var stage=$('fm-stage');if(stage)stage.className='fm-stage'+(sheetNode?' is-paused':'');
		paintSheet(d);
	}
	function loadSheetReasons(id){
		if(!last)return;
		tasksFor(last,id).forEach(function(t){
			if(!t.id||(t.selection&&t.selection.reason)||sheetDetail[t.id])return;
			fetch('/api/task/'+encodeURIComponent(t.id),{cache:'no-store'}).then(function(r){if(!r.ok)return null;return r.json()}).then(function(detail){
				if(!detail||!detail.selection)return;
				sheetDetail[t.id]=detail.selection;
				if(last&&sheetNode===id)paintSheet(last);
			}).catch(function(){});
		});
	}
	function onFleetNode(e){
		var t=e.target,el=t&&t.closest?t.closest('[data-node]'):null;
		if(!el)return;
		var id=el.getAttribute('data-node');
		if(!id||!last)return;
		if(coarse()){if(peeked!==id){peeked=id;sheetNode=null;renderFleet(last);return}}
		peeked=null;sheetNode=id;renderFleet(last);loadSheetReasons(id);
	}
	function onFleetSheet(e){
		var t=e.target;
		if(!t||!t.closest||!t.closest('[data-close]'))return;
		sheetNode=null;peeked=null;if(last)renderFleet(last);
	}
	function fleetLive(ok){var el=$('fm-link');if(!el)return;el.className='fm-link '+(ok?'is-live':'is-down');el.textContent=ok?'Live':'Disconnected'}
	var fleetNodeRoot=$('fm-nodes'),fleetSheetRoot=$('fm-sheet');
	if(fleetNodeRoot&&fleetNodeRoot.addEventListener)fleetNodeRoot.addEventListener('click',onFleetNode);
	if(fleetSheetRoot&&fleetSheetRoot.addEventListener)fleetSheetRoot.addEventListener('click',onFleetSheet);

	function render(d){
		last=d;isLive=!!d.live;
		renderFleet(d);
		var g=d.gjcRuntime||{},s=d.summary;
		$('rt-ver').textContent=g.installed?(g.version||'Installed'):(g.lastCheckedAt&&sig.rt?'Not installed':'Checking');sig.rt=1;
		lastCheck=g.installed&&g.lastCheckedAt?Date.parse(g.lastCheckedAt):0;
		if(g.brokerDiscovery==='ready')chipEl('rt-broker','ok','Broker OK');
		else chipEl('rt-broker',g.brokerDiscovery?'warn':'','Broker '+(g.brokerDiscovery||'Checking'));
		if(g.mcpCoordinatorReady===true)chipEl('rt-coord','ok','Coordinator ready');
		else chipEl('rt-coord',g.mcpCoordinatorReady===false?'bad':'',g.mcpCoordinatorReady===false?'Coordinator not ready':'Checking coordinator');
		if(typeof g.activeSessionsCount==='number')chipEl('rt-sess','info','Sessions '+g.activeSessionsCount+' active / '+g.totalSessionsCount);
		else chipEl('rt-sess','','Checking sessions');
		chipEl('rt-cap',s.openNodes===0?'warn':'info','Slots held '+s.heldTasks+(s.openNodes!=null?' · open nodes '+s.openNodes+' / '+s.totalNodes:''));

		$('p-count').textContent='Tasks '+s.totalTasks+(s.omittedTasks>0?' · listed '+(s.listedTasks||d.tasks.length)+' · omitted '+s.omittedTasks:'');
		put('flow',d.pipeline,flowHtml(d.pipeline));
		$('flow').className='flow'+(s.activeTasks>0?' busy':'');
		put('outcome',[d.pipeline.outcome,s.queuedTasks,s.unplaceableTasks,s.activeTasks],outcomeHtml(d));
		put('tasks',[d.tasks,d.archivedTasks,s.omittedTasks,s.omittedArchived,detailCache,detailLoad,detailError,folds,open],tasksHtml(d.tasks.map(withDetail),d.archivedTasks.map(withDetail),s.omittedTasks||0,s.omittedArchived||0));
		refreshOpenDetails();

		$('n-count').textContent=s.totalNodes+' nodes';
		put('nodes',d.nodes.map(function(n){var c={};for(var k in n)c[k]=n[k];delete c.resources;c.probe=n.probe&&{o:n.probe.ok,p:n.probe.probed,v:n.probe.version,e:n.probe.error,l:n.probe.liveSessions,t:n.probe.totalSessions,se:n.probe.sessionsError,ms:Math.round((n.probe.elapsedMs||0)/200)};return c}),
			d.nodes.length?d.nodes.map(nodeHtml).join(''):'<div class="empty">No nodes registered</div>');
		d.nodes.forEach(applyRes);

		if(tab===null||!d.nodes.some(function(n){return n.id===tab}))tab=d.nodes.length?d.nodes[0].id:null;
		var liveAll=0,known=0;
		d.nodes.forEach(function(n){if(n.probe&&n.probe.sessionsOk){liveAll+=n.probe.liveSessions;known++}});
		$('s-count').textContent=known?'Active '+liveAll+' · '+known+'/'+d.nodes.length+' nodes queried':'';
		put('tabs',[tab,d.nodes.map(function(n){return [n.id,n.probe&&n.probe.liveSessions,n.probe&&n.probe.totalSessions]})],d.nodes.map(function(n){
			var p=n.probe,c=p&&p.sessionsOk?p.liveSessions+'/'+p.totalSessions:p?'–':'…';
			return '<button data-tab="'+esc(n.id)+'" class="'+(n.id===tab?'sel':'')+'">'+esc(n.id)+'<small>'+c+'</small></button>';
		}).join(''));
		var cur=d.nodes.filter(function(n){return n.id===tab})[0];
		put('sessions',cur?[tab,cur.probe&&cur.probe.checkedAt&&cur.probe.sessions,cur.probe&&[cur.probe.ok,cur.probe.error,cur.probe.sessionsError]]:null,cur?sessHtml(cur):'<div class="empty">No nodes</div>');
	}
	$('tasks').addEventListener('click',function(e){
		var el=e.target.closest('.tk');if(!el)return;
		var id=el.getAttribute('data-id');
		if(open[id]&&detailError[id]){loadDetail(id);return;}
		open[id]=!open[id];
		if(last)render(last);
		if(open[id])loadDetail(id);
	});
	document.querySelector('main').addEventListener('click',function(e){
		var b=e.target.closest('.fold');if(!b)return;e.stopPropagation();
		var name=b.getAttribute('data-fold');folds[name]=!folds[name];
		if(last)render(last);
	});
	$('tabs').addEventListener('click',function(e){
		var b=e.target.closest('button');if(!b)return;tab=b.getAttribute('data-tab');if(last)render(last);
	});
	function tick(){
		if(!lastCheck){$('rt-age').textContent='';return}
		var sec=Math.max(0,Math.round((Date.now()-lastCheck)/1000));
		$('rt-age').textContent=sec<2?'Just checked':sec+'s ago checked';
	}
	function alive(){
		fails=0;lastMsg=Date.now();document.body.classList.remove('stale');$('live').classList.remove('down');
		$('clock').textContent=new Date().toTimeString().slice(0,8);
		fleetLive(true);
	}
	function down(){document.body.classList.add('stale');$('live').classList.add('down');$('clock').textContent='Disconnected';fleetLive(false)}
	function poll(){
		fetch('/api/state',{cache:'no-store'}).then(function(r){if(!r.ok)throw new Error(r.status);return r.json()}).then(function(d){
			alive();render(d);
		}).catch(function(){if(++fails>=2)down()});
	}
	/* Live channel: full state every 2s plus each node's resource sample as it arrives. Polling is the fallback. */
	function connect(){
		var ws;
		try{ws=new WebSocket((location.protocol==='https:'?'wss://':'ws://')+location.host+'/ws')}catch(e){setTimeout(connect,5000);return}
		ws.onopen=function(){wsOk=true};
		ws.onmessage=function(e){
			var m;try{m=JSON.parse(e.data)}catch(x){return}
			alive();
			if(m.type==='state')render(m.state);
			else if(m.type==='resources'&&last)for(var i=0;i<last.nodes.length;i++)if(last.nodes[i].id===m.nodeId){last.nodes[i].resources=m.resources;applyRes(last.nodes[i])}
		};
		ws.onclose=function(){wsOk=false;setTimeout(connect,2000)};
	}
	poll();connect();
	setInterval(function(){if(!wsOk)poll();else if(lastMsg&&Date.now()-lastMsg>8000)down()},3000);
	setInterval(tick,1000);
})();
</script>
</body>
</html>`;
