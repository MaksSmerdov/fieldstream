import type { DeviceMode, ModeSpan } from '@fieldstream/contracts';
import { toIsoTimestamp } from './clock.js';

/** Смена режима: момент и режим, который начался с этого момента. */
export interface ModeChange {
  readonly at: string;
  readonly mode: DeviceMode;
}

export interface ModeSpansInput {
  readonly from: string;
  readonly to: string;
  /** Режим на начало окна: считается по последней смене до него. */
  readonly initialMode: DeviceMode;
  readonly changes: readonly ModeChange[];
}

/**
 * Отрезки режимов на окне. Полоса под графиком должна покрывать окно целиком и без дыр:
 * пропуск читался бы как «режим неизвестен», хотя прибор всё это время в каком-то был.
 * Смены до начала окна только меняют исходный режим, смены после конца отбрасываются.
 */
export const buildModeSpans = (input: ModeSpansInput): ModeSpan[] => {
  const fromMs = Date.parse(input.from);
  const toMs = Date.parse(input.to);
  if (Number.isNaN(fromMs) || Number.isNaN(toMs) || toMs <= fromMs) return [];

  const sorted = [...input.changes]
    .map((change) => ({ atMs: Date.parse(change.at), mode: change.mode }))
    .filter((change) => !Number.isNaN(change.atMs))
    .sort((left, right) => left.atMs - right.atMs);

  const spans: ModeSpan[] = [];
  let mode = input.initialMode;
  let startedMs = fromMs;

  for (const change of sorted) {
    if (change.atMs <= fromMs) {
      mode = change.mode;
      continue;
    }
    if (change.atMs >= toMs) break;
    if (change.mode === mode) continue;

    spans.push({ mode, from: toIsoTimestamp(startedMs), to: toIsoTimestamp(change.atMs) });
    mode = change.mode;
    startedMs = change.atMs;
  }

  spans.push({ mode, from: toIsoTimestamp(startedMs), to: toIsoTimestamp(toMs) });

  return spans;
};
