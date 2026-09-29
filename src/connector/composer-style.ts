export const composerStyle = `
*{box-sizing:border-box} [hidden]{display:none!important}
button,input{font:13px system-ui}button{cursor:pointer;color:var(--ink);border:0;background:transparent}
button:disabled{opacity:.4;cursor:default}button:not(:disabled):hover{background:var(--hover)}
button:focus-visible,input:focus-visible{outline:2px solid #21c063;outline-offset:2px}
.ghost{position:fixed;color:#79938b;opacity:.8;overflow:hidden;pointer-events:none;white-space:pre-wrap;overflow-wrap:anywhere}
.trigger{position:fixed;pointer-events:auto;display:grid;place-items:center;width:28px;height:28px;padding:0;border-radius:50%;color:#21c063;font-size:18px}
.trigger[aria-expanded=true]{background:var(--surface)}
.popup{position:fixed;width:272px;max-width:calc(100vw - 16px);padding:8px;background:var(--background);color:var(--ink);box-shadow:0 8px 28px #0004;border:1px solid var(--line);border-radius:12px;pointer-events:auto;font:13px/1.45 system-ui;overflow:auto;overscroll-behavior:contain}
.popup-header{display:flex;align-items:center;justify-content:space-between;gap:8px;padding:0 2px 6px 6px;font-weight:600}
.close{width:24px;height:24px;padding:0;border-radius:50%;font:20px/1 system-ui;color:var(--muted)}
.actions{display:grid;grid-template-columns:1fr 1fr;gap:4px}
.action{padding:9px 10px;border-radius:7px;text-align:left}
.instruction{display:flex;align-items:center;gap:4px;border-top:1px solid var(--line);margin-top:7px;padding-top:8px}
input{min-width:0;flex:1;width:100%;padding:8px 10px;background:var(--surface);color:var(--ink);border:1px solid transparent;border-radius:7px}
input::placeholder{color:var(--muted)}
.apply{display:grid;place-items:center;flex:none;width:32px;height:32px;padding:0;border-radius:50%;color:#21c063;font-size:19px}
.primary{border-radius:7px;padding:7px 12px;background:#21c063;color:#082719;font-weight:600}
.primary:not(:disabled):hover{background:#29d16e}
.preview-text{white-space:pre-wrap;overflow-wrap:anywhere;max-height:220px;overflow:auto;margin:2px 6px 10px;user-select:text}
.preview-footer{display:flex;align-items:center;justify-content:flex-end;gap:9px;padding:0 4px 2px}
kbd{color:var(--muted);font:11px system-ui;border:1px solid var(--line);border-radius:4px;padding:2px 4px}
.notice-text{padding:0 6px 6px;font-size:12px;color:var(--muted)}
.pending-text{display:flex;align-items:center;gap:8px;padding:6px;color:var(--muted)}
.spinner{width:12px;height:12px;border:2px solid var(--line);border-top-color:#21c063;border-radius:50%;animation:spin .8s linear infinite}
@keyframes spin{to{transform:rotate(360deg)}}@media(prefers-reduced-motion:reduce){.spinner{animation:none}}
`;
