import { test } from 'node:test';
import assert from 'node:assert/strict';
import { QUALITY, effectiveWidth, farToleranceFt } from '../js/quality.js';

test('survey grade changes nothing: the pipe-width tolerance is used as before', () => {
  assert.equal(effectiveWidth(0.67, 'survey'), 0.67);
  assert.equal(farToleranceFt('survey'), 25);
});

test('phone GPS raises the noise floor above a small pipe width, but never lowers a large one', () => {
  assert.equal(effectiveWidth(0.67, 'phone'), 2 * QUALITY.phone.tolFt);   // tolerance = width / 2 = 15 ft
  assert.equal(effectiveWidth(60, 'phone'), 60);                          // a 60 ft "width" already exceeds it
});

test('units: the floor converts from feet to metres', () => {
  assert.ok(Math.abs(effectiveWidth(0.2, 'phone', 0.3048) - 30 * 0.3048) < 1e-9);
});

test('the off-the-line distance grows with the preset, and an unknown key falls back to survey', () => {
  assert.equal(farToleranceFt('phone'), 45);
  assert.equal(farToleranceFt('mapping'), 25);
  assert.equal(effectiveWidth(1, 'nonsense'), 1);
});
