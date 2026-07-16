import { describe, it, expect } from 'vitest';
import { normalizeDigits, extractNumbers, findMissingNumbers } from './number-guard';

describe('normalizeDigits', () => {
  it('converts Arabic-Indic digits to Western', () => {
    expect(normalizeDigits('٥٠٠')).toBe('500');
  });

  it('converts Extended Arabic-Indic (Persian) digits to Western', () => {
    expect(normalizeDigits('۵۰۰')).toBe('500');
  });

  it('leaves Western digits and other text untouched', () => {
    expect(normalizeDigits('500mg twice daily')).toBe('500mg twice daily');
  });

  it('handles mixed Arabic-Indic and Western digits in the same string', () => {
    expect(normalizeDigits('٥٠٠mg / 500mg')).toBe('500mg / 500mg');
  });
});

describe('extractNumbers', () => {
  it('extracts a simple integer', () => {
    expect(extractNumbers('take 500 mg')).toEqual(['500']);
  });

  it('extracts decimals', () => {
    expect(extractNumbers('dose is 2.5 mL')).toEqual(['2.5']);
  });

  it('extracts a number embedded directly in a unit (no space)', () => {
    expect(extractNumbers('500mg tablet')).toEqual(['500']);
  });

  it('strips thousands separators', () => {
    expect(extractNumbers('population of 1,000 people')).toEqual(['1000']);
  });

  it('treats a bare decimal comma as a decimal point when not a thousands separator', () => {
    expect(extractNumbers('dose 2,5 mL')).toEqual(['2.5']);
  });

  it('normalizes Arabic-Indic digits before extracting', () => {
    expect(extractNumbers('الجرعة ٥٠٠ ملغ')).toEqual(['500']);
  });

  it('dedupes repeated numbers', () => {
    expect(extractNumbers('500 mg now, 500 mg later')).toEqual(['500']);
  });

  it('returns an empty array when there are no numbers', () => {
    expect(extractNumbers('no numbers here at all')).toEqual([]);
  });
});

describe('findMissingNumbers', () => {
  it('flags nothing when every source number survives translation', () => {
    const result = findMissingNumbers('Take 500mg twice daily.', 'خذ 500 ملغ مرتين يوميًا.');
    expect(result.ok).toBe(true);
    expect(result.missing).toEqual([]);
  });

  it('flags a dose silently dropped from the translation', () => {
    const result = findMissingNumbers(
      'Take 500mg twice daily.',
      'خذ الدواء مرتين يوميًا.', // 500 is gone
    );
    expect(result.ok).toBe(false);
    expect(result.missing).toEqual(['500']);
  });

  it('flags a dose that was altered (not just dropped)', () => {
    const result = findMissingNumbers(
      'Take 500mg twice daily.',
      'خذ ٥٥٠ ملغ مرتين يوميًا.', // 550, not 500 -- a mistranslation, not a drop
    );
    expect(result.ok).toBe(false);
    expect(result.missing).toEqual(['500']);
  });

  it('recognizes a dose preserved via Arabic-Indic digits as present, not missing', () => {
    const result = findMissingNumbers(
      'Take 500mg twice daily.',
      'خذ ٥٠٠ ملغ مرتين يوميًا.', // 500 rendered in Arabic-Indic digits
    );
    expect(result.ok).toBe(true);
    expect(result.missing).toEqual([]);
  });

  it('flags a decimal dose dropped from translation', () => {
    const result = findMissingNumbers('Dose: 2.5 mL every 8 hours.', 'الجرعة كل 8 ساعات.');
    expect(result.ok).toBe(false);
    expect(result.missing).toEqual(['2.5']);
  });

  it('is not a false positive when the translation adds extra numbers not in the source', () => {
    // extra numbers in the translation (e.g. a footnote reference) shouldn't count against it
    const result = findMissingNumbers('Take 500mg daily.', 'خذ 500 ملغ يوميًا. (١)');
    expect(result.ok).toBe(true);
    expect(result.missing).toEqual([]);
  });

  it('handles multiple numbers, flagging only the ones actually missing', () => {
    const result = findMissingNumbers(
      'Take 500mg in the morning and 250mg at night.',
      'خذ 500 ملغ في الصباح.', // 250 got dropped
    );
    expect(result.ok).toBe(false);
    expect(result.missing).toEqual(['250']);
  });
});
