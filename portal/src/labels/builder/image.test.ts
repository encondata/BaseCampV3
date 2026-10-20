/**
 * Image elements in the builder core: the name each source shows, the box
 * in dots, what the canvas asks the server for (and when it asks nothing),
 * what a raster is cached by, and the bits as the canvas paints them.
 */

import { describe, expect, it } from 'vitest';

import {
  IMAGE_SIZES, PERSON_SAMPLE_KEY, bitsToRgba, imageBoxDots, imageName, imageRasterSize, rasterKey, rasterRequest,
  samplePersonId,
} from './image';
import type { ImageElement } from './model';

const PERSON = '0b7f3c52-6a2e-4c41-9d1e-3f2a9b8c7d10';

function image(over: Partial<ImageElement> = {}): ImageElement {
  return { id: 'image-1', type: 'image', source: 'photo', x: 0.1, y: 0.2, w: 0.8, h: 1, rotation: 0, ...over };
}

describe('imageName', () => {
  it('names a photo, a logo and a static image', () => {
    expect(imageName(image())).toBe('Photo');
    expect(imageName(image({ source: 'logo' }))).toBe('Logo');
    expect(imageName(image({ source: 'static' }))).toBe('Image');
  });
});

describe('sizes', () => {
  it('a photo is portrait and a logo or static image landscape', () => {
    expect(IMAGE_SIZES).toEqual({ photo: { w: 0.8, h: 1 }, logo: { w: 1, h: 0.5 }, static: { w: 1, h: 0.5 } });
  });

  it('the box rounds each side to whole dots as the compiler does, and turns at 90 and 270', () => {
    // 0.5 in at 203 is 101.5 dots: Python's round goes to the even 102
    expect(imageBoxDots(image({ w: 1, h: 0.5 }), 203)).toEqual({ w: 203, h: 102 });
    expect(imageRasterSize(image({ w: 1, h: 0.5 }), 203)).toEqual({ width: 203, height: 102 });
    expect(imageRasterSize(image({ w: 1, h: 0.5, rotation: 90 }), 203)).toEqual({ width: 102, height: 203 });
    expect(imageRasterSize(image({ rotation: 270 }), 300)).toEqual({ width: 300, height: 240 });
    expect(imageRasterSize(image({ rotation: 180 }), 300)).toEqual({ width: 240, height: 300 });
  });
});

describe('samplePersonId', () => {
  it(`reads the sample person from ${PERSON_SAMPLE_KEY}`, () => {
    expect(PERSON_SAMPLE_KEY).toBe('person:id');
    expect(samplePersonId({ 'person:id': PERSON, person_name: 'Ada' })).toBe(PERSON);
    expect(samplePersonId({ person_name: 'Ada' })).toBeNull();
    expect(samplePersonId({ 'person:id': '' })).toBeNull();
  });

  it('sends the stored value as it is, as the server reads it (only an empty one is no person)', () => {
    // the server's `if not value` treats only "" as none: a padded or blank
    // value is a person it can't find (422 person_not_found), never a trimmed one
    expect(samplePersonId({ 'person:id': `${PERSON} ` })).toBe(`${PERSON} `);
    expect(samplePersonId({ 'person:id': '  ' })).toBe('  ');
  });
});

describe('rasterRequest', () => {
  it('asks for the sample person’s photo or logo at the element’s box, fit and turn', () => {
    expect(rasterRequest(image({ rotation: 90 }), 300, PERSON)).toEqual({
      source: 'photo', person_id: PERSON, w_in: 0.8, h_in: 1, dpi: 300, fit: 'cover', rotation: 90,
    });
    expect(rasterRequest(image({ source: 'logo', fit: 'cover' }), 203, PERSON)).toEqual({
      source: 'logo', person_id: PERSON, w_in: 0.8, h_in: 1, dpi: 203, fit: 'cover', rotation: 0,
    });
  });

  it('asks for a static image by its id, whoever the sample person is', () => {
    expect(rasterRequest(image({ source: 'static', imageId: 'img-9' }), 600, PERSON)).toEqual({
      source: 'static', image_id: 'img-9', w_in: 0.8, h_in: 1, dpi: 600, fit: 'contain', rotation: 0,
    });
    expect(rasterRequest(image({ source: 'static', imageId: 'img-9' }), 600, null)?.image_id).toBe('img-9');
  });

  it('asks nothing when there is nothing to fetch', () => {
    expect(rasterRequest(image(), 300, null)).toBeNull();
    expect(rasterRequest(image({ source: 'logo' }), 300, null)).toBeNull();
    expect(rasterRequest(image({ source: 'static' }), 300, PERSON)).toBeNull();
    expect(rasterRequest(image({ source: 'static', imageId: null }), 300, PERSON)).toBeNull();
    expect(rasterRequest(image({ w: 0 }), 300, PERSON)).toBeNull();
    expect(rasterRequest(image({ w: 0.001 }), 300, PERSON)).toBeNull();
  });
});

describe('rasterKey', () => {
  const key = (el: ImageElement, dpi = 300, person: string | null = PERSON) => rasterKey(rasterRequest(el, dpi, person)!);

  it('is the same for the same picture, box in dots, fit, turn, DPI and person', () => {
    expect(key(image())).toBe(key(image({ x: 2, y: 1, brightness: 40, contrast: 150, invert: true, mode: 'threshold' })));
    // a hair that stays inside the same dot
    expect(key(image({ w: 0.8 + 0.0001 }))).toBe(key(image()));
  });

  it('changes with anything the server’s picture depends on', () => {
    const base = key(image());
    for (const other of [
      key(image({ w: 0.9 })), key(image({ h: 0.9 })), key(image({ fit: 'contain' })), key(image({ rotation: 90 })),
      key(image(), 600), key(image(), 300, 'another-person'), key(image({ source: 'logo' })),
    ]) {
      expect(other).not.toBe(base);
    }
    expect(key(image({ source: 'static', imageId: 'a' }))).not.toBe(key(image({ source: 'static', imageId: 'b' })));
    // a static image is the same whoever the sample person is
    expect(key(image({ source: 'static', imageId: 'a' }), 300, 'p1'))
      .toBe(key(image({ source: 'static', imageId: 'a' }), 300, 'p2'));
  });
});

describe('bitsToRgba', () => {
  it('paints a black dot opaque black and leaves a white one transparent, ignoring pad bits', () => {
    // 10 x 2: row 0 = 1000000001, row 1 = 0110000000; each row two bytes
    const bits = Uint8Array.from([0b10000000, 0b01111111, 0b01100000, 0b00111111]);
    const rgba = bitsToRgba(bits, 10, 2);
    expect(rgba).toHaveLength(10 * 2 * 4);
    const alpha = Array.from({ length: 20 }, (_, i) => rgba[i * 4 + 3]);
    expect(alpha).toEqual([255, 0, 0, 0, 0, 0, 0, 0, 0, 255, 0, 255, 255, 0, 0, 0, 0, 0, 0, 0]);
    for (let i = 0; i < 20; i++) expect([rgba[i * 4], rgba[i * 4 + 1], rgba[i * 4 + 2]]).toEqual([0, 0, 0]);
  });
});
