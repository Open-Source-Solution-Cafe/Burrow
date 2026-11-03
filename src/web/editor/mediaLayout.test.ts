import { describe, expect, it } from 'vitest';
import { mediaWidthPercent } from './mediaLayout';

describe('media width normalization', () => {
  it.each([
    [100, 100],
    [25, 25],
    [50, 50],
    [49.6, 50],
    [0, 25],
    [-10, 25],
    [150, 100],
    [NaN, 100],
    [Infinity, 100],
  ])('normalizes %s to %s', (input, expected) => {
    expect(mediaWidthPercent(input)).toBe(expected);
  });
});
