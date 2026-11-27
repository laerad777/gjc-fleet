/** Self-contained dashboard page served by `gjc-fleet ui`; no external assets. */
import { DASHBOARD_FONT_FACE_CSS } from "./dashboard-fonts";

export const DASHBOARD_HTML = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta name="theme-color" content="#f7f8fe">
<title>GJC Fleet Dashboard</title>
<style>
${DASHBOARD_FONT_FACE_CSS}
:root{
	--bg:#f7f8fe;--panel:rgba(255,255,255,.72);--panel-hi:rgba(255,255,255,.94);
	--line:#e3e5f3;--line-hi:#cfd3ea;
	--text:#14162b;--sub:#3d4160;--dim:#5b6080;
	--ac:#5b5bf0;--ac2:#8f8fff;--mint:#1fbf8a;--sky:#8fa8ff;--violet:#5b3fd0;--amber:#f0a52a;--rose:#ef4a5b;--warn:#8a5206;
	--ok:#17b57e;--ink:#14162b;--mut:#5b6080;--bad:#ef4a5b;
	--ease:cubic-bezier(.22,1,.36,1);--n:132px;--hit-min:44px;/* WCAG 2.5.5 / platform HIG minimum touch target */
	/* one link per hub-node pair; its colors, widths and dash patterns live here only */
	--lk-ok:#17b57e;--lk-wait:#f0a52a;--lk-unk:#b3b7cf;--lk-down:#c3c6da;
	--lk-w:1.6;--lk-w-hot:2.8;--lk-dash-down:2 7;--lk-dash-go:4 5;--lk-pulse-dur:.9s;
	/* 4px-base spacing scale; header/map-chrome gaps and margins pick from these tokens. */
	--sp-1:4px;--sp-2:8px;--sp-3:12px;--sp-4:16px;--sp-5:20px;--sp-6:24px;
	--sai-b:env(safe-area-inset-bottom,0px);
	--disp:'Fleet Display',Georgia,"Iowan Old Style","Times New Roman",serif;
	--sans:'Fleet Text',-apple-system,BlinkMacSystemFont,"SF Pro Text","Segoe UI",Roboto,"Noto Sans",system-ui,sans-serif;
}
*{box-sizing:border-box;margin:0;padding:0;-webkit-tap-highlight-color:transparent}
html,body{height:100%}
html{background:var(--bg)}
body{font-family:var(--sans);color:var(--text);line-height:1.45;-webkit-font-smoothing:antialiased;overflow:hidden;min-width:0;
	background:radial-gradient(900px 600px at 50% 46%,#fff 0%,rgba(255,255,255,0) 70%),radial-gradient(700px 500px at 85% -10%,#e6e6ff 0%,rgba(230,230,255,0) 70%),radial-gradient(600px 500px at -5% 105%,#e4ecff 0%,rgba(228,236,255,0) 70%),var(--bg)}
@keyframes rise{from{opacity:0;transform:translateY(14px);filter:blur(6px)}to{opacity:1;transform:none;filter:none}}
.rise{opacity:0;transform:translateY(14px);animation:rise .7s var(--ease) forwards;animation-delay:calc(var(--i,0) * 60ms)}
.settled .rise{animation:none;opacity:1;transform:none}

/* ---- map header ---- */
header{position:absolute;top:0;left:0;right:0;padding:30px 44px;display:flex;justify-content:space-between;align-items:flex-start;gap:20px;z-index:5;pointer-events:none}
header .hd,header .rt{pointer-events:auto;max-width:100%;min-width:0}
h1{font-size:11px;letter-spacing:.32em;font-weight:600;color:var(--mut)}
.hl{font-family:var(--disp);font-weight:400;font-size:36px;letter-spacing:-.025em;line-height:1.12;margin-top:8px}
.hl b{font-weight:600;font-style:italic;background:linear-gradient(100deg,var(--ac),#9a7bff);-webkit-background-clip:text;background-clip:text;color:transparent}
.hl .soft{font-weight:400;color:var(--mut)}
h1 .ov{display:inline-flex;align-items:center;gap:7px;margin-left:16px;padding:4px 11px 4px 9px;border-radius:99px;letter-spacing:.2em;font-size:9.5px;vertical-align:1px;text-transform:uppercase;
	background:rgba(23,181,126,.12);box-shadow:0 0 0 1px rgba(23,181,126,.35) inset;color:#0b6e4d}
h1 .ov .od{width:6px;height:6px;border-radius:50%;background:var(--ok)}
h1 .ov.deg{background:rgba(240,165,42,.13);box-shadow:0 0 0 1px rgba(240,165,42,.35) inset;color:#8a5206}
h1 .ov.deg .od{background:var(--amber);animation:pls 2s infinite}
h1 .ov.dn{background:rgba(239,74,91,.1);box-shadow:0 0 0 1px rgba(239,74,91,.35) inset;color:#b42a3a}
h1 .ov.dn .od{background:var(--rose)}
h1 .ov.unk{background:rgba(90,96,128,.09);box-shadow:0 0 0 1px rgba(90,96,128,.3) inset;color:#4a4f6b}
h1 .ov.unk .od{background:transparent;box-shadow:0 0 0 1.5px #9aa0bd inset}
@keyframes pls{0%{box-shadow:0 0 0 0 rgba(240,165,42,.6)}70%{box-shadow:0 0 0 7px rgba(240,165,42,0)}100%{box-shadow:0 0 0 0 rgba(240,165,42,0)}}
.sum{--metric-size:36px;display:grid;grid-template-columns:repeat(3,max-content);column-gap:var(--sp-5);justify-content:end;text-align:right;align-items:start}
.sum div{display:grid;grid-template-rows:1.25em auto;row-gap:var(--sp-1);min-width:0}
.sum div span{display:block;font-size:11px;line-height:1.25;color:var(--mut);letter-spacing:.10em;text-transform:uppercase;font-weight:500;white-space:nowrap}
.sum div strong{font-family:var(--disp);font-size:var(--metric-size);line-height:1;font-weight:400;letter-spacing:-.03em;font-variant-numeric:tabular-nums}
.sum .w strong{color:#c4303f}
.sum .states{grid-column:1/-1;display:flex;flex-wrap:wrap;gap:4px 12px;justify-content:flex-end;font-size:10px;letter-spacing:.08em;text-transform:uppercase;color:var(--sub);margin-top:2px}
.sum .st{display:inline-flex;align-items:center;gap:5px;white-space:nowrap}
.sum .st i{width:8px;height:8px;flex:none}
.sum .st.dn i{background:#c4303f;border-radius:2px}
.sum .st.dg i{background:var(--amber);clip-path:polygon(50% 0,100% 100%,0 100%)}
.sum .st.unk i{border-radius:50%;box-shadow:0 0 0 1.5px #9aa0bd inset}
.sum .st.pz i{background:linear-gradient(90deg,var(--dim) 33%,transparent 33%,transparent 66%,var(--dim) 66%)}
.sum .st.ok i{background:var(--ok);border-radius:50%}
.rt{display:flex;flex-direction:column;align-items:flex-end;flex:0 0 auto}
.live{display:flex;align-items:center;gap:8px;font-size:12px;color:var(--sub);font-variant-numeric:tabular-nums;margin-top:10px;
	padding:5px 11px;border-radius:999px;background:var(--panel);border:1px solid var(--line);transition:border-color .4s,color .4s}
.dot{position:relative;width:7px;height:7px;border-radius:50%;background:var(--ok)}
.dot::after{content:"";position:absolute;inset:-4px;border-radius:50%;border:1px solid var(--ok);animation:ping 1.8s var(--ease) infinite}
@keyframes ping{0%{transform:scale(.6);opacity:.9}100%{transform:scale(2.1);opacity:0}}
header,.nm,.ql,.hub small,.lg,.hint,#tip,.dl{line-height:normal}
header .rt .live{position:absolute;top:9px;right:44px;margin:0;padding:0;border:0;background:none;font-size:11px;letter-spacing:.04em;color:var(--dim)}
header .rt .live.down{color:#b42a3a}
.live.down{color:#b42a3a;border-color:rgba(239,74,91,.4)}
.live.down .dot{background:var(--rose)}.live.down .dot::after{border-color:var(--rose)}
header .rt .live.wait{color:var(--warn)}
header .rt .live.retry{color:var(--warn)}
header .rt .live.off{color:#b42a3a}
.live.wait{color:var(--warn)}
.live.wait .dot{background:var(--amber)}.live.wait .dot::after{border-color:var(--amber)}
.live.retry{color:var(--warn);border-color:rgba(240,165,42,.4)}
.live.retry .dot{background:var(--amber)}.live.retry .dot::after{border-color:var(--amber);animation:none}
.live.off{color:#b42a3a;border-color:rgba(239,74,91,.4)}
.live.off .dot{background:var(--rose)}.live.off .dot::after{border-color:var(--rose);animation:none}
.sr{position:absolute;width:1px;height:1px;margin:-1px;padding:0;overflow:hidden;clip:rect(0 0 0 0);white-space:nowrap;border:0}
.fresh{display:none;align-items:center;gap:8px;margin-top:10px;font-size:10.5px;letter-spacing:.14em;text-transform:uppercase;color:#8a5206}
.fresh{display:none;align-items:center;gap:8px;margin-top:var(--sp-3);font-size:0.6875rem;letter-spacing:.14em;text-transform:uppercase;color:#8a5206}
.fresh.on{display:flex}
.fresh b{font-weight:600}
.fresh span{color:var(--sub);letter-spacing:.06em;text-transform:none;font-size:11.5px;padding-left:8px;border-left:1px solid var(--line)}
.fresh .sd{width:11px;height:11px;border-radius:50%;border:1.5px solid var(--amber);position:relative}
.fresh .sd:after{content:"";position:absolute;left:3.5px;top:1.5px;width:1.5px;height:4px;background:var(--amber);border-radius:1px;transform-origin:50% 100%;animation:spin 6s linear infinite}
.lease{position:relative;display:none;align-items:center;gap:12px;margin-top:12px;padding:8px 16px 11px 14px;width:max-content;max-width:100%;border-radius:16px;overflow:hidden;
	background:linear-gradient(135deg,rgba(255,250,238,.92),rgba(255,244,222,.8));box-shadow:0 14px 34px -16px rgba(200,130,20,.45),0 0 0 1px rgba(240,165,42,.38) inset}
.lease.on{display:flex}
.lease .ld2{flex:none;width:9px;height:9px;border-radius:50%;background:var(--amber);animation:pls 2s infinite}
.lease .lt b{display:block;font-family:var(--disp);font-weight:600;font-size:15px;color:#5c3a05}
.lease .lt span{display:block;font-size:12px;color:#6f5121;margin-top:2px}
.lease em{font-style:normal;font-family:var(--disp);font-weight:600;font-size:22px;color:#8a5206;font-variant-numeric:tabular-nums;margin-left:6px;padding-left:14px;border-left:1px solid rgba(240,165,42,.35)}
.lease .lbar{position:absolute;left:0;right:0;bottom:0;height:3px;background:rgba(240,165,42,.15);display:none}
.lease.wp .lbar{display:block}
.lease .lbar i{display:block;height:100%;background:linear-gradient(90deg,#f6c26a,var(--amber));transition:width 1s linear}
.lease.xd{background:linear-gradient(135deg,rgba(255,241,243,.94),rgba(255,228,232,.82));box-shadow:0 14px 34px -16px rgba(190,40,60,.45),0 0 0 1px rgba(239,74,91,.4) inset}
.lease.xd .ld2{background:var(--rose);animation:none}
.lease.xd .lt b{color:#7a1f2b}
.lease.xd .lt span{color:#96414c}
.lease.xd em{color:#b42a3a;border-left-color:rgba(239,74,91,.35)}
.lease.xd .lbar{background:rgba(239,74,91,.16)}
.lease.xd .lbar i{background:var(--rose)}

/* ---- map stage ---- */
#spot{position:absolute;inset:0;pointer-events:none;z-index:1;background:radial-gradient(420px circle at var(--mx,50%) var(--my,50%),rgba(120,120,255,.16),rgba(120,120,255,0) 70%)}
#stage{position:absolute;inset:0;overflow:hidden;clip-path:inset(var(--map-top,0px) 0 var(--map-bottom,0px) 0);touch-action:none;z-index:3;cursor:grab;user-select:none;-webkit-user-select:none}
#stage.grab{cursor:grabbing}
#world{position:absolute;left:0;top:0;width:100%;height:100%;transform-origin:0 0;will-change:transform}
#world.anim{transition:transform .28s var(--ease)}
#world.sc .node.in,#world.sc .node.in .ring{animation:none}
#world.sc.overview .nm{visibility:hidden}
#world.sc.overview .node.fail .nm,#world.sc.overview .node.down .nm{visibility:visible}
#world.sc.overview .bl.zero{display:none}
#stage:focus-visible{outline:2px solid var(--ac);outline-offset:1px}
/* ---- map control cluster: one token scale drives every bottom-right control ---- */
#zc{--ctl-h:36px;--ctl-h-touch:44px;--ctl-radius:999px;--ctl-seg-w:40px;
	--ctl-border:var(--line-hi);--ctl-bg:var(--panel-hi);
	--ctl-shadow:0 6px 16px -12px rgba(50,50,150,.35);
	--ctl-focus:2px solid var(--ac);
	position:absolute;z-index:6;right:44px;bottom:58px;display:flex;flex-direction:row;align-items:center;gap:8px}
/* segmented zoom: one pill, segments split by hairlines, no per-button chrome */
.zseg{display:flex;align-items:stretch;height:var(--ctl-h);border:1px solid var(--ctl-border);border-radius:var(--ctl-radius);background:var(--ctl-bg);box-shadow:var(--ctl-shadow)}
.zseg button{width:var(--ctl-seg-w);border:0;background:transparent;color:var(--ink);cursor:pointer;display:grid;place-items:center;transition:background .2s,color .2s}
.zseg button:hover{background:rgba(91,91,240,.08)}
.zseg button:focus-visible{outline:var(--ctl-focus);outline-offset:-2px}
.zseg button[aria-disabled="true"]{opacity:.4;cursor:default}
.zseg #zo{border-radius:var(--ctl-radius) 0 0 var(--ctl-radius)}
.zseg #zr{border-left:1px solid var(--line);border-radius:0 var(--ctl-radius) var(--ctl-radius) 0}
.zseg svg{width:16px;height:16px;stroke:currentColor;fill:none;stroke-width:1.7;stroke-linecap:round;stroke-linejoin:round}
.zseg output{min-width:44px;display:grid;place-items:center;font-size:11px;letter-spacing:.08em;color:var(--mut);font-variant-numeric:tabular-nums;border-left:1px solid var(--line);border-right:1px solid var(--line)}
/* find node: chip-styled combobox, same tokens as the filter chips */
#find-node{position:relative}
#find-node[hidden]{display:none}
#find-btn{height:var(--ctl-h);padding:0 13px;display:inline-flex;align-items:center;gap:7px;border:1px solid var(--ctl-border);border-radius:var(--ctl-radius);background:var(--ctl-bg);color:var(--sub);font:inherit;font-size:0.8125rem;font-weight:500;letter-spacing:.01em;cursor:pointer;box-shadow:var(--ctl-shadow);transition:border-color .2s,color .2s}
#find-btn:hover{border-color:var(--ac2);color:var(--text)}
#find-btn:focus-visible{outline:var(--ctl-focus);outline-offset:2px}
#find-btn svg{width:14px;height:14px;stroke:currentColor;fill:none;stroke-width:1.7;stroke-linecap:round;stroke-linejoin:round}
#find-pop{position:absolute;right:0;bottom:calc(100% + 8px);width:min(280px,calc(100vw - 32px));padding:8px;border-radius:16px;background:rgba(255,255,255,.94);backdrop-filter:blur(18px) saturate(140%);-webkit-backdrop-filter:blur(18px) saturate(140%);box-shadow:0 18px 44px -18px rgba(40,40,120,.4),0 0 0 1px var(--line);z-index:24}
#find-pop[hidden]{display:none}
#find-q{width:100%;height:var(--ctl-h);padding:0 12px;border:1px solid var(--line);border-radius:10px;background:#fff;font:inherit;font-size:13px;color:var(--text)}
#find-q:focus-visible{outline:var(--ctl-focus);outline-offset:1px}
#find-list{list-style:none;margin:6px 0 0;max-height:min(320px,40vh);overflow-y:auto}
#find-list li{min-height:var(--ctl-h);display:flex;align-items:center;gap:8px;padding:0 10px;border-radius:10px;font-size:13px;color:var(--sub);cursor:pointer}
#find-list li:hover{background:rgba(91,91,240,.06)}
#find-list li[aria-selected="true"]{background:rgba(91,91,240,.1);color:var(--text)}
#find-list li .fdot{width:7px;height:7px;border-radius:50%;flex:none}
#find-list li.none{color:var(--dim);cursor:default}
#find-list li.none:hover{background:none}
/* star focus indicator (ported from ha-zigbee-mesh-map's star pill): chip tokens, explicit exit */
#star-pill{display:inline-flex;align-items:center;gap:7px;height:var(--ctl-h);padding:0 6px 0 13px;border:1px solid var(--ctl-border);border-radius:var(--ctl-radius);background:var(--ctl-bg);box-shadow:var(--ctl-shadow);color:var(--text);font-size:0.8125rem;font-weight:500;letter-spacing:.01em}
#star-pill[hidden]{display:none}
#star-pill .fdot{width:7px;height:7px;border-radius:50%;flex:none}
#star-pill span{max-width:120px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
#star-x{width:32px;border:0;border-radius:0 var(--ctl-radius) var(--ctl-radius) 0;background:transparent;color:var(--mut);cursor:pointer;display:grid;place-items:center}
#star-x:hover{background:rgba(91,91,240,.1);color:var(--text)}
#star-x:focus-visible{outline:var(--ctl-focus);outline-offset:1px}
#star-x svg{width:10px;height:10px;stroke:currentColor;stroke-width:1.6;stroke-linecap:round}
#star-x{align-self:stretch}
/* ---- node filters: calm light chips; dimming never moves the map ---- */
#fbar{display:flex;flex-wrap:wrap;gap:8px;margin-top:16px;max-width:600px}
.fchip{appearance:none;border:1px solid var(--line-hi);background:var(--panel-hi);color:var(--sub);font:inherit;font-size:0.8125rem;font-weight:500;letter-spacing:.01em;border-radius:999px;padding:7px 13px;display:inline-flex;align-items:center;gap:7px;cursor:pointer;box-shadow:0 6px 16px -12px rgba(50,50,150,.35);transition:border-color .2s,color .2s,background .2s,opacity .2s}
.fchip:hover{border-color:var(--ac2);color:var(--text)}
.fchip:focus-visible{outline:2px solid var(--ac);outline-offset:2px}
.fchip[aria-pressed="true"]{background:rgba(91,91,240,.1);border-color:var(--ac);color:var(--violet)}
.fchip .fd{width:7px;height:7px;border-radius:50%;flex:none}
.fchip b{font-weight:600;font-variant-numeric:tabular-nums;color:var(--mut)}
.fchip[aria-pressed="true"] b{color:inherit}
.fchip.zero{opacity:.5}
.fchip.clear{border-style:dashed;color:var(--mut);box-shadow:none}
.fchip[hidden]{display:none}
#fstat{margin-top:8px;font-size:11px;letter-spacing:.06em;color:var(--mut)}
#fstat:empty{display:none}
.node.dim{opacity:.16;filter:saturate(.3)}
#links path,#links circle{transition:opacity .35s var(--ease)}
/* Many nodes: orb, label and balloon sizes come from --n/--nf/--bs set per node count; the hub shrinks with --hs. */
#world.sc .bl{transform:scale(var(--bs,1))}
#world.sc .bl.run{top:14%;right:10%;transform-origin:100% 0;transform:scale(var(--bs,1)) translate(50%,-50%)}
#world.sc .bl.bad{top:14%;left:10%;transform-origin:0 0;transform:scale(var(--bs,1)) translate(-50%,-50%)}
#world.sc .bl.wait{bottom:14%;right:10%;transform-origin:100% 100%;transform:scale(var(--bs,1)) translate(50%,50%)}
#world.sc .nm{top:calc(86.4% + 2px)}
#world.sc .nm b{font-size:var(--nf,15px);max-width:var(--lw,200px);overflow:hidden;text-overflow:ellipsis}
#world.sc .nm span{font-size:var(--nf2,11px);letter-spacing:.02em}
#world.sc .nchips{margin-top:2px;gap:3px}
#world.sc.dn .nm span{display:none}
#world.sc.dn .nchip{font-size:0;padding:0;gap:0;background:none;box-shadow:none;letter-spacing:0}
#world.sc.dn .nchip.dn u{width:9px;height:9px}
#world.sc.dn .nchip:not(.dn):before{content:"";width:9px;height:9px;border-radius:50%;background:var(--amber)}
/* Large fleets: perpetual motion does not scale to dozens of nodes. State stays encoded in color, dashes and balloons; entry animations, the hub and queue markers are untouched. */
#world.calm .busy .ring .sp,#world.calm .busy .ring .sp2,#world.calm .idle .ring .sp{animation:none}
#world.calm .busy .orb,#world.calm .idle .orb{animation:none}
#world.calm .busy .ic .f{animation:none}
svg#links{position:absolute;inset:0;width:100%;height:100%;pointer-events:none}
.hub{position:absolute;width:150px;height:150px;transform:translate(-50%,-50%) scale(var(--hs,1));display:grid;place-items:center;cursor:pointer;animation:hubin 1.2s cubic-bezier(.16,1,.3,1) both}
@keyframes hubin{from{opacity:0;transform:translate(-50%,-50%) scale(.5)}}
.hub .core{width:88px;height:88px;border-radius:50%;display:grid;place-items:center;position:relative;z-index:2;
	background:radial-gradient(circle at 30% 25%,#fff,#e9ebff 70%);
	box-shadow:0 24px 60px -12px rgba(91,91,240,.55),0 0 0 8px rgba(255,255,255,.55),0 0 0 9px rgba(91,91,240,.1),inset 0 -8px 18px rgba(91,91,240,.12)}
.hub .halo{position:absolute;width:128px;height:128px;border-radius:50%;background:conic-gradient(from 0deg,rgba(91,91,240,0),rgba(91,91,240,.55),rgba(160,130,255,0) 55%,rgba(91,91,240,0));filter:blur(9px);animation:spin 6s linear infinite;pointer-events:none}
.hub .r{position:absolute;inset:0;margin:auto;border-radius:50%;border:1px solid rgba(91,91,240,.35);animation:rip 4.2s ease-out infinite;pointer-events:none}
.hub .r:nth-child(3){animation-delay:1.4s}.hub .r:nth-child(4){animation-delay:2.8s}
.hub.exp .r{border-color:rgba(240,165,42,.55)}
@keyframes rip{0%{width:88px;height:88px;opacity:.9}100%{width:var(--rp,330px);height:var(--rp,330px);opacity:0}}
.hub small{position:absolute;top:calc(100% + 2px);font-size:10.5px;letter-spacing:.14em;text-transform:uppercase;color:var(--mut);white-space:nowrap;pointer-events:none}
.q{position:absolute;width:30px;height:30px;margin:-15px;transform:scale(var(--hs,1));border-radius:50%;background:#fff;color:var(--ac);font-size:12px;font-weight:700;display:grid;place-items:center;
	box-shadow:0 6px 18px -4px rgba(91,91,240,.5),0 0 0 1.5px var(--ac2) inset;z-index:3;cursor:pointer;animation:pop2 .9s cubic-bezier(.16,1,.3,1) both .9s}
.q:after{content:"";position:absolute;inset:-5px;border-radius:50%;border:1px solid var(--ac2);animation:rip2 2.4s ease-out infinite}
@keyframes pop2{from{opacity:0;transform:scale(.3)}}
@keyframes rip2{to{transform:scale(1.7);opacity:0}}
.ql{position:absolute;transform:translateX(-50%);font-size:10.5px;color:var(--mut);letter-spacing:.14em;text-transform:uppercase;white-space:nowrap;pointer-events:none}
.node{position:absolute;width:var(--n);height:var(--n);will-change:transform;cursor:pointer;z-index:4;touch-action:manipulation;transition:opacity .35s var(--ease),filter .35s var(--ease)}
/* Centering, hover lift and the entry pop live on this inner box so the outer element's
 * transform is owned by the drift loop: per-frame writes are compositor-only translate3d
 * and never restart the hover transition or the pop animation. */
.nbod{position:absolute;inset:0;transform:translate(-50%,-50%);transition:transform .7s cubic-bezier(.16,1,.3,1)}
.node:focus-visible{outline:2px solid var(--ac);outline-offset:4px;border-radius:50%}
.node:hover .nbod{transform:translate(-50%,-50%) scale(1.07)}
.node.in{animation:fi 1.1s cubic-bezier(.16,1,.3,1) var(--ad,0s) both}
.node.in .nbod{animation:pop 1.1s cubic-bezier(.16,1,.3,1) var(--ad,0s) both}
.node.in .ring{transform-origin:50% 50%;animation:pop2 1.1s cubic-bezier(.16,1,.3,1) var(--ad,0s) both}
@keyframes pop{from{opacity:0;transform:translate(-50%,-50%) scale(.4)}to{opacity:1;transform:translate(-50%,-50%) scale(1)}}
.orb{position:absolute;inset:13.6%;border-radius:50%;display:grid;place-items:center;
	background:radial-gradient(circle at 32% 22%,#fff 0%,#f6f7ff 45%,#e9ebff 100%);
	box-shadow:0 34px 50px -22px rgba(50,50,150,.45),0 10px 18px -8px rgba(50,50,150,.18),0 0 0 1px var(--line),inset 0 2px 0 #fff,inset 0 -10px 20px rgba(91,91,240,.07);
	transition:box-shadow .5s,transform .6s cubic-bezier(.16,1,.3,1)}
.node:hover .orb{box-shadow:0 44px 70px -24px rgba(91,91,240,.6),0 10px 18px -8px rgba(50,50,150,.2),0 0 0 1px rgba(91,91,240,.45),inset 0 2px 0 #fff}
.orb svg.ic{width:45.8%;height:auto;stroke:var(--ink);fill:none;stroke-width:1.6;stroke-linecap:round;stroke-linejoin:round}
.ic .f{fill:var(--ac);fill-opacity:.17;stroke:none}
.ic .ac{stroke:var(--ac);fill:none}
.ic .acf{fill:var(--ac);stroke:none}
.ic .bel{fill:#fff;stroke:var(--ink);stroke-opacity:.35;stroke-width:1.2}
.ic .ey{fill:var(--ink);stroke:none}
.ring{position:absolute;inset:0;width:100%;height:100%;overflow:visible}
.nm{position:absolute;top:calc(100% - 4px);left:50%;transform:translateX(-50%);text-align:center;white-space:nowrap}
.nm b{font-family:var(--disp);font-size:15px;font-weight:600;display:block}
.nm span{font-size:11px;color:var(--mut);letter-spacing:.04em}
.bl{position:absolute;min-width:30px;height:30px;padding:0 8px;border-radius:15px 15px 15px 4px;display:grid;place-items:center;font-size:14px;font-weight:700;color:#fff;font-variant-numeric:tabular-nums}
.bl.run{top:4.5%;right:-4.5%;background:linear-gradient(140deg,var(--ac),#7a6bff);box-shadow:0 8px 20px -4px rgba(91,91,240,.7)}
.bl.run.zero{color:var(--sub);background:#fff;box-shadow:0 0 0 1px var(--line-hi) inset}
.bl.bad{top:-2px;left:2px;background:#d73a4b;box-shadow:0 8px 18px -4px rgba(239,74,91,.7);min-width:24px;height:24px;font-size:12px;border-radius:12px 12px 12px 3px}
.bl.wait{bottom:18px;right:-4px;background:#fff;color:#3d3dc8;min-width:24px;height:24px;font-size:12px;border-radius:12px 12px 12px 3px;box-shadow:0 0 0 1.5px var(--ac2) inset,0 6px 14px -4px rgba(91,91,240,.4)}
.nchips{display:flex;flex-direction:column;align-items:center;gap:5px;margin-top:8px}
.nchip{display:inline-flex;align-items:center;gap:6px;font-style:normal;font-size:9.5px;font-weight:600;letter-spacing:.12em;text-transform:uppercase;padding:4px 9px;border-radius:99px;white-space:nowrap}
.nchip.dn{color:#b42a3a;background:rgba(239,74,91,.1);box-shadow:0 0 0 1px rgba(239,74,91,.35) inset}
.nchip.dn u{width:6px;height:6px;border-radius:50%;background:var(--rose);text-decoration:none}
.nchip.dg,.nchip.rk{color:#8a5206;background:rgba(240,165,42,.13);box-shadow:0 0 0 1px rgba(240,165,42,.4) inset}
.nchip.pz{color:var(--sub);background:rgba(91,91,240,.07);box-shadow:0 0 0 1px var(--line-hi) inset}
.busy .ring .sp{transform-origin:66px 66px;animation:spin 3.2s linear infinite}
.busy .ring .sp2{transform-origin:66px 66px;animation:spin 5.5s linear infinite reverse}
.busy .orb{animation:breathe 2.2s ease-in-out infinite}
.idle .orb{animation:breathe 5s ease-in-out infinite}
.idle .ring .sp{transform-origin:66px 66px;animation:spin 24s linear infinite}
.busy .ic .f{animation:ip 2.1s ease-in-out infinite}
@keyframes ip{50%{fill-opacity:.46}}
@keyframes spin{to{transform:rotate(360deg)}}
@keyframes breathe{50%{transform:scale(1.045)}}
.fail .orb{animation:shake 2.4s ease-in-out infinite;box-shadow:0 22px 44px -14px rgba(239,74,91,.45),0 0 0 1.5px rgba(239,74,91,.5) inset}
.fail .orb svg.ic{stroke:var(--bad)}
.fail .ic .f,.fail .ic .acf{fill:var(--bad)}.fail .ic .ac{stroke:var(--bad)}
@keyframes shake{0%,86%,100%{transform:none}88%{transform:translateX(-3px)}91%{transform:translateX(3px)}94%{transform:translateX(-2px)}97%{transform:translateX(2px)}}
.down .orb{animation:none!important;opacity:.8;filter:grayscale(1) saturate(0);background:radial-gradient(circle at 32% 22%,#fff,#f1f2f6 55%,#e4e6ee);box-shadow:0 20px 30px -22px rgba(60,60,90,.35),0 0 0 1px var(--line),inset 0 2px 0 #fff}
.down .orb svg.ic{stroke:#a7abc2}
.down .ic .f{fill:#a7abc2}.down .ic .ac{stroke:#a7abc2}.down .ic .acf{fill:#a7abc2}.down .ic .ey{fill:#a7abc2}
.down .ring{filter:grayscale(1);opacity:1}
.down .ring circle{animation:dr 30s linear infinite;transform-origin:66px 66px}
@keyframes dr{to{transform:rotate(360deg)}}
.down .nm b{color:#6f7390}
/* state-change flashes and interior glide (motion polish) */
.node.reco .orb{animation:reco 1.5s var(--ease)!important}
@keyframes reco{0%{filter:grayscale(1) saturate(0);opacity:.8}30%{filter:none;opacity:1;box-shadow:0 0 0 14px rgba(23,181,126,.28),0 20px 40px -18px rgba(60,60,90,.4)}100%{filter:none;opacity:1;box-shadow:0 0 0 30px rgba(23,181,126,0)}}
.node.reco .ring{transform-origin:50% 50%;animation:recoring 1.5s ease-out}
@keyframes recoring{0%{opacity:.2;transform:scale(.94)}40%{opacity:1}100%{opacity:1;transform:scale(1)}}
.node.dropin .orb{animation:dropin .9s var(--ease)!important}
@keyframes dropin{0%{filter:none;opacity:1;transform:scale(1)}100%{filter:grayscale(1) saturate(0);opacity:.8;transform:scale(.97)}}
.live.recon .dot::after{animation:ping .9s var(--ease) 2}
/* Relayout glide: only the orb and ring travel from the previous spot; the node box, label and balloons never slide. Uses the individual translate property so it composes with transform animations (breathe/shake/reco). */
.node.gl .orb,.node.gl .ring{translate:var(--gdx,0px) var(--gdy,0px)}
.stalled .orb{opacity:.82;filter:saturate(.45)}
/* group bubble: one node standing for several healthy nodes of the same OS and arch; two offset discs behind it read as a stack */
.node.cl:before,.node.cl:after{content:"";position:absolute;inset:13.6%;border-radius:50%;background:#eef0ff;box-shadow:0 0 0 1px var(--line);z-index:-1}
.node.cl:before{transform:translate(4%,-4%)}.node.cl:after{transform:translate(-4%,4%)}
.node.cl{min-width:var(--hit-min,44px);min-height:var(--hit-min,44px)}
.cl .orb svg.ic{position:absolute;top:13%;width:24%}
.cl .orb .cnt{font-family:var(--disp);font-weight:600;font-size:calc(var(--n)*.27);line-height:1;margin-top:18%;font-variant-numeric:tabular-nums;color:var(--ink)}
.cl.dg .ring circle:first-child{stroke:var(--amber);stroke-opacity:.9;stroke-width:2.4}
.cl.uk .ring circle:first-child{stroke:#8b90ab;stroke-opacity:.9;stroke-dasharray:3 5;stroke-width:2}
#world.sc .cl .nm b{max-width:none}
#world.sc.overview .cl .nm,#world.sc.overview.gp .node.rk .nm,#world.sc.overview.gp .node.down .nm,#world.sc.overview.gp .node.fail .nm{visibility:visible}
#zc #zg{width:var(--hit-min,44px);height:var(--hit-min,44px);border-radius:50%;border:1px solid var(--line-hi);background:var(--panel-hi);color:var(--ink);cursor:pointer;display:grid;place-items:center;font:inherit;font-size:11px;font-weight:600;letter-spacing:.04em}
#zc #zg[hidden]{display:none}
#zc #zg:focus-visible{outline:2px solid var(--ac);outline-offset:2px}
.fadein{animation:fi 1.6s .9s both}@keyframes fi{from{opacity:0}}
/* One link per hub-node pair. Encoding after cytoscape.js edge styles (MIT, logic only, no dependency): a single edge whose line-style carries path state and whose per-end arrows carry direction state by shape and fill. No repeating flow animation; a confirmed state change pulses once. */
.lk{fill:none;stroke-linecap:round;stroke-width:var(--lk-w);transition:stroke-width .3s,stroke-opacity .3s}
.lk.down{stroke:var(--lk-down);stroke-opacity:.9;stroke-dasharray:var(--lk-dash-down)}
.lk.go{stroke-dasharray:var(--lk-dash-go)}
.lk.hot{stroke-width:var(--lk-w-hot)}
.lk.pulse{animation:lkpulse var(--lk-pulse-dur) ease-out 1}
@keyframes lkpulse{from{stroke-width:var(--lk-w-hot)}to{stroke-width:var(--lk-w)}}
.gs-ok{stop-color:var(--lk-ok)}.gs-wait{stop-color:var(--lk-wait)}.gs-unk{stop-color:var(--lk-unk)}
.mk-ok{fill:var(--lk-ok)}.mk-wait{fill:var(--lk-wait)}.mk-unk{fill:none;stroke:var(--lk-unk);stroke-width:1.4}
.hit{fill:none;stroke:transparent;stroke-width:12;pointer-events:stroke;cursor:pointer}
.hit:focus-visible{outline:none;stroke:var(--ac);stroke-opacity:.55}
#sheet .lc:focus-visible{outline:2px solid var(--ac);outline-offset:2px;border-radius:8px}
@media(pointer:coarse){.hit{stroke-width:24px}}
.hint{position:absolute;bottom:26px;right:44px;text-align:right;font-family:var(--disp);font-style:italic;font-size:14px;color:var(--mut);z-index:2}
.lg{position:absolute;bottom:22px;left:44px;font-size:11px;color:var(--mut);letter-spacing:.1em;text-transform:uppercase;display:flex;flex-direction:column;gap:9px;z-index:2}
.lg .lr1{display:flex;gap:24px;align-items:center}
.lg span{display:flex;gap:8px;align-items:center}
.lg .lab{font-weight:600;color:var(--ink);letter-spacing:.2em;font-size:10px;margin-right:-6px}
.dt{display:inline-block;width:7px;height:7px;border-radius:50%;margin-right:6px;flex:none}
.dt.ok{background:var(--ok)}
.dt.wait{background:var(--amber);border-radius:0;clip-path:polygon(50% 0,100% 100%,0 100%)}
.dt.unk{background:transparent;box-shadow:0 0 0 1.5px #b3b7cf inset}
.lg .dt{margin:0}

/* ---- tooltip ---- */
#tip{position:absolute;z-index:20;width:300px;padding:18px 20px;border-radius:18px;background:rgba(255,255,255,.86);backdrop-filter:blur(22px) saturate(1.6);-webkit-backdrop-filter:blur(22px) saturate(1.6);
	box-shadow:0 30px 70px -20px rgba(40,40,120,.35),0 0 0 1px rgba(255,255,255,.9) inset,0 0 0 1px rgba(91,91,240,.08);opacity:0;transform:translateY(6px) scale(.97);transition:opacity .22s,transform .22s;pointer-events:none}
#tip.on{opacity:1;transform:none}
#tip h3{font-family:var(--disp);font-size:17px;font-weight:600;display:flex;justify-content:space-between;align-items:baseline}
#tip h3 em{font-style:normal;font-family:var(--sans);font-size:10.5px;letter-spacing:.12em;text-transform:uppercase;font-weight:600}
.kv{display:grid;grid-template-columns:auto 1fr;gap:5px 14px;font-size:12px;margin:12px 0;color:var(--sub)}
.kv b,.kv dd{color:var(--text);font-weight:500;text-align:right}
.kv dt{color:var(--dim)}
.kv dd{text-align:left;min-width:0;overflow-wrap:anywhere}
.ld{height:3px;background:var(--line);border-radius:2px;margin:10px 0 2px;overflow:hidden}.ld i{display:block;height:100%;background:linear-gradient(90deg,var(--ac2),var(--ac))}
.tt{border-top:1px solid var(--line);padding-top:10px;margin-top:4px}
.tt div{font-size:12px;padding:5px 0}.tt div b{font-weight:600;display:block;font-size:12.5px}.tt div span{color:var(--sub)}
.tt .none{color:var(--dim)}
.tt .sh{font-size:10px;letter-spacing:.22em;text-transform:uppercase;font-weight:600;color:var(--dim);padding:2px 0 3px}
.tt .sr{display:grid;grid-template-columns:1fr auto;gap:12px;align-items:center}
.tt .sr b{font-weight:500}
.tt .sr span{white-space:nowrap;font-variant-numeric:tabular-nums}
.arr{margin:0 5px;color:var(--dim);font-weight:400}

/* ---- sheet (node detail, hub overview) ---- */
#veil{position:absolute;inset:0;z-index:30;pointer-events:none;background:rgba(236,237,252,0);backdrop-filter:blur(0);-webkit-backdrop-filter:blur(0);transition:background .8s,backdrop-filter .8s}
#veil.on{pointer-events:auto;background:rgba(236,237,252,.55);backdrop-filter:blur(16px);-webkit-backdrop-filter:blur(16px)}
#sheet{position:absolute;z-index:31;inset:0;pointer-events:none;clip-path:circle(0 at var(--cx,50%) var(--cy,50%));background:linear-gradient(160deg,#fff 0%,#f3f4ff 100%);transition:clip-path 1s cubic-bezier(.76,0,.16,1)}
#sheet.on{pointer-events:auto;clip-path:circle(150% at var(--cx,50%) var(--cy,50%))}
#sheet .glow{position:absolute;width:640px;height:640px;left:-160px;top:-200px;border-radius:50%;background:radial-gradient(circle,rgba(143,143,255,.35),rgba(143,143,255,0) 65%);pointer-events:none}
.x{position:absolute;top:30px;right:40px;width:44px;height:44px;border-radius:50%;border:1px solid var(--line);background:#fff;cursor:pointer;display:grid;place-items:center;z-index:5;transition:transform .3s}
.x:hover{transform:rotate(90deg)}
.dwrap{position:relative;height:100%;max-width:1160px;margin:0 auto;padding:64px 56px;display:grid;grid-template-columns:340px 1fr;gap:64px;opacity:0;transform:translateY(24px);transition:opacity .9s .45s cubic-bezier(.16,1,.3,1),transform .9s .45s cubic-bezier(.16,1,.3,1)}
#sheet.on .dwrap{opacity:1;transform:none}
#hubw{display:block;overflow-y:auto}
#sheet[data-mode="hub"] #dw,#sheet[data-mode="node"] #hubw{display:none}
.big{position:relative;width:230px;height:230px;margin:10px 0 30px}
.big:before{content:"";position:absolute;inset:-60px;border-radius:50%;background:radial-gradient(circle,rgba(143,143,255,.35),rgba(143,143,255,0) 65%);animation:breathe 4s ease-in-out infinite}
.big .node{position:absolute;left:50%;top:50%;transform:translate(-50%,-50%) scale(1.75);cursor:default;animation:none}
.dl h2{font-family:var(--disp);font-weight:600;font-size:46px;letter-spacing:-.025em;line-height:1.1;padding-bottom:4px;overflow-wrap:anywhere;background:linear-gradient(100deg,#14162b 40%,#5b5bf0);-webkit-background-clip:text;background-clip:text;color:transparent}
.dl p.s{font-size:14px;color:var(--sub);margin-top:6px;letter-spacing:.04em}
.dl .kv{font-size:13px;margin-top:26px;gap:12px 16px}
.dr{min-height:0;overflow-y:auto;scrollbar-width:thin;scrollbar-color:var(--line-hi) transparent;padding-right:4px}
.dr::-webkit-scrollbar{display:block;width:6px}
.dr::-webkit-scrollbar-thumb{background:var(--line-hi);border-radius:3px}
.dr::-webkit-scrollbar-track{background:transparent}
.dr h4{font-size:11px;letter-spacing:.28em;text-transform:uppercase;color:var(--sub);font-weight:600;margin-bottom:18px}
.wk{position:relative;padding:22px 0 22px 40px;border-top:1px solid var(--line)}
.wk:hover{background:linear-gradient(90deg,rgba(91,91,240,.06),rgba(91,91,240,0))}
.wk .no{position:absolute;left:0;top:24px;font-size:12px;color:#3d3dc8;font-weight:700;font-variant-numeric:tabular-nums}
.wk b{font-family:var(--disp);font-weight:400;font-size:21px;letter-spacing:-.01em}
.wk .ph{float:right;font-size:11px;letter-spacing:.12em;text-transform:uppercase;color:#3d3dc8;font-weight:600;max-width:55%;text-align:right}
.wk .ph.r{color:#b42a3a}
.wk .why{margin-top:10px;font-size:13.5px;color:var(--sub);line-height:1.65}
.wk .why u{text-decoration:none;color:var(--ink);font-weight:500}
.pg{height:3px;background:var(--line);border-radius:2px;margin-top:14px;overflow:hidden}
.pg i{display:block;height:100%;background:linear-gradient(90deg,var(--ac2),var(--ac))}
.sc{display:grid;grid-template-columns:120px 1fr 1fr;gap:18px;padding:16px 0;border-top:1px solid var(--line)}
.sc>b{font-family:var(--disp);font-weight:400;font-size:19px}
.sc .lc small{display:block;font-size:10px;letter-spacing:.2em;text-transform:uppercase;color:var(--dim);margin-bottom:4px}
.sc .lc span{display:flex;align-items:center;font-size:13.5px;font-weight:500}
.sc .lc em{display:block;font-style:normal;font-size:12px;color:var(--sub);margin-top:3px;line-height:1.5}
.co{margin:0 0 30px;padding:18px 20px;border-radius:18px;background:linear-gradient(135deg,rgba(255,255,255,.9),rgba(255,247,236,.9));box-shadow:0 0 0 1px rgba(239,74,91,.18) inset,0 18px 40px -24px rgba(200,80,60,.35)}
.co .cot{display:flex;align-items:center;gap:12px;font-size:14px;font-weight:500}
.co p{font-size:13.5px;color:var(--sub);margin:10px 0 0;line-height:1.6}
.co .cor{display:flex;gap:10px;margin-top:14px;padding-top:14px;border-top:1px solid #f1e3cf;font-size:13px;line-height:1.55;color:#6b4a14}
.co .cor svg{flex:none;margin-top:3px}
.rsec{margin:0 0 30px}
.x2{display:none}

/* ---- shared components (hub overview + node detail) ---- */
.glass{background:var(--panel);border:1px solid var(--line);border-radius:18px;backdrop-filter:blur(18px) saturate(140%);-webkit-backdrop-filter:blur(18px) saturate(140%);
	box-shadow:0 10px 30px -22px rgba(40,40,120,.35),inset 0 1px 0 rgba(255,255,255,.9);transition:transform .35s var(--ease),border-color .35s,background .35s}
@media(hover:hover){.glass:hover{border-color:var(--line-hi);background:var(--panel-hi)}}
.runtime{position:relative;padding:16px 18px;margin-bottom:22px;overflow:hidden}
.eyebrow{font-size:10.5px;font-weight:600;letter-spacing:.14em;text-transform:uppercase;color:var(--sub)}
.rt-row{display:flex;align-items:flex-end;justify-content:space-between;gap:12px;margin:4px 0 12px}
.rt-ver{font-family:var(--disp);font-size:26px;font-weight:600;letter-spacing:-.02em;color:var(--text)}
.rt-age{font-size:11.5px;color:var(--dim);font-variant-numeric:tabular-nums;white-space:nowrap}
.chips{display:flex;flex-wrap:wrap;gap:8px}
.chip{display:inline-flex;align-items:center;gap:7px;font-size:12px;font-weight:550;padding:6px 11px;border-radius:999px;
	border:1px solid var(--line);background:rgba(20,22,43,.03);color:var(--sub);transition:color .4s,border-color .4s,background .4s}
.chip b{width:6px;height:6px;border-radius:50%;background:currentColor}
.chip.ok{color:#0b6e4d;border-color:rgba(23,181,126,.4);background:rgba(23,181,126,.12)}
.chip.warn{color:#7a4a05;border-color:rgba(240,165,42,.5);background:rgba(240,165,42,.16)}
.chip.bad{color:#b42a3a;border-color:rgba(239,74,91,.4);background:rgba(239,74,91,.1)}
.chip.info{color:#3d3dc8;border-color:rgba(91,91,240,.35);background:rgba(91,91,240,.1)}
.chip.mute{color:var(--dim);border-color:var(--line);background:rgba(20,22,43,.03);opacity:1}
.sec{display:flex;align-items:baseline;justify-content:space-between;margin:0 2px 11px}
h2{font-size:14px;font-weight:650;letter-spacing:-.01em}
.count{font-size:11.5px;color:var(--dim);font-variant-numeric:tabular-nums}
.list{display:grid;gap:10px;margin-bottom:26px;grid-template-columns:minmax(0,1fr)}
@media(min-width:680px){.list.nodes{grid-template-columns:repeat(2,minmax(0,1fr))}}
.card{padding:16px}
.note{font-size:11.5px;color:var(--dim);margin-top:10px;line-height:1.5}
.mono{font-family:ui-monospace,SFMono-Regular,Menlo,monospace}
.wrap{max-width:960px;margin:0 auto}
.spin{width:10px;height:10px;border-radius:50%;border:1.5px solid currentColor;border-top-color:transparent;animation:rot .8s linear infinite}
@keyframes rot{to{transform:rotate(360deg)}}
.empty{padding:26px 16px;text-align:center;font-size:12.5px;color:var(--dim);border:1px dashed var(--line-hi);border-radius:18px}
#dw .empty{padding:34px 20px;font-size:13px}
.res-none{margin-bottom:11px}
.skel{height:76px;border-radius:18px;background:linear-gradient(100deg,var(--panel) 30%,var(--panel-hi) 50%,var(--panel) 70%);background-size:300% 100%;animation:shimmer 1.6s linear infinite}
@keyframes shimmer{to{background-position:-300% 0}}
.stale main{opacity:1;filter:saturate(.4);transition:opacity .5s,filter .5s}
#stage{transition:filter .5s}
.stale #stage{filter:saturate(.4)}
footer{text-align:center;font-size:11px;color:var(--dim);padding:6px 0 4px}
.pipe{padding:20px 12px 16px;margin-bottom:12px}
.flow{display:grid;grid-template-columns:repeat(7,1fr);position:relative}
.flow::before,.flow::after{content:"";position:absolute;top:18px;left:7.14%;right:7.14%;height:2px;border-radius:2px}
.flow::before{background:var(--line-hi)}
.flow::after{background:repeating-linear-gradient(90deg,var(--ac) 0 7px,transparent 7px 16px);background-size:16px 100%;opacity:0;transition:opacity .5s;animation:dash .7s linear infinite}
.flow.busy::after{opacity:.9}
@keyframes dash{to{background-position:16px 0}}
.st{display:flex;flex-direction:column;align-items:center;gap:5px;position:relative;z-index:1;min-width:0}
.st .n{width:38px;height:38px;border-radius:50%;display:grid;place-items:center;font-size:15px;font-weight:700;font-variant-numeric:tabular-nums;background:#fff;border:1.5px solid var(--line-hi);color:var(--dim);transition:all .5s var(--ease)}
.st.seen .n{color:var(--text);border-color:rgba(91,91,240,.45)}
.st.on .n{color:#fff;background:linear-gradient(140deg,var(--ac2),var(--ac));border-color:transparent;animation:halo 1.8s ease-out infinite}
@keyframes halo{0%{box-shadow:0 0 0 0 rgba(91,91,240,.45)}100%{box-shadow:0 0 0 14px rgba(91,91,240,0)}}
.st .l{font-size:11.5px;font-weight:600;color:var(--sub)}
.st.on .l,.st.seen .l{color:var(--text)}
.st .r{font-size:10px;color:var(--dim);font-variant-numeric:tabular-nums}
.outcome{display:flex;flex-wrap:wrap;gap:7px;margin-top:16px;padding-top:14px;border-top:1px solid var(--line)}
.outcome .chip{padding:5px 10px;font-size:11.5px}
.tk{padding:14px 16px;cursor:pointer}
.tk-head{display:flex;align-items:center;gap:10px}
.tk-key{flex:1;min-width:0;font-size:14px;font-weight:650;letter-spacing:-.015em}
.tk-head .chip{flex:none;padding:4px 9px;font-size:11px}
.tk-sub{font-size:11.5px;color:var(--sub);margin:3px 0 11px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.tk-sub b{color:var(--text);font-weight:600}
.steps{display:grid;grid-template-columns:repeat(7,1fr);gap:4px}
.steps i{height:5px;border-radius:3px;background:rgba(20,22,43,.09);transform-origin:left}
.steps i.done{background:linear-gradient(90deg,var(--ac2),var(--ac));animation:fill .6s var(--ease) backwards;animation-delay:calc(var(--s) * 70ms)}
.steps i.now{background:var(--ac);animation:glow 1.1s ease-in-out infinite alternate}
.steps i.wait{background:var(--amber);opacity:.85}
.steps i.fail{background:var(--rose)}
@keyframes fill{from{transform:scaleX(0)}}
@keyframes glow{from{opacity:.35}to{opacity:1;box-shadow:0 0 10px rgba(91,91,240,.6)}}
.settled .steps i.done{animation:none}
.steplabels{display:grid;grid-template-columns:repeat(7,1fr);gap:4px;margin-top:5px;font-size:9.5px;color:var(--dim);text-align:center;font-variant-numeric:tabular-nums}
.steplabels span.hit{color:var(--sub)}
.more{display:grid;grid-template-rows:0fr;transition:grid-template-rows .45s var(--ease)}
.more>div{overflow:hidden}
.tk.open .more{grid-template-rows:1fr}
.caret{flex:none;width:8px;height:8px;border-right:1.5px solid var(--dim);border-bottom:1.5px solid var(--dim);transform:rotate(45deg);transition:transform .35s var(--ease);margin:0 2px 3px 2px}
.tk.open .caret{transform:rotate(225deg);margin-bottom:-3px}
.blk{margin-top:14px;padding-top:12px;border-top:1px solid var(--line)}
.blk h3{font-size:10.5px;font-weight:600;letter-spacing:.12em;text-transform:uppercase;color:var(--sub);margin-bottom:8px}
.blk .kv{margin:0;font-size:12px}
.tl{position:relative;padding-left:16px}
.tl::before{content:"";position:absolute;left:3px;top:6px;bottom:6px;width:1px;background:var(--line-hi)}
.tl li{list-style:none;position:relative;display:flex;gap:8px;align-items:baseline;font-size:12px;padding:3px 0}
.tl li::before{content:"";position:absolute;left:-16px;top:8px;width:7px;height:7px;border-radius:50%;background:#fff;border:1.5px solid var(--dim)}
.tl li.key::before{border-color:var(--ac);background:var(--ac)}
.tl li.bad::before{border-color:var(--rose);background:var(--rose)}
.tl time{flex:none;color:var(--dim);font-size:11px;font-variant-numeric:tabular-nums}
.tl em{font-style:normal;color:var(--sub);min-width:0;overflow-wrap:anywhere}
.ndc{padding:15px 16px}
.nd-top{display:flex;align-items:center;gap:12px;margin-bottom:12px}
.nd-top .chip{margin-left:auto;flex:none;padding:4px 9px;font-size:11px}
.os{width:36px;height:36px;flex:none;border-radius:11px;display:grid;place-items:center;font-size:11px;font-weight:700;letter-spacing:.04em;color:var(--text);background:linear-gradient(140deg,rgba(143,143,255,.22),rgba(91,91,240,.1));border:1px solid var(--line-hi)}
.node-id{font-size:14.5px;font-weight:650;letter-spacing:-.02em;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.node-sub{font-size:11.5px;color:var(--sub);font-family:ui-monospace,SFMono-Regular,Menlo,monospace}
.hold{display:flex;flex-wrap:wrap;gap:6px;margin-bottom:10px}
.hold .chip{padding:4px 9px;font-size:11px;max-width:100%}
.hold .chip span{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.stats{display:grid;grid-template-columns:repeat(3,1fr);gap:8px;margin-bottom:10px}
.stats div{background:rgba(20,22,43,.03);border:1px solid var(--line);border-radius:10px;padding:7px 9px}
.stats b{display:block;font-size:16px;font-weight:700;font-variant-numeric:tabular-nums;letter-spacing:-.02em}
.stats small{font-size:10.5px;color:var(--dim)}
.meta{font-size:11px;color:var(--dim);line-height:1.6;overflow-wrap:anywhere}
.meta b{color:var(--sub);font-weight:500}
.adm{display:flex;align-items:center;gap:8px;margin-bottom:10px;font-size:12px;color:var(--sub)}
.adm i{flex:none;width:8px;height:8px;border-radius:50%;background:var(--dim)}
.adm.open i{background:var(--ok)}
.adm.hold i{background:var(--amber)}
.adm b{color:var(--text);font-weight:600}
.tabs{display:flex;gap:6px;overflow-x:auto;margin-bottom:10px;padding-bottom:2px;scrollbar-width:none}
.tabs::-webkit-scrollbar{display:none}
.tabs button{flex:none;font:inherit;font-size:12px;font-weight:600;color:var(--sub);background:var(--panel);border:1px solid var(--line);border-radius:999px;padding:7px 12px;cursor:pointer;transition:all .3s var(--ease)}
.tabs button small{font-weight:500;color:var(--dim);margin-left:5px;font-variant-numeric:tabular-nums}
.tabs button.sel{color:#0b1020;background:linear-gradient(140deg,var(--mint),var(--sky));border-color:transparent}
.tabs button.sel small{color:#0b1020}
.ss{padding:11px 14px;display:flex;align-items:center;gap:11px}
.ss .lamp{flex:none;width:8px;height:8px;border-radius:50%;background:var(--dim)}
.ss.live .lamp{background:var(--ac)}
.ss.st-working .lamp{background:var(--ok);animation:blink 1.6s ease-in-out infinite}
.ss.st-waiting_workflow .lamp,.ss.st-waiting_answer .lamp,.ss.st-waiting_permission .lamp{background:var(--amber);animation:blink 1s ease-in-out infinite}
.ss.st-stale .lamp,.ss.st-unknown .lamp{background:#d98a0a;opacity:.7}
@keyframes blink{0%,100%{opacity:1}50%{opacity:.35}}
.ss-main{flex:1;min-width:0}
.ss-sub{font-size:11px;color:var(--sub);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.ss-age{flex:none;font-size:11px;color:var(--dim);font-variant-numeric:tabular-nums}
.ss .chip{padding:3px 8px;font-size:10.5px}
.ss-title{font-size:13.5px;font-weight:600;letter-spacing:-.01em;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.ss-title.none{color:var(--dim);font-weight:500}
.res{display:grid;gap:9px;margin-bottom:11px}
.res-row{display:grid;grid-template-columns:minmax(0,auto) minmax(0,1fr);align-items:baseline;gap:4px 10px;font-size:11.5px}
.res-row label{grid-area:1/1;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;color:var(--sub)}
.res-row label small{color:var(--dim)}
.res-row .bar{grid-area:2/1/3/3;flex:none;width:100%;height:5px;border-radius:5px;background:rgba(20,22,43,.08);overflow:hidden}
.bar u{display:block;height:100%;width:0;border-radius:inherit;text-decoration:none;background:linear-gradient(90deg,var(--ac2),var(--ac));transition:width .9s var(--ease),background .4s}
.res-row.warn .bar u{background:var(--amber)}
.res-row.hot .bar u{background:var(--rose)}
.res-row span{grid-area:1/2;text-align:right;overflow:hidden;text-overflow:ellipsis;color:var(--text);font-variant-numeric:tabular-nums;white-space:nowrap}
.res-row span small{color:var(--dim)}
.fold{display:flex;align-items:center;gap:8px;width:100%;font:inherit;font-size:12px;font-weight:600;color:var(--sub);text-align:left;background:transparent;border:1px dashed var(--line-hi);border-radius:14px;padding:10px 14px;cursor:pointer;transition:color .3s,border-color .3s}
.fold:hover{color:var(--text);border-color:var(--sub)}
.fold .caret{margin-left:auto}
.fold.open .caret{transform:rotate(225deg);margin-bottom:-3px}
.folded{display:grid;grid-template-rows:0fr;transition:grid-template-rows .45s var(--ease);grid-template-columns:minmax(0,1fr);min-width:0}
.folded>div{overflow:hidden;display:grid;gap:10px;min-width:0;grid-template-columns:minmax(0,1fr)}
.fold.open+.folded{grid-template-rows:1fr}
@media(prefers-reduced-motion:reduce){*,*::before,*::after{animation-duration:.01ms!important;animation-iteration-count:1!important;transition-duration:.01ms!important}}

/* ---- sheet snap states (mobile): snap offsets are tokens; the peek value itself is measured
   from the summary block at open time. Pattern source: viliket/pure-web-bottom-sheet (MIT). ---- */
#sheet{--sheet-peek:45vh;--sheet-pad-b:22px;--sheet-ease:cubic-bezier(.16,1,.3,1)}
.grab{display:none}

/* Short phones give the map more room without hiding failure or selecting a node for the operator. */
/* ---- phones: the sheet is a bottom sheet ---- */
@media(max-width:700px){
body{min-width:0}
header{flex-direction:column;gap:var(--sp-4);padding:22px var(--sp-5)}
.hl{font-size:26px}
h1{font-size:10.5px}
h1 .ov{margin-left:10px}
.sum{--metric-size:29px;width:min(100%,360px);grid-template-columns:repeat(3,minmax(0,1fr));column-gap:var(--sp-3);text-align:left;container-type:inline-size}
.sum .states{justify-content:flex-start;font-size:9px;gap:3px 9px}
.sum div{row-gap:var(--sp-1)}
.sum div span{font-size:10px;letter-spacing:.04em}
/* Fluid label size: the longest label measures 9.9px wide per 1px of font, so 30.5 keeps all three columns inside their track at any width (container query, no breakpoints). */
@supports (font-size:1cqw){.sum div span{font-size:min(10px,calc((100cqw - var(--sp-6)) / 30.5))}}
.rt{width:100%;align-items:flex-start}
header .rt .live{top:8px;right:20px}
.fresh{margin-top:6px}
header .hd{align-self:stretch}
.lease{margin-top:12px;width:100%;padding:10px 12px 12px;gap:10px}
.lease .lt b{font-size:14px}.lease .lt span{font-size:11px}.lease em{font-size:19px;padding-left:10px}
.hub{--rp:250px}
.hint{left:0;right:0;text-align:center;bottom:104px;font-size:13px}
#zc{right:14px;bottom:140px;--ctl-h:var(--ctl-h-touch);--ctl-seg-w:var(--ctl-h-touch)}#find-btn{font-size:13px}#star-x{width:44px}
/* tight rows: the focus pill stands in for the find button; the popup anchors to the whole control row */
#zc.star #find-node{display:none}
#find-node{position:static}
#find-pop{left:0;right:0;width:auto}
#find-q{font-size:16px}
#fbar{flex-wrap:nowrap;overflow-x:auto;margin-top:12px;padding-bottom:4px;max-width:100%;scrollbar-width:none}
#fbar::-webkit-scrollbar{display:none}
.fchip{min-height:44px;padding:0 16px;font-size:13px;flex:none}
.lg{left:20px;right:20px;bottom:16px;gap:8px;font-size:11px}
.lg .lr1{flex-wrap:wrap;gap:6px 16px}
.nm b{font-size:14px}.nm span{font-size:11px}
.mh{display:none}
.nchip{font-size:8.5px;letter-spacing:.07em;padding:3px 8px}
#sheet{position:fixed;inset:auto 0 0 0;height:90%;border-radius:28px 28px 0 0;clip-path:none!important;transform:translateY(105%);transition:transform .8s var(--sheet-ease);box-shadow:0 -30px 80px -20px rgba(40,40,120,.4);overflow:hidden;overscroll-behavior-y:none;padding-bottom:env(safe-area-inset-bottom)}
#sheet.on[data-snap="peek"]{transform:translateY(calc(100% - var(--sheet-peek)))}
#sheet.on[data-snap="full"]{transform:none}
#sheet.drag{transition:none}
/* 44px tall grab strip: the whole strip is the drag/tap target, the pill inside is the visual */
.grab{display:grid;place-items:center;height:44px;cursor:grab;touch-action:none;position:relative;z-index:4}
.grab i{display:block;width:42px;height:4px;border-radius:2px;background:#d3d6ec}
#veil.on.peek{background:rgba(236,237,252,.22);backdrop-filter:blur(5px);-webkit-backdrop-filter:blur(5px)}
.dwrap{display:block;overflow-y:auto;padding:34px 22px calc(var(--sheet-pad-b) + env(safe-area-inset-bottom));transition:opacity .7s .25s,transform .7s .25s;overscroll-behavior-y:none}
#sheet[data-mode="hub"] .dwrap{padding-top:68px}
.x{top:16px;right:16px;width:var(--hit-min);height:var(--hit-min)}
.dl{display:grid;grid-template-columns:116px 1fr;column-gap:12px;align-items:center}
.big{grid-row:1/3;width:116px;height:116px;margin:0}
.big:before{inset:-30px}
.big .node{transform:translate(-50%,-50%) scale(.9)}
.dl h2{font-size:32px;align-self:end}
.dl p.s{align-self:start;font-size:13px}
.dl .kv{grid-column:1/-1;font-size:13.5px;margin:18px 0 28px;gap:11px 16px}
.wk{padding:18px 0 18px 34px}.wk b{font-size:18px}.wk .why{font-size:13.5px}
.sc{grid-template-columns:1fr 1fr;gap:10px 16px}.sc>b{grid-column:1/-1}
.co{padding:16px}
.tk-sub{white-space:normal}
}
@media(max-width:700px) and (max-height:719px){
header{gap:6px;padding:16px 18px}
header .sum{--metric-size:28px}
header .hl{font-size:22px}
header .lease{margin-top:5px;padding:6px 8px}
.hint{display:none}
#zc{bottom:61px}
.lg{bottom:7px}
}
/* ---- phone grid map: hub on top, node cards in a measured grid below ---- */
/* Design tokens for the grid component; JS reads the geometry tokens, so spacing lives here only. */
@media(max-width:700px){
#world.gr{--gr-orb:76px;--gr-gap:10px;--gr-name-w:116px;--gr-hub-gap:6px;--gr-queue-h:34px}
#world.gr .nm{top:calc(100% + 2px)}
#world.gr .nm b{font-size:13px;max-width:var(--gr-name-w);overflow:hidden;text-overflow:ellipsis}
#world.gr .nm span{display:none}
#world.gr .nchips{margin-top:4px;gap:4px}
#world.gr .nchip{font-size:9px;letter-spacing:.06em;padding:3px 8px}
#world.gr .bl{transform:scale(.78);transform-origin:100% 0}
#world.gr .bl.bad,#world.gr .bl.wait{display:none}
#world.gr .bl.run.zero{display:none}
#world.gr .q{display:none}
#world.gr #links path.fl,#world.gr #links path.draw{display:none}
#world.gr .hub .halo{display:none}
/* queue summary: one tappable pill under the hub instead of orbiting markers */
.ql.pill{pointer-events:auto;cursor:pointer;white-space:nowrap;padding:8px 14px;border-radius:999px;background:var(--panel-hi);border:1px solid var(--line-hi);color:var(--sub);font-size:11px;letter-spacing:.1em;box-shadow:0 8px 20px -12px rgba(50,50,150,.4)}
/* node filter bar: horizontal scroll with an edge fade, 44px touch height (labels shortened in the <=480px block) */
#fbar{flex-wrap:nowrap;overflow-x:auto;max-width:100%;scrollbar-width:none;padding-bottom:4px;-webkit-mask-image:linear-gradient(90deg,#000 80%,transparent);mask-image:linear-gradient(90deg,#000 80%,transparent)}
#fbar::-webkit-scrollbar{display:none}
.fchip{min-height:44px;flex:none}
}
/* Text-minimal layer: only essential copy stays on small phones. */
@media(max-width:480px){
.hint{display:none}
.lg{display:none}
.lease .lt span{display:none}
#zc{bottom:12px;right:12px}
#fbar .fchip{font-size:0;gap:5px;padding:0 14px}
#fbar .fchip::before{font-size:0.8125rem;font-weight:500}
#fbar .fchip b{font-size:0.8125rem;margin-left:5px}
#fbar .fchip[data-f=down]::before{content:"Down"}
#fbar .fchip[data-f=attn]::before{content:"Attn"}
#fbar .fchip[data-f=assigned]::before{content:"Asgd"}
#fbar .fchip[data-f=darwin]::before{content:"Mac"}
#fbar .fchip[data-f=win32]::before{content:"Win"}
#fbar .fchip[data-f=linux]::before{content:"Linux"}
#fbar .fchip[data-f=__clear]::before{content:"Clear"}
}
@media(max-width:350px){.sum div{grid-template-rows:2.5em auto}.sum{column-gap:8px}}
</style>
</head>
<body>
<header>
	<div class="hd">
		<h1>FLEET<span class="ov unk" id="ov" data-testid="pill-unknown"><i class="od"></i><span id="ov-t">Connecting</span></span></h1>
		<div class="hl" id="hl" data-testid="headline"><span class="soft">Connecting to the fleet&hellip;</span></div>
		<div id="fbar" role="group" aria-label="Node filters" data-testid="node-filters"></div>
		<div id="fstat" role="status" aria-live="polite" data-testid="filter-status"></div>
		<div class="lease" id="lease"><i class="ld2"></i><div class="lt"><b id="lease-t">Hub lease expiring</b><span id="lease-s"></span></div><em id="lc"></em><i class="lbar"><i id="lbi"></i></i></div>
	</div>
	<div class="rt">
		<div class="sum" id="sum"></div>
		<div class="fresh" id="fresh"><i class="sd"></i><b id="fresh-label">Health data stale</b><span id="fresh-s"></span></div>
		<div class="live wait" id="live"><span class="dot"></span><span id="clock">Loading</span><span class="sr" id="live-sr" role="status" aria-live="polite"></span></div>
	</div>
</header>
<div id="spot"></div>
<div id="stage" tabindex="0" aria-label="Fleet map" data-testid="map-viewport"><div id="world" data-testid="map-world"><svg id="links"></svg></div></div>
<div id="zc" role="group" aria-label="Map controls"><div id="find-node" hidden><button type="button" id="find-btn" data-testid="find-node" aria-haspopup="listbox" aria-expanded="false" aria-label="Find node" title="Find node"><svg viewBox="0 0 16 16"><circle cx="7" cy="7" r="4.2"/><path d="M10.2 10.2L14 14"/></svg><span>Find node…</span></button><div id="find-pop" hidden><input id="find-q" type="text" role="combobox" aria-expanded="true" aria-autocomplete="list" aria-controls="find-list" aria-activedescendant="" aria-label="Search nodes" placeholder="Search nodes…" autocomplete="off" spellcheck="false"><ul id="find-list" role="listbox" aria-label="Matching nodes"></ul></div></div><div id="star-pill" role="status" hidden><i class="fdot" id="star-dot"></i><span id="star-name"></span><button type="button" id="star-x" aria-label="Clear node focus" title="Clear node focus (Esc)"><svg viewBox="0 0 16 16"><path d="M3 3l10 10M13 3L3 13"/></svg></button></div><div class="zseg"><button type="button" id="zo" data-testid="zoom-out" aria-label="Zoom out" title="Zoom out (-)"><svg viewBox="0 0 16 16"><path d="M3 8h10"/></svg></button><button type="button" id="zg" data-testid="group-collapse" aria-label="Collapse expanded groups" title="Collapse groups" hidden>Group</button><output id="zv" data-testid="zoom-level" aria-live="polite" aria-label="Zoom level">100%</output><button type="button" id="zi" data-testid="zoom-in" aria-label="Zoom in" title="Zoom in (+)"><svg viewBox="0 0 16 16"><path d="M3 8h10M8 3v10"/></svg></button><button type="button" id="zr" data-testid="zoom-reset" aria-label="Fit map" title="Fit to screen (0, double-tap)"><svg viewBox="0 0 16 16"><path d="M2.5 6V2.5H6M10 2.5h3.5V6M13.5 10v3.5H10M6 13.5H2.5V10"/></svg></button></div></div>
<div class="lg"><div class="lr1"><span><svg width="34" height="10" viewBox="0 0 34 10"><line x1="0" y1="5" x2="28" y2="5" style="stroke:var(--ac);stroke-dasharray:var(--lk-dash-go)" stroke-width="2"/><path d="M25 1l8 4-8 4z" style="fill:var(--ac)"/></svg>Dispatching work</span><span><svg width="34" height="10" viewBox="0 0 34 10"><line x1="0" y1="5" x2="28" y2="5" style="stroke:var(--lk-down);stroke-dasharray:var(--lk-dash-down)" stroke-width="2"/></svg>Path down</span><span class="lab">SSH</span><span><svg width="34" height="10" viewBox="0 0 34 10"><line x1="0" y1="5" x2="28" y2="5" style="stroke:var(--lk-ok)" stroke-width="2"/><path d="M25 1l8 4-8 4z" style="fill:var(--lk-ok)"/></svg>Observed</span><span><svg width="34" height="10" viewBox="0 0 34 10"><line x1="0" y1="5" x2="24" y2="5" style="stroke:var(--lk-wait)" stroke-width="2"/><path d="M29 1l4 4-4 4-4-4z" style="fill:var(--lk-wait)"/></svg>Stale</span><span><svg width="34" height="10" viewBox="0 0 34 10"><line x1="0" y1="5" x2="28" y2="5" style="stroke:var(--lk-unk)" stroke-width="2"/><path d="M25 1l8 4-8 4z" style="fill:none;stroke:var(--lk-unk);stroke-width:1.4"/></svg>Not checked</span></div></div>
<div class="hint" id="hint"></div>
<div id="tip"></div><div id="veil"></div>
<div id="sheet" data-testid="sheet" data-mode="node" role="dialog" aria-modal="true" aria-label="Fleet details" aria-hidden="true" inert><div class="glow"></div><div class="grab" id="grab" role="button" tabindex="0" aria-label="Resize detail panel" title="Drag or tap to resize the panel"><i></i></div>
	<button class="x" id="cl" aria-label="Close"><svg width="16" height="16" viewBox="0 0 16 16" stroke="#14162b" stroke-width="1.6" stroke-linecap="round"><path d="M3 3l10 10M13 3L3 13"/></svg></button>
	<div class="dwrap" id="dw"></div>
	<div class="dwrap" id="hubw">
	<div class="wrap">
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
	</div>
</div>
<script>
(function(){
	var $=function(id){return document.getElementById(id)};
	var esc=function(v){return String(v==null?'':v).replace(/[&<>"']/g,function(c){return{'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]})};
	var sig={},open={},folds={},tab=null,lastCheck=0,fails=0,last=null,isLive=false,lastMsg=0,wsOk=false,detailCache={},detailLoad={},detailError={};
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
	/* Relative time via Intl.RelativeTimeFormat (narrow = the terse style already used here);
	 * the unit thresholds follow the gatus time.js pattern, reimplemented dependency-free. */
	var RTF=null;
	try{RTF=new Intl.RelativeTimeFormat('en',{numeric:'always',style:'narrow'})}catch(e){}
	function ago(ms){if(!ms)return '';var s=Math.max(0,Math.round((Date.now()-ms)/1000));
		if(RTF){
			if(s<60)return RTF.format(-s,'second');
			var rm=Math.floor(s/60);if(rm<60)return RTF.format(-rm,'minute');
			var rh=Math.floor(rm/60);if(rh<48)return RTF.format(-rh,'hour');
			return RTF.format(-Math.floor(rh/24),'day');
		}
		if(s<60)return s+'s ago';var m=Math.floor(s/60);if(m<60)return m+'m ago';var h=Math.floor(m/60);if(h<48)return h+'h ago';return Math.floor(h/24)+'d ago'}
	function chipEl(id,cls,label){var el=$(id);el.className='chip '+cls;el.lastElementChild.textContent=label}
	var RELEASED_UNCONFIRMED='Released by operator · session end not confirmed (may still be running on the node)';
	function chip(cls,label,lead){return '<span class="chip '+cls+'">'+(lead||'<b></b>')+'<span>'+esc(label)+'</span></span>'}
	/* html may be a builder: it runs only after the key says the section changed, so a push that
	 * changes nothing in a section skips its HTML build as well as the DOM write. */
	function put(id,key,html){var s=JSON.stringify(key);if(sig[id]===s)return false;var el=$(id);if(sig[id]!==undefined)el.classList.add('settled');sig[id]=s;el.innerHTML=typeof html==='function'?html():html;return true}

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
		if(!tasks.length&&!archived.length)return '<div class="empty">No tasks have been received in this hub DB yet.</div>';
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
		// Latency is patched in place (data-ms) so jitter never rebuilds the card.
		return '<span class="chip ok"><b></b><span>Response <span data-ms="'+esc(n.id)+'">'+(p.elapsedMs!=null?(p.elapsedMs/1000).toFixed(1)+'s':'')+'</span></span></span>';
	}
	function gb(n){return n>=1099511627776?(n/1099511627776).toFixed(1)+'TB':(n/1073741824).toFixed(n>=10737418240?0:1)+'GB'}
	function meter(label,pct,text,m){
		var w=Math.max(0,Math.min(100,pct||0)),cls=w>=90?' hot':w>=75?' warn':'';
		return '<div class="res-row'+cls+'" data-m="'+m+'"><label>'+label+'</label><div class="bar"><u style="width:'+w.toFixed(1)+'%"></u></div><span>'+text+'</span></div>';
	}
	function resHtml(n){
		var r=n.resources;
		if(!r){
			if(n.status&&n.status.level==='down')return '<div class="meta" style="margin-bottom:10px"><b>Resources</b> No measurement · the node is not answering checks</div>';
			if(n.reachable===false)return '<div class="meta res-none">No resource sample · this node is unreachable</div>';
			if(!n.admission)return '<div class="meta res-none">No resource sample yet</div>';
			return isLive?'<div class="res"><div class="skel" style="height:58px;border-radius:10px"></div></div>':'';
		}
		if(!r.ok)return '<div class="meta" style="margin-bottom:10px"><b>Resources</b> '+esc(r.error||'Measurement failed')+'</div>';
		var cores=' <small>/ '+(r.physicalCores!=null?r.physicalCores+' cores':'cores unknown')+((r.threads||r.cores)!=null?' · '+(r.threads||r.cores)+' threads':'')+'</small>';
		var cpu=(r.cpuPct==null?'Measuring':Math.round(r.cpuPct)+'%')+(r.load1!=null?' <small>· load '+r.load1.toFixed(2)+'</small>':'')+cores;
		var h=meter('CPU',r.cpuPct,cpu,'cpu');
		if(r.memTotal)h+=meter('Memory',r.memUsed/r.memTotal*100,gb(r.memUsed)+' <small>/ '+gb(r.memTotal)+(r.memReclaimed?' · host reclaimed '+gb(r.memReclaimed):'')+'</small>','mem');
		(r.disks||[]).forEach(function(d,i){h+=meter('Disk <small>'+esc(d.path)+'</small>',d.used/d.total*100,gb(d.total-d.used)+' free <small>/ '+gb(d.total)+'</small>','disk'+i)});
		return '<div class="res">'+h+'</div>';
	}
	/* Update a node's meters in place so bars slide to the new value instead of being rebuilt. */
	/* Callers that update many nodes pass a prebuilt id -> elements map; one full-document scan per render instead of one per node. */
	function applyRes(n,els){
		setDrift(n);
		var all=els||document.querySelectorAll('[data-res]');
		for(var q=0;q<all.length;q++){
			var el=all[q];
			if(el.getAttribute('data-res')!==n.id)continue;
			var html=resHtml(n);
			if(el.__html===html)continue;
			el.__html=html;
			var tmp=document.createElement('div');tmp.innerHTML=html;
			var next=tmp.querySelectorAll('.res-row'),cur=el.querySelectorAll('.res-row');
			if(!next.length||next.length!==cur.length){el.innerHTML=html;continue}
			for(var k=0;k<next.length;k++){
				cur[k].className=next[k].className;
				cur[k].querySelector('u').style.width=next[k].querySelector('u').style.width;
				cur[k].querySelector('span').innerHTML=next[k].querySelector('span').innerHTML;
				cur[k].querySelector('label').innerHTML=next[k].querySelector('label').innerHTML;
			}
		}
	}
	function patchMs(d){
		var byId=Object.create(null);
		for(var i=0;i<d.nodes.length;i++)byId[d.nodes[i].id]=d.nodes[i];
		var all=document.querySelectorAll('[data-ms]');
		for(var q=0;q<all.length;q++){
			var n=byId[all[q].getAttribute('data-ms')];
			if(n&&n.probe&&n.probe.elapsedMs!=null)all[q].textContent=(n.probe.elapsedMs/1000).toFixed(1)+'s';
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
		return '<div class="glass ndc rise" style="--i:'+i+'">'+
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

	function renderAdmin(d){
		last=d;isLive=!!d.live;
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
		put('tasks',[d.tasks,d.archivedTasks,s.omittedTasks,s.omittedArchived,detailCache,detailLoad,detailError,folds,open],function(){return tasksHtml(d.tasks.map(withDetail),d.archivedTasks.map(withDetail),s.omittedTasks||0,s.omittedArchived||0)});
		refreshOpenDetails();

		$('n-count').textContent=s.totalNodes+' nodes';
		put('nodes',d.nodes.map(function(n){var c={};for(var k in n)c[k]=n[k];delete c.resources;c.probe=n.probe&&{o:n.probe.ok,p:n.probe.probed,v:n.probe.version,e:n.probe.error,l:n.probe.liveSessions,t:n.probe.totalSessions,se:n.probe.sessionsError};return c}),
			function(){return d.nodes.length?d.nodes.map(nodeHtml).join(''):'<div class="empty">No nodes registered</div>'});
		var resEls=Object.create(null);
		document.querySelectorAll('[data-res]').forEach(function(el){var k=el.getAttribute('data-res');(resEls[k]||(resEls[k]=[])).push(el)});
		d.nodes.forEach(function(n){applyRes(n,resEls[n.id]||[])});patchMs(d);

		if(tab===null||!d.nodes.some(function(n){return n.id===tab}))tab=d.nodes.length?d.nodes[0].id:null;
		var liveAll=0,known=0;
		d.nodes.forEach(function(n){if(n.probe&&n.probe.sessionsOk){liveAll+=n.probe.liveSessions;known++}});
		$('s-count').textContent=known?'Active '+liveAll+' · '+known+'/'+d.nodes.length+' nodes queried':'';
		put('tabs',[tab,d.nodes.map(function(n){return [n.id,n.probe&&n.probe.liveSessions,n.probe&&n.probe.totalSessions]})],function(){return d.nodes.map(function(n){
			var p=n.probe,c=p&&p.sessionsOk?p.liveSessions+'/'+p.totalSessions:p?'–':'…';
			return '<button data-tab="'+esc(n.id)+'" class="'+(n.id===tab?'sel':'')+'">'+esc(n.id)+'<small>'+c+'</small></button>';
		}).join('')});
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
	/* ================= map view ================= */
	var RM=false,MOB=false,NS=132,W=0,H=0,RMQ=null;
	/* .hub is 150x150 in CSS (scaled by --hs); the queue label parks below whichever reaches lower: the hub box or the lowest queue chip. Gap is --sp-2 (8px). */
	var HUBBOX=150,QCHIP=30;
	function queueLow(qs){if(!qs||!qs.length)return 0;var m=0;for(var i=0;i<qs.length;i++)m=Math.max(m,Math.sin((-90+(i-(qs.length-1)/2)*50)*Math.PI/180));return m*QR()+QCHIP/2*HS}
	try{RMQ=matchMedia('(prefers-reduced-motion: reduce)');RM=RMQ.matches}catch(e){}
	var COARSE=false;try{COARSE=matchMedia('(pointer:coarse)').matches}catch(e){}
	var HIT_MIN=44;/* keep in sync with --hit-min; WCAG 2.5.5 / platform HIG minimum touch target */
	var stage=$('world'),vp=$('stage'),links=$('links'),tip=$('tip'),sheet=$('sheet'),veil=$('veil'),dw=$('dw');
	var sheetAnchor=null,pollPending=false,BO=Object.create(null),knownIds=Object.create(null),pvis=Object.create(null),rafLive=false;
	var BS=1,HS=1,DLIM=Object.create(null),DENSE=false,fontsReady=false,mapDeferred=false,viewTouched=false,VW={k:1,x:0,y:0},FIT={k:1,x:0,y:0},CB={x0:0,y0:0,x1:0,y1:0},KMIN=.5,KMAX=4,lastWH='',V=null,recvAt=Date.now(),NEL={},base={},pos={},off={},DRIFT=Object.create(null),HUBP={x:0,y:0},MTOP=0,MBOT=190,LNK={},hovN=null,tapped=null,lastPT='mouse',layoutSig='',qSig='',nodeSig={},mode=null,sheetNode=null,sheetSig=null,CM=false,EXP=Object.create(null),PREV=null,PREVWH='',SEED=null,OVERVIEW_PX=11,GROUP_CELL=96,HIT=44,zt=0;
	var COL={ok:'#17b57e',wait:'#f0a52a',unk:'#b3b7cf'};
	/* One severity rank per node, worst wins; an operator-paused node (disabled or draining) ranks as notice. */
	var SEV_OK=1,SEV_PAUSED=2,SEV_UNKNOWN=3,SEV_DEGRADED=4,SEV_DOWN=5;
	function sevOf(v){
		var l=v.status.level,w=l==='down'?SEV_DOWN:l==='degraded'?SEV_DEGRADED:l==='unknown'?SEV_UNKNOWN:SEV_OK;
		return (v.raw.enabled===false||v.raw.draining===true)?Math.max(w,SEV_PAUSED):w;
	}
	var SSL={ok:'Observed',wait:'Stale',unk:'Not checked'};
	var LVL={coordinator_unreachable:'Coordinator not responding',sdk_probe_failed:'SDK probe failed',resource_sample_failed:'Resource stream disconnected',no_fresh_control_observation:'No recent health check',unreachable:'Unreachable',sdk_not_ready:'SDK not ready',model_not_ready:'Model not ready',draining:'Draining',disabled:'Disabled',probe_failed:'Probe failed',resource_stream_failed:'Resource stream failed',node_unstable:'Node unstable',broker_session_list_failed:'Session list failed'};
	function lvlReason(r){return LVL[r]||reasonLabel(r)}
	var WHY={only_eligible_node:'Only eligible node',higher_preference:'Matches a stated preference',fewer_held_tasks:'Fewest held tasks',node_id_tiebreak:'Tie broken by node id',no_eligible_node:'No eligible node',global_capacity:'Global limit reached'};
	var OSN={darwin:'macOS',win32:'Windows',linux:'Linux'};
	function FP(d,x){return '<path class="f" '+(x||'')+' d="'+d+'"/><path d="'+d+'"/>'}
	var ICON={
		darwin:FP('M11.5 8h21A4.5 4.5 0 0 1 37 12.5v11a4.5 4.5 0 0 1-4.5 4.5h-21A4.5 4.5 0 0 1 7 23.5v-11A4.5 4.5 0 0 1 11.5 8z')+'<path d="M22 28v8M15.5 37h13"/><path d="M7 23.5h30" opacity=".4"/><path class="ac" d="M17.5 13.5v3.2M26.5 13.5v3.2M22 12.5v6M16.8 20c3 2 7.4 2 10.4 0"/>',
		win32:FP('M7 11l13-2v13H7z')+FP('M23 8.5L38 6v16H23z','style="animation-delay:.35s"')+FP('M7 25h13v13L7 36z','style="animation-delay:.7s"')+FP('M23 25h15v16l-15-2.5z','style="animation-delay:1.05s"'),
		linux:FP('M22 5.5c-3.6 0-5.6 3.2-5.6 7 0 2.4-.9 3.6-2.6 7C11.9 23.4 11 28 14 32c1.2 1.6 3.4 2.6 8 2.6s6.8-1 8-2.6c3-4 2.1-8.6.2-12.5-1.7-3.4-2.6-4.6-2.6-7 0-3.8-2-7-5.6-7z')+'<path class="bel" d="M22 17c-3 0-5 3.5-5 8s2 7.5 5 7.5 5-3 5-7.5-2-8-5-8z"/><circle class="ey" cx="19.4" cy="11" r="1.05"/><circle class="ey" cx="24.6" cy="11" r="1.05"/><path class="acf" d="M20.3 13.4h3.4L22 15.8z"/><path d="M14.4 22c-2 2.2-3 5-1.8 8M29.6 22c2 2.2 3 5 1.8 8"/><path class="ac" d="M16.4 37c-2.8 0-4.4-.6-4-2 .4-1.2 2.3-1.6 4.4-.8M27.6 37c2.8 0 4.4-.6 4-2-.4-1.2-2.3-1.6-4.4-.8"/>'
	};
	/* ---- Server observation fields; missing telemetry remains unknown. ---- */
	function sshOf(d){var m=Object.create(null);(d.sshLinks||[]).forEach(function(l){m[l.nodeId]=l});return m}
	function dirView(x){
		if(!x||x.status==='not_checked')return {s:'unk',label:SSL.unk,chk:null};
		return {s:x.status==='observed'?'ok':'wait',label:x.status==='observed'?SSL.ok:SSL.wait,chk:x.checkedAt?Date.parse(x.checkedAt):null};
	}
	function buildView(d){
		var tasks=d.tasks||[],ssh=sshOf(d),nodes=d.nodes.map(function(n){
			var status=n.status||{level:'unknown',reasons:['no_fresh_control_observation']},risk=n.tasksAtRisk||{count:0,taskIds:[]},l=ssh[n.id];
			var orun=n.observedRunning==null?null:Math.max(0,Number(n.observedRunning)||0);
			return {id:n.id,os:n.os,arch:n.arch,raw:n,status:status,risk:risk,obs:orun,
				out:l?dirView(l.hubToNode):null,inn:l?dirView(l.nodeToHub):null,
				/* dispatching is its own task phase in the payload; preparing/active (also RUN) are not a dispatch in flight, so they never draw the dash. */
				disp:tasks.some(function(t){return t.nodeId===n.id&&t.phase==='dispatching'})};
		});
		nodes.forEach(function(v){
			v.vis=v.status.level==='down'?'down':(v.risk.count&&tasks.some(function(t){return t.nodeId===v.id&&UNKNOWN[t.phase]}))?'fail':v.raw.currentLoad>0?'busy':'idle';
		});
		var q=tasks.filter(function(t){return t.phase==='queued'});
		var down=nodes.filter(function(v){return v.status.level==='down'}).length,degraded=nodes.filter(function(v){return v.status.level==='degraded'}).length;
		var risk=nodes.reduce(function(a,v){return a+v.risk.count},0);
		var gen=Date.parse(d.generatedAt)||recvAt;
		var lease=null;
		if(d.hub&&d.hub.lease){var L=d.hub.lease,ps=Number(L.periodSec);lease={state:L.state,expiresLocal:L.expiresAt==null?null:recvAt+(Date.parse(L.expiresAt)-gen),periodSec:ps>0?ps:null}}
		var fresh=null;
		if(d.health&&d.health.freshness){var F=d.health.freshness;fresh={state:F.state,ageAtRecv:F.checkedAt==null?null:Math.max(0,Math.round((gen-Date.parse(F.checkedAt))/1000))}}
		var overall=(d.summary&&d.summary.overall)||{state:'unknown',confirmedRunning:0,reasons:[]};
		// A partially refreshed view must not claim live work if every received path is down.
		if(nodes.length&&down===nodes.length)overall={state:'critical',confirmedRunning:0,reasons:overall.reasons||[]};
		var attention=new Set();
		tasks.forEach(function(t){var a=t.attention;if(a?(a==='failed'||a==='needs_confirmation'||a==='approval_required'||a==='unplaceable'):(UNKNOWN[t.phase]||t.phase==='failed'||t.phase==='approval_required'))attention.add(t.id)});
		nodes.forEach(function(v){v.risk.taskIds.forEach(function(id){attention.add(id)})});
		var needs=attention.size;
		return {nodes:nodes,queue:q,down:down,overall:overall,lease:lease,fresh:fresh,needs:needs,running:Math.max(0,Number(overall.confirmedRunning)||0),ssh:ssh};
	}
	/* ---- groups: when labels cannot stay readable at fit, healthy nodes of one OS and arch collapse into a single bubble ---- */
	var RANK={ok:0,unk:1,wait:2};
	function gkey(v){return v.os+'|'+v.arch}
	function isFlag(v){return v.vis==='down'||v.vis==='fail'||v.risk.count>0}
	/* One hub-to-group link per pair: the group shows the worst SSH state of its members (stale over not checked over observed). */
	function worstDir(m,k){
		var w=null,cnt=0,chk=null;
		m.forEach(function(v){var x=v[k];if(!x)return;if(!w||RANK[x.s]>RANK[w.s]){w=x;cnt=0;chk=null}if(x.s===w.s){cnt++;if(x.chk&&(!chk||x.chk<chk))chk=x.chk}});
		return w?{s:w.s,label:w.label,chk:chk,count:cnt,total:m.length}:null;
	}
	function groupOf(key,m,fl){
		var load=0,held=0,busy=0,deg=0,unk=0;
		m.forEach(function(v){load+=v.raw.currentLoad||0;held+=(v.status.level!=='down'&&v.raw.heldNotRunning)||0;if(v.vis==='busy')busy++;if(v.status.level==='degraded')deg++;else if(v.status.level==='unknown'||v.status.level==='paused')unk++});
		return {id:'cl:'+key,key:key,cluster:true,os:m[0].os,arch:m[0].arch,members:m,n:m.length,busyN:busy,degN:deg,unkN:unk,fl:fl,
			vis:busy?'busy':'idle',status:{level:deg?'degraded':unk?'unknown':'healthy',reasons:[]},risk:{count:0,taskIds:[]},
			raw:{currentLoad:load,heldNotRunning:held},out:worstDir(m,'out'),inn:worstDir(m,'inn')};
	}
	/* Units are what the map draws: every node, or (grouped) one bubble per OS/arch plus every flagged node and every node of an expanded group. */
	function mkUnits(){
		if(!CM){V.units=V.nodes.slice();return}
		var g={},order=[],u=[],fl={};
		V.nodes.forEach(function(v){
			var k=gkey(v);
			if(isFlag(v)){var f=fl[k]||(fl[k]={down:0,risk:0});if(v.vis==='down')f.down++;else f.risk++;u.push(v);return}
			if(EXP[k]){u.push(v);return}
			if(!g[k]){g[k]=[];order.push(k)}g[k].push(v);
		});
		var gs=[];
		order.forEach(function(k){if(g[k].length>1)gs.push(groupOf(k,g[k],fl[k]||{down:0,risk:0}));else u.push(g[k][0])});
		V.units=gs.concat(u);
	}
	function canGroup(){var c={};return V.nodes.some(function(v){if(isFlag(v))return false;var k=gkey(v);c[k]=(c[k]||0)+1;return c[k]>1})}
	function ago2(ms){if(!ms)return 'not yet';return ago(ms)}
	/* ---- header ---- */
	function head(){
		var o=V.overall,run=V.running,tot=V.nodes.length;
		var h=$('hl'),ov=$('ov');
		var state=o.state,confirmed=Number(o.confirmedRunning)||0;
		var flight='<br><b>'+run+(run===1?' task':' tasks')+' in flight</b>';
		if(state==='degraded')h.innerHTML=confirmed>0?'Degraded, <i class="soft">still running.</i><br><b>'+confirmed+(confirmed===1?' task':' tasks')+' confirmed running</b>':'Degraded.<br><b>Activity not confirmed</b>';
		else if(state==='critical')h.innerHTML='Fleet paths down.<br><b>No response confirmed</b>';
		else if(state==='unknown')h.innerHTML='Health unconfirmed.'+flight;
		else h.innerHTML=run?tot+(tot===1?' node, ':' nodes, ')+'humming.'+flight:tot+(tot===1?' node, ':' nodes, ')+'standing by.';
		ov.className='ov'+(state==='degraded'?' deg':state==='critical'?' dn':state==='unknown'?' unk':'');
		ov.setAttribute('data-testid',state==='degraded'?'pill-degraded':state==='critical'?'pill-down':state==='unknown'?'pill-unknown':'pill-healthy');
		$('ov-t').textContent=state==='degraded'?'Degraded':state==='critical'?'Down':state==='unknown'?'Unknown':'Healthy';
		var buckets=[[SEV_DOWN,'dn','down'],[SEV_DEGRADED,'dg','degraded'],[SEV_UNKNOWN,'unk','unknown'],[SEV_PAUSED,'pz','paused'],[SEV_OK,'ok','healthy']],counts={},i;
		for(i=0;i<V.nodes.length;i++){var sv=sevOf(V.nodes[i]);counts[sv]=(counts[sv]||0)+1}
		var parts=[],spoken=[];
		for(i=0;i<buckets.length;i++){var c=counts[buckets[i][0]]||0;if(c){parts.push('<span class="st '+buckets[i][1]+'"><i></i>'+c+' '+buckets[i][2]+'</span>');spoken.push(c+' '+buckets[i][2])}}
		$('sum').innerHTML='<div><span>Running</span><strong>'+run+'</strong></div><div><span>Queued</span><strong>'+V.queue.length+'</strong></div><div class="w"><span>Needs attention</span><strong>'+V.needs+'</strong></div>'+
			(parts.length?'<div class="states" data-testid="node-states" role="text" aria-label="Node states: '+spoken.join(', ')+'">'+parts.join('')+'</div>':'');
		tickHead();
	}
	function fmt(v){return Math.floor(v/60)+':'+String(v%60).padStart(2,'0')}
	function tickHead(){
		if(!V)return;
		var L=V.lease,lb=$('lease');
		if(L&&L.expiresLocal!=null&&(L.state==='expiring'||L.state==='expired'||L.expiresLocal<=Date.now())){
			var rem=Math.max(0,Math.ceil((L.expiresLocal-Date.now())/1000)),expired=L.state==='expired'||rem===0;
			lb.classList.add('on');lb.classList.toggle('xd',expired);
			$('lease-t').textContent=expired?'Hub lease expired':'Hub lease expiring';
			$('lease-s').textContent=expired?'No current lease is confirmed.':'Renewal has not yet been observed.';
			$('lc').textContent=fmt(rem);
			if(L.periodSec>0){lb.classList.add('wp');$('lbi').style.width=Math.min(100,rem/L.periodSec*100)+'%'}
			else lb.classList.remove('wp');
		}else lb.classList.remove('on','wp');
		var f=$('fresh');
		if(V.fresh&&V.fresh.state!=='fresh'){
			f.classList.add('on');$('fresh-label').textContent=V.fresh.state==='stale'?'Health data stale':V.fresh.state==='late'?'Health checks late':'Health checks incomplete';
			$('fresh-s').textContent=V.fresh.ageAtRecv==null?'':(V.fresh.ageAtRecv+Math.round((Date.now()-recvAt)/1000))+'s old';
		}else f.classList.remove('on');
	}
	/* ---- node drawing ---- */
	function ringSvg(s,live){
		var c=s==='fail'?'#ef4a5b':s==='down'?'#b9bdd3':'#5b5bf0';
		var o='<svg class="ring" viewBox="0 0 132 132"><circle cx="66" cy="66" r="62" fill="none" stroke="'+c+'" stroke-opacity="'+(s==='idle'?.18:s==='down'?.7:.25)+'" '+(s==='down'?'stroke-dasharray="7 6" stroke-width="1.6"':'')+'/>';
		if(s==='busy'&&live)o+='<g class="sp"><circle cx="66" cy="4" r="4" fill="'+c+'"/><path d="M66 4A62 62 0 0 1 120 35" stroke="'+c+'" stroke-width="2" fill="none" stroke-linecap="round" opacity=".5"/></g><g class="sp2"><circle cx="66" cy="128" r="2.5" fill="#8f8fff"/></g>';
		if(s==='idle')o+='<g class="sp"><circle cx="66" cy="4" r="2.5" fill="'+c+'" opacity=".6"/></g>';
		if(s==='fail')o+='<circle cx="66" cy="66" r="62" fill="none" stroke="#ef4a5b" stroke-width="1.5" stroke-dasharray="18 12">'+(RM?'':'<animate attributeName="stroke-dashoffset" from="0" to="-60" dur="2s" repeatCount="indefinite"/>')+'</circle>';
		return o+'</svg>';
	}
	function orbHtml(v){return '<div class="orb"><svg class="ic" viewBox="0 0 44 44">'+(ICON[v.os]||ICON.linux)+'</svg></div>'+ringSvg(v.vis,v.obs>0)+'<div class="bl run'+(v.raw.currentLoad?'':' zero')+'" data-testid="balloon" aria-label="'+v.raw.currentLoad+' assignments marked active">'+v.raw.currentLoad+'</div>'+(v.risk.count?'<div class="bl bad">'+v.risk.count+'</div>':'')+(v.raw.heldNotRunning&&v.status.level!=='down'?'<div class="bl wait">'+v.raw.heldNotRunning+'</div>':'')}
	var WARN_ICON='<svg width="10" height="10" viewBox="0 0 10 10"><path d="M5 1L9.3 8.6H.7z" fill="none" stroke="currentColor" stroke-width="1.2" stroke-linejoin="round"/><path d="M5 4v2M5 7.2v.1" stroke="currentColor" stroke-width="1.2" stroke-linecap="round"/></svg>';
	function chipsHtml(v){
		var o='',s=v.status;
		if(s.level==='down')o+='<i class="nchip dn" data-testid="node-badge"><u></u>'+(MOB?'Down':'Down · '+esc(lvlReason(s.reasons[0])))+'</i>';
		else if(s.level==='degraded')o+='<i class="nchip dg" data-testid="node-badge">'+(MOB?'Degraded':'Degraded · '+esc(lvlReason(s.reasons[0])))+'</i>';
		else if(s.level==='unknown')o+='<i class="nchip pz">'+(MOB?'Unknown':'Health unknown')+'</i>';
		if(v.raw.enabled===false)o+='<i class="nchip pz" data-testid="node-badge">Paused</i>';
		else if(v.raw.draining===true)o+='<i class="nchip pz" data-testid="node-badge">Draining</i>';
		if(v.risk.count)o+='<i class="nchip rk">'+WARN_ICON+v.risk.count+(MOB?' at risk':(v.risk.count>1?' tasks':' task')+' at risk')+'</i>';

		return o?'<div class="nchips">'+o+'</div>':'';
	}
	function groupInner(u){
		var cn='<b class="cnt">'+u.n+'</b>',fx=u.fl||{down:0,risk:0};
		var o='<div class="orb"><svg class="ic" viewBox="0 0 44 44">'+(ICON[u.os]||ICON.linux)+'</svg>'+cn+'</div>'+ringSvg(u.vis)+'<div class="bl run'+(u.raw.currentLoad?'':' zero')+'" aria-label="'+u.raw.currentLoad+' assignments marked active">'+u.raw.currentLoad+'</div>'+(u.raw.heldNotRunning?'<div class="bl wait">'+u.raw.heldNotRunning+'</div>':'');
		var ch='';
		if(u.degN)ch+='<i class="nchip dg">'+u.degN+' degraded</i>';
		if(u.unkN)ch+='<i class="nchip pz">'+u.unkN+' not confirmed</i>';
		if(fx.down)ch+='<i class="nchip dn"><u></u>'+fx.down+' down, shown apart</i>';
		if(fx.risk)ch+='<i class="nchip rk">'+WARN_ICON+fx.risk+' at risk, shown apart</i>';
		return o+'<div class="nm"><b>'+esc(OSN[u.os]||u.os)+' · '+esc(u.arch)+'</b><span>'+u.n+' nodes'+(u.busyN?' · '+u.busyN+' working':'')+'</span>'+(ch?'<div class="nchips">'+ch+'</div>':'')+'</div>';
	}
	function groupLabel(u){return (OSN[u.os]||u.os)+' '+u.arch+' group, '+u.n+' nodes, '+u.busyN+' working'+(u.degN?', '+u.degN+' degraded':'')+'. Press to expand'}
	function nodeInner(v){if(v.cluster)return groupInner(v);return orbHtml(v)+'<div class="nm"><b title="'+esc(v.id)+'">'+esc(v.id)+'</b><span>'+esc(OSN[v.os]||v.os)+' · '+esc(v.arch)+'</span>'+chipsHtml(v)+'</div>'}
	function nodeKey(v){if(v.cluster)return JSON.stringify([v.vis,v.n,v.obs,v.raw.currentLoad,v.raw.heldNotRunning,v.busyN,v.degN,v.unkN,v.fl,v.out&&v.out.s,v.inn&&v.inn.s,v.members.map(function(m){return m.id})]);return JSON.stringify([v.vis,v.obs,v.raw.currentLoad,v.raw.heldNotRunning,v.risk.count,v.status.level,v.status.reasons,v.os,v.arch,fltSig()])}
	/* 'in' only on first build: it carries the entry pop on the fresh .nbod, and a status
	 * patch rebuilds the inner box, so replaying the class would re-pop the node every poll. */
	function nodeCls(v,entering){var pre='node nd'+(entering?' in':'');if(v.cluster)return pre+' cl '+v.vis+(v.degN?' dg':v.unkN?' uk':'');return pre+' '+v.vis+(v.risk.count?' rk':'')+(DRIFT[v.id]&&DRIFT[v.id].stalled?' stalled':'')+(nodeMatch(v)?'':' dim')}
	function nodeBody(v){return '<div class="nbod">'+nodeInner(v)+'</div>'}
	/* ---- node filters: facet chips. OR within a group (status / OS), AND across groups. Dimming is visual only; positions, layout and the Find node picker never change.
	   'Assigned' counts held assignments (currentLoad): the state feed carries no per-node confirmed-execution field (only the global summary.overall.confirmedRunning),
	   so the chip must not claim that work is actually running. ---- */
	var FACETS=[
		{key:'down',label:'Down',cat:'status',col:'#b42a3a',test:function(v){return v.status.level==='down'}},
		{key:'attn',label:'Needs attention',cat:'status',col:'#a8680a',test:function(v){return v.vis==='fail'||v.risk.count>0||v.status.level==='degraded'}},
		{key:'assigned',label:'Assigned',cat:'status',col:'#0b6e4d',test:function(v){return v.raw.currentLoad>0}},
		{key:'darwin',label:'macOS',cat:'os',col:null,test:function(v){return v.os==='darwin'}},
		{key:'win32',label:'Windows',cat:'os',col:null,test:function(v){return v.os==='win32'}},
		{key:'linux',label:'Linux',cat:'os',col:null,test:function(v){return v.os==='linux'}}
	];
	var fOn=Object.create(null);
	function fltSig(){return FACETS.filter(function(f){return fOn[f.key]}).map(function(f){return f.key}).join(',')}
	function nodeMatch(v){
		var cats=Object.create(null);
		FACETS.forEach(function(f){if(fOn[f.key])cats[f.cat]=true});
		for(var c in cats)if(!FACETS.some(function(f){return fOn[f.key]&&f.cat===c&&f.test(v)}))return false;
		return true;
	}
	/* Filter buttons are built once and then updated in place (count, aria-label, aria-pressed, zero/Clear visibility only):
	   rebuilding the DOM on every render would drop keyboard focus from the chips on each live refresh. */
	var fBtns=null,fClear=null;
	function buildFilters(bar){
		bar.innerHTML='';
		fBtns=Object.create(null);
		FACETS.forEach(function(f){
			var b=document.createElement('button');
			b.type='button';b.className='fchip';b.setAttribute('data-f',f.key);b.setAttribute('data-testid','filter-'+f.key);
			if(f.col){var d=document.createElement('i');d.className='fd';d.style.background=f.col;b.appendChild(d)}
			b.appendChild(document.createTextNode(f.label+' '));
			b.appendChild(document.createElement('b'));
			bar.appendChild(b);
			fBtns[f.key]=b;
		});
		fClear=document.createElement('button');
		fClear.type='button';fClear.className='fchip clear';fClear.setAttribute('data-f','__clear');fClear.setAttribute('data-testid','filter-clear');fClear.textContent='Clear';fClear.hidden=true;
		bar.appendChild(fClear);
	}
	function renderFilters(){
		var bar=$('fbar');if(!bar||!V)return;
		if(!fBtns||!fBtns[FACETS[0].key]||fBtns[FACETS[0].key].parentNode!==bar)buildFilters(bar);
		FACETS.forEach(function(f){
			var n=V.nodes.filter(f.test).length,b=fBtns[f.key];
			b.classList.toggle('zero',!n);
			b.setAttribute('aria-pressed',fOn[f.key]?'true':'false');
			b.setAttribute('aria-label',f.label+', '+n+(n===1?' node':' nodes'));
			b.lastChild.textContent=n;
		});
		fClear.hidden=!fltSig();
	}
	function applyFilters(){
		if(!V)return;
		var any=!!fltSig(),shown=0;
		V.units.forEach(function(v,i){
			var ok=v.cluster?v.members.some(function(m){return lit(m)}):lit(v);
			if(ok)shown+=v.cluster?v.members.length:1;
			var el=NEL[v.id];if(el)el.classList.toggle('dim',!ok);
			var g=LNK[v.id];
			if(g&&g.p)g.p.style.opacity=ok?'':'0.07';
		});
		var st=$('fstat');if(st)st.textContent=any?'Showing '+shown+' of '+V.nodes.length+' nodes':'';
		try{history.replaceState(null,'',location.pathname+location.search+(any?'#flt='+fltSig():''))}catch(e){}
	}
	$('fbar').addEventListener('click',function(e){
		var b=e.target&&e.target.closest?e.target.closest('.fchip'):null;if(!b)return;
		var k=b.getAttribute('data-f');
		if(k==='__clear')fOn=Object.create(null);else fOn[k]=!fOn[k];
		renderFilters();applyFilters();
		if(k==='__clear'&&fBtns&&fBtns[FACETS[0].key])fBtns[FACETS[0].key].focus();
	});
	(function(){var m=/(?:^|[#&])flt=([a-z0-9,]*)/.exec(location.hash||'');if(m&&m[1])m[1].split(',').forEach(function(k){if(FACETS.some(function(f){return f.key===k}))fOn[k]=true})})();
	function stLabel(v){return v.vis==='busy'&&!(v.obs>0)?'Marked active':ST[v.vis]}
	/* ---- geometry ---- */
	function ctrl(i){var p=pos[V.units[i].id],cx=HUBP.x,cy=HUBP.y;if(MOB)return {x:(cx+p.x)/2,y:(cy+p.y)/2};return {x:(cx+p.x)/2,y:(cy+p.y)/2-((p.y>cy)?-30:30)}}
	function r1(v){return Math.round(v*10)/10}
	/* The one link of a hub-node pair: the shared hub-to-node curve, trimmed so the stroke starts outside the hub core and ends at the node orb edge. */
	function linkD(i){
		var p=pos[V.units[i].id],c=ctrl(i),h=HUBP,hubClear=52*HS,nodeR=NS/2;
		function pt(t){return {x:(1-t)*(1-t)*h.x+2*(1-t)*t*c.x+t*t*p.x,y:(1-t)*(1-t)*h.y+2*(1-t)*t*c.y+t*t*p.y}}
		var a=0,b=1;
		for(var k=0;k<=60;k++){var q=pt(k/60);if(Math.hypot(q.x-h.x,q.y-h.y)>hubClear){a=k/60;break}}
		for(var k2=60;k2>=0;k2--){var q2=pt(k2/60);if(Math.hypot(q2.x-p.x,q2.y-p.y)>nodeR){b=k2/60;break}}
		if(b<=a){a=0;b=1}
		var pa=pt(a),pb=pt(b),tx=(1-a)*(c.x-h.x)+a*(p.x-c.x),ty=(1-a)*(c.y-h.y)+a*(p.y-c.y);
		var qx=r1(pa.x+(b-a)*tx),qy=r1(pa.y+(b-a)*ty);
		return 'M'+r1(pa.x)+' '+r1(pa.y)+' Q'+qx+' '+qy+' '+r1(pb.x)+' '+r1(pb.y);
	}
	/* setAttribute only on change: a rewritten path d invalidates the whole-stage SVG layer even when identical. */
	function setD(el,d){if(el&&el.__d!==d){el.__d=d;el.setAttribute('d',d)}}
	/* A node's link curve depends only on that node's position and the hub, so a write tick
	 * recomputes the curves of the nodes that actually moved, not all of them. Curves are
	 * quantized to whole pixels: slow drift below 1px leaves the d untouched, which keeps a
	 * full-fleet tick from re-rastering the link layer for sub-pixel motion. */
	function paintNode(i){
		var v=V.units[i];if(!v)return;
		var g=LNK[v.id];if(!g||!g.p)return;
		var o=off[v.id],p=pos[v.id];
		if(o&&g.p.__d!=null){var qx=Math.round(p.x),qy=Math.round(p.y);if(o.px===qx&&o.py===qy)return;o.px=qx;o.py=qy}
		var d=linkD(i);setD(g.p,d);if(g.h)setD(g.h,d);
		if(g.g){g.g.setAttribute('x1',HUBP.x);g.g.setAttribute('y1',HUBP.y);g.g.setAttribute('x2',p.x);g.g.setAttribute('y2',p.y)}
	}
	function paint(list){
		if(list){for(var q=0;q<list.length;q++)paintNode(list[q]);return}
		V.units.forEach(function(_,i){paintNode(i)});
	}
	/* ---- drift: motion comes from the node's measured CPU ---- */
	function setDrift(n){
		var r=n.resources,dr=DRIFT[n.id]||(DRIFT[n.id]={load:0,live:false,stalled:false,ph:0});
		if(r&&r.ok){dr.live=true;dr.stalled=false;dr.load=r.cpuPct==null?.1:Math.max(0,Math.min(1,r.cpuPct/100))}
		else{dr.live=false;dr.stalled=!!(r&&r.ok===false)}
		var el=NEL[n.id];
		if(el){el.style.setProperty('--load',dr.load);el.classList.toggle('stalled',dr.stalled)}
	}
	var tlast=0,twrite=0,tlink=0,linkDirty=[];
	function startLoop(){if(!RM&&!rafLive){rafLive=true;tlast=0;requestAnimationFrame(frame)}}
	if(RMQ&&RMQ.addEventListener)RMQ.addEventListener('change',function(){try{RM=RMQ.matches}catch(e){}
		if(RM){BO=Object.create(null);stage.querySelectorAll('.node.gl').forEach(function(e){e.classList.remove('gl');e.style.removeProperty('--gdx');e.style.removeProperty('--gdy')})}
		startLoop()});
	function frame(ts){
		rafLive=true;
		var dt=Math.min(.05,(ts-tlast)/1000||.016);tlast=ts;
		/* The spring integrates at rAF rate; DOM writes are capped at ~30fps and skipped while a
		 * node's rounded drift offset is unchanged, so settled/idle nodes stop touching the DOM. */
		var write=ts-twrite>=33;
		if(V)V.units.forEach(function(v,i){
			var o=off[v.id],el=NEL[v.id],dr=DRIFT[v.id];if(!o||!el)return;
			var amp=(RM||!dr||!dr.live||v.vis==='down')?0:(.25+.75*dr.load)*(MOB?.6:1)*(DLIM[v.id]==null?1:DLIM[v.id]);
			if(dr)dr.ph+=dt*(.5+1.1*(dr.load||0));
			var t=dr?dr.ph:0,ph=i*1.9;
			var tx=amp*(15*Math.sin(t*1.1+ph)+7*Math.sin(t*2.2+ph*2.3)),ty=amp*(11*Math.cos(t*.94+ph*1.3)+6*Math.sin(t*1.86+ph));
			if(hovN===v.id){tx=o.hx;ty=o.hy}
			o.vx+=((tx-o.x)*6-o.vx*3.2)*dt;o.vy+=((ty-o.y)*6-o.vy*3.2)*dt;o.x+=o.vx*dt;o.y+=o.vy*dt;
			var bo=BO[v.id];
			if(bo){var f=Math.min(1,dt*5);bo.x+=(0-bo.x)*f;bo.y+=(0-bo.y)*f;
				if(bo.x*bo.x+bo.y*bo.y<.04){BO[v.id]=null;el.classList.remove('gl');el.style.removeProperty('--gdx');el.style.removeProperty('--gdy')}
				else{el.style.setProperty('--gdx',r1(bo.x)+'px');el.style.setProperty('--gdy',r1(bo.y)+'px')}}
			var p=pos[v.id],b=base[v.id];p.x=b.x+o.x;p.y=b.y+o.y;
			if(!write)return;
			/* Drift rides on transform, not left/top: the write stays on the compositor and no
			 * longer invalidates layout for every node on every write tick. */
			var dx=r1(o.x),dy=r1(o.y);
			if(o.dx!==dx||o.dy!==dy){o.dx=dx;o.dy=dy;el.style.transform='translate3d('+dx+'px,'+dy+'px,0)';if(!o.ld){o.ld=1;linkDirty.push(i)}}
		});
		if(write){
			twrite=ts;
			/* Links repaint on their own ~10Hz cadence: node motion keeps the 30fps write tick,
			 * while curve recompute + SVG invalidation (the raster-heavy part) runs at most 10x/s.
			 * A line trails its node by at most ~100ms; layout and status changes still paint at once. */
			if(ts-tlink>=100&&linkDirty.length&&V&&Object.keys(LNK).length){
				tlink=ts;paint(linkDirty);
				for(var q=0;q<linkDirty.length;q++){var u=V.units[linkDirty[q]];if(u&&off[u.id])off[u.id].ld=0}
				linkDirty=[];
			}
		}
		if(!RM)requestAnimationFrame(frame);else rafLive=false;
	}
	/* One-shot state-change flash: a recovery glows green, a drop fades to gray. */
	function flash(el,cls,ms){el.classList.add(cls);setTimeout(function(){if(el.isConnected)el.classList.remove(cls)},ms)}
	/* ---- build / patch the map ---- */
	/* Narrow screens: after the nodes are in the DOM, measure each label block and push nodes apart (and away from the hub) until no label, orb or the hub box overlaps another; keep all of them inside the screen. */
	/* ---- many nodes: size everything from the node count ---- */
	function QR(){return DENSE?76*HS:(MOB?92:118)}
	function QL(qs){return Math.max(HUBBOX/2*HS,queueLow(qs))+8}
	function mapRect(){var hd=document.querySelector('header'),bot=0,hi;
		/* Bottom reservation comes from the chrome that is actually on screen (legend, zoom controls, hint), not a guessed constant. Falls back to the previous constants where layout measurement is unavailable. */
		try{
			if(typeof getComputedStyle!=='function')throw 0;
			['.lg','#zc','.hint'].forEach(function(sel){var el=document.querySelector(sel);if(!el)return;var cs=getComputedStyle(el);if(cs.display==='none'||cs.visibility==='hidden')return;var r=el.getBoundingClientRect();if(r.height)bot=Math.max(bot,H-r.top)});
			bot+=8;
		}catch(e){bot=MOB?(W<=480?76:(H<720?110:190)):100}
		hi=H-bot;return {x0:10,x1:W-10,y0:Math.min(hi-64,Math.max(0,(hd&&hd.offsetHeight||0)+4)),y1:hi}}
	function syncClip(){
		var R=mapRect();
		vp.style.setProperty('--map-top',R.y0+'px');
		vp.style.setProperty('--map-bottom',Math.max(0,H-R.y1)+'px');
		return R;
	}
	function nodePicker(){
		var picker=$('find-node'),sig=JSON.stringify(V.nodes.map(function(n){return n.id}));
		if(sig===picker.getAttribute('data-node-options'))return;
		picker.setAttribute('data-node-options',sig);
		picker.hidden=!DENSE;
		if(picker.hidden)findClose(false);
		findItems=V.nodes.map(function(n){return {id:n.id,level:(n.status&&n.status.level)||'unknown'}});
		if(!$('find-pop').hidden)findRender();
	}
	/* ---- find node combobox + star focus (port of ha-zigbee-mesh-map's search dim/highlight and star mode).
	   One spotlight predicate owns all dimming; the map never moves while typing. ---- */
	var findItems=[],findMatches=[],findActive=-1,findQuery='',starId=null,starPrev=null;
	function findMatch(v){return !findQuery||v.id.toLowerCase().indexOf(findQuery)>=0}
	function lit(v){return nodeMatch(v)&&findMatch(v)&&(!starId||v.id===starId)}
	function findLevelColor(l){return l==='down'?'#ef4a5b':l==='degraded'?'#f0a52a':l==='healthy'?'#17b57e':'#b3b7cf'}
	function findRender(){
		findMatches=findItems.filter(function(it){return !findQuery||it.id.toLowerCase().indexOf(findQuery)>=0});
		if(findActive>=findMatches.length)findActive=findMatches.length-1;
		if(findActive<0&&findMatches.length)findActive=0;
		$('find-list').innerHTML=findMatches.length?findMatches.map(function(it,i){return '<li id="find-opt-'+i+'" role="option" aria-selected="'+(i===findActive)+'" data-id="'+esc(it.id)+'"><i class="fdot" style="background:'+findLevelColor(it.level)+'"></i>'+esc(it.id)+'</li>'}).join(''):'<li class="none" role="option" aria-selected="false" aria-disabled="true">No matching nodes</li>';
		$('find-q').setAttribute('aria-activedescendant',findMatches.length&&findActive>=0?'find-opt-'+findActive:'');
	}
	function findSetQuery(q){findQuery=q.trim().toLowerCase();findRender();applyFilters()}
	function findOpen(){
		if($('find-node').hidden||!$('find-pop').hidden)return;
		$('find-pop').hidden=false;$('find-btn').setAttribute('aria-expanded','true');
		findActive=0;$('find-q').value='';findSetQuery('');$('find-q').focus();
	}
	function findClose(restore){
		if($('find-pop').hidden)return;
		$('find-pop').hidden=true;$('find-btn').setAttribute('aria-expanded','false');
		$('find-q').value='';findQuery='';applyFilters();
		if(restore)$('find-btn').focus();
	}
	function findChoose(i){
		var it=findMatches[i];findClose(true);
		if(it&&!NEL[it.id]){EXP[gkey(cur(it.id))]=1;viewTouched=true;layout();syncClip()}
		if(it&&NEL[it.id]){starEnter(it.id);starCenter();openNode(it.id,NEL[it.id],$('find-btn'))}
	}
	/* star mode: isolate one node on the map (others dim through lit()), keep a pill with an explicit exit,
	   and restore the saved view on exit - the same contract as ha-zigbee-mesh-map's star pill. */
	function starEnter(id){
		if(!starId)starPrev={k:VW.k,x:VW.x,y:VW.y};
		starId=id;
		$('zc').classList.add('star');
		$('star-name').textContent=id;
		$('star-dot').style.background=findLevelColor((cur(id).status||{}).level||'unknown');
		$('star-pill').hidden=false;
		applyFilters();
	}
	function starCenter(){
		var el=starId&&NEL[starId];if(!el||!el.getBoundingClientRect)return;
		var r=el.getBoundingClientRect(),dx=W/2-(r.left+r.width/2),dy=H/2-(r.top+r.height/2);
		if(Math.hypot(dx,dy)<8)return;
		viewTouched=true;VW.x+=dx;VW.y+=dy;clampView();stage.classList.toggle('anim',!RM);applyView();
	}
	function starExit(restore){
		if(!starId)return;starId=null;
		$('zc').classList.remove('star');$('star-pill').hidden=true;
		if(restore&&starPrev){VW={k:starPrev.k,x:starPrev.x,y:starPrev.y};viewTouched=true;stage.classList.toggle('anim',!RM);applyView()}
		starPrev=null;applyFilters();
	}
	$('find-btn').onclick=function(){if($('find-pop').hidden)findOpen();else findClose(true)};
	$('star-x').onclick=function(){starExit(true)};
	$('find-q').addEventListener('input',function(){findActive=0;findSetQuery(this.value)});
	$('find-q').addEventListener('keydown',function(e){
		if(e.key==='ArrowDown'||e.key==='ArrowUp'){e.preventDefault();if(findMatches.length){findActive=(findActive+(e.key==='ArrowDown'?1:-1)+findMatches.length)%findMatches.length;findRender();var el=document.getElementById('find-opt-'+findActive);if(el&&el.scrollIntoView)el.scrollIntoView({block:'nearest'})}}
		else if(e.key==='Enter'){e.preventDefault();if(findMatches.length)findChoose(Math.max(0,findActive))}
		else if(e.key==='Escape'){e.preventDefault();e.stopPropagation();findClose(true)}
	});
	$('find-list').addEventListener('pointerdown',function(e){
		var li=e.target&&e.target.closest?e.target.closest('li[data-id]'):null;if(!li)return;e.preventDefault();
		for(var i=0;i<findMatches.length;i++)if(findMatches[i].id===li.getAttribute('data-id')){findChoose(i);break}
	});
	$('find-list').addEventListener('mousemove',function(e){
		var li=e.target&&e.target.closest?e.target.closest('li[data-id]'):null;if(!li)return;
		for(var i=0;i<findMatches.length;i++)if(findMatches[i].id===li.getAttribute('data-id')&&findActive!==i){findActive=i;findRender();break}
	});
	document.addEventListener('pointerdown',function(e){if(!e.target||!e.target.closest||!e.target.closest('#find-node'))findClose(false)});
	/* Roving tabindex among nodes (WAI-ARIA APG grid pattern): arrows move focus to the nearest node in that direction. */
	function nodeStep(el,key){
		var id=el.getAttribute('data-id'),p0=pos[id];if(!p0||!V)return;
		var vx=key==='ArrowLeft'?-1:key==='ArrowRight'?1:0,vy=key==='ArrowUp'?-1:key==='ArrowDown'?1:0,best=null,bs=1/0;
		V.units.forEach(function(v){if(v.id===id)return;var p=pos[v.id];if(!p)return;var dx=p.x-p0.x,dy=p.y-p0.y,d=Math.hypot(dx,dy);if(!d)return;var al=(dx*vx+dy*vy)/d;if(al<.45)return;var sc=d*(2-al);if(sc<bs){bs=sc;best=v.id}});
		if(!best)return;
		el.setAttribute('tabindex','-1');var n=NEL[best];n.setAttribute('tabindex','0');n.focus();
	}
	function boxAmt(a,b,M){return {ox:Math.min(a.x+a.hw,b.x+b.hw)-Math.max(a.x-a.hw,b.x-b.hw)+M,oy:Math.min(a.y+a.dn,b.y+b.dn)-Math.max(a.y-a.up,b.y-b.up)+M}}
	/* Overlap relief along the centre line, split by box area - the collide force from d3-force (ISC),
		generalized from circles to measured boxes via each box's support half-extent along the push axis.
		d3's random jiggle for coincident centres is replaced by a deterministic nudge so layout stays reproducible.
		Equal shares mark a free pair and the split then follows box area (the lighter box moves more);
		an explicit 1/0 share pins one box in place (the hub). */
	function boxPush(a,b,fa,fb,M){
		var o=boxAmt(a,b,M);if(o.ox<=0||o.oy<=0)return;
		var ax=a.x,ay=a.y+(a.dn-a.up)/2,bx=b.x,by=b.y+(b.dn-b.up)/2,dx=ax-bx,dy=ay-by,l=Math.sqrt(dx*dx+dy*dy);
		if(l<1e-4){dx=1;dy=1e-4;l=1}
		var ux=dx/l,uy=dy/l;
		var ha=a.hw*Math.abs(ux)+(a.up+a.dn)/2*Math.abs(uy)+M/2,hb=b.hw*Math.abs(ux)+(b.up+b.dn)/2*Math.abs(uy)+M/2;
		var ov=ha+hb-l;if(ov<=0)return;
		var wa=fa,wb=fb;
		if(fa===fb){var ma=2*a.hw*(a.up+a.dn),mb=2*b.hw*(b.up+b.dn);wa=mb/(ma+mb);wb=ma/(ma+mb)}
		a.x+=ux*ov*wa;a.y+=uy*ov*wa;b.x-=ux*ov*wb;b.y-=uy*ov*wb;
	}
	/* Hub-centred hierarchy: value-sorted concentric rings ported from cytoscape.js's concentric layout
		(MIT - levels sorted by value with higher values toward the centre, per-level sweep dTheta = 2pi/len,
		chord-based minimum radius, start angle 3pi/2, clockwise). The concentric value is attention: nodes that
		need eyes take the inner rings beside the hub. Rings are computed once per layout() from the status at
		that moment, so live status flips never move nodes; only a structural relayout re-ranks. The circle is
		then scaled into the elliptical map rect, and the shared collide pass resolves what the chords miss.
		Logic ported only; no dependency added. */
	function ringPlace(B,cx,cy,AX,AY,gap,rHub){
		var LV={fail:3,down:3,busy:2,idle:1},maxHalf=0;
		B.forEach(function(b,i){b.lv=LV[b.vis]||0;b.ord=i;maxHalf=Math.max(maxHalf,b.hw,(b.up+b.dn)/2)});
		B.sort(function(a,b){return b.lv-a.lv||a.ord-b.ord});
		var minDist=2*maxHalf+gap,r=rHub+maxHalf+gap,rOut=r;
		for(var i0=0;i0<B.length;){
			var lv=B[i0].lv,i1=i0;while(i1<B.length&&B[i1].lv===lv)i1++;
			var len=i1-i0,dT=len>1?2*Math.PI/len:0;
			if(len>1){var dc=Math.cos(dT)-1,ds=Math.sin(dT),rMin=Math.sqrt(minDist*minDist/(dc*dc+ds*ds));if(rMin>r)r=rMin}
			for(var j=i0;j<i1;j++){var t=3*Math.PI/2+dT*(j-i0);B[j].rx=r*Math.cos(t);B[j].ry=r*Math.sin(t)}
			rOut=r;r+=minDist;i0=i1;
		}
		B.forEach(function(b){b.x=cx+b.rx*AX/rOut;b.y=cy+b.ry*AY/rOut;delete b.rx;delete b.ry;delete b.lv;delete b.ord});
	}
	function setDense(ns,sc){
		NS=ns;HS=Math.max(.5,Math.min(1,ns/(MOB?104:132)));
		var nf=Math.max(10*sc,Math.min(15,ns*.115));
		stage.style.setProperty('--n',ns+'px');stage.style.setProperty('--hs',HS);
		stage.style.setProperty('--nf',nf+'px');stage.style.setProperty('--nf2',Math.max(9.5,nf*.75)+'px');
		BS=Math.min(1.3,Math.max(.7,ns/104,.75*sc));stage.style.setProperty('--bs',BS);stage.style.setProperty('--lw',Math.max(62,nf*6.4)+'px');
		stage.classList.toggle('dn',ns<76);
	}
	function packDense(R0){
		var N=V.units.length,M=8,cx=HUBP.x,cy=HUBP.y,ok=false,B,HB,ns,R=R0,sc,SC=[1,1.12,1.25,1.4,1.55,1.75,2,2.3,2.6];
		for(var si=0;N<=40&&si<SC.length&&!ok;si++){
			sc=SC[si];R={x0:cx-(cx-R0.x0)*sc,x1:cx+(R0.x1-cx)*sc,y0:cy-(cy-R0.y0)*sc,y1:cy+(R0.y1-cy)*sc};
			var floor=si===SC.length-1?30:48;
			for(ns=MOB?96:132;ns>=floor;ns-=4){
				setDense(ns,sc);
				B=V.units.map(function(v){
					var nm=NEL[v.id].querySelector('.nm')||{offsetWidth:0,offsetHeight:0};
					return {id:v.id,vis:v.vis,hw:Math.max(nm.offsetWidth/2,ns*.364,ns*.4+15*BS),up:Math.max(ns*.364,ns*.36+15*BS),dn:ns*.364+2+nm.offsetHeight,x:0,y:0};
				});
				var hr=QR()+16;
				HB={x:cx,y:cy,hw:hr,up:hr,dn:Math.max(hr,QL(V?V.queue.slice(0,9):null)+14)};
				var A=(R.x1-R.x0)/2,Bh=(R.y1-R.y0)/2;
				if(SEED){var r0=.3;B.forEach(function(b,i){var r=Math.sqrt(r0*r0+(1-r0*r0)*(i+.5)/N),t=i*2.39996+.6,sd=SEED[b.id];b.x=sd?sd.x:cx+r*A*.9*Math.cos(t);b.y=sd?sd.y:cy+r*Bh*.85*Math.sin(t)})}
				else ringPlace(B,cx,cy,A,Bh,M,hr);
				for(var it=0;it<140;it++){
					var dirty=false;
					function collide(a,b,fa,fb){
						var o=boxAmt(a,b,M);
						if(o.ox<=0||o.oy<=0)return;
						dirty=true;boxPush(a,b,fa,fb,M);
					}
					for(var i=0;i<N;i++){collide(B[i],HB,1,0);for(var j=i+1;j<N;j++)collide(B[i],B[j],.5,.5)}
					if(!dirty)break;
					B.forEach(function(b){b.x=Math.min(R.x1-b.hw,Math.max(R.x0+b.hw,b.x));b.y=Math.min(R.y1-b.dn,Math.max(R.y0+b.up,b.y))});
				}
				ok=true;
				for(var i2=0;i2<N&&ok;i2++){
					var oh=boxAmt(B[i2],HB,M-1);if(oh.ox>0&&oh.oy>0)ok=false;
					for(var j2=i2+1;j2<N&&ok;j2++){var o=boxAmt(B[i2],B[j2],M-1);if(o.ox>0&&o.oy>0)ok=false}
				}
				if(ok)break;
			}
		}
		/* Bounded solver. A spacious, deterministic grid is safer than returning overlapped boxes. */
		if(!ok){
			setDense(MOB?72:84,1);
			var cellW=132,cellH=112,cols=Math.max(2,Math.ceil(Math.sqrt(N*(R0.x1-R0.x0)/Math.max(64,R0.y1-R0.y0)))),rows=Math.ceil(N/cols);
			var w=cols*cellW,h=rows*cellH+130,lo=cx-w/2,top=cy-h/2;
			var HUP=top+48;
			R={x0:lo,x1:lo+w,y0:top,y1:top+h};HB={x:cx,y:HUP,hw:64,up:48,dn:80};HUBP={x:cx,y:HUP};
			var hub=document.getElementById('hubnode');if(hub){hub.style.top=HUP+'px'}
			sc=Math.max(1,w/Math.max(1,R0.x1-R0.x0),h/Math.max(1,R0.y1-R0.y0));
			B=V.units.map(function(v,i){
				return {id:v.id,hw:60,up:40,dn:53,x:lo+(i%cols+.5)*cellW,y:top+130+(Math.floor(i/cols)+.5)*cellH};
			});
		}
		/* fit view: scale 1/sc about the map centre so every node is on screen; the layout canvas is larger than the screen only when the screen cannot hold all labels at a readable size */
		var kf=1/sc;
		if(COARSE&&NS*kf<HIT_MIN){
			kf=HIT_MIN/NS;
			var av={};V.nodes.forEach(function(v){if(v.vis==='fail'||v.vis==='down')av[v.id]=1});
			var attn=B.filter(function(b){return av[b.id]})[0];
			FIT=attn?{k:kf,x:W/2-attn.x*kf,y:H/2-attn.y*kf}:{k:kf,x:cx*(1-kf),y:cy*(1-kf)};
		}else FIT={k:kf,x:cx*(1-kf),y:cy*(1-kf)};
		CB={x0:Math.min(R.x0,cx-HB.hw)-12,y0:Math.min(R.y0,cy-HB.up)-12,x1:Math.max(R.x1,cx+HB.hw)+12,y1:Math.max(R.y1,cy+HB.dn)+12};
		/* drift: each node may only wander half the clear gap to its neighbours, the hub and the canvas edge */
		B.forEach(function(b,i){
			if(!ok){DLIM[b.id]=0;return}
			var s=Math.min(b.x-b.hw-R.x0,R.x1-b.x-b.hw,b.y-b.up-R.y0,R.y1-b.y-b.dn)+6,h=boxAmt(b,HB,M);
			s=Math.min(s,2*Math.max(M-h.ox,M-h.oy));
			for(var j=0;j<B.length;j++){if(j===i)continue;var o=boxAmt(b,B[j],M);s=Math.min(s,Math.max(M-o.ox,M-o.oy))}
			DLIM[b.id]=Math.max(0,Math.min(1,((s-2)/2)/22));
		});
		B.forEach(function(b){var el=NEL[b.id];base[b.id]={x:b.x,y:b.y};pos[b.id]={x:b.x,y:b.y};el.style.left=b.x+'px';el.style.top=b.y+'px'});
	}
	/* ---- phone grid: hub on top, cards in rows; every size is measured, nothing overlaps by construction ---- */
	function grTok(name,fb){var v=parseFloat(getComputedStyle(stage).getPropertyValue(name));return isFinite(v)?v:fb}
	function gridMobile(R){
		var N=V.units.length,cx=W/2;
		HS=N>12?.5:N>6?.56:.62;
		var hb=150*HS,hy=R.y0+hb/2+4;
		HUBP={x:cx,y:hy};
		var hub=document.getElementById('hubnode');if(hub){hub.style.left=cx+'px';hub.style.top=hy+'px'}
		var NS0=N<=8?grTok('--gr-orb',76):N<=16?66:58;NS=NS0;
		stage.style.setProperty('--n',NS0+'px');stage.style.setProperty('--hs',HS);
		stage.style.setProperty('--nf','13px');stage.style.setProperty('--nf2','9.5px');
		stage.style.setProperty('--bs','.78');stage.style.setProperty('--lw',grTok('--gr-name-w',116)+'px');
		var gap=grTok('--gr-gap',10);
		var nameW=0,labelH=0;
		V.units.forEach(function(v){var nm=NEL[v.id].querySelector('.nm');if(!nm)return;
			var b=nm.querySelector('b');if(b)nameW=Math.max(nameW,Math.min(b.offsetWidth,grTok('--gr-name-w',116)));
			labelH=Math.max(labelH,nm.offsetHeight)});
		var cellW=Math.max(NS0,nameW)+gap,cellH=NS0+2+labelH+gap;
		var cols=Math.max(1,Math.min(N,Math.floor((R.x1-R.x0+gap)/cellW)));
		if(N>8)cols=Math.max(2,cols);
		var gw=cols*cellW-gap,gx=cx-gw/2;
		var gy=hy+hb/2+(V.queue.length?grTok('--gr-queue-h',34):grTok('--gr-hub-gap',6)+8);
		V.units.forEach(function(v,i){
			var x=gx+(i%cols+.5)*cellW,y=gy+Math.floor(i/cols)*cellH+NS0/2;
			base[v.id]={x:x,y:y};pos[v.id]={x:x,y:y};DLIM[v.id]=0;
			var el=NEL[v.id];el.style.left=x+'px';el.style.top=y+'px';
		});
		var rows=Math.ceil(N/cols);
		CB={x0:gx-12,y0:R.y0-4,x1:gx+gw+12,y1:gy+(rows-1)*cellH+cellH-gap+8};
		var kf=Math.min(1,(R.x1-R.x0)/(CB.x1-CB.x0),(R.y1-R.y0)/(CB.y1-CB.y0));
		var cmx=(CB.x0+CB.x1)/2,cmy=(CB.y0+CB.y1)/2;
		FIT={k:kf,x:(R.x0+R.x1)/2-cmx*kf,y:(R.y0+R.y1)/2-cmy*kf};
	}
	/* ---- zoom and pan: the map layer is one transformed element; scale 1 is the fit view ---- */
	function clampView(){
		var pad=40;
		function ax(lo,hi,len,t){var a=len-hi*VW.k,b=-lo*VW.k,mn=Math.min(a,b)-pad,mx=Math.max(a,b)+pad;return Math.min(mx,Math.max(mn,t))}
		VW.x=ax(CB.x0,CB.x1,W,VW.x);VW.y=ax(CB.y0,CB.y1,H,VW.y);
	}
	function applyView(){
		stage.style.transform='translate('+r1(VW.x)+'px,'+r1(VW.y)+'px) scale('+Math.round(VW.k*1000)/1000+')';
		var font=parseFloat(stage.style.getPropertyValue?stage.style.getPropertyValue('--nf'):'')||15;
		stage.classList.toggle('overview',DENSE&&font*VW.k<OVERVIEW_PX);
		$('zg').hidden=!(CM&&Object.keys(EXP).length);
		vp.setAttribute('data-zoom',String(Math.round(VW.k*1000)/1000));
		$('zv').textContent=Math.round(VW.k/FIT.k*100)+'%';vp.setAttribute('data-fit',String(Math.round(FIT.k*1000)/1000));
		$('zi').setAttribute('aria-disabled',VW.k>=KMAX-.001?'true':'false');
		$('zo').setAttribute('aria-disabled',VW.k<=KMIN+.001?'true':'false');
	}
	function zoomAt(cx,cy,f,anim){
		var nk=Math.min(KMAX,Math.max(KMIN,VW.k*f));if(nk===VW.k)return;
		viewTouched=true;
		var q=nk/VW.k;VW.x=cx-(cx-VW.x)*q;VW.y=cy-(cy-VW.y)*q;VW.k=nk;
		stage.classList.toggle('anim',!!anim&&!RM);applyView();tip.classList.remove('on');scheduleAuto();
	}
	function fitView(){viewTouched=false;stage.classList.toggle('anim',!RM);if(Object.keys(EXP).length){EXP=Object.create(null);layout();syncClip()}VW={k:FIT.k,x:FIT.x,y:FIT.y};applyView()}
	var ptrs={},pan=null,pinch=null,moved=false,lastTap={t:0,x:0,y:0};
	function ptrIds(){return Object.keys(ptrs)}
	function interactive(t){return !!(t&&t.closest&&t.closest('.node,.hub,.q'))}
	vp.addEventListener('wheel',function(e){
		e.preventDefault();
		var d=e.deltaY*(e.deltaMode===1?33:e.deltaMode===2?400:1);
		zoomAt(e.clientX,e.clientY,Math.min(2,Math.max(.5,Math.exp(-d*(e.ctrlKey?.01:.0016)))),false);
	},{passive:false});
	vp.addEventListener('pointerdown',function(e){
		if(e.pointerType==='mouse'&&e.button!==0)return;
		if(!ptrIds().length)moved=false;
		ptrs[e.pointerId]={x:e.clientX,y:e.clientY};
		var ids=ptrIds();
		if(ids.length===1){pan={id:e.pointerId,sx:e.clientX,sy:e.clientY,ox:VW.x,oy:VW.y,on:false,t:e.target}}
		else if(ids.length===2){
			var a=ptrs[ids[0]],b=ptrs[ids[1]],c={x:(a.x+b.x)/2,y:(a.y+b.y)/2};
			pinch={d0:Math.hypot(a.x-b.x,a.y-b.y)||1,k0:VW.k,wx:(c.x-VW.x)/VW.k,wy:(c.y-VW.y)/VW.k};
			pan=null;moved=true;stage.classList.remove('anim');tip.classList.remove('on');
		}
	});
	addEventListener('pointermove',function(e){
		if(!ptrs[e.pointerId])return;
		ptrs[e.pointerId]={x:e.clientX,y:e.clientY};
		var ids=ptrIds();
		if(pinch&&ids.length>=2){
			var a=ptrs[ids[0]],b=ptrs[ids[1]],c={x:(a.x+b.x)/2,y:(a.y+b.y)/2};
			var nk=Math.min(KMAX,Math.max(KMIN,pinch.k0*Math.hypot(a.x-b.x,a.y-b.y)/pinch.d0));
			viewTouched=true;VW.k=nk;VW.x=c.x-pinch.wx*nk;VW.y=c.y-pinch.wy*nk;clampView();applyView();scheduleAuto();return;
		}
		if(pan&&pan.id===e.pointerId){
			var dx=e.clientX-pan.sx,dy=e.clientY-pan.sy;
			if(!pan.on&&Math.hypot(dx,dy)>6){pan.on=true;moved=true;stage.classList.remove('anim');vp.classList.add('grab');tip.classList.remove('on');hovN=null}
			if(pan.on){viewTouched=true;VW.x=pan.ox+dx;VW.y=pan.oy+dy;clampView();applyView()}
		}
	});
	function endPtr(e){
		if(!ptrs[e.pointerId])return;
		var wasPan=pan&&pan.id===e.pointerId?pan:null;
		delete ptrs[e.pointerId];
		var ids=ptrIds();
		if(pinch&&ids.length<2){pinch=null;if(ids.length===1){var q=ptrs[ids[0]];pan={id:+ids[0],sx:q.x,sy:q.y,ox:VW.x,oy:VW.y,on:false,t:null}}}
		if(wasPan){
			if(!wasPan.on&&e.type==='pointerup'&&e.pointerType!=='mouse'&&!interactive(wasPan.t)){
				var now=Date.now();
				if(now-lastTap.t<320&&Math.hypot(e.clientX-lastTap.x,e.clientY-lastTap.y)<30){fitView();lastTap.t=0}
				else lastTap={t:now,x:e.clientX,y:e.clientY};
			}
			pan=null;
		}
		if(!ids.length){vp.classList.remove('grab');setTimeout(function(){moved=false},60)}
	}
	addEventListener('pointerup',endPtr);addEventListener('pointercancel',endPtr);
	vp.addEventListener('click',function(e){if(moved){e.stopPropagation();e.preventDefault()}},true);
	vp.addEventListener('dblclick',function(e){if(!interactive(e.target))fitView()});
	$('zi').onclick=function(){zoomAt(W/2,H/2,1.25,true)};
	$('zo').onclick=function(){zoomAt(W/2,H/2,1/1.25,true)};
	$('zr').onclick=fitView;
	document.addEventListener('keydown',function(e){
		if(mode||e.ctrlKey||e.metaKey||e.altKey)return;
		var t=e.target,tg=t&&t.tagName;
		if(!t||!t.closest||!t.closest('#stage,#zc'))return;if(tg==='INPUT'||tg==='TEXTAREA'||tg==='SELECT'||(t&&t.isContentEditable))return;
		if(e.key==='Escape'){if(starId){e.preventDefault();starExit(true)}return}
		if(e.key==='+'||e.key==='='){e.preventDefault();zoomAt(W/2,H/2,1.25,true)}
		else if(e.key==='-'||e.key==='_'){e.preventDefault();zoomAt(W/2,H/2,1/1.25,true)}
		else if(e.key==='0'){e.preventDefault();fitView()}
	});
	/* Measured trigger: group only when the full layout cannot keep labels at the readable size the overview state already uses. */
	function effFont(){return (parseFloat(stage.style.getPropertyValue('--nf'))||15)*FIT.k}
	function layout(){
		if(!V)return;
		var pf=document.activeElement,rn=pf&&pf.getAttribute?pf.getAttribute('data-id'):null,wh0=lastWH;
		SEED=seedFor();
		CM=false;mkUnits();layoutPass(rn);
		if(canGroup()&&effFont()<OVERVIEW_PX){CM=true;mkUnits();lastWH=wh0;layoutPass(rn)}
		stage.classList.toggle('gp',CM);
		PREV={};PREVWH=innerWidth+'x'+innerHeight;for(var k in base)PREV[k]={x:base[k].x,y:base[k].y};SEED=null;
	}
	/* Opening or closing a group keeps every other unit where it was: members start around their group bubble, a new bubble starts at its members' centre. Only valid for the same viewport. */
	function seedFor(){
		if(!PREV||PREVWH!==innerWidth+'x'+innerHeight)return null;
		var sd={},idx={};
		function at(v){var q=PREV[v.id];if(q)return q;q=PREV['cl:'+gkey(v)];if(!q)return null;var j=idx[gkey(v)]=(idx[gkey(v)]||0)+1,a=j*2.39996,r=Math.sqrt(j)*40;return {x:q.x+r*Math.cos(a),y:q.y+r*Math.sin(a)}}
		var grp={};
		V.nodes.forEach(function(v){var q=at(v);if(q){sd[v.id]=q;var g=grp[gkey(v)]||(grp[gkey(v)]={x:0,y:0,n:0,pos:{}});if(PREV[v.id]){g.x+=q.x;g.y+=q.y;g.n++}}});
		Object.keys(grp).forEach(function(k){var g=grp[k];if(g.n&&!PREV['cl:'+k])sd['cl:'+k]={x:g.x/g.n,y:g.y/g.n}});
		return sd;
	}
	function layoutPass(restoreNode){
		W=innerWidth;H=innerHeight;MOB=W<700;
		var N=V.units.length,ND=V.nodes.length;
		NS=MOB?(ND>6?84:104):(ND>6?104:132);
		document.documentElement.style.setProperty('--n',NS+'px');
		DENSE=ND>6;stage.classList.toggle('sc',DENSE);stage.classList.toggle('gr',MOB);stage.classList.toggle('calm',ND>18);stage.classList.remove('dn');HS=1;DLIM=Object.create(null);FIT={k:1,x:0,y:0};CB={x0:0,y0:0,x1:W,y1:H};
		['--n','--hs','--nf','--nf2','--bs','--lw'].forEach(function(p){stage.style.setProperty(p,'')});
		var R=syncClip();nodePicker();
		var oldPos=pos;BO=Object.create(null);
		stage.querySelectorAll('.node,.hub,.q,.ql').forEach(function(e){e.remove()});
		links.innerHTML='';linkDirty=[];NEL=Object.create(null);LNK=Object.create(null);base=Object.create(null);pos=Object.create(null);off=Object.create(null);nodeSig=Object.create(null);
		var cx=W/2,cy=Math.max(R.y0+45,Math.min(H/2+18,R.y1-45)),rx=Math.min(W*.34,440),ry=Math.min(H*.3,230);
		if(DENSE){cx=(R.x0+R.x1)/2;cy=(R.y0+R.y1)/2}
		var ang=V.units.map(function(_,i){return N===1?Math.PI/2:(-90-180/N+i*360/N)*Math.PI/180});
		if(N===4&&!MOB)ang=[-150,-30,150,30].map(function(a){return a*Math.PI/180});
		if(MOB&&!DENSE){var top=R.y0,bot=H-R.y1;MTOP=top;MBOT=bot;cy=(top+H-bot)/2;var dy=Math.max(0,Math.min(190,(H-bot-top)/2-NS/2-34)),dx=Math.max(0,Math.min(150,W/2-NS/2-10));rx=dx*1.4142;ry=dy*1.4142/1.15}
		HUBP={x:cx,y:cy};
		var hub=document.createElement('div');hub.className='hub'+(V.lease&&V.lease.state!=='held'?' exp':'');hub.id='hubnode';
		hub.setAttribute('role','button');hub.setAttribute('tabindex','0');hub.setAttribute('aria-label','Open hub overview');
		hub.style.left=cx+'px';hub.style.top=cy+'px';
		hub.innerHTML='<i class="halo"></i><i class="r"></i><i class="r"></i><i class="r"></i><div class="core"><svg width="36" height="36" viewBox="0 0 36 36" fill="none" stroke="#5b5bf0" stroke-width="1.6" stroke-linecap="round"><circle cx="18" cy="18" r="4"/><circle cx="18" cy="5" r="2"/><circle cx="29" cy="24" r="2"/><circle cx="7" cy="24" r="2"/><path d="M18 14V7M21.5 20l6 3M14.5 20l-6 3"/></svg></div>';
		stage.appendChild(hub);
		hub.onclick=function(e){openHub(hub)};
		hub.onkeydown=function(e){if(e.key==='Enter'||e.key===' '){e.preventDefault();openHub(hub)}};
		/* Per-end arrowheads: marker-end (node side) reports hub-to-node, the flipped marker-start (hub side) reports node-to-hub. Shape and fill separate observed (filled triangle), stale (filled diamond) and never checked (hollow triangle). */
		var LKMK=[['ok','M1 2L10 6L1 10z',9,'M11 2L2 6L11 10z',3],['wait','M6 1L11 6L6 11L1 6z',10,'M6 1L11 6L6 11L1 6z',2],['unk','M1 2L10 6L1 10z',9,'M11 2L2 6L11 10z',3]];
		var L='<defs>';
		LKMK.forEach(function(m){
			L+='<marker id="lk-me-'+m[0]+'" markerUnits="userSpaceOnUse" markerWidth="12" markerHeight="12" refX="'+m[2]+'" refY="6" orient="auto"><path d="'+m[1]+'" class="mk-'+m[0]+'"/></marker>';
			L+='<marker id="lk-ms-'+m[0]+'" markerUnits="userSpaceOnUse" markerWidth="12" markerHeight="12" refX="'+m[4]+'" refY="6" orient="auto"><path d="'+m[3]+'" class="mk-'+m[0]+'"/></marker>';
		});
		L+='</defs>';
		V.units.forEach(function(v,i){
			var x=Math.min(W-NS/2-8,Math.max(NS/2+8,cx+Math.cos(ang[i])*rx)),y=cy+Math.sin(ang[i])*ry*1.15;
			base[v.id]={x:x,y:y};pos[v.id]={x:x,y:y};off[v.id]={x:0,y:0,vx:0,vy:0,hx:0,hy:0};
			var el=document.createElement('div');el.className=nodeCls(v,!knownIds[v.id]);el.style.setProperty('--ad',(.3+Math.min(i,5)*.08)+'s');el.style.left=x+'px';el.style.top=y+'px';el.setAttribute('data-id',v.id);
			el.setAttribute('role','button');el.setAttribute('tabindex','-1');el.setAttribute('aria-label',v.cluster?groupLabel(v):'Open '+v.id);if(v.cluster)el.setAttribute('aria-expanded','false');
			el.innerHTML=nodeBody(v);stage.appendChild(el);
			/* The label block (name, OS, state chips) hangs below the orb; keep its bottom inside the map band or the chips are clipped away. */
			var nm=el.querySelector('.nm'),dnh=nm?nm.offsetTop+nm.offsetHeight:NS;
			if(y+dnh>R.y1||y-NS/2<R.y0){y=Math.min(R.y1-dnh,Math.max(R.y0+NS/2,y));base[v.id].y=y;pos[v.id].y=y;el.style.top=y+'px'}
			NEL[v.id]=el;nodeSig[v.id]=nodeKey(v);pvis[v.id]=v.vis;if(knownIds[v.id])el.classList.remove('in');knownIds[v.id]=1;
			L+='<g data-n="'+esc(v.id)+'" class="fadein"><linearGradient id="lkg'+i+'" gradientUnits="userSpaceOnUse"><stop offset="0" class="gs-unk"/><stop offset="1" class="gs-unk"/></linearGradient><path id="lk'+i+'" class="lk" stroke="url(#lkg'+i+')"/><path class="hit" id="lkh'+i+'"/></g>';
		});
		links.innerHTML=L;
		if(DENSE)packDense(R);else if(MOB)gridMobile(R);
		/* Layout changes: the node box, label and number balloons jump straight to the new spot (spacing never slides); only the orb and ring glide over from the previous spot. */
		V.units.forEach(function(v){
			var b=base[v.id];if(!b)return;
			pos[v.id]={x:b.x,y:b.y};
			var el=NEL[v.id];el.style.left=b.x+'px';el.style.top=b.y+'px';
			if(!RM&&oldPos[v.id]){var gdx=oldPos[v.id].x-b.x,gdy=oldPos[v.id].y-b.y;
				if(gdx*gdx+gdy*gdy>4){BO[v.id]={x:gdx,y:gdy};el.classList.add('gl');el.style.setProperty('--gdx',r1(gdx)+'px');el.style.setProperty('--gdy',r1(gdy)+'px')}}
		});
		V.units.forEach(function(v,i){
			var lg=document.getElementById('lkg'+i);
			LNK[v.id]={p:document.getElementById('lk'+i),h:document.getElementById('lkh'+i),g:lg,s0:lg.firstChild,s1:lg.lastChild,sig:''};
		});
		qSig='';paintQueue();patchStatus();bindMap();V.nodes.forEach(function(v){setDrift(v.raw)});paint();
		layoutSig=layoutKey();
		if(mode==='node'&&sheetAnchor&&sheetAnchor!==$('find-node')&&NEL[sheetNode])sheetAnchor=NEL[sheetNode];
		if(mode==='hub')sheetAnchor=hub;
		if(!mode&&restoreNode&&NEL[restoreNode]&&NEL[restoreNode].focus)NEL[restoreNode].focus({preventScroll:true});
		var wh=W+'x'+H;KMIN=FIT.k*.5;KMAX=Math.max(1.15,FIT.k*4);
		if(wh!==lastWH||!viewTouched){lastWH=wh;VW={k:FIT.k,x:FIT.x,y:FIT.y}}
		else VW.k=Math.min(KMAX,Math.max(KMIN,VW.k));
		clampView();applyView();applyFilters();
	}
	function layoutKey(){var header=document.querySelector('header');return JSON.stringify([V.units.map(function(v){return [v.id,v.os]}),innerWidth,innerHeight,header&&header.offsetHeight||0])}
	function paintQueue(){
		var k=JSON.stringify(V.queue.map(function(t){return t.id}));
		if(k===qSig)return;qSig=k;
		stage.querySelectorAll('.q,.ql').forEach(function(e){e.remove()});
		var qs=V.queue.slice(0,9);
		if(!MOB)qs.forEach(function(t,i){
			var q=document.createElement('div');q.className='q';q.setAttribute('data-q',t.id);
			var a=(-90+(i-(qs.length-1)/2)*50)*Math.PI/180;
			q.style.left=HUBP.x+Math.cos(a)*QR()+'px';q.style.top=HUBP.y+Math.sin(a)*QR()+'px';
			q.textContent=String(i+1);
			q.onmouseenter=function(){showTip(q,tipQ(t))};q.onmouseleave=function(){tip.classList.remove('on')};
			stage.appendChild(q);
		});
		if(!V.queue.length)return;
		var ql=document.createElement('div');
		if(MOB){
			ql.className='ql pill';ql.style.left=HUBP.x+'px';ql.style.top=(HUBP.y+HUBBOX/2*HS+6)+'px';
			ql.textContent=V.queue.length+' queued';
			ql.setAttribute('role','button');ql.setAttribute('tabindex','0');ql.setAttribute('aria-label','Open hub overview, '+V.queue.length+' queued');
			ql.onclick=function(){var h=$('hubnode');if(h)openHub(h)};
		}else{
			ql.className='ql';ql.style.left=HUBP.x+'px';ql.style.top=HUBP.y+QL(qs)+'px';
			ql.textContent='Queue · '+V.queue.length+' waiting'+(V.queue.length>qs.length?' (showing '+qs.length+')':'');
		}
		stage.appendChild(ql);
	}
	/* Colors and classes follow live status; no element is rebuilt for a status change. */
	/* Single-responsibility link renderer: path-down dots first, per-direction SSH state from real data fields, a static dash while a dispatch is in flight, and a one-shot pulse on a confirmed state change only. Nothing is rebuilt for a status change. */
	function patchLink(v){
		var g=LNK[v.id];if(!g||!g.p)return;
		var out=v.out?v.out.s:'unk',inn=v.inn?v.inn.s:'unk',down=v.vis==='down',go=v.disp&&!down;
		var sig=[down,out,inn,go].join();
		if(sig===g.sig)return;
		var first=g.sig==='';g.sig=sig;
		g.p.setAttribute('class','lk'+(down?' down':'')+(go?' go':''));
		g.p.setAttribute('marker-end','url(#lk-me-'+out+')');
		g.p.setAttribute('marker-start','url(#lk-ms-'+inn+')');
		g.s0.setAttribute('class','gs-'+inn);g.s1.setAttribute('class','gs-'+out);
		if(g.h)g.h.setAttribute('aria-label',(down?'Path down. ':'')+'SSH hub to '+v.id+': '+SSL[out]+'. '+v.id+' to hub: '+SSL[inn]);
		if(!first)g.p.classList.add('pulse');
	}
	function patchStatus(){
		V.units.forEach(function(v){patchLink(v)});
		var hub=document.getElementById('hubnode');if(hub)hub.className='hub'+(V.lease&&V.lease.state!=='held'?' exp':'');
	}
	function updateMap(){
		/* The first layout measures node labels and the header; before the embedded fonts
		   finish loading those metrics come from fallback fonts, and the solved positions
		   jump (or start outside the map) when the real faces arrive. Defer only the first
		   map build until fonts settle; a 900ms cap bounds the wait. */
		if(!fontsReady){mapDeferred=true;return}
		mkUnits();
		if(layoutKey()!==layoutSig){layout();return}
		V.units.forEach(function(v){
			var el=NEL[v.id];if(!el)return;
			var k=nodeKey(v);
			if(nodeSig[v.id]!==k){
				var ov=pvis[v.id];pvis[v.id]=v.vis;
				nodeSig[v.id]=k;el.className=nodeCls(v);el.innerHTML=nodeBody(v);
				if(v.cluster)el.setAttribute('aria-label',groupLabel(v));
				if(!RM&&ov&&ov!==v.vis){
					if(v.vis==='down')flash(el,'dropin',950);
					else if(ov==='down'||ov==='fail')flash(el,'reco',1500);
				}
			}
		});
		paintQueue();patchStatus();
		if(V.nodes.length)V.nodes.forEach(function(v){if(v.raw.resources!==undefined)setDrift(v.raw)});
	}
	/* ---- tips ---- */
	function sshRows(v){
		if(!v.out)return '<div class="tt" style="margin-top:6px"><div class="sh">SSH</div><div class="none">No SSH route evidence available.</div></div>';
		function row(t,dir,x){return '<div class="sr"><b>'+t+'</b><span><i class="dt '+x.s+'"></i>'+x.label+(x.chk?' · '+ago2(x.chk):'')+'</span></div>'}
		return '<div class="tt" style="margin-top:6px"><div class="sh">SSH</div>'+row('Hub <span class="arr">→</span> node','out',v.out)+row('Node <span class="arr">→</span> hub','in',v.inn)+'</div>';
	}
	function tasksOfNode(id){return (last&&last.tasks||[]).filter(function(t){return t.nodeId===id&&(t.held||RUN[t.phase]||UNKNOWN[t.phase]||t.phase==='approval_required'||t.phase==='completed_unverified')})}
	var ST={down:'Down',fail:'Needs eyes',busy:'Working',idle:'Standing by'};
	function nodeTip(v){
		var r=v.raw.resources,ts=tasksOfNode(v.id),st=v.status.level==='degraded'?'Degraded':v.status.level==='unknown'?'Health unknown':stLabel(v);
		if(v.raw.enabled===false)st='Paused'+(v.status.level==='healthy'?'':' · '+st);
		else if(v.raw.draining===true)st='Draining'+(v.status.level==='healthy'?'':' · '+st);
		var col=v.vis==='down'||v.vis==='fail'?'#c4303f':v.status.level==='degraded'?'#8a5206':'#3d3dc8';
		return '<h3>'+esc(v.id)+'<em style="color:'+col+'">'+esc(st)+'</em></h3><div class="kv"><span>OS</span><b>'+esc(OSN[v.os]||v.os)+' '+esc(v.arch)+'</b><span>Marked active</span><b>'+v.raw.currentLoad+'</b>'+(r&&r.ok&&r.cpuPct!=null?'<span>CPU</span><b>'+Math.round(r.cpuPct)+'%</b>':'')+'</div>'+
			(r&&r.ok&&r.cpuPct!=null?'<div class="ld"><i style="width:'+Math.min(100,r.cpuPct)+'%"></i></div>':'')+
			'<div class="tt">'+(ts.length?ts.slice(0,3).map(function(t){var p=phaseLabel(t);return '<div><b>'+esc(t.title||t.key)+'</b><span>'+esc(p[1])+'</span></div>'}).join('')+(ts.length>3?'<div class="none">+'+(ts.length-3)+' more</div>':''):'<div class="none">Nothing assigned</div>')+'</div>'+sshRows(v);
	}
	function tipQ(t){var p=phaseLabel(t);return '<h3>Queued '+esc(t.key)+'<em style="color:#3d3dc8">Waiting</em></h3><div class="tt" style="border:0"><div><b>'+esc(t.title||t.key)+'</b><span>'+esc(t.placement&&t.placement.summary?t.placement.summary:p[1])+'</span></div></div>'}
	function linkTip(v){
		function row(t,x){return '<div class="lr"><b><i class="dt '+x.s+'"></i>'+t+'</b><span>'+x.label+(x.chk?' · checked '+ago2(x.chk):' · never checked from this side')+'</span></div>'}
		return '<h3>'+esc(v.id)+'<span class="arr" style="font-size:14px">↔</span>hub<em style="color:#3d3dc8">SSH</em></h3><div class="tt" style="border:0">'+row('Hub <span class="arr">→</span> '+esc(v.id),v.out)+row(esc(v.id)+' <span class="arr">→</span> hub',v.inn)+'</div>';
	}
	function showTip(el,html){
		if(MOB){var rr=el.getBoundingClientRect();return mobTip(rr.top+rr.height/2,html)}
		tip.style.width='';tip.innerHTML=html;var r=el.getBoundingClientRect(),th=tip.offsetHeight,x=r.right+14;
		if(x+300>W-16)x=r.left-314;
		tip.style.left=x+'px';tip.style.top=Math.max(90,Math.min(H-th-16,r.top+r.height/2-th/2))+'px';tip.classList.add('on');
	}
	function showTipAt(x,y,html){
		if(MOB)return mobTip(y,html);
		tip.style.width='';tip.innerHTML=html;var th=tip.offsetHeight,px=x+18;if(px+300>W-16)px=x-318;
		tip.style.left=px+'px';tip.style.top=Math.max(90,Math.min(H-th-16,y-th/2))+'px';tip.classList.add('on');
	}
	function mobTip(ay,html){tip.style.width=(W-24)+'px';tip.innerHTML=html;var th=tip.offsetHeight;tip.style.left='12px';tip.style.top=(ay>H/2?12:H-th-14)+'px';tip.classList.add('on')}
	function hotLane(id,on){var g=LNK[id];if(!g||!g.p)return;g.p.classList.toggle('hot',on)}
	/* Roving tabindex over the links: only the focused node's link (first node by default) is in the tab order, so N links cost one Tab stop. */
	var LKROVE=null;
	function rove(id){LKROVE=id;V.units.forEach(function(v){var g=LNK[v.id];if(g&&g.h)g.h.setAttribute('tabindex',v.id===id?'0':'-1')})}
	function bindMap(){
		if(!V.units.some(function(v){return v.id===LKROVE}))LKROVE=V.units.length?V.units[0].id:null;
		V.units.forEach(function(v){
			var el=NEL[v.id];if(!el)return;
			if(v.cluster){
				el.onmouseenter=function(){if(lastPT==='touch')return;hovN=v.id;off[v.id].hx=off[v.id].x;off[v.id].hy=off[v.id].y;showTip(el.querySelector('.orb'),groupTip(curU(v.id)));hotLane(v.id,true)};
				el.onmouseleave=function(){hovN=null;tip.classList.remove('on');hotLane(v.id,false)};
				el.onclick=function(){openGroup(v.id)};
				el.onkeydown=function(e){if(e.key==='Enter'||e.key===' '){e.preventDefault();openGroup(v.id)}};
				var gg=LNK[v.id];
				if(gg&&gg.h){
					gg.h.onmouseenter=function(e){hotLane(v.id,true);showTipAt(e.clientX,e.clientY,groupLinkTip(curU(v.id)))};
					gg.h.onmousemove=function(e){showTipAt(e.clientX,e.clientY,groupLinkTip(curU(v.id)))};
					gg.h.onmouseleave=function(){hotLane(v.id,false);tip.classList.remove('on')};
				}
				return;
			}
			el.onmouseenter=function(){if(lastPT==='touch')return;hovN=v.id;off[v.id].hx=off[v.id].x;off[v.id].hy=off[v.id].y;showTip(el.querySelector('.orb'),nodeTip(cur(v.id)));hotLane(v.id,true)};
			el.onmouseleave=function(){hovN=null;tip.classList.remove('on');hotLane(v.id,false)};
			el.onclick=function(e){
				if(lastPT==='touch'&&tapped!==v.id){tapped=v.id;hovN=v.id;showTip(el.querySelector('.orb'),nodeTip(cur(v.id)));return}
				tapped=null;openNode(v.id,el);
			};
			el.onkeydown=function(e){if(e.key==='Enter'||e.key===' '){e.preventDefault();openNode(v.id,el)}else if(e.key.slice(0,5)==='Arrow'){e.preventDefault();nodeStep(el,e.key)}};
			el.onfocus=function(){rove(v.id)};
			var g=LNK[v.id];
			if(g&&g.h){
				g.h.setAttribute('tabindex',v.id===LKROVE?'0':'-1');g.h.setAttribute('role','button');
				/* One activation path for pointer and keyboard; without pointer coordinates the tip anchors to the link itself. */
				var openLink=function(e){hotLane(v.id,true);if(e&&e.clientX)showTipAt(e.clientX,e.clientY,linkTip(cur(v.id)));else showTip(g.h,linkTip(cur(v.id)))};
				g.h.onfocus=function(){rove(v.id);openLink()};
				g.h.onblur=function(){hotLane(v.id,false);tip.classList.remove('on')};
				g.h.onclick=openLink;
				g.h.onkeydown=function(e){if(e.key==='Enter'||e.key===' '){e.preventDefault();openLink()}};
				g.h.onmouseenter=function(e){hotLane(v.id,true);showTipAt(e.clientX,e.clientY,linkTip(cur(v.id)))};
				g.h.onmousemove=function(e){showTipAt(e.clientX,e.clientY,linkTip(cur(v.id)))};
				g.h.onmouseleave=function(){hotLane(v.id,false);tip.classList.remove('on')};
			}
		});
	}
	function curU(id){for(var i=0;i<V.units.length;i++)if(V.units[i].id===id)return V.units[i];return V.units[0]}
	function groupTip(u){
		var idle=u.n-u.busyN-u.degN-u.unkN;
		return '<h3>'+esc(OSN[u.os]||u.os)+' · '+esc(u.arch)+'<em style="color:#3d3dc8">Group</em></h3><div class="kv"><span>Nodes</span><b>'+u.n+'</b><span>Working</span><b>'+u.busyN+'</b><span>Marked active</span><b>'+u.raw.currentLoad+'</b>'+(u.degN?'<span>Degraded</span><b>'+u.degN+'</b>':'')+(u.unkN?'<span>Not confirmed</span><b>'+u.unkN+'</b>':'')+'</div>'+
			'<div class="tt"><div class="none">Down and at-risk nodes are never grouped. Open the group to see each node.</div></div>'+groupSsh(u);
	}
	function groupSsh(u){
		if(!u.out)return '<div class="tt" style="margin-top:6px"><div class="sh">SSH</div><div class="none">No SSH route evidence available.</div></div>';
		function row(t,x){return '<div class="sr"><b>'+t+'</b><span><i class="dt" style="background:'+COL[x.s]+'"></i>'+x.label+(x.count<x.total?' · '+x.count+' of '+x.total:'')+(x.chk?' · '+ago2(x.chk):'')+'</span></div>'}
		return '<div class="tt" style="margin-top:6px"><div class="sh">SSH · worst of group</div>'+row('Hub <span class="arr">→</span> node',u.out)+row('Node <span class="arr">→</span> hub',u.inn)+'</div>';
	}
	function groupLinkTip(u){return '<h3>'+esc(OSN[u.os]||u.os)+' '+esc(u.arch)+'<span class="arr" style="font-size:14px">↔</span>hub<em style="color:#3d3dc8">SSH</em></h3>'+groupSsh(u)}
	/* Open one group: only its healthy nodes appear individually, then the view frames them. */
	function focusIds(ids){
		var R=mapRect(),x0=1e9,y0=1e9,x1=-1e9,y1=-1e9;
		ids.forEach(function(id){var p=base[id],el=NEL[id];if(!p||!el)return;var nm=el.querySelector('.nm'),lh=nm?nm.offsetHeight:60;x0=Math.min(x0,p.x-NS*.6);x1=Math.max(x1,p.x+NS*.6);y0=Math.min(y0,p.y-NS*.45);y1=Math.max(y1,p.y+NS*.4+lh)});
		if(x1<x0)return;
		var k=Math.max(FIT.k,Math.min(KMAX,(W-24)/(x1-x0),(R.y1-R.y0-16)/(y1-y0)),Math.min(KMAX,HIT*1.02/NS));
		VW.k=k;VW.x=W/2-(x0+x1)/2*k;VW.y=(R.y0+R.y1)/2-(y0+y1)/2*k;
		viewTouched=true;stage.classList.toggle('anim',!RM);clampView();applyView();
	}
	function openGroup(id){
		var u=curU(id);if(!u||!u.cluster)return;
		var ids=u.members.map(function(m){return m.id});
		EXP[u.key]=1;viewTouched=true;tip.classList.remove('on');hovN=null;tapped=null;
		layout();syncClip();focusIds(ids);
		var f=NEL[ids[0]];if(f&&f.focus)f.focus({preventScroll:true});
	}
	function hasExp(){return CM&&Object.keys(EXP).length>0}
	function collapseGroups(){
		if(!Object.keys(EXP).length)return;
		var k=Object.keys(EXP)[0];
		EXP=Object.create(null);viewTouched=false;stage.classList.toggle('anim',!RM);tip.classList.remove('on');
		layout();syncClip();VW={k:FIT.k,x:FIT.x,y:FIT.y};applyView();
		var u=V.units.filter(function(x){return x.cluster&&x.key===k})[0],f=u&&NEL[u.id];if(f&&f.focus)f.focus({preventScroll:true});
	}
	$('zg').onclick=collapseGroups;
	/* Zooming in on a group opens it once the group's nodes could be drawn at the readable cell size inside the view. */
	function autoOpen(){
		if(!CM||mode||(pan&&pan.on)||pinch)return;
		var R=mapRect(),cx=W/2,cy=(R.y0+R.y1)/2,best=null,bd=1e9,dia0=NS*.728;
		V.units.forEach(function(u){
			if(!u.cluster)return;var p=pos[u.id];if(!p)return;
			var sx=VW.x+p.x*VW.k,sy=VW.y+p.y*VW.k;
			if(sx<0||sx>W||sy<R.y0||sy>R.y1)return;
			var need=Math.min(Math.sqrt(u.n)*GROUP_CELL,.8*Math.min(W,R.y1-R.y0),.9*dia0*KMAX);
			if(dia0*VW.k<need)return;
			var d=Math.hypot(sx-cx,sy-cy);if(d<bd){bd=d;best=u}
		});
		if(best)openGroup(best.id);
	}
	function scheduleAuto(){clearTimeout(zt);zt=setTimeout(autoOpen,220)}
	function cur(id){for(var i=0;i<V.nodes.length;i++)if(V.nodes[i].id===id)return V.nodes[i];return V.nodes[0]}
	/* ---- sheet ---- */
	function laneRows(v){
		if(!v.out)return '';
		/* Each direction is a tabbable group so keyboard users keep the per-direction state the map links no longer all carry. */
		function cell(x,t){return '<div class="lc" tabindex="0" role="group" aria-label="'+esc(t)+' SSH: '+esc(x.label)+'. '+esc(x.chk?'Checked '+ago2(x.chk):'Never checked from this side')+'"><small>'+t+'</small><span><i class="dt" style="background:'+COL[x.s]+'"></i>'+x.label+'</span><em>'+(x.chk?'Checked '+ago2(x.chk):'Never checked from this side')+'</em></div>'}
		return '<h4 style="margin-top:30px">SSH channel</h4><div class="sc"><b>hub</b>'+cell(v.out,'Out →')+cell(v.inn,'In ←')+'</div><p class="note">Only hub-initiated resource streams are observed. Node to node and node to hub are not measured, so they are never shown as connected.</p>';
	}
	function callout(v){
		var s=v.status,ts=v.risk.taskIds.map(function(id){return findTask(id)}).filter(Boolean);
		if(s.level!=='down'&&!ts.length)return '';
		var h='<div class="co">';
		if(s.level==='down')h+='<div class="cot"><i class="nchip dn"><u></u>Down</i><span>'+esc(lvlReason(s.reasons[0]))+(v.raw.probe&&v.raw.probe.checkedAt?'. Last probe '+esc(ago2(Date.parse(v.raw.probe.checkedAt))):'')+'.</span></div><p>This node did not answer a recent check. That does not prove the device is off.</p>';
		else h+='<div class="cot"><i class="nchip rk">'+WARN_ICON+'At risk</i><span>Some tasks on this node need a look.</span></div>';
		if(ts.length)h+='<div class="cor"><svg width="14" height="14" viewBox="0 0 10 10"><path d="M5 1L9.3 8.6H.7z" fill="none" stroke="#a8680a" stroke-width="1.1" stroke-linejoin="round"/><path d="M5 4v2M5 7.2v.1" stroke="#a8680a" stroke-width="1.1" stroke-linecap="round"/></svg><span>'+ts.map(function(t){return '<b>'+esc(t.key)+'</b>'}).join(', ')+' need verification'+'. '+(ts.some(function(t){return UNKNOWN[t.phase]})?'The outcome is unknown, so ':'Progress cannot be confirmed, so ')+'the task stays held for you. Nothing is re-sent or re-placed.</span></div>';
		return h+'</div>';
	}
	function sheetHtml(v){
		var n=v.raw,ts=tasksOfNode(v.id),s=v.status,adm=n.admission;
		var health=s.level==='healthy'?'':'<span>Health</span><b style="color:'+(s.level==='down'?'#b42a3a':'#8a5206')+'">'+(s.level==='down'?'Down':s.level==='degraded'?'Degraded':s.level==='unknown'?'Unknown':'Paused')+' · '+esc(s.reasons.map(lvlReason).join(', '))+'</b>';
		var sub=(s.level==='degraded'?'Degraded':s.level==='unknown'?'Health unknown':stLabel(v));
		if(n.enabled===false)sub='Paused'+(s.level==='healthy'?'':' · '+sub);
		else if(n.draining===true)sub='Draining'+(s.level==='healthy'?'':' · '+sub);
		return '<div class="dl"><div class="big"><div class="node '+v.vis+'">'+orbHtml(v)+'</div></div><h2>'+esc(v.id)+'</h2><p class="s">'+esc(sub)+' · '+esc(OSN[v.os]||v.os)+' '+esc(v.arch)+'</p>'+
			'<div class="kv"><span>Marked active</span><b>'+n.currentLoad+'</b><span>Held, not running</span><b>'+n.heldNotRunning+'</b><span>SDK / Model</span><b>'+(n.sdkReady&&n.modelReady?'Ready':'Not ready')+'</b><span>New work</span><b>'+(adm?(adm.open?'Open':'Held · '+esc(adm.reasons.map(reasonLabel).join(', '))):'Sampling off')+'</b>'+health+(v.risk.count?'<span>Tasks at risk</span><b>'+v.risk.count+'</b>':'')+'<span>Lifetime tasks</span><b>'+n.assignedTotal+'</b><span>Wins / Trouble</span><b>'+n.succeeded+' / '+n.troubled+'</b></div></div>'+
			'<div class="dr">'+callout(v)+'<div class="rsec"><h4>Resources</h4><div data-res="'+esc(v.id)+'">'+resHtml(n)+'</div></div><h4>Assigned work · '+ts.length+'</h4>'+
			(ts.length?ts.map(function(t,i){
				var p=phaseLabel(t),d=detailCache[t.id],why=d&&d.selection&&d.selection.reason?WHY[d.selection.reason]||d.selection.reason:null,bad=p[0]==='bad'||UNKNOWN[t.phase];
				return '<div class="wk"><span class="no">'+String(i+1).padStart(2,'0')+'</span><span class="ph'+(bad?' r':'')+'">'+esc(p[1])+'</span><b>'+esc(t.title||t.key)+'</b><div class="why">'+esc(t.key)+' · Why here <u>'+(why?esc(why):(d?'Not recorded (assigned before reasons were kept)':'Loading…'))+'</u></div><div class="pg"><i style="width:'+Math.max(4,Math.min(100,(t.stageIndex+1)/7*100))+'%"></i></div></div>';
			}).join(''):'<div class="empty">Nothing assigned. Ready for whatever comes next.</div>')+laneRows(v)+'</div>';
	}
	function renderSheet(){
		if(mode!=='node'||!V)return;
		var v=null;for(var i=0;i<V.nodes.length;i++)if(V.nodes[i].id===sheetNode)v=V.nodes[i];
		if(!v){closeSheet();return}
		tasksOfNode(v.id).slice(0,12).forEach(function(t){if(!detailCache[t.id]&&!detailLoad[t.id]&&!detailError[t.id])loadDetail(t.id)});
		var n=Object.assign({},v.raw);delete n.resources;
		var key=JSON.stringify([n,v.status,v.risk,v.out,v.inn,v.vis,tasksOfNode(v.id).map(function(t){return [t.id,t.phase,t.stageIndex,t.title,!!detailCache[t.id],detailCache[t.id]&&detailCache[t.id].selection&&detailCache[t.id].selection.reason]})]);
		if(key===sheetSig)return;
		sheetSig=key;dw.innerHTML=sheetHtml(v);applyRes(v.raw);
	}
	function openAt(el,anchor){
		tapped=null;hovN=null;tip.classList.remove('on');
		var r=el.getBoundingClientRect();sheet.style.setProperty('--cx',r.left+r.width/2+'px');sheet.style.setProperty('--cy',r.top+r.height/2+'px');
		sheetAnchor=anchor||el;veil.classList.add('on');sheet.classList.add('on');sheet.removeAttribute('inert');sheet.setAttribute('aria-hidden','false');
		setSnap(MOB?'peek':'full');
		var close=$('cl');if(close.focus)close.focus({preventScroll:true});
	}
	function openNode(id,el,anchor){mode='node';sheetNode=id;sheetSig=null;sheet.setAttribute('data-mode','node');renderSheet();openAt(el,anchor)}
	function openHub(el){mode='hub';sheetNode=null;sheet.setAttribute('data-mode','hub');openAt(el)}
	function closeSheet(){
		if(!mode)return;
		var anchor=sheetAnchor;
		mode=null;tapped=null;hovN=null;sheetAnchor=null;
		tip.classList.remove('on');sheet.classList.remove('on');veil.classList.remove('on');
		snapState=null;sheetDrag=null;sheet.removeAttribute('data-snap');sheet.style.transform='';
		sheet.setAttribute('aria-hidden','true');sheet.setAttribute('inert','');
		if(anchor&&anchor.isConnected&&anchor.focus)anchor.focus({preventScroll:true});
	}
	/* ---- mobile sheet snap states: peek / full / dismiss.
		Pattern source: viliket/pure-web-bottom-sheet (MIT): snap points, swipe-to-dismiss, safe-area inset.
		Its scroll-container + CSS scroll-snap architecture was not ported - this sheet is one transformed
		element, so snap points are transform offsets and a handle drag settles to the nearest one.
		Peek height is measured from the summary block at open time, never a fixed px. ---- */
	/* peek bounds as viewport-height fractions; flickV = px/ms velocity that skips one snap; tapPx = tap/drag split */
	var SNAP={minPeek:.3,maxPeek:.6,flickV:.4,tapPx:6},snapState=null,sheetDrag=null;
	function snapPeekPx(){
		var wrap=$(mode==='hub'?'hubw':'dw'),block=wrap&&wrap.querySelector(mode==='hub'?'.runtime':'.dl');
		var h=(block?block.offsetHeight:0)+34+44; /* dwrap padding-top + grab strip */
		return Math.min(H*SNAP.maxPeek,Math.max(H*SNAP.minPeek,h));
	}
	function setSnap(s){
		snapState=s;sheet.setAttribute('data-snap',s);veil.classList.toggle('peek',s==='peek');
		if(s==='peek')sheet.style.setProperty('--sheet-peek',Math.round(snapPeekPx())+'px');
	}
	function snapOffsets(){var h=sheet.offsetHeight||1;return {full:0,peek:Math.max(0,h-snapPeekPx()),closed:h*1.05}}
	function sheetOffsetNow(){
		var m=/translateY\((-?[\d.]+)px\)/.exec(sheet.style.transform||'');
		if(m)return parseFloat(m[1]);
		var o=snapOffsets();return snapState==='full'?o.full:o.peek;
	}
	(function(){
		var grab=$('grab');if(!grab)return;
		grab.addEventListener('pointerdown',function(e){
			if(!MOB||!mode)return;
			sheetDrag={y:e.clientY,t:e.timeStamp,off:sheetOffsetNow()};
			sheet.classList.add('drag');
			try{grab.setPointerCapture(e.pointerId)}catch(x){}
			e.preventDefault();
		});
		grab.addEventListener('pointermove',function(e){
			if(!sheetDrag)return;
			var o=snapOffsets(),off=Math.min(o.closed,Math.max(o.full,sheetDrag.off+e.clientY-sheetDrag.y));
			sheet.style.transform='translateY('+off+'px)';
		});
		function settle(e){
			if(!sheetDrag)return;
			var d=sheetDrag;sheetDrag=null;sheet.classList.remove('drag');
			var dist=e.clientY-d.y,o=snapOffsets(),off=Math.min(o.closed,Math.max(o.full,d.off+dist));
			sheet.style.transform='';veil.classList.remove('peek');
			if(Math.abs(dist)<SNAP.tapPx){setSnap(snapState==='full'?'peek':'full');return}
			var v=dist/Math.max(1,e.timeStamp-d.t);
			if(v>SNAP.flickV){if(snapState==='full')setSnap('peek');else closeSheet();return}
			if(v<-SNAP.flickV){setSnap('full');return}
			var best='peek',bd=Infinity;
			[['full',o.full],['peek',o.peek],['closed',o.closed]].forEach(function(p){var dd=Math.abs(off-p[1]);if(dd<bd){bd=dd;best=p[0]}});
			if(best==='closed')closeSheet();else setSnap(best);
		}
		grab.addEventListener('pointerup',settle);
		grab.addEventListener('pointercancel',settle);
		grab.addEventListener('keydown',function(e){
			if(!MOB||!mode)return;
			if(e.key==='Enter'||e.key===' '){e.preventDefault();setSnap(snapState==='full'?'peek':'full')}
		});
	})();
	veil.onclick=closeSheet;$('cl').onclick=closeSheet;
	document.addEventListener('keydown',function(e){
		if(!mode)return;
		if(e.key==='Escape'){e.preventDefault();closeSheet();return}
		if(e.key!=='Tab')return;
		var stops=Array.from(sheet.querySelectorAll('button:not([disabled]),a[href],input:not([disabled]),select:not([disabled]),[tabindex="0"]')).filter(function(el){return el.getClientRects().length>0});
		if(!stops.length)return;
		var first=stops[0],last=stops[stops.length-1],cur=document.activeElement;
		if((e.shiftKey&&(cur===first||!sheet.contains(cur)))||(!e.shiftKey&&(cur===last||!sheet.contains(cur)))){e.preventDefault();(e.shiftKey?last:first).focus()}
	});
	document.addEventListener('pointerdown',function(e){lastPT=e.pointerType},true);
	document.addEventListener('click',function(e){if(tapped&&e.target.closest&&!e.target.closest('.node')&&!e.target.closest('#sheet')){tapped=null;hovN=null;tip.classList.remove('on')}});
	document.addEventListener('mousemove',function(e){var b=$('spot').style;b.setProperty('--mx',e.clientX+'px');b.setProperty('--my',e.clientY+'px')});
	try{$('hint').textContent=(matchMedia('(pointer:coarse)').matches||innerWidth<700)?'Tap to peek. Tap again to go deeper. Tap the hub for every task.':'Hover to peek. Click a node to go deeper. Click the hub for every task.'}catch(e){}
	function render(d){
		recvAt=Date.now();
		renderAdmin(d);
		V=buildView(d);
		head();
		updateMap();syncClip();
		renderFilters();applyFilters();
		renderSheet();
	}
	function relayoutIfNeeded(){
		if(!fontsReady){if(V)mapDeferred=true;return}
		if(V&&layoutKey()!==layoutSig){layout();syncClip()}
	}
	addEventListener('resize',relayoutIfNeeded);
	var mapHeader=document.querySelector('header');
	if(mapHeader&&typeof ResizeObserver==='function')new ResizeObserver(relayoutIfNeeded).observe(mapHeader);
	// Embedded font swaps can alter node letters even if the header happens to keep its height.
	function fontsSettled(){if(fontsReady)return;fontsReady=true;if(V&&mapDeferred){mapDeferred=false;updateMap();syncClip()}}
	if(document.fonts&&document.fonts.ready){
		document.fonts.ready.then(function(){var deferred=mapDeferred;fontsSettled();if(V&&!deferred){layout();syncClip()}});
		setTimeout(fontsSettled,900);
	}else fontsReady=true;
	startLoop();
	function tick(){
		tickHead();if(V)relayoutIfNeeded();
		if(!lastCheck){$('rt-age').textContent='';return}
		var sec=Math.max(0,Math.round((Date.now()-lastCheck)/1000));
		$('rt-age').textContent=sec<2?'Just checked':ago2(Date.now()-sec*1000)+' checked';
	}
	function alive(){
		fails=0;lastMsg=Date.now();document.body.classList.remove('stale');
		if(connState==='loading')setConn('live',new Date().toTimeString().slice(0,8),'Dashboard live');
		else if(connState==='live'&&Date.now()>=clockHold)$('clock').textContent=new Date().toTimeString().slice(0,8);
		if(wsGaveUp){wsGaveUp=false;wsRetry=0;connect()}
	}
	function down(){document.body.classList.add('stale')}
	/* Error is not loading: only before the first state arrives, say the hub cannot be reached. */
	function connErr(){
		if(last)return;
		var ov=$('ov');ov.className='ov unk';ov.setAttribute('data-testid','pill-unreachable');$('ov-t').textContent='Unreachable';
		$('hl').innerHTML='Hub unreachable.<br><b>Retrying automatically</b>';
		var ids=['tasks','nodes','sessions'];
		for(var i=0;i<ids.length;i++){var el=$(ids[i]);if(el&&el.querySelector&&el.querySelector('.skel'))el.innerHTML='<div class="empty">Could not load the fleet state. Retrying automatically.</div>'}
	}

	function poll(){
		if(pollPending)return;pollPending=true;
		fetch('/api/state',{cache:'no-store'}).then(function(r){if(!r.ok)throw new Error(r.status);return r.json()}).then(function(d){
			alive();render(d);
		}).catch(function(){if(++fails>=2){down();connErr()}}).finally(function(){pollPending=false});
	}
	/* Live channel: full state every 2s plus each node's resource sample as it arrives. Polling is the fallback.
	 * Reconnect timing follows the partysocket pattern (github.com/cloudflare/partykit, ISC license):
	 * exponential backoff with jitter, a per-episode retry cap, a handshake timeout, and a retry-count
	 * reset once a connection stays up for a while. Reimplemented inline - no vendored code, no dependencies.
	 * The header pill shows connection state and changes only on real connection events
	 * (first data, open, close, scheduled retry, recovery), never on a timer-made-up state. */
	var WS_CFG={
		minDelayMs:1000,      /* first retry delay */
		growFactor:1.6,       /* backoff growth per attempt */
		maxDelayMs:15000,     /* backoff ceiling */
		jitterRatio:0.3,      /* +/- randomization so reconnects do not arrive as a stampede */
		maxRetries:8,         /* per outage episode; the polling fallback stays on meanwhile */
		connectTimeoutMs:4000,/* a hung handshake counts as a failed attempt */
		minUptimeMs:5000,     /* a connection this stable resets the retry count */
		reconnectedTextMs:6000/* how long "Reconnected" shows before the clock returns */
	};
	var ws=null,wsRetry=0,wsTimer=0,wsOpenTimer=0,wsStableTimer=0,wsGaveUp=false,hadOutage=false,clockHold=0,connState='loading';
	function wsNextDelayMs(){
		var base=Math.min(WS_CFG.maxDelayMs,WS_CFG.minDelayMs*Math.pow(WS_CFG.growFactor,Math.max(0,wsRetry-1)));
		var spread=base*WS_CFG.jitterRatio;
		return Math.round(base-spread+Math.random()*2*spread);
	}
	function announce(t){var sr=$('live-sr');if(sr&&sr.textContent!==t)sr.textContent=t}
	function setConn(s,txt,say){
		if(s===connState)return;
		connState=s;
		var live=$('live');
		live.classList.toggle('wait',s==='loading'||s==='connecting');
		live.classList.toggle('retry',s==='retry');
		live.classList.toggle('off',s==='offline');
		if(txt!=null)$('clock').textContent=txt;
		if(say)announce(say);
	}
	function scheduleReconnect(){
		wsOk=false;
		if(wsRetry>=WS_CFG.maxRetries){wsGaveUp=true;setConn('offline','Offline','Live channel offline. Updates continue by periodic refresh.');return}
		wsRetry++;hadOutage=true;
		var wait=wsNextDelayMs(),sec=Math.max(1,Math.round(wait/1000));
		setConn('retry',(MOB?'Retry ':'Retrying in ')+sec+'s','Connection lost. Retrying in '+sec+' seconds');
		wsTimer=setTimeout(connect,wait);
	}
	function connect(){
		clearTimeout(wsTimer);wsTimer=0;
		if(connState!=='loading')setConn('connecting','Connecting…','Connecting to the live channel');
		var sock;
		try{sock=new WebSocket((location.protocol==='https:'?'wss://':'ws://')+location.host+'/ws')}catch(e){scheduleReconnect();return}
		ws=sock;
		clearTimeout(wsOpenTimer);
		wsOpenTimer=setTimeout(function(){wsOpenTimer=0;if(sock.readyState!==WebSocket.OPEN)try{sock.close()}catch(e){}},WS_CFG.connectTimeoutMs);
		sock.onopen=function(){
			if(sock!==ws)return;
			clearTimeout(wsOpenTimer);wsOpenTimer=0;wsOk=true;
			clearTimeout(wsStableTimer);
			wsStableTimer=setTimeout(function(){wsRetry=0},WS_CFG.minUptimeMs);
			if(connState==='loading')return;/* first data, not the bare handshake, ends the loading state */
			if(hadOutage){hadOutage=false;clockHold=Date.now()+WS_CFG.reconnectedTextMs;setConn('live','Reconnected','Connection restored')}
			else setConn('live',new Date().toTimeString().slice(0,8),'Live channel connected');
		};
		sock.onmessage=function(e){
			if(sock!==ws)return;
			var m;try{m=JSON.parse(e.data)}catch(x){return}
			alive();
			if(m.type==='state')render(m.state);
			else if(m.type==='resources'&&last)for(var i=0;i<last.nodes.length;i++)if(last.nodes[i].id===m.nodeId){last.nodes[i].resources=m.resources;applyRes(last.nodes[i])}
		};
		sock.onclose=function(){
			if(sock!==ws)return;
			clearTimeout(wsOpenTimer);wsOpenTimer=0;clearTimeout(wsStableTimer);
			ws=null;scheduleReconnect();
		};
	}
	poll();connect();
	setInterval(function(){if(!wsOk)poll();else if(lastMsg&&Date.now()-lastMsg>8000)poll()},3000);
	setInterval(tick,1000);
})();
</script>
</body>
</html>`;
