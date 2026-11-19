import React from 'react';
import type { Provider, Status, StickerTagError } from '../shared/model';
import type { Act } from './index';
export const providerName = (provider: Provider) => provider === 'openai' ? 'OpenAI' : 'Anthropic';
export const SparkIcon = () => <svg viewBox="0 0 24 24" aria-hidden="true"><path fill="currentColor" d="M12 2.5c.75 4.95 4.55 8.75 9.5 9.5-4.95.75-8.75 4.55-9.5 9.5-.75-4.95-4.55-8.75-9.5-9.5 4.95-.75 8.75-4.55 9.5-9.5z"/></svg>;
export const TagDots = () => <span className="tag-dots" aria-hidden="true"><i/><i/><i/></span>;
export const tagSettingsError = (error?: StickerTagError) => error === 'no-key' || error === 'auth' || error === 'no-vision';
export function tagErrorMessage(error: StickerTagError, provider: Provider): string {
  const name = providerName(provider);
  return error === 'no-key' ? `Add an ${name} API key to tag stickers.` : error === 'auth' ? `${name} key rejected.`
    : error === 'rate-limit' ? `Rate limited by ${name}.` : error === 'quota' ? `${name} quota reached.` : error === 'offline' ? `Couldn’t reach ${name}.`
    : error === 'no-vision' ? 'The selected model can’t read images.' : 'Couldn’t tag this sticker.';
}
export function TagStrip({ status, act, settings, retry }: { status: Status; act: Act; settings(): void; retry(): void }) {
  const progress = status.stickerTagging;
  if (!progress) return null;
  const running = progress.state === 'running', blocked = progress.state === 'blocked';
  const link = (label: string, callback: () => void) => <button className="strip-link" onClick={callback}>{label}</button>;
  return <>
    <p className={`sticker-strip tag-strip${blocked ? ' warn' : ''}`} role={blocked ? 'alert' : 'status'}>
      <span>{running ? <><TagDots/>Tagging {Math.min(progress.completed + 1, progress.total)} of {progress.total}{progress.failed > 0 && ` · ${progress.failed} failed`}</>
        : blocked ? <>{tagErrorMessage(progress.error ?? 'failed', progress.provider).replace(/\.$/, '')}{progress.error !== 'no-key' && progress.error !== 'no-vision' && progress.error !== 'rate-limit' && ` · ${progress.tagged} of ${progress.total} tagged`}</>
        : progress.state === 'done' ? <><span className="ok">✓</span>{progress.tagged} tagged</>
        : progress.state === 'stopped' ? <>Stopped · {progress.tagged} of {progress.total} tagged{progress.failed ? ` · ${progress.failed} failed` : ''}</>
        : <>{progress.tagged} tagged · {progress.failed} failed</>}</span>
      {running && progress.failed > 0 && link('Try again', retry)}
      {running ? link('Stop', () => void act({ type: 'stopStickerTags' })) : blocked && tagSettingsError(progress.error) ? link('Settings', settings)
        : (blocked || progress.failed > 0) && link('Try again', retry)}
      {!running && progress.state !== 'done' && <button className="icon-close" aria-label="Dismiss tagging result" onClick={() => void act({ type: 'dismissStickerTags' })}>×</button>}
    </p>
    {running && <div className="tag-progress" aria-hidden="true"><i style={{ width: `${progress.completed / Math.max(1, progress.total) * 100}%` }}/></div>}
  </>;
}
