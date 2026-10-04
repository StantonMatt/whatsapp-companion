export const composerStyle = `
*{box-sizing:border-box} [hidden]{display:none!important}
button,input{font:13px system-ui}button{cursor:pointer;color:var(--ink);border:0;background:transparent}
button:disabled{opacity:.4;cursor:default}button:not(:disabled):hover{background:var(--hover)}
button:focus-visible{outline:2px solid #21c063;outline-offset:2px}
.ghost{position:fixed;color:#79938b;opacity:.8;overflow:hidden;pointer-events:none;white-space:pre-wrap;overflow-wrap:anywhere}
.trigger{position:fixed;pointer-events:auto;display:grid;place-items:center;width:28px;height:28px;padding:0;border-radius:50%;color:#21c063;font-size:18px}
.trigger[aria-expanded=true]{background:var(--surface)}
.popup{position:fixed;width:296px;max-width:calc(100vw - 16px);padding:8px;background:var(--background);color:var(--ink);box-shadow:0 8px 28px #0004;border:1px solid var(--line);border-radius:12px;pointer-events:auto;font:13px/1.45 system-ui;overflow:auto;overscroll-behavior:contain}
.popup-header{display:flex;align-items:center;justify-content:space-between;gap:8px;padding:0 2px 6px 6px;font-weight:600}
.close{width:24px;height:24px;padding:0;border-radius:50%;font:20px/1 system-ui;color:var(--muted)}
.action{padding:9px 10px;border-radius:7px;text-align:left}
.actions{display:flex;flex-wrap:wrap;gap:6px;padding:0 2px}
.actions .action{padding:4px 10px;border-radius:14px;background:var(--surface);line-height:18px}
.instruction{display:flex;align-items:center;gap:4px;margin-top:10px;padding:2px 2px 2px 14px;background:var(--surface);border:1px solid transparent;border-radius:20px}
.instruction:focus-within{border-color:#21c063}
input{min-width:0;flex:1;width:100%;padding:7px 0;background:transparent;color:var(--ink);border:0}
input:focus-visible{outline:0}
input::placeholder{color:var(--muted)}
.apply{display:grid;place-items:center;flex:none;width:32px;height:32px;padding:0;border-radius:50%;color:#21c063}
.apply svg{width:20px;height:20px;translate:1px 0}
.apply:disabled{opacity:.5;color:var(--muted)}
.notice-text{padding:0 6px 6px;font-size:12px;color:var(--muted)}
.ghost.loading{opacity:1}
.dots{display:inline-block;width:0;white-space:nowrap;letter-spacing:.12em}.dots.gap i:first-child{margin-left:.18em}.dots i{font-style:normal}
.dots-fallback{position:fixed;width:auto;transform:translate(-100%,-50%);color:#79938b;pointer-events:none}
.sr-status{position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0 0 0 0);white-space:nowrap}
`;
