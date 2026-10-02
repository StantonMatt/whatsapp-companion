// @vitest-environment jsdom
import { test, expect } from 'vitest';
import { stickerImageState } from '../src/connector/sticker-image-state';

test.each(['source', 'load'])('an errored image can retry after a new %s', retry => {
  const image = document.createElement('img'); image.src = 'data:image/webp;base64,b2xk';
  Object.defineProperties(image, { complete: { value: false, configurable: true }, naturalWidth: { value: 0, configurable: true } });
  expect(stickerImageState(image)).toBe('pending');
  image.dispatchEvent(new Event('error')); expect(stickerImageState(image)).toBe('settled');
  if (retry === 'source') {
    image.src = 'data:image/webp;base64,bmV3';
    expect(stickerImageState(image)).toBe('pending');
  } else image.dispatchEvent(new Event('load'));
  Object.defineProperties(image, { complete: { value: true }, naturalWidth: { value: 100 } });
  expect(stickerImageState(image)).toBe('ready');
});
