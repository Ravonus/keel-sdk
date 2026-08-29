/**
 * Keel verification chrome — the standard on-chain proof surface.
 *
 * An invisible bar on the left edge that shows on hover; click it and a panel
 * slides out with everything Keel knows about what is being rendered: the
 * proof summary, the checks, storage sources, verified resources, token
 * identity, version commitments, the object trail, staking, contract facets.
 * A failed check takes over the frame in red, because a silent failure is worse
 * than no seal at all.
 *
 * The point is that it is forced. The work is wrapped *in* the verifier, so a
 * marketplace cannot display the art without executing the check — rendering
 * and verifying are the same act, and no one has to opt in or be told to trust
 * a bespoke badge. The chrome is sandboxed from the content it wraps, so the
 * content cannot fake its own proof.
 *
 * Same markup, same CSS, same behaviour everywhere. A reader who has seen it
 * once knows what it means. This is the default action for anything wrapped —
 * even a plain PNG upload — not something a creator has to wire up.
 *
 * Extracted verbatim from the Vault viewer, where it was tangled with a game.
 *
 *   import { mountKeelVerification } from "@keel/viewer/verification-chrome";
 *   mountKeelVerification({ result, runtime, context });
 *   // push your own rows into the panel:
 *   mountKeelVerification({ ..., extraRows: [{ key: "Edition", value: "3 of 25" }] });
 */

export const KEEL_VERIFICATION_CSS = '\n      :root{color-scheme:dark;font:14px Inter,ui-sans-serif,system-ui,sans-serif;background:#030706;color:#effff9;--verify:#67f6c5;--verify-rgb:103,246,197;--verify-ink:#06120e;--scene-a:#173b32;--scene-b:#07110f;--scene-c:#020504;--scene-grid-rgb:103,246,197;--scene-canvas-filter:none}*{box-sizing:border-box}html,body{margin:0;width:100%;height:100%;overflow:hidden}body{background:radial-gradient(circle at 50% 42%,var(--scene-a) 0,var(--scene-b) 38%,var(--scene-c) 76%);transition:background .55s ease}button{font:inherit}main{position:relative;width:100%;height:100%;display:grid;place-items:center}.grid{position:absolute;inset:0;opacity:.16;background-image:linear-gradient(rgba(var(--scene-grid-rgb),.72) 1px,transparent 1px),linear-gradient(90deg,rgba(var(--scene-grid-rgb),.72) 1px,transparent 1px);background-size:28px 28px;mask-image:radial-gradient(circle,#000,transparent 72%)}html[data-vault-scene=grid] .grid{inset:-28px;will-change:transform;contain:strict}html[data-vault-scene=constellation] .grid{opacity:.28;background-image:radial-gradient(circle,rgba(var(--scene-grid-rgb),.9) 0 1px,transparent 1.5px),radial-gradient(circle,rgba(var(--scene-grid-rgb),.5) 0 1px,transparent 1.4px);background-position:0 0,21px 17px;background-size:52px 52px,73px 73px}html[data-vault-scene=reactor] .grid{opacity:.2;background-image:repeating-conic-gradient(from 45deg at 50% 50%,rgba(var(--scene-grid-rgb),.42) 0 1deg,transparent 1deg 15deg),repeating-radial-gradient(circle at 50% 50%,rgba(var(--scene-grid-rgb),.48) 0 1px,transparent 1px 42px);background-size:auto;mask-image:radial-gradient(circle,#000 0 58%,transparent 78%)}html[data-vault-scene=void-horizon] .grid{opacity:.2;background-image:linear-gradient(0deg,rgba(var(--scene-grid-rgb),.66) 1px,transparent 1px),linear-gradient(115deg,transparent 0 48%,rgba(var(--scene-grid-rgb),.32) 49%,transparent 51%);background-size:100% 34px,96px 96px;transform:perspective(420px) rotateX(58deg) scale(1.5);transform-origin:50% 74%;mask-image:linear-gradient(transparent 9%,#000 42%,transparent 91%)}canvas{width:min(94vmin,720px);height:min(94vmin,720px);image-rendering:pixelated;position:relative;z-index:1;outline:none;filter:var(--scene-canvas-filter);transition:filter .5s ease,opacity .5s ease}.identity{position:absolute;z-index:2;left:clamp(16px,4vw,44px);bottom:clamp(34px,5vw,58px);pointer-events:none;transition:opacity .35s ease,transform .35s ease}.eyebrow{margin:0 0 7px;color:#67f6c5;font-size:10px;font-weight:900;letter-spacing:.16em;text-transform:uppercase}.identity h1{margin:0;font-size:clamp(22px,4vw,46px);letter-spacing:-.05em}.traits{margin-top:9px;color:#9cb5ad;font:11px ui-monospace,SFMono-Regular,monospace}.hint{position:absolute;right:clamp(16px,4vw,44px);bottom:clamp(16px,4vw,40px);z-index:2;color:#769188;font-size:10px;text-transform:uppercase;letter-spacing:.12em}body.ready .eyebrow{filter:drop-shadow(0 0 9px #67f6c5)}\n      .verify-corner{position:absolute;z-index:8;left:0;bottom:0;width:clamp(76px,11vw,112px);height:clamp(76px,11vw,112px);display:flex;align-items:flex-end;justify-content:flex-start;padding:clamp(13px,2.5vw,24px);pointer-events:auto}.verify-seal{--seal-alpha:.16;display:grid;grid-template-columns:30px 0fr;align-items:center;width:36px;height:36px;padding:2px;border:1px solid rgba(var(--verify-rgb),var(--seal-alpha));border-radius:999px;background:rgba(3,12,9,.34);color:var(--verify);opacity:.22;overflow:hidden;cursor:pointer;box-shadow:0 0 0 1px rgba(255,255,255,.025) inset,0 0 22px rgba(var(--verify-rgb),.04);backdrop-filter:blur(9px);transition:opacity .35s ease,width .45s cubic-bezier(.2,.85,.25,1),grid-template-columns .45s cubic-bezier(.2,.85,.25,1),border-color .35s ease,background .35s ease,box-shadow .35s ease}.verify-corner:hover .verify-seal,.verify-seal:focus-visible,.verify-seal[aria-expanded=true]{--seal-alpha:.62;grid-template-columns:30px 1fr;width:96px;opacity:1;background:rgba(3,16,12,.88);box-shadow:0 0 28px rgba(var(--verify-rgb),.18)}.verify-seal:focus-visible{outline:2px solid #fff;outline-offset:3px}.seal-mark{position:relative;width:30px;height:30px;display:grid;place-items:center;flex:none}.seal-mark::before{content:"";width:17px;height:20px;border:1.5px solid currentColor;border-radius:9px 9px 11px 11px;clip-path:polygon(50% 0,94% 19%,86% 72%,50% 100%,14% 72%,6% 19%);background:rgba(var(--verify-rgb),.08);box-shadow:0 0 14px currentColor}.seal-mark::after{content:"";width:7px;height:4px;border-left:1.5px solid currentColor;border-bottom:1.5px solid currentColor;transform:translateY(-1px) rotate(-45deg)}.seal-label{min-width:0;white-space:nowrap;overflow:hidden;font-size:9px;font-weight:900;letter-spacing:.16em}.verify-backdrop{position:absolute;z-index:9;inset:0;border:0;background:rgba(0,3,2,.56);opacity:0;pointer-events:none;transition:opacity .4s ease}.verify-panel{position:absolute;z-index:10;left:clamp(10px,2vw,24px);bottom:clamp(10px,2vw,24px);width:min(440px,calc(100% - clamp(20px,4vw,48px)));max-height:min(680px,calc(100% - clamp(20px,4vw,48px)));display:flex;flex-direction:column;border:1px solid rgba(var(--verify-rgb),.26);border-radius:24px;background:linear-gradient(145deg,rgba(10,25,20,.985),rgba(3,8,7,.985));box-shadow:0 28px 90px rgba(0,0,0,.72),0 0 50px rgba(var(--verify-rgb),.08);opacity:0;transform:translateY(22px) scale(.975);pointer-events:none;overflow:hidden;transition:opacity .35s ease,transform .5s cubic-bezier(.18,.86,.24,1)}body.verify-open .verify-backdrop{opacity:1;pointer-events:auto}body.verify-open .verify-panel{opacity:1;transform:none;pointer-events:auto}body.verify-open .identity{opacity:.16;transform:translateY(-8px)}.verify-head{display:flex;align-items:flex-start;gap:14px;padding:22px 22px 17px;border-bottom:1px solid rgba(255,255,255,.08)}.verify-orb{position:relative;width:42px;height:42px;display:grid;place-items:center;border-radius:50%;color:var(--verify);background:rgba(var(--verify-rgb),.09);border:1px solid rgba(var(--verify-rgb),.32);box-shadow:0 0 24px rgba(var(--verify-rgb),.1)}.verify-copy{min-width:0;flex:1}.verify-kicker{margin:0 0 5px;color:var(--verify);font-size:9px;font-weight:900;letter-spacing:.16em;text-transform:uppercase}.verify-title{margin:0;font-size:20px;line-height:1.08;letter-spacing:-.035em}.verify-summary{margin:7px 0 0;color:#a0b6ae;font-size:11px;line-height:1.45}.verify-close{width:34px;height:34px;border:0;border-radius:50%;background:rgba(255,255,255,.06);color:#d9e8e3;cursor:pointer;font-size:19px;transition:background .2s ease,transform .2s ease}.verify-close:hover{background:rgba(255,255,255,.13);transform:rotate(6deg)}.verify-scroll{padding:16px 18px 20px;overflow:auto;overscroll-behavior:contain}.verify-section{margin:0 0 14px;padding:14px;border:1px solid rgba(255,255,255,.075);border-radius:16px;background:rgba(255,255,255,.025)}.verify-section:last-child{margin-bottom:0}.verify-section h3{margin:0 0 11px;color:#cde1da;font-size:10px;letter-spacing:.13em;text-transform:uppercase}.verify-row{display:grid;grid-template-columns:minmax(105px,.8fr) minmax(0,1.2fr);gap:12px;padding:7px 0;border-top:1px solid rgba(255,255,255,.055);font-size:10px;line-height:1.35}.verify-row:first-of-type{border-top:0}.verify-key{color:#718c83}.verify-value{color:#d9e8e3;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;overflow-wrap:anywhere;text-align:right}.verify-check{display:grid;grid-template-columns:9px 1fr;align-items:start;gap:9px;padding:7px 0;border-top:1px solid rgba(255,255,255,.055);font-size:10px}.verify-check:first-of-type{border-top:0}.verify-dot{width:7px;height:7px;margin-top:3px;border-radius:50%;background:var(--verify);box-shadow:0 0 10px rgba(var(--verify-rgb),.55)}.verify-check small{display:block;margin-top:2px;color:#748d85;line-height:1.35}.verify-footer{display:flex;align-items:center;justify-content:space-between;gap:10px;padding:12px 20px 14px;border-top:1px solid rgba(255,255,255,.07);color:#668078;font-size:9px}.verify-footer strong{color:#91a9a1;letter-spacing:.08em;text-transform:uppercase}.verify-alert{position:absolute;z-index:7;inset:clamp(12px,2.5vw,28px);display:none;place-items:center;padding:clamp(22px,5vw,64px);border:2px solid #ff4d5e;border-radius:22px;background:repeating-linear-gradient(135deg,rgba(110,0,13,.88) 0,rgba(110,0,13,.88) 22px,rgba(72,0,8,.92) 22px,rgba(72,0,8,.92) 44px);box-shadow:0 0 0 5px rgba(255,45,68,.13),0 0 80px rgba(255,0,32,.22);text-align:center}.verify-alert-copy{max-width:720px}.verify-alert-kicker{margin:0;color:#fff;font-size:clamp(11px,2vw,16px);font-weight:1000;letter-spacing:.22em;text-transform:uppercase}.verify-alert h2{margin:10px 0 12px;color:#fff;font-size:clamp(38px,9vw,96px);line-height:.82;letter-spacing:-.07em;text-transform:uppercase;text-shadow:0 5px 0 rgba(60,0,8,.5)}.verify-alert p{margin:0 auto 20px;max-width:600px;color:#ffdce0;font-size:clamp(13px,2vw,18px);line-height:1.45}.verify-alert button{border:1px solid rgba(255,255,255,.55);border-radius:999px;padding:11px 17px;background:#fff;color:#6b0010;font-size:10px;font-weight:1000;letter-spacing:.13em;text-transform:uppercase;cursor:pointer}.verification-failed{--verify:#ff6573;--verify-rgb:255,101,115}.verification-failed .verify-alert{display:grid}.verification-failed canvas{filter:grayscale(1) brightness(.38) contrast(1.25);opacity:.5}.verification-failed .verify-seal{opacity:1;border-color:#ff6573;background:#3f0009;box-shadow:0 0 32px rgba(255,20,49,.5)}.verification-unavailable{--verify:#ffca63;--verify-rgb:255,202,99}.verification-unavailable .seal-mark::after{width:2px;height:8px;border:0;border-left:2px solid currentColor;transform:translateY(-2px);box-shadow:0 5px 0 -1px currentColor}html[data-verification-chrome=external] .verify-corner{display:none}@media(max-width:580px){.hint{display:none}.identity{bottom:78px}.verify-panel{border-radius:20px}.verify-row{grid-template-columns:1fr;gap:3px}.verify-value{text-align:left}.verify-alert h2{font-size:clamp(34px,14vw,70px)}}@media(prefers-reduced-motion:reduce){*,*::before,*::after{scroll-behavior:auto!important;animation:none!important;transition-duration:.01ms!important}}\n      .verify-corner{left:0!important;right:auto!important;bottom:0!important;justify-content:flex-start!important;padding:10px!important}.verify-corner .verify-seal{grid-template-columns:1fr!important;width:var(--keel-seal-size,40px)!important;height:var(--keel-seal-size,40px)!important;padding:0!important;border:0!important;border-radius:0!important;background:transparent!important;color:var(--keel-seal-color,var(--verify))!important;box-shadow:none!important;overflow:visible!important}.verify-corner .seal-mark{width:var(--keel-seal-size,40px);height:var(--keel-seal-size,40px)}.verify-corner .seal-mark::before{content:attr(data-keel-seal-glyph);width:90%;height:90%;display:grid;place-items:center;border:1px solid currentColor;border-radius:0;clip-path:polygon(50% 0,61% 8%,75% 4%,82% 18%,96% 25%,92% 39%,100% 50%,92% 61%,96% 75%,82% 82%,75% 96%,61% 92%,50% 100%,39% 92%,25% 96%,18% 82%,4% 75%,8% 61%,0 50%,8% 39%,4% 25%,18% 18%,25% 4%,39% 8%);background:radial-gradient(circle,rgba(3,12,9,.96) 0 46%,rgba(var(--verify-rgb),.18) 47% 62%,rgba(3,12,9,.96) 63%);color:currentColor;font:900 16px/1 ui-monospace,SFMono-Regular,Menlo,monospace;letter-spacing:-.08em;box-shadow:0 0 0 1px rgba(255,255,255,.08) inset,0 0 22px currentColor}.verify-corner[data-keel-seal-shape=disc] .seal-mark::before{clip-path:circle(50%);border-radius:50%}.verify-corner[data-keel-seal-shape=shield] .seal-mark::before{clip-path:polygon(50% 0,92% 17%,84% 72%,50% 100%,16% 72%,8% 17%)}.verify-corner[data-keel-seal-shape=square] .seal-mark::before{clip-path:none;border-radius:7px}.verify-corner .seal-mark::after{content:"";position:absolute;inset:20%;border:1px solid currentColor;border-radius:50%;transform:none;box-shadow:none;opacity:.48}.verify-corner .seal-label{position:absolute;width:1px;height:1px;padding:0;margin:-1px;overflow:hidden;clip:rect(0,0,0,0);white-space:nowrap;border:0}.verify-corner:hover .verify-seal,.verify-corner[data-verify-corner-active=true] .verify-seal,.verify-seal[aria-expanded=true]{width:var(--keel-seal-size,40px)!important;grid-template-columns:1fr!important;background:transparent!important;box-shadow:none!important}.verify-corner:hover .seal-mark,.verify-corner[data-verify-corner-active=true] .seal-mark,.verify-seal[aria-expanded=true] .seal-mark{filter:drop-shadow(0 0 8px currentColor)}.verify-panel{left:clamp(10px,2vw,24px)!important;right:auto!important}\n    \n\n      .arena-hud{top:20px;left:20px;min-width:300px;padding:14px 15px;border:1px solid rgba(var(--scene-grid-rgb),.18);border-radius:18px;background:linear-gradient(145deg,rgba(4,15,12,.88),rgba(2,8,7,.62));box-shadow:0 14px 44px #0008,inset 0 1px #ffffff0a;backdrop-filter:blur(14px)}\n      .arena-state{display:flex;align-items:center;gap:8px}.arena-state::before{content:"";width:7px;height:7px;border-radius:50%;background:rgb(var(--scene-grid-rgb));box-shadow:0 0 14px rgb(var(--scene-grid-rgb))}\n      .arena-meters{padding-bottom:8px;border-bottom:1px solid #ffffff0c}.status-bars{width:100%;grid-template-columns:46px minmax(120px,1fr);gap:5px 8px}.status-track{height:6px}.arena-abilities{margin-top:3px}\n      .command-deck{position:absolute;z-index:5;right:20px;top:20px;display:flex;align-items:flex-start;gap:8px}.arena-controls{position:static;padding:11px 13px;border:1px solid #ffffff14;border-radius:14px;background:#030b09a6;color:#88a39a;line-height:1.7;backdrop-filter:blur(12px)}\n      .ui-icon-button{display:grid;place-items:center;width:42px;height:42px;border:1px solid rgba(var(--scene-grid-rgb),.28);border-radius:13px;background:#06110ed9;color:#dffff6;cursor:pointer;box-shadow:0 10px 30px #0008;transition:transform .18s ease,border-color .18s ease,background .18s ease}.ui-icon-button:hover,.ui-icon-button:focus-visible{transform:translateY(-2px);border-color:rgba(var(--scene-grid-rgb),.72);background:#0a1d18}.ui-icon-button:focus-visible{outline:2px solid rgb(var(--scene-grid-rgb));outline-offset:2px}\n      .identity{left:24px;bottom:24px;max-width:min(520px,58vw);padding:15px 17px;border:1px solid #ffffff0d;border-radius:18px;background:linear-gradient(145deg,#07110fd1,#0308079e);box-shadow:0 16px 42px #0008;backdrop-filter:blur(14px)}.identity h1{font-size:clamp(24px,3.4vw,42px)}.traits{line-height:1.55}\n      .mobile-drawer{display:none}.mobile-drawer-handle{border:1px solid rgba(var(--scene-grid-rgb),.35);border-bottom:0;border-radius:18px 18px 0 0;background:#071713ed;color:#dffff5;padding:9px 18px;font:900 9px ui-monospace,monospace;letter-spacing:.14em}.mobile-drawer-panel{padding:12px 16px max(24px,env(safe-area-inset-bottom));border-top:1px solid rgba(var(--scene-grid-rgb),.28);background:linear-gradient(180deg,#071713fa,#020706fe);box-shadow:0 -24px 70px #000b}.mobile-drawer-panel h2{margin:0 0 5px;font-size:18px}.mobile-drawer-panel p{margin:0;color:#88a39a;font:9px/1.55 ui-monospace,monospace}.mobile-drawer-actions{display:grid;grid-template-columns:1fr 1fr;gap:8px;margin-top:12px}.drawer-action{border:1px solid #ffffff16;border-radius:12px;padding:10px;background:#ffffff08;color:#dffff5;font:800 9px ui-monospace,monospace}\n      .settings-backdrop{position:absolute;z-index:18;inset:0;border:0;background:#0009;opacity:0;pointer-events:none;transition:opacity .22s ease}.settings-panel{position:absolute;z-index:19;right:20px;top:20px;width:min(430px,calc(100% - 40px));max-height:calc(100% - 40px);display:flex;flex-direction:column;border:1px solid rgba(var(--scene-grid-rgb),.34);border-radius:22px;background:linear-gradient(155deg,#0a1b17fc,#030807fc);box-shadow:0 26px 90px #000c;opacity:0;transform:translateY(-10px) scale(.985);pointer-events:none;overflow:hidden;transition:opacity .22s ease,transform .22s ease}.settings-open .settings-backdrop{opacity:1;pointer-events:auto}.settings-open .settings-panel{opacity:1;transform:none;pointer-events:auto}.settings-head{display:flex;align-items:flex-start;gap:12px;padding:19px 19px 14px;border-bottom:1px solid #ffffff0d}.settings-head div{flex:1}.settings-head h2{margin:0;font-size:20px}.settings-head p{margin:5px 0 0;color:#78958c;font-size:10px}.settings-scroll{overflow:auto;padding:14px 18px 18px}.settings-section-title{margin:2px 0 9px;color:rgb(var(--scene-grid-rgb));font:900 9px ui-monospace,monospace;letter-spacing:.16em;text-transform:uppercase}.keybind-list{display:grid;gap:6px}.keybind-row{display:grid;grid-template-columns:1fr 110px;align-items:center;gap:12px;padding:8px 9px;border:1px solid #ffffff0c;border-radius:11px;background:#ffffff05;color:#bcd1ca;font-size:11px}.keybind-button{border:1px solid rgba(var(--scene-grid-rgb),.28);border-radius:8px;padding:7px;background:#071713;color:#dffff5;font:800 10px ui-monospace,monospace;cursor:pointer}.keybind-button.listening{border-color:#ffcb66;color:#ffdd94;animation:keypulse .7s ease-in-out infinite alternate}.controller-map{display:grid;grid-template-columns:1fr 1fr;gap:6px;margin:0;padding:0;list-style:none;color:#9bb1a9;font:9px/1.5 ui-monospace,monospace}.controller-map li{padding:7px 8px;border:1px solid #ffffff0b;border-radius:9px;background:#ffffff05}.settings-actions{display:flex;gap:8px;margin-top:13px}.settings-action{flex:1;border:1px solid #ffffff16;border-radius:10px;padding:9px;background:#ffffff08;color:#dffff5;font-size:10px}.gamepad-status{color:#78958c}.gamepad-status.connected{color:#67f6c5}@keyframes keypulse{to{box-shadow:0 0 18px #ffcb6644}}\n      @media(max-width:760px){.command-deck{right:10px;top:10px}.arena-controls{display:none}.arena-hud{top:10px;left:10px;min-width:0;width:calc(100% - 70px);padding:9px 10px;border-radius:14px}.arena-meters{gap:8px;padding-bottom:5px}.arena-meters b{font-size:11px}.status-bars{grid-template-columns:38px 1fr;gap:3px 6px}.arena-abilities{display:none}.identity{display:none}.verify-corner{left:auto;right:8px;bottom:58px;width:48px;height:48px;padding:6px}.verify-seal{opacity:.58}.mobile-drawer{position:absolute;z-index:12;left:50%;bottom:0;display:flex;flex-direction:column;align-items:center;width:100%;transform:translate(-50%,calc(100% - 34px));transition:transform .28s cubic-bezier(.2,.8,.2,1);pointer-events:none}.mobile-drawer>*{pointer-events:auto}.mobile-drawer-open .mobile-drawer{transform:translate(-50%,0)}.mobile-drawer-panel{width:100%;max-height:68vh;overflow:auto}.mobile-drawer-open .touch-controls{opacity:.12;pointer-events:none}.mobile-drawer-open .touch-controls *{pointer-events:none}.settings-panel{inset:8px;width:auto;max-height:calc(100% - 16px);border-radius:18px}.settings-backdrop{z-index:18}.controller-map{grid-template-columns:1fr}.traits{max-width:none}.touch-controls{bottom:max(42px,env(safe-area-inset-bottom))}.touch-stick{width:104px;height:104px}.touch-stick::after{left:30px;top:30px}.touch-actions{grid-template-columns:repeat(3,46px)}.touch-fire{width:100px}.verify-panel{z-index:21}.verify-backdrop{z-index:20}}\n    \n\n      .verify-corner .verify-seal{opacity:0!important;visibility:hidden;pointer-events:none;transform:var(--keel-seal-rest-transform,translateX(calc(-1 * (var(--keel-seal-size,40px) + 32px))) rotate(-7deg) scale(.94));transform-origin:0 100%;will-change:opacity,transform;transition:opacity var(--keel-seal-fade-out,900ms) ease,transform var(--keel-seal-fade-out,900ms) cubic-bezier(.45,0,.8,.2),visibility 0s linear var(--keel-seal-fade-out,900ms)!important}.verify-corner:hover .verify-seal,.verify-corner[data-verify-corner-active=true] .verify-seal,.verify-seal[aria-expanded=true]{opacity:1!important;visibility:visible;pointer-events:auto;transform:translateX(0) rotate(0deg) scale(1);transition:opacity var(--keel-seal-fade-in,420ms) ease,transform var(--keel-seal-fade-in,420ms) cubic-bezier(.16,1,.3,1),visibility 0s linear 0s!important}.verify-corner[data-keel-seal-motion=slide]{--keel-seal-rest-transform:translateX(calc(-1 * (var(--keel-seal-size,40px) + 32px))) rotate(-7deg) scale(.94)}.verify-corner[data-keel-seal-motion=stamp]{--keel-seal-rest-transform:translate(-8px,8px) rotate(-12deg) scale(.72)}.verify-corner[data-keel-seal-motion=scale]{--keel-seal-rest-transform:scale(.68)}.verify-corner[data-keel-seal-motion=rise]{--keel-seal-rest-transform:translateY(14px) scale(.82)}.verify-corner[data-keel-seal-motion=none]{--keel-seal-rest-transform:none}.verify-panel{width:var(--keel-panel-width,min(560px,calc(100% - clamp(20px,4vw,48px))))!important;border-radius:var(--keel-panel-radius,22px)!important;background:linear-gradient(145deg,var(--keel-panel-surface,#07120f),#030807)!important;color:var(--keel-panel-text,#d9e8e3)}.verify-panel[data-keel-placement=right]{left:auto!important;right:clamp(10px,2vw,24px)!important}.verify-panel[data-keel-placement=center]{left:50%!important;right:auto!important;bottom:50%!important;transform:translate(-50%,calc(50% + 22px)) scale(.975)}body.verify-open .verify-panel[data-keel-placement=center]{transform:translate(-50%,50%)}.verify-page-nav{display:flex;gap:6px;margin:0 0 12px;padding:3px;border:1px solid rgba(255,255,255,.08);border-radius:12px;background:#0003}.verify-page-button{flex:1;min-width:0;border:0;border-radius:9px;padding:8px 7px;background:transparent;color:var(--keel-panel-muted,#748d85);font:850 8px/1 ui-monospace,SFMono-Regular,monospace;letter-spacing:.08em;text-transform:uppercase;cursor:pointer}.verify-page-button[aria-selected=true]{background:rgba(var(--verify-rgb),.13);color:var(--keel-seal-color,var(--verify));box-shadow:0 0 0 1px rgba(var(--verify-rgb),.17) inset}.verify-page{display:grid;gap:12px}.verify-page[hidden]{display:none!important}.verify-page[data-layout=stack]{grid-template-columns:1fr}.verify-page[data-layout=columns],.verify-page[data-layout=grid]{grid-template-columns:repeat(var(--keel-page-columns,1),minmax(0,1fr))}.verify-page .verify-section{min-width:0;margin:0;grid-column:span var(--keel-panel-span,1)}@media(max-width:700px){.verify-page[data-layout=columns],.verify-page[data-layout=grid]{grid-template-columns:1fr}.verify-page .verify-section{grid-column:1}.verify-page-nav{position:sticky;top:-16px;z-index:2;background:#07120ff5}}\n      .verify-alert-actions{display:flex;flex-wrap:wrap;justify-content:center;gap:9px}.verify-alert-dismiss{background:transparent!important;color:#fff!important}.verification-failed.verification-alert-dismissed .verify-alert{display:none}\n    \n\n      html[data-vault-presentation-mode=gallery] body{background:radial-gradient(circle at 50% 43%,var(--scene-a) 0,var(--scene-b) 48%,#020403 86%)}\n      html[data-vault-presentation-mode=gallery] main{isolation:isolate}\n      html[data-vault-presentation-mode=gallery] .grid{opacity:.08;mask-image:radial-gradient(circle,#000 0 24%,transparent 72%)}\n      html[data-vault-presentation-mode=gallery] canvas{width:min(96vmin,720px);height:min(96vmin,720px);pointer-events:none}\n      html[data-vault-presentation-mode=gallery] :is(.arena-hud,.command-deck,.arena-flash,.identity,.touch-controls,.mobile-drawer,.settings-backdrop,.settings-panel,.verify-corner,.verify-backdrop,.verify-panel,.verify-alert){display:none!important}\n      html[data-vault-presentation-mode=gallery] body.gallery-preview-failed main::after{content:"PREVIEW UNAVAILABLE";position:absolute;z-index:3;inset:0;display:grid;place-items:center;color:#ff9caf;font:900 11px ui-monospace,monospace;letter-spacing:.14em}\n      html[data-vault-presentation-mode=gallery] body.gallery-preview-failed canvas{opacity:.22;filter:grayscale(1)}\n    ';
export const KEEL_VERIFICATION_MARKUP = '<div class="verify-corner" data-verify-intent-zone="bottom-left"><button class="verify-seal" id="verify-seal" data-keel-seal="stamp" type="button" tabindex="-1" aria-hidden="true" aria-controls="verify-panel" aria-expanded="false" aria-label="Open Keel verification proof"><span class="seal-mark" aria-hidden="true"></span><span class="seal-label">Keel proof</span></button></div><button class="verify-backdrop" id="verify-backdrop" type="button" tabindex="-1" aria-label="Close verification details"></button><aside class="verify-panel" id="verify-panel" role="dialog" aria-modal="true" aria-labelledby="verify-title" aria-describedby="verify-summary" aria-hidden="true"><header class="verify-head"><span class="verify-orb" aria-hidden="true"><span class="seal-mark"></span></span><div class="verify-copy"><p class="verify-kicker" id="verify-kicker">Checking proof</p><h2 class="verify-title" id="verify-title">Verification pending</h2><p class="verify-summary" id="verify-summary">Inspecting the pinned Keel runtime context.</p></div><button class="verify-close" id="verify-close" type="button" aria-label="Close verification details">×</button></header><div class="verify-scroll" id="verify-details"></div><footer class="verify-footer"><strong>Keel proof viewer</strong><span id="verify-tier">Client proof</span></footer></aside><section class="verify-alert" id="verify-alert" role="alert" aria-live="assertive"><div class="verify-alert-copy"><p class="verify-alert-kicker">Do not trust this render</p><h2>Verification failed</h2><p id="verify-alert-message">The supplied on-chain proof did not match the rendered asset.</p><div class="verify-alert-actions"><button id="verify-alert-open" type="button">Inspect failed checks</button><button class="verify-alert-dismiss" id="verify-alert-dismiss" type="button">Dismiss warning</button></div></div></section>';
export const KEEL_VERIFICATION_PRESENTATION = '{"protocol":"keel-verification-presentation@1","revision":2,"seal":{"glyph":"S","shape":"stamp","motion":"slide","color":"verification-state","sizePx":40,"fadeInMs":420,"holdMs":650,"fadeOutMs":900},"overlay":{"placement":"left","width":"wide","navigation":"tabs","initialPage":"overview"},"theme":{"accent":"verification-state","surface":"#07120f","text":"#d9e8e3","muted":"#748d85","radiusPx":22},"pages":[{"id":"overview","label":"Proof","layout":"stack","columns":1,"panels":[{"id":"proof-summary","type":"overview","span":1},{"id":"verification-checks","type":"checks","span":1}]},{"id":"sources","label":"Files","layout":"columns","columns":2,"panels":[{"id":"storage-sources","type":"storage","span":1},{"id":"verified-resources","type":"resources","span":1}]},{"id":"provenance","label":"Trail","layout":"grid","columns":2,"panels":[{"id":"token-identity","type":"identity","span":1},{"id":"version-commitments","type":"commitments","span":1},{"id":"keel-object-trail","type":"object-trail","span":2},{"id":"stake-object","type":"staking","span":2},{"id":"contract-facets","type":"contract-facets","span":2}]}]}';

const KEEL_VERIFICATION_PRESENTATION_PROTOCOL = "keel-verification-presentation@1";
const KEEL_VERIFICATION_PANEL_TYPES = new Set(["overview", "checks", "storage", "resources", "identity", "commitments", "object-trail", "staking", "contract-facets"]);
const normalizeVerificationPresentation = (input) => {
  if (input?.protocol !== KEEL_VERIFICATION_PRESENTATION_PROTOCOL || !Number.isSafeInteger(input.revision) || input.revision < 1) throw new Error("Unsupported Keel verification presentation manifest.");
  const seal = input.seal;
  if (!seal || typeof seal.glyph !== "string" || seal.glyph.length < 1 || seal.glyph.length > 4 || !["stamp", "disc", "shield", "square"].includes(seal.shape) || !["slide", "stamp", "scale", "rise", "none"].includes(seal.motion)) throw new Error("Invalid Keel verification seal presentation.");
  for (const [name, value, minimum, maximum] of [["sizePx", seal.sizePx, 24, 72], ["fadeInMs", seal.fadeInMs, 50, 3000], ["holdMs", seal.holdMs, 0, 10000], ["fadeOutMs", seal.fadeOutMs, 50, 3000]]) {
    if (!Number.isSafeInteger(value) || value < minimum || value > maximum) throw new Error(`Invalid Keel seal ${name}.`);
  }
  const overlay = input.overlay;
  if (!overlay || !["left", "right", "center"].includes(overlay.placement) || !["compact", "standard", "wide"].includes(overlay.width) || !["tabs", "stepper"].includes(overlay.navigation)) throw new Error("Invalid Keel verification overlay presentation.");
  const theme = input.theme;
  const color = (value, state = false) => (state && value === "verification-state") || /^#[0-9a-f]{6}$/u.test(value ?? "");
  if (!theme || !color(theme.accent, true) || !color(theme.surface) || !color(theme.text) || !color(theme.muted) || !Number.isSafeInteger(theme.radiusPx) || theme.radiusPx < 0 || theme.radiusPx > 48) throw new Error("Invalid Keel verification theme presentation.");
  if (theme.cssResource !== undefined && (!/^[a-z0-9][a-z0-9-]{0,63}$/u.test(theme.cssResource.id) || !/^0x[0-9a-f]{64}$/u.test(theme.cssResource.digest) || !Number.isSafeInteger(theme.cssResource.byteLength) || theme.cssResource.byteLength < 1 || theme.cssResource.byteLength > 65536)) throw new Error("Invalid Keel verification CSS commitment.");
  if (!Array.isArray(input.pages) || input.pages.length < 1 || input.pages.length > 8) throw new Error("Invalid Keel verification page manifest.");
  const pageIds = new Set(), panelIds = new Set();
  const pages = input.pages.map((page) => {
    if (!/^[a-z0-9][a-z0-9-]{0,63}$/u.test(page?.id) || pageIds.has(page.id) || typeof page.label !== "string" || page.label.length < 1 || page.label.length > 32 || !["stack", "columns", "grid"].includes(page.layout) || !Number.isSafeInteger(page.columns) || page.columns < 1 || page.columns > 3 || !Array.isArray(page.panels) || page.panels.length < 1 || page.panels.length > 16) throw new Error("Invalid Keel verification page.");
    pageIds.add(page.id);
    const panels = page.panels.map((item) => {
      const span = item.span ?? 1;
      if (!/^[a-z0-9][a-z0-9-]{0,63}$/u.test(item?.id) || panelIds.has(item.id) || !KEEL_VERIFICATION_PANEL_TYPES.has(item.type) || !Number.isSafeInteger(span) || span < 1 || span > page.columns) throw new Error("Invalid Keel verification panel.");
      panelIds.add(item.id);
      return Object.freeze({ ...item, span });
    });
    return Object.freeze({ ...page, panels: Object.freeze(panels) });
  });
  if (!pageIds.has(overlay.initialPage)) throw new Error("The initial Keel verification page does not exist.");
  return Object.freeze({ ...input, seal: Object.freeze({ ...seal }), overlay: Object.freeze({ ...overlay }), theme: Object.freeze({ ...input.theme }), pages: Object.freeze(pages) });
};
const embeddedVerificationPresentation = normalizeVerificationPresentation(JSON.parse((typeof document === "undefined" ? null : document.querySelector("#keel-verification-presentation")?.textContent) ?? KEEL_VERIFICATION_PRESENTATION));

const ANCHOR_FAMILY_NAMES = Object.freeze({ 1: "Ethereum", 2: "Tezos", 3: "Bitcoin Ordinals" });
const OBJECT_TRAIL = Object.freeze([
  {
    field: "portableRoot", label: "Portable package", type: "Cross-chain content root",
    description: "The fingerprint for the portable presentation package.",
    impact: "A different root means a different package of presentation content.", source: "Portable anchor",
  },
  {
    field: "portableManifestObjectId", label: "Portable manifest", type: "Manifest / JSON",
    revision: "portableManifestObjectRevision",
    description: "The table of contents that says which portable bytes belong together.",
    impact: "It controls what the portable presentation is allowed to load.", source: "On-chain / Keel",
  },
  {
    field: "portableDecodedObjectId", label: "Decoded presentation", type: "HTML / data",
    revision: "portableDecodedObjectRevision",
    description: "The decoded payload referenced by the portable manifest.",
    impact: "Changing it can change the rendered presentation.", source: "On-chain / Keel",
  },
  {
    field: "portableAnchorRoot", label: "Portable anchor", type: "Cross-chain proof link",
    description: "The registry link that binds the portable package to its exact Keel objects and revisions.",
    impact: "It prevents a delivery copy from pointing at a different package.", source: "On-chain / Keel",
  },
  {
    field: "assetFamilyId", label: "Asset family", type: "Asset catalog",
    revision: "assetFamilyRevision",
    description: "The family of visual and audio parts available to this character.",
    impact: "A different family can change the character's available parts.", source: "On-chain / Keel",
  },
  {
    field: "assetId", label: "Selected asset", type: "Asset selection",
    description: "The exact asset choice derived from the pinned token recipe.",
    impact: "This can change the character or equipped weapon that is rendered.", source: "On-chain / Keel",
  },
  {
    field: "spriteObjectId", label: "Sprite", type: "Image / sprite",
    description: "The image object used for the visible character or weapon pixels.",
    impact: "This directly changes what the collector sees.", source: "On-chain / Keel",
  },
  {
    field: "targetMapObjectId", label: "Target map", type: "Data / mask",
    description: "The map that tells the renderer which pixels receive each material or effect.",
    impact: "It can change color placement, masks, and material regions.", source: "On-chain / Keel",
  },
  {
    field: "effectProfileObjectId", label: "Effect profile", type: "FX / behavior",
    description: "The committed effect rules used by the viewer.",
    impact: "It can change particles, lights, trails, and animation response.", source: "On-chain / Keel",
  },
  {
    field: "soundProfileObjectId", label: "Sound profile", type: "Audio",
    description: "The committed sound mapping used by the viewer.",
    impact: "It can change which sound plays and how it is decoded.", source: "On-chain / Keel",
  },
]);

const isSupplied = (value) => value !== undefined && value !== null && value !== "";
const shortValue = (value) => typeof value === "string" && value.length > 22
  ? `${value.slice(0, 10)}…${value.slice(-8)}` : String(value);
const sourceTag = (source) => {
  const uri = typeof source?.uri === "string" ? source.uri.toLowerCase() : "";
  if (source?.kind === "onchain") return { label: "On-chain / Keel", detail: `Chain ${source.chainId} · object ${shortValue(source.objectId)}`, tone: "onchain" };
  if (source?.kind === "contract-call") return { label: "On-chain call", detail: `Chain ${source.chainId} · contract read`, tone: "onchain" };
  if (source?.kind === "inline") return { label: "Bundled", detail: "Embedded in the verified viewer", tone: "bundled" };
  if (source?.kind === "composite") return { label: "Composed", detail: "Built from committed parts", tone: "composed" };
  if (uri.startsWith("ipfs://") || uri.includes("/ipfs/")) return { label: "IPFS mirror", detail: shortValue(source.uri), tone: "ipfs" };
  if (uri.startsWith("ar://") || uri.includes("arweave")) return { label: "Arweave mirror", detail: shortValue(source.uri), tone: "arweave" };
  if (uri.startsWith("ord://") || uri.includes("ordinal") || uri.includes("inscription")) return { label: "Ordinals mirror", detail: shortValue(source.uri), tone: "ordinals" };
  if (uri.startsWith("tezos://") || uri.includes("tezos") || uri.includes("tzkt")) return { label: "Tezos mirror", detail: shortValue(source.uri), tone: "tezos" };
  return { label: "URI mirror", detail: shortValue(source.uri), tone: "uri" };
};
/**
 * How a viewer document gets what it renders, as `viewerCarriage` on the proof
 * ledger reports it. The ledger does not ask the document: it reads the viewer
 * composite's own part list on chain and looks for the asset the ladder proved.
 * That is the only reason this row is worth showing — a document's own claim
 * about whether it fetches would be the least trustworthy thing on the panel.
 */
const CARRIAGE_ORDER = ["Unknown", "Linked", "Inline", "Hybrid"];
const CARRIAGE_COPY = {
  Inline: {
    display: "Inline · carried by the document",
    tone: "onchain",
    detail: "The artwork is one of this document's own parts. Rendering it and holding it are the same act: nothing is fetched, and no host has to be up or honest.",
  },
  Linked: {
    display: "Linked · read at render time",
    tone: "uri",
    detail: "The document does not carry the artwork. It reads it from a node when it renders — a much smaller document, and a live dependency on whoever answers.",
  },
  Hybrid: {
    display: "Hybrid · carries some, fetches the rest",
    tone: "uri",
    detail: "Part of what this document renders travels with it and part is fetched. A viewer that said 'nothing is fetched' here would be wrong.",
  },
  Unknown: {
    display: "Not reported",
    tone: "neutral",
    detail: "No viewer is bound for this token, or its parts could not be read, so the ledger has no answer to give.",
  },
};

const carriageOf = (runtimeContext) => {
  const raw = runtimeContext?.viewerCarriage;
  if (typeof raw === "string" && CARRIAGE_COPY[raw] !== undefined) return raw;
  if (Number.isInteger(raw) && CARRIAGE_ORDER[raw] !== undefined) return CARRIAGE_ORDER[raw];
  return undefined;
};

/**
 * What the ledger has not been asked, the panel can still observe: every source
 * that actually resolved is on the record. Reported separately and labelled as
 * observed, because "this is what the bytes did" and "this is what the chain
 * says the document is" are different claims and only one of them is a proof.
 */
const observedCarriage = (sources) => {
  const kinds = new Set(sources.flatMap((resource) => (resource.sources ?? []).map((source) => source?.kind)));
  if (kinds.size === 0) return undefined;
  const fetched = kinds.has("uri");
  const carried = kinds.has("inline") || kinds.has("composite");
  if (fetched && carried) return "Hybrid";
  if (fetched) return "Linked";
  if (carried && !kinds.has("onchain") && !kinds.has("contract-call")) return "Inline";
  return "Linked";
};

const contentResources = () => {
  const content = globalThis.__KEEL_CONTENT__;
  if (typeof content?.resources !== "function") return [];
  try {
    const result = content.resources();
    return Array.isArray(result) ? result : [];
  } catch {
    return [];
  }
};
const stakeLockupLabel = (lockup) => {
  if (lockup?.mode === "minimum-duration") return `Minimum duration · ${lockup.seconds} seconds from stake start`;
  if (lockup?.mode === "until-disabled") return "Until disabled · the manager must disable this object before unstake";
  return "No lockup · unstake is available while the object is active";
};
const stakeManagerLabel = (stake) => {
  if (stake?.managerVerified !== true) return "Not verified · gated resources remain withheld";
  if (stake.managerPolicy?.mode === "verified-custom") return "Verified custom · immutable code + paid review receipt";
  return "Official Keel manager · immutable proof accepted";
};

function mountVerificationUI(result, runtime, runtimeContext, presentationInput) {
  const seal = document.querySelector("#verify-seal"), panel = document.querySelector("#verify-panel");
  const corner = document.querySelector(".verify-corner");
  const closeButton = document.querySelector("#verify-close"), backdrop = document.querySelector("#verify-backdrop");
  const alertOpen = document.querySelector("#verify-alert-open"), alertDismiss = document.querySelector("#verify-alert-dismiss"), details = document.querySelector("#verify-details");
  const title = document.querySelector("#verify-title"), summary = document.querySelector("#verify-summary");
  const kicker = document.querySelector("#verify-kicker"), tier = document.querySelector("#verify-tier");
  const alertMessage = document.querySelector("#verify-alert-message");
  const presentation = normalizeVerificationPresentation(presentationInput ?? globalThis.__KEEL_VERIFICATION_PRESENTATION__ ?? embeddedVerificationPresentation);
  const sealMarks = document.querySelectorAll(".seal-mark");
  for (const mark of sealMarks) mark.dataset.keelSealGlyph = presentation.seal.glyph;
  seal.dataset.keelSeal = presentation.seal.shape;
  corner.dataset.keelSealShape = presentation.seal.shape;
  corner.dataset.keelSealMotion = presentation.seal.motion;
  corner.dataset.keelPresentationRevision = String(presentation.revision);
  corner.style.setProperty("--keel-seal-size", `${presentation.seal.sizePx}px`);
  corner.style.setProperty("--keel-seal-fade-in", `${presentation.seal.fadeInMs}ms`);
  corner.style.setProperty("--keel-seal-fade-out", `${presentation.seal.fadeOutMs}ms`);
  if (presentation.seal.color !== "verification-state") corner.style.setProperty("--keel-seal-color", presentation.seal.color);
  panel.dataset.keelPlacement = presentation.overlay.placement;
  panel.dataset.keelWidth = presentation.overlay.width;
  panel.style.setProperty("--keel-panel-width", presentation.overlay.width === "compact" ? "min(420px,calc(100% - 20px))" : presentation.overlay.width === "wide" ? "min(760px,calc(100% - 20px))" : "min(560px,calc(100% - 20px))");
  panel.style.setProperty("--keel-panel-radius", `${presentation.theme.radiusPx}px`);
  panel.style.setProperty("--keel-panel-surface", presentation.theme.surface);
  panel.style.setProperty("--keel-panel-text", presentation.theme.text);
  panel.style.setProperty("--keel-panel-muted", presentation.theme.muted);
  if (presentation.theme.accent !== "verification-state") panel.style.setProperty("--keel-seal-color", presentation.theme.accent);
  document.documentElement.dataset.verificationChrome = "embedded";
  document.documentElement.dataset.keelVerificationPresentation = String(presentation.revision);
  let lastFocus;
  let currentResult = result;
  let cornerHideTimer;
  const setCornerPresence = (active) => {
    if (active) {
      corner.dataset.verifyCornerActive = "true";
      seal.tabIndex = 0;
      seal.setAttribute("aria-hidden", "false");
    } else {
      delete corner.dataset.verifyCornerActive;
      seal.tabIndex = -1;
      seal.setAttribute("aria-hidden", "true");
    }
  };

  const section = (heading, panelType) => {
    const node = document.createElement("section"); node.className = "verify-section";
    node.dataset.keelPanelType = panelType;
    const label = document.createElement("h3"); label.textContent = heading; node.append(label); details.append(node); return node;
  };
  const note = (parent, text, className = "verify-note") => {
    const node = document.createElement("p"); node.className = className; node.textContent = text; parent.append(node); return node;
  };
  const row = (parent, key, value, options = {}) => {
    if (!isSupplied(value)) return false;
    const node = document.createElement("div"); node.className = "verify-row";
    const name = document.createElement("span"); name.className = "verify-key"; name.textContent = key;
    const output = document.createElement("span"); output.className = `verify-value${options.plain ? " verify-value-plain" : ""}`;
    output.textContent = options.display ?? (options.plain ? String(value) : shortValue(value)); output.title = String(value);
    node.append(name, output); parent.append(node);
    return true;
  };
  const badge = (parent, value) => {
    const tag = typeof value === "string" ? { label: value } : value;
    const node = document.createElement("span"); node.className = `verify-source-badge verify-source-${tag.tone ?? "neutral"}`; node.textContent = tag.label;
    if (tag.detail !== undefined) node.title = tag.detail;
    parent.append(node); return node;
  };
  const trailItem = (parent, item, index, value, options = {}) => {
    if (!isSupplied(value)) return false;
    const node = document.createElement("article"); node.className = "verify-trail-item";
    const head = document.createElement("div"); head.className = "verify-trail-head";
    const step = document.createElement("span"); step.className = "verify-trail-step"; step.textContent = String(index + 1).padStart(2, "0");
    const title = document.createElement("strong"); title.textContent = item.label;
    const type = document.createElement("span"); type.className = "verify-trail-type"; type.textContent = item.type;
    head.append(step, title, type); node.append(head);
    const sourceLine = document.createElement("div"); sourceLine.className = "verify-source-line";
    const sources = options.sources ?? [item.source ?? "On-chain / Keel"];
    for (const source of sources) badge(sourceLine, source);
    node.append(sourceLine);
    const description = document.createElement("p"); description.className = "verify-trail-description"; description.textContent = item.description;
    node.append(description);
    const valueLine = document.createElement("div"); valueLine.className = "verify-trail-value";
    const code = document.createElement("code"); code.textContent = options.display ?? shortValue(value); code.title = String(value);
    valueLine.append(code);
    if (isSupplied(item.revision) && isSupplied(runtimeContext?.[item.revision])) {
      const revision = document.createElement("span"); revision.className = "verify-revision"; revision.textContent = `rev ${runtimeContext[item.revision]}`; revision.title = `Pinned object revision ${runtimeContext[item.revision]}`; valueLine.append(revision);
    }
    node.append(valueLine);
    const impact = document.createElement("small"); impact.className = "verify-trail-impact"; impact.textContent = `Can affect: ${item.impact}`; node.append(impact);
    parent.append(node); return true;
  };
  const applyPresentationLayout = () => {
    const queues = new Map();
    for (const node of [...details.querySelectorAll(":scope > .verify-section")]) {
      const type = node.dataset.keelPanelType;
      if (!queues.has(type)) queues.set(type, []);
      queues.get(type).push(node);
    }
    const navigation = document.createElement("nav"); navigation.className = "verify-page-nav"; navigation.dataset.navigation = presentation.overlay.navigation; navigation.setAttribute("role", "tablist"); navigation.setAttribute("aria-label", "Verification proof pages");
    const pageHost = document.createElement("div"); pageHost.className = "verify-page-host";
    const available = [];
    for (const pageDefinition of presentation.pages) {
      const pageNode = document.createElement("section"); pageNode.className = "verify-page"; pageNode.id = `verify-page-${pageDefinition.id}`; pageNode.dataset.layout = pageDefinition.layout; pageNode.style.setProperty("--keel-page-columns", String(pageDefinition.columns)); pageNode.setAttribute("role", "tabpanel");
      for (const panelDefinition of pageDefinition.panels) {
        const node = queues.get(panelDefinition.type)?.shift();
        if (!(node instanceof HTMLElement)) continue;
        node.dataset.keelPanelId = panelDefinition.id;
        node.style.setProperty("--keel-panel-span", String(panelDefinition.span));
        if (panelDefinition.title) node.querySelector("h3").textContent = panelDefinition.title;
        pageNode.append(node);
      }
      if (pageNode.childElementCount === 0) continue;
      const button = document.createElement("button"); button.className = "verify-page-button"; button.type = "button"; button.id = `verify-page-tab-${pageDefinition.id}`; button.textContent = pageDefinition.label; button.setAttribute("role", "tab"); button.setAttribute("aria-controls", pageNode.id); pageNode.setAttribute("aria-labelledby", button.id);
      navigation.append(button); pageHost.append(pageNode); available.push({ id: pageDefinition.id, button, pageNode });
    }
    if (available.length === 0) throw new Error("The verification presentation did not select any available proof panels.");
    const select = (id) => {
      const selected = available.some((item) => item.id === id) ? id : available[0].id;
      for (const item of available) {
        const active = item.id === selected;
        item.button.setAttribute("aria-selected", String(active)); item.button.tabIndex = active ? 0 : -1; item.pageNode.hidden = !active;
      }
      details.dataset.activePage = selected;
    };
    for (const item of available) item.button.addEventListener("click", () => select(item.id));
    select(presentation.overlay.initialPage);
    details.replaceChildren(navigation, pageHost);
  };
  const render = (next) => {
    currentResult = next;
    document.body.classList.remove("verification-alert-dismissed");
    document.body.classList.remove("verification-verified", "verification-failed", "verification-unavailable");
    document.body.classList.add(`verification-${next.state}`);
    document.documentElement.dataset.vaultVerification = next.state;
    document.documentElement.dataset.vaultVerificationFixture = String(next.isFixture);
    title.textContent = next.isFixture ? `TEST FIXTURE — ${next.title}` : next.title;
    summary.textContent = next.isFixture ? `TEST FIXTURE ONLY. ${next.summary}` : next.summary;
    tier.textContent = next.proofTier;
    kicker.textContent = next.isFixture ? "TEST FIXTURE — NOT A LIVE PROOF"
      : next.state === "verified" ? (next.syntheticTokenContext ? "Keel runtime active" : "On-chain proof accepted") : next.state === "failed" ? "Proof rejected" : "Proof unavailable";
    seal.setAttribute("aria-label", `${next.title}. Open on-chain verification details`);
    if (next.state === "failed") alertMessage.textContent = next.isFixture ? `TEST FIXTURE — ${next.summary}` : next.summary;
    details.replaceChildren();
    const plain = section("What this proves", "overview");
    note(plain, next.state === "unavailable"
      ? "This presentation did not enable a supported Keel verifier API. The art may still render, but no verifier receipt is being claimed."
      : next.syntheticTokenContext
      ? "This is a runtime preview: it proves the bundled Keel viewer and its committed resource pipeline. It does not claim that this preview is a live token snapshot at a block."
      : next.state === "verified"
        ? "This render is tied to the token, the exact viewer version, and the chain block shown below."
        : "The viewer is showing the evidence that failed. Treat the render as unverified until the failed check is resolved.");
    const guide = document.createElement("div"); guide.className = "verify-guide-grid";
    for (const card of [
      ["Presentation", "HTML + CSS", "The page shell, layout, and visual rules.", "Changes how the viewer looks."],
      ["Recipe", "Seed + versions", "The token recipe chooses the object IDs and revisions.", "Changes which character parts are selected."],
      ["Assets", "Pixels + FX + sound", "Committed objects supply the image, masks, effects, and audio.", "Changes what the collector sees or hears."],
    ]) {
      const cardNode = document.createElement("div"); cardNode.className = "verify-guide-card";
      const label = document.createElement("span"); label.className = "verify-guide-label"; label.textContent = card[0];
      const titleNode = document.createElement("strong"); titleNode.textContent = card[1];
      const copy = document.createElement("p"); copy.textContent = card[2];
      const impact = document.createElement("small"); impact.textContent = card[3];
      cardNode.append(label, titleNode, copy, impact); guide.append(cardNode);
    }
    plain.append(guide);
    const checkSection = section(next.state === "failed" ? "Failed verification checks" : "Verification checks", "checks");
    const hasMapContext = Object.keys(runtimeContext ?? {}).some((key) => key.startsWith("map"));
    const visibleChecks = next.checks.filter((check) => check.id !== "map-pin");
    if (hasMapContext) {
      const mapCheck = next.checks.find((check) => check.id === "map-pin");
      if (mapCheck !== undefined) visibleChecks.push(mapCheck);
    }
    for (const item of visibleChecks) {
      const node = document.createElement("div"); node.className = "verify-check"; node.dataset.check = item.passed ? "pass" : item.severity;
      const dot = document.createElement("span"); dot.className = "verify-dot";
      if (!item.passed) { dot.style.background = item.severity === "unavailable" ? "#ffca63" : "#ff6573"; dot.style.boxShadow = "0 0 10px currentColor"; }
      const copy = document.createElement("span"); copy.textContent = `${item.passed ? "PASS" : item.severity === "unavailable" ? "NOT PROVEN" : "FAIL"} · ${item.label}`;
      const detail = document.createElement("small"); detail.textContent = item.plain ?? item.detail; detail.title = item.detail; copy.append(detail);
      if (item.impact !== undefined) { const impact = document.createElement("small"); impact.className = "verify-check-impact"; impact.textContent = `Impact: ${item.impact}`; copy.append(impact); }
      node.append(dot, copy); checkSection.append(node);
    }
    const sources = contentResources();
    const sourceFamilies = new Set(sources.flatMap((resource) => (resource.sources ?? []).map((source) => sourceTag(source).label)));
    const storage = section("Where the bytes come from", "storage");
    row(storage, "Canonical viewer", next.syntheticTokenContext ? "Bundled Keel preview" : sourceFamilies.has("On-chain / Keel") ? "On-chain / Keel" : "Verified Keel runtime", { plain: true });

    // Carriage first, because it is the question everything under it qualifies:
    // a document that carries what it renders depends on nobody, and one that
    // reads it depends on whoever answers. Both are legitimate. Only one of
    // them is what a reader assumes when nothing says otherwise.
    const ledgerCarriage = carriageOf(runtimeContext);
    const seen = ledgerCarriage ?? observedCarriage(sources);
    const carriageCopy = CARRIAGE_COPY[seen ?? "Unknown"];
    if (row(storage, "Carriage", carriageCopy.display, { plain: true })) {
      note(
        storage,
        ledgerCarriage === undefined
          ? `${carriageCopy.detail} Observed from the sources that resolved here; the proof ledger's own viewerCarriage was not supplied to this viewer.`
          : `${carriageCopy.detail} Read from the proof ledger, which determines it from the viewer composite's part list on chain rather than from anything the document claims.`,
        "verify-note verify-note-muted",
      );
    }

    // A chain read is not a free read. Something answered the call, and a panel
    // that lists IPFS as a dependency while staying silent about the node it
    // just talked to is grading itself generously.
    const transport = runtimeContext?.rpcTransport;
    if (transport !== undefined && transport !== null) {
      row(storage, "Chain read through", transport.servedBy ?? (transport.endpoints ?? []).join(", "), { plain: true });
      row(storage, "Endpoints permitted", (transport.endpoints ?? []).length, { plain: true });
      row(
        storage,
        "Governed host list",
        transport.hostListRevision === undefined
          ? "Built-in list · no revision pinned"
          : `Revision ${transport.hostListRevision} · epoch ${transport.hostListEpoch}${transport.hostListStale ? " · STALE, the governor roster has rotated since" : ""}`,
        { plain: true },
      );
      note(
        storage,
        "Endpoints are held to the list KeelManager publishes, which moves only through a two-thirds governor envelope. The bytes a node returns are content-addressed and checked here, so a node cannot substitute them — but it can be slow, offline, or watching, and that is worth knowing.",
        "verify-note verify-note-muted",
      );
    }

    for (const [label, family] of [["IPFS", "IPFS mirror"], ["Ordinals", "Ordinals mirror"], ["Tezos", "Tezos mirror"]]) {
      row(storage, label, sourceFamilies.has(family) ? "Declared mirror" : "Not declared for this proof", { plain: true });
    }
    note(storage, "Mirrors are optional delivery copies. They can make content easier to retrieve, but they do not replace the committed source. Keel reads the committed source itself by default; a mirror is consulted only where one is deliberately turned on.");
    if (sources.length > 0) {
      const files = section(`Verified viewer files · ${sources.length}`, "resources");
      for (const resource of sources) {
        const file = document.createElement("article"); file.className = "verify-file-item";
        const head = document.createElement("div"); head.className = "verify-file-head";
        const fileName = document.createElement("strong"); fileName.textContent = resource.originalName ?? resource.id;
        const mediaType = document.createElement("span"); mediaType.className = "verify-file-type"; mediaType.textContent = resource.mediaType ?? resource.role ?? "resource";
        head.append(fileName, mediaType); file.append(head);
        const sourceLine = document.createElement("div"); sourceLine.className = "verify-source-line";
        for (const source of resource.sources ?? []) badge(sourceLine, sourceTag(source));
        if ((resource.sources ?? []).length === 0) badge(sourceLine, next.syntheticTokenContext ? "Bundled" : "Verified runtime");
        file.append(sourceLine);
        const fileMeta = document.createElement("small"); fileMeta.className = "verify-file-meta"; fileMeta.textContent = `${resource.role ?? "resource"} · ${resource.byteLength ?? "?"} bytes · ${shortValue(resource.digest ?? "digest unavailable")}`; file.append(fileMeta);
        files.append(file);
      }
    } else {
      note(storage, "The standalone preview embeds its viewer files in the bundled HTML, so a separate gateway file list is not available here.", "verify-note verify-note-muted");
    }
    const identity = section("Token identity", "identity");
    let identityCount = 0;
    // `contextData` was an outer-scope variable in the vault viewer this file
    // was extracted from, holding the same object `runtimeContext` holds here.
    // The extraction kept three `?? contextData?.…` fallbacks without the
    // variable, and mounting threw a ReferenceError the moment the identity
    // section rendered - found the first time the module ran standalone.
    identityCount += row(identity, "Chain ID", runtimeContext?.chainId) ? 1 : 0;
    const tokenId = runtimeContext?.tokenId;
    identityCount += row(identity, "Token ID", tokenId, tokenId === "preview" ? { display: "Preview · no token binding", plain: true } : {}) ? 1 : 0;
    identityCount += row(identity, "Pinned block", runtimeContext?.blockNumber) ? 1 : 0;
    identityCount += row(identity, "Block hash", runtimeContext?.blockHash) ? 1 : 0;
    identityCount += row(identity, "Token seed", runtimeContext?.derivedTokenSeed) ? 1 : 0;
    // `localParams` was the vault viewer's URLSearchParams over its own URL -
    // another outer-scope leftover. A mounted module takes its inputs from the
    // context it is handed, not from whatever URL happens to host it.
    identityCount += row(identity, "Packed attributes", runtimeContext?.packedAttributes) ? 1 : 0;
    if (identityCount === 0) note(identity, "No token-specific identity was supplied to this viewer.");
    else if (next.syntheticTokenContext) note(identity, "These are preview inputs. A live token proof also needs the pinned block and block hash.");

    const versions = section("Versions & commitments", "commitments");
    let versionCount = 0;
    versionCount += row(versions, "Viewer revision", runtime?.revision) ? 1 : 0;
    versionCount += row(versions, "Viewer content hash", runtime?.manifestDigest) ? 1 : 0;
    versionCount += row(versions, "Catalog revision", runtimeContext?.catalogRevision) ? 1 : 0;
    versionCount += row(versions, "Asset-family revision", runtimeContext?.assetFamilyRevision) ? 1 : 0;
    versionCount += row(versions, "Portable root", runtimeContext?.portableRoot) ? 1 : 0;
    versionCount += row(versions, "Anchor root", runtimeContext?.portableAnchorRoot) ? 1 : 0;
    if (versionCount === 0) note(versions, "No live version commitments were supplied to this preview.");

    const trail = section("Keel object trail", "object-trail");
    const viewerTrail = { field: "manifestDigest", label: "Viewer package", type: "HTML + CSS + code", description: "The page and runtime that explain and render the object graph.", impact: "A different package can change the entire presentation.", source: next.syntheticTokenContext ? "Bundled preview" : "On-chain / Keel" };
    let trailCount = 0;
    trailCount += trailItem(trail, viewerTrail, trailCount, runtime?.manifestDigest, { display: runtime?.manifestDigest ? undefined : "Bundled viewer package" }) ? 1 : 0;
    if (next.syntheticTokenContext && trailCount === 0) trailCount += trailItem(trail, viewerTrail, trailCount, "bundled-preview", { display: "Bundled Keel viewer" }) ? 1 : 0;
    for (const item of OBJECT_TRAIL) trailCount += trailItem(trail, item, trailCount, runtimeContext?.[item.field]) ? 1 : 0;
    const attestedAnchors = Array.isArray(runtimeContext?.attestedAnchors) ? runtimeContext.attestedAnchors : [];
    for (const anchored of attestedAnchors) {
      const familyName = ANCHOR_FAMILY_NAMES[anchored.family] ?? `Family ${anchored.family}`;
      trailCount += row(trail, `Anchored on ${familyName} · network ${anchored.network}`, anchored.anchorRoot, {
        display: `revision ${anchored.objectRevision} · ${shortValue(anchored.anchorRoot)}`,
      }) ? 1 : 0;
    }
    if (attestedAnchors.length > 0) note(trail, "Anchored networks are registry-verified locations of these exact bytes: the home chain's row is the native proof, and foreign rows were oracle-verified byte-for-byte before the registry accepted them.");
    if (trailCount === 0) note(trail, "No token-specific Keel object IDs were supplied. The preview is using its bundled resource graph.");
    else note(trail, "The trail is ordered from the viewer package to the portable binding, recipe, and the objects that affect pixels, effects, and sound.");
    const stake = runtimeContext?.stakeObject;
    if (stake !== undefined) {
      const staking = section(stake.active ? "Stake object · active" : "Stake object · inactive", "staking");
      note(staking, stake.active
        ? "This verified stake is loading the staked entrypoint and its gated map resources."
        : stake.managerVerified
          ? "No active stake was found for this token. The viewer is using its original entrypoint; gated map resources are withheld."
          : "A stake object is declared, but its manager is not verified. The viewer is using its original entrypoint and withholding gated map resources.");
      row(staking, "Manager", stakeManagerLabel(stake), { plain: true });
      row(staking, "Chain", stake.chain, { plain: true });
      row(staking, "Manager address", stake.manager);
      row(staking, "Stake object ID", stake.stakeObjectId);
      row(staking, "Viewer enabled while staked", stake.viewerId);
      row(staking, "Host map token", `${stake.hostCollection} · ${stake.hostTokenId}`);
      row(staking, "Staked token", `${stake.stakedCollection ?? "collection unavailable"} · ${stake.stakedTokenId}`);
      row(staking, "Current token owner", stake.tokenOwner ?? (stake.active ? stake.manager : "Not escrowed"), { plain: true });
      row(staking, "Staker", stake.staker ?? "No active staker", { plain: true });
      row(staking, "Map owner", stake.hostOwner ?? "Not declared for this proof", { plain: true });
      row(staking, "Controller", stake.controller ?? stake.manager, { plain: true });
      row(staking, "Lockup", stakeLockupLabel(stake.lockup), { plain: true });
      row(staking, "Started at", stake.startedAt ?? "Not active", { plain: true });
      row(staking, "This character in this map", stake.counters.objectTokenLifetime, { plain: true });
      row(staking, "All lifetime stakes into this map", stake.counters.objectLifetime, { plain: true });
      row(staking, "Characters active in this map", stake.counters.objectActive, { plain: true });
      row(staking, "This character across all maps", stake.counters.tokenLifetime, { plain: true });
      row(staking, "This token active stakes", stake.counters.tokenActive, { plain: true });
      row(staking, "Global lifetime stakes", stake.counters.globalLifetime, { plain: true });
      row(staking, "Global active stakes", stake.counters.globalActive, { plain: true });
      row(staking, "Gated viewer slot", stake.slot, { plain: true });
      row(staking, "Map code object", stake.codeObjectId);
      row(staking, "Map code revision", stake.codeObjectRevision, { plain: true });
      row(staking, "Runtime commitment", stake.runtimeDigest);
      row(staking, "Backpack", stake.backpack?.kind ?? "Not enabled", { plain: true });
      if (stake.managerProof !== undefined) {
        row(staking, "Immutable manager code", stake.managerProof.codeHash);
        row(staking, "Manager evidence", stake.managerProof.evidenceDigest ?? "Not declared for this proof", { plain: true });
        if (stake.managerProof.feeReceipt !== undefined) row(staking, "Review fee receipt", stake.managerProof.feeReceipt);
      }
      note(staking, `Rules: require the token to be staked before loading ${stake.stakedEntrypoint}; unstake restores the original entrypoint. ${stakeLockupLabel(stake.lockup)}. The global counters include every stake object using this manager, while token counters follow this character across maps.`);
    }
    if (next.collectionVerification !== undefined) {
      const proof = next.collectionVerification;
      const collection = section("Collection contract facets", "contract-facets");
      row(collection, "Proof class", proof.input.proofClass);
      row(collection, "Receipt ID", proof.input.receiptId);
      row(collection, "Observation block", `${proof.input.observationBlockNumber} · ${proof.input.observationBlockHash}`);
      row(collection, "Current pinned block", `${proof.input.blockNumber} · ${proof.input.blockHash}`);
      row(collection, "Policy version", proof.input.policyVersion);
      row(collection, "Evidence root", proof.input.evidenceRoot);
      for (const facet of proof.rows) {
        const authority = facet.authority ?? facet.timelock;
        row(collection, facet.label, `${facet.verdict.toUpperCase()} · ${facet.reason}${authority === undefined ? "" : ` · ${authority}`}`);
      }
    }
    applyPresentationLayout();
  };
  const open = () => {
    setCornerPresence(true);
    lastFocus = document.activeElement; document.body.classList.add("verify-open"); panel.setAttribute("aria-hidden", "false"); seal.setAttribute("aria-expanded", "true");
    closeButton.focus({ preventScroll: true });
    parent.postMessage({ protocol: "keel-viewer-verification@1", action: "opened", state: document.documentElement.dataset.vaultVerification }, "*");
  };
  const close = () => {
    document.body.classList.remove("verify-open"); panel.setAttribute("aria-hidden", "true"); seal.setAttribute("aria-expanded", "false");
    if (lastFocus instanceof HTMLElement && lastFocus !== seal) lastFocus.focus({ preventScroll: true });
    else seal.blur();
    scheduleCornerHide();
    parent.postMessage({ protocol: "keel-viewer-verification@1", action: "closed" }, "*");
  };
  const revealCorner = () => {
    clearTimeout(cornerHideTimer);
    setCornerPresence(true);
  };
  const scheduleCornerHide = () => {
    clearTimeout(cornerHideTimer);
    cornerHideTimer = setTimeout(() => {
      if (!document.body.classList.contains("verify-open")) setCornerPresence(false);
    }, presentation.seal.holdMs);
  };
  setCornerPresence(false);
  corner.addEventListener("pointerenter", revealCorner);
  corner.addEventListener("pointerleave", scheduleCornerHide);
  corner.addEventListener("pointerdown", revealCorner);
  corner.addEventListener("pointerup", scheduleCornerHide);
  corner.addEventListener("pointercancel", scheduleCornerHide);
  seal.addEventListener("focus", revealCorner);
  seal.addEventListener("blur", scheduleCornerHide);
  seal.addEventListener("click", open); alertOpen.addEventListener("click", open); alertDismiss.addEventListener("click", () => { document.body.classList.add("verification-alert-dismissed"); parent.postMessage({ protocol: "keel-viewer-verification@1", action: "warning-dismissed", state: currentResult.state }, "*"); }); closeButton.addEventListener("click", close); backdrop.addEventListener("click", close);
  addEventListener("keydown", (event) => {
    if (!document.body.classList.contains("verify-open")) return;
    if (event.key === "Escape") { close(); return; }
    if (event.key !== "Tab") return;
    const focusable = [...panel.querySelectorAll("button:not([disabled]),a[href],[tabindex]:not([tabindex='-1'])")].filter((node) => node instanceof HTMLElement && !node.hidden);
    if (focusable.length === 0) { event.preventDefault(); panel.focus({ preventScroll: true }); return; }
    const first = focusable[0], last = focusable[focusable.length - 1];
    if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus({ preventScroll: true }); }
    else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus({ preventScroll: true }); }
  });
  addEventListener("message", (event) => {
    if (event.source !== parent || event.data?.protocol !== "keel-viewer-verification@1") return;
    if (event.data.action === "open") open();
    else if (event.data.action === "close") close();
    else if (event.data.action === "toggle") document.body.classList.contains("verify-open") ? close() : open();
    else if (event.data.action === "set-chrome" && (event.data.chrome === "external" || event.data.chrome === "embedded")) document.documentElement.dataset.verificationChrome = event.data.chrome;
    else if (event.data.action === "force-failure") globalThis.__VAULT_VERIFICATION_UI__?.fail("Viewer readiness", "The viewer did not finish initializing before the host deadline.");
  });
  const api = Object.freeze({
    open, close,
    ready() {
      parent.postMessage({ protocol: "keel-viewer-verification@1", action: "ready", state: currentResult.state, title: currentResult.title, proofTier: currentResult.proofTier }, "*");
    },
    fail(label, detail) {
      render(Object.freeze({ state: "failed", title: "Verification failed", summary: `${label}: ${detail}`, checks: Object.freeze([{ id: "viewer-execution", label, passed: false, detail, severity: "fatal" }]), proofTier: "Rejected render", isFixture: false, proofMode: "rejected" }));
      parent.postMessage({ protocol: "keel-viewer-verification@1", action: "state", state: "failed", title: "Verification failed", proofTier: "Rejected render" }, "*");
    },
  });
  Object.defineProperty(globalThis, "__VAULT_VERIFICATION_UI__", { value: api, configurable: false, writable: false });
  render(result);
  parent.postMessage({ protocol: "keel-viewer-verification@1", action: "mounted" }, "*");
  return api;
}

/**
 * Inject the chrome and mount it. Idempotent — a second call reuses the DOM
 * already on the page instead of stacking another seal.
 *
 * @param extraRows Rows a creator wants in the panel. Presentation only: they
 * are rendered in their own section and can never change a check's result.
 */
/**
 * Carriage and transport are host-supplied rather than manifest-injected, on
 * purpose. `context` is the set of fields a manifest declares and a pinned read
 * fills, and that list is itself verified; widening it to carry disclosure
 * would blur a boundary worth keeping sharp. A host reads `viewerCarriage` off
 * the proof ledger and `disclosure()` off the RPC module, and passes both here.
 */
const withDisclosure = (context, carriage, transport) =>
  carriage === undefined && transport === undefined
    ? context
    : {
        ...(context ?? {}),
        ...(carriage === undefined ? {} : { viewerCarriage: carriage }),
        ...(transport === undefined ? {} : { rpcTransport: transport }),
      };

export function mountKeelVerification({ result, runtime, context, carriage, transport, presentation, extraRows, target = document.body } = {}) {
  if (!document.querySelector("#keel-verification-style")) {
    const style = document.createElement("style");
    style.id = "keel-verification-style";
    style.textContent = KEEL_VERIFICATION_CSS;
    document.head.append(style);
  }
  if (!document.querySelector("#verify-seal")) {
    const host = document.createElement("div");
    host.innerHTML = KEEL_VERIFICATION_MARKUP;
    target.append(...host.childNodes);
  }
  const mounted = mountVerificationUI(result, runtime, withDisclosure(context, carriage, transport), presentation);
  if (Array.isArray(extraRows) && extraRows.length !== 0) {
    const details = document.querySelector("#verify-details");
    if (details) {
      const section = document.createElement("section");
      section.className = "verify-section";
      const heading = document.createElement("h3");
      heading.textContent = "Collection";
      section.append(heading);
      for (const row of extraRows) {
        const line = document.createElement("div");
        line.className = "verify-row";
        const key = document.createElement("span");
        key.className = "verify-key";
        key.textContent = String(row?.key ?? "");
        // A row may link out (an explorer, a source). Rendered as an anchor so
        // a reader can check the claim themselves rather than taking the panel's
        // word for it — but still text-only content, so a row can never inject
        // markup into the proof surface.
        let value;
        if (typeof row?.href === "string" && /^https?:\/\//u.test(row.href)) {
          value = document.createElement("a");
          value.href = row.href;
          value.target = "_blank";
          value.rel = "noreferrer noopener";
          value.style.color = "inherit";
        } else {
          value = document.createElement("span");
        }
        value.className = "verify-value";
        value.textContent = String(row?.value ?? "");
        line.append(key, value);
        section.append(line);
      }
      details.append(section);
    }
  }
  return mounted;
}

export { mountVerificationUI };
