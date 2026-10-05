import { useCallback, useLayoutEffect, useRef, useState, type RefObject } from 'react';

const GAP = 8;
const OVERSCAN = 1;

// Tile rows have a fixed square height. The one inline detail row has a measured
// height and remains mounted, so scrolling never discards an editor or its draft.
export function useStickerViewport(grid: RefObject<HTMLDivElement | null>, count: number, columns: number, detailIndex: number, editMode: boolean) {
  const [view, setView] = useState({ top: 0, bottom: typeof window === 'undefined' ? 900 : window.innerHeight, stride: 92, extra: 0 });
  const measureRef = useRef(() => {});
  const detailRow = detailIndex < 0 ? -1 : Math.floor(detailIndex / columns);
  const rows = Math.ceil(count / columns);
  const at = (y: number) => {
    const detailTop = (detailRow + 1) * view.stride;
    return Math.floor((y - (detailRow >= 0 && y >= detailTop ? Math.min(view.extra, y - detailTop) : 0)) / view.stride);
  };
  const first = Math.max(0, Math.min(rows, at(view.top) - OVERSCAN));
  const last = Math.max(first, Math.min(rows, at(view.bottom) + 1 + OVERSCAN));

  useLayoutEffect(() => {
    const element = grid.current, panel = element?.closest<HTMLElement>('.panel');
    if (!element || !panel) return;
    let offset = 0, headerHeight = 0, viewportHeight = window.innerHeight;
    const scroll = () => {
      const top = panel.scrollTop - offset + headerHeight;
      const bottom = panel.scrollTop - offset + viewportHeight;
      setView(previous => previous.top === top && previous.bottom === bottom ? previous : { ...previous, top, bottom });
    };
    const measure = () => {
      const width = element.clientWidth;
      const stride = width ? (width - (columns - 1) * GAP) / columns + GAP : 92;
      const rect = element.getBoundingClientRect(), bounds = panel.getBoundingClientRect();
      const header = panel.querySelector<HTMLElement>('.sticker-head')?.getBoundingClientRect().height ?? 0;
      const bar = panel.querySelector<HTMLElement>('.sticker-select-bar')?.getBoundingClientRect().height ?? 0;
      const height = panel.clientHeight || window.innerHeight;
      offset = rect.top - bounds.top + panel.scrollTop;
      headerHeight = header;
      viewportHeight = height - bar;
      const top = panel.scrollTop - offset + header;
      const bottom = panel.scrollTop - offset + viewportHeight;
      const detail = element.querySelector<HTMLElement>('.sticker-detail');
      const extra = detail ? detail.getBoundingClientRect().height + GAP - 2 : 0;
      setView(previous => previous.top === top && previous.bottom === bottom && previous.stride === stride && previous.extra === extra
        ? previous : { top, bottom, stride, extra });
    };
    measureRef.current = measure;
    measure();
    panel.addEventListener('scroll', scroll, { passive: true });
    window.addEventListener('resize', measure);
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(measure);
    for (const target of [panel, element, element.parentElement, panel.querySelector('.sticker-head'), panel.querySelector('.sticker-select-bar'), element.querySelector('.sticker-detail')]) {
      if (target) observer?.observe(target);
    }
    return () => {
      panel.removeEventListener('scroll', scroll); window.removeEventListener('resize', measure); observer?.disconnect();
    };
  }, [grid, columns, detailIndex, count, editMode]);

  const reveal = useCallback((index: number) => {
    if (index < 0) return false;
    const row = Math.floor(index / columns);
    if (row >= first && row < last) return false;
    const panel = grid.current?.closest<HTMLElement>('.panel');
    if (!panel) return false;
    const top = row * view.stride + (detailRow >= 0 && row > detailRow ? view.extra : 0);
    panel.scrollTop += top - view.top;
    // Update synchronously as scroll events are delivered later by the browser.
    setView(previous => ({ ...previous, top, bottom: top + previous.bottom - previous.top }));
    return true;
  }, [columns, first, last, detailRow, grid, view]);
  const refresh = useCallback(() => measureRef.current(), []);
  return { first, last, rows, stride: view.stride, reveal, refresh };
}
