import { deviceProfileSchema } from '@fieldstream/contracts';
import type { DeviceProfile, ReadBlock, RegisterType } from '@fieldstream/contracts';
import type { z } from 'zod';
import { entryFitsBlock, listPlanEntries } from '../frames/read-plan.js';
import type { PlanEntry } from '../frames/read-plan.js';

/** Профиль до применения умолчаний схемы: то, что реально пишут в файле модели прибора. */
export type DeviceProfileInput = z.input<typeof deviceProfileSchema>;

/** Найденная проблема профиля: путь до места и человекочитаемое описание. */
export interface ProfileIssue {
  readonly path: string;
  readonly message: string;
}

export type ProfileValidation =
  | { readonly ok: true; readonly profile: DeviceProfile }
  | { readonly ok: false; readonly issues: readonly ProfileIssue[] };

/** Путь вида "rc-2000 / секция temps / параметр supply_temp_c". */
const profilePath = (profileKey: string, sectionKey?: string, paramKey?: string): string => {
  const parts = [profileKey];
  if (sectionKey !== undefined) parts.push(`секция ${sectionKey}`);
  if (paramKey !== undefined) parts.push(`параметр ${paramKey}`);
  return parts.join(' / ');
};

/** Безопасный проход по неразобранным данным профиля. */
const dig = (value: unknown, path: readonly (string | number)[]): unknown => {
  let current = value;

  for (const step of path) {
    if (current === null || typeof current !== 'object') return undefined;
    current = (current as Record<string | number, unknown>)[step];
  }

  return current;
};

const keyAt = (input: unknown, path: readonly (string | number)[]): string | undefined => {
  const value = dig(input, [...path, 'key']);
  return typeof value === 'string' ? value : undefined;
};

/** Ошибка схемы с путём, понятным человеку, а не индексами массивов. */
const describeIssue = (input: unknown, issue: z.ZodIssue): ProfileIssue => {
  const rawProfileKey = dig(input, ['profileKey']);
  const profileKey = typeof rawProfileKey === 'string' ? rawProfileKey : 'профиль без ключа';
  const path = issue.path;
  const sectionIndex = path[1];
  const paramIndex = path[3];

  if (path[0] === 'sections' && typeof sectionIndex === 'number') {
    const sectionKey = keyAt(input, ['sections', sectionIndex]) ?? `#${String(sectionIndex)}`;

    if (path[2] === 'params' && typeof paramIndex === 'number') {
      const paramKey =
        keyAt(input, ['sections', sectionIndex, 'params', paramIndex]) ?? `#${String(paramIndex)}`;
      const tail = path.slice(4);
      return {
        path: profilePath(profileKey, sectionKey, paramKey) + fieldSuffix(tail),
        message: issue.message,
      };
    }

    return {
      path: profilePath(profileKey, sectionKey) + fieldSuffix(path.slice(2)),
      message: issue.message,
    };
  }

  return { path: profilePath(profileKey) + fieldSuffix(path), message: issue.message };
};

const fieldSuffix = (path: readonly (string | number)[]): string =>
  path.length > 0 ? ` / поле ${path.join('.')}` : '';

/** Ключи секций уникальны, иначе пути ошибок перестают указывать на одно место. */
const duplicateSectionIssues = (profile: DeviceProfile): ProfileIssue[] => {
  const issues: ProfileIssue[] = [];
  const seen = new Set<string>();

  for (const section of profile.sections) {
    if (seen.has(section.key)) {
      issues.push({
        path: profilePath(profile.profileKey, section.key),
        message: `ключ секции "${section.key}" объявлен дважды`,
      });
    }
    seen.add(section.key);
  }

  return issues;
};

/** Ключ параметра уникален в пределах профиля: по нему потом ищут метрику и уставку. */
const duplicateParamIssues = (profile: DeviceProfile): ProfileIssue[] => {
  const issues: ProfileIssue[] = [];
  const owner = new Map<string, string>();

  for (const entry of listPlanEntries(profile)) {
    const previous = owner.get(entry.param.key);
    if (previous !== undefined) {
      issues.push({
        path: profilePath(profile.profileKey, entry.sectionKey, entry.param.key),
        message: `ключ параметра "${entry.param.key}" уже объявлен в секции "${previous}"`,
      });
      continue;
    }
    owner.set(entry.param.key, entry.sectionKey);
  }

  return issues;
};

const describeRange = (registerType: RegisterType, start: number, end: number): string =>
  start === end
    ? `${registerType} ${String(start)}`
    : `${registerType} ${String(start)}..${String(end)}`;

/** Адреса не перекрываются: 32-битная величина занимает два регистра, а не один. */
const overlapIssues = (profile: DeviceProfile): ProfileIssue[] => {
  const issues: ProfileIssue[] = [];
  const previousByType = new Map<RegisterType, PlanEntry>();

  for (const entry of listPlanEntries(profile)) {
    const previous = previousByType.get(entry.registerType);

    if (previous !== undefined && entry.start <= previous.end) {
      issues.push({
        path: profilePath(profile.profileKey, entry.sectionKey, entry.param.key),
        message:
          `регистры ${describeRange(entry.registerType, entry.start, entry.end)} перекрывают ` +
          `параметр "${previous.param.key}" (секция ${previous.sectionKey}, ` +
          `${describeRange(previous.registerType, previous.start, previous.end)})`,
      });
    }

    if (previous === undefined || entry.end > previous.end)
      previousByType.set(entry.registerType, entry);
  }

  return issues;
};

/** Путь вида "pm-3phase / readPlan / блок mains". */
const blockPath = (profileKey: string, blockId: string): string =>
  `${profileKey} / readPlan / блок ${blockId}`;

/** Последний регистр блока. */
const blockEnd = (block: ReadBlock): number => block.startAddress + block.registerCount - 1;

/** Объявленные блоки не перекрываются между собой и не повторяют идентификатор. */
const blockIssues = (profile: DeviceProfile, blocks: readonly ReadBlock[]): ProfileIssue[] => {
  const issues: ProfileIssue[] = [];
  const seenIds = new Set<string>();
  const previousByType = new Map<RegisterType, ReadBlock>();
  const sorted = [...blocks].sort(
    (left, right) =>
      left.registerType.localeCompare(right.registerType) || left.startAddress - right.startAddress,
  );

  for (const block of sorted) {
    const path = blockPath(profile.profileKey, block.id);

    if (seenIds.has(block.id)) {
      issues.push({ path, message: `идентификатор блока "${block.id}" объявлен дважды` });
    }
    seenIds.add(block.id);

    const previous = previousByType.get(block.registerType);
    const previousEnd = previous === undefined ? -1 : blockEnd(previous);

    if (previous !== undefined && block.startAddress <= previousEnd) {
      issues.push({
        path,
        message:
          `блок ${describeRange(block.registerType, block.startAddress, blockEnd(block))} ` +
          `перекрывает блок "${previous.id}" (${describeRange(previous.registerType, previous.startAddress, previousEnd)})`,
      });
    }

    if (previous === undefined || blockEnd(block) > previousEnd) {
      previousByType.set(block.registerType, block);
    }
  }

  return issues;
};

/** Объявленный блок обязан пролезать в один запрос: иначе прибор его просто не отдаст. */
const oversizedBlockIssues = (
  profile: DeviceProfile,
  blocks: readonly ReadBlock[],
): ProfileIssue[] =>
  blocks
    .filter((block) => block.registerCount > profile.maxBlockRegisters)
    .map((block) => ({
      path: blockPath(profile.profileKey, block.id),
      message:
        `блок занимает ${String(block.registerCount)} регистров при лимите ` +
        `maxBlockRegisters ${String(profile.maxBlockRegisters)}: за один запрос столько не прочитать`,
    }));

/** Пересекается ли блок хоть одним регистром с параметром: целиком тот помещаться не обязан. */
const blockTouchesEntry = (block: ReadBlock, entry: PlanEntry): boolean =>
  entry.registerType === block.registerType &&
  entry.start <= blockEnd(block) &&
  entry.end >= block.startAddress;

/** Блок-призрак: запрос уходит, а нужных регистров в нём нет, значит читается впустую. */
const emptyBlockIssues = (profile: DeviceProfile, blocks: readonly ReadBlock[]): ProfileIssue[] => {
  const entries = listPlanEntries(profile);

  return blocks
    .filter((block) => !entries.some((entry) => blockTouchesEntry(block, entry)))
    .map((block) => ({
      path: blockPath(profile.profileKey, block.id),
      message:
        `блок ${describeRange(block.registerType, block.startAddress, blockEnd(block))} ` +
        `не закрывает ни одного параметра: ${String(block.registerCount)} регистров читались бы впустую`,
    }));
};

/** Параметр закрывает ровно один блок: иначе те же регистры уходят в линию дважды за цикл. */
const doubleCoveredIssues = (
  profile: DeviceProfile,
  blocks: readonly ReadBlock[],
): ProfileIssue[] =>
  listPlanEntries(profile).flatMap((entry) => {
    const owners = blocks.filter((block) => entryFitsBlock(entry, block));
    if (owners.length < 2) return [];

    return [
      {
        path: profilePath(profile.profileKey, entry.sectionKey, entry.param.key),
        message:
          `параметр помещается сразу в блоки ${owners.map((block) => `"${block.id}"`).join(', ')}: ` +
          `регистры ${describeRange(entry.registerType, entry.start, entry.end)} читались бы дважды за цикл`,
      },
    ];
  });

/** Если блоки объявлены руками, каждый параметр обязан помещаться в один из них целиком. */
const uncoveredIssues = (profile: DeviceProfile, blocks: readonly ReadBlock[]): ProfileIssue[] =>
  listPlanEntries(profile)
    .filter((entry) => !blocks.some((block) => entryFitsBlock(entry, block)))
    .map((entry) => ({
      path: profilePath(profile.profileKey, entry.sectionKey, entry.param.key),
      message:
        `параметр не помещается целиком ни в один объявленный блок чтения: ` +
        `нужны регистры ${describeRange(entry.registerType, entry.start, entry.end)}`,
    }));

const semanticIssues = (profile: DeviceProfile): ProfileIssue[] => {
  const blocks = profile.readPlan?.blocks ?? [];
  const issues = [
    ...duplicateSectionIssues(profile),
    ...duplicateParamIssues(profile),
    ...overlapIssues(profile),
  ];

  if (blocks.length > 0) {
    issues.push(
      ...blockIssues(profile, blocks),
      ...oversizedBlockIssues(profile, blocks),
      ...emptyBlockIssues(profile, blocks),
      ...doubleCoveredIssues(profile, blocks),
      ...uncoveredIssues(profile, blocks),
    );
  }

  return issues;
};

/**
 * Полная проверка профиля: схема контрактов плюс правила, которые схемой не выражаются.
 * Ошибок не бросает, чтобы редактор профилей мог показать сразу все проблемы списком.
 */
export const validateDeviceProfile = (input: unknown): ProfileValidation => {
  const parsed = deviceProfileSchema.safeParse(input);

  if (!parsed.success) {
    return { ok: false, issues: parsed.error.issues.map((issue) => describeIssue(input, issue)) };
  }

  const issues = semanticIssues(parsed.data);
  return issues.length > 0 ? { ok: false, issues } : { ok: true, profile: parsed.data };
};

/** Профиль модели прибора: проверяется на месте, чтобы ошибка описания не доехала до линии. */
export const defineDeviceProfile = (input: DeviceProfileInput): DeviceProfile => {
  const result = validateDeviceProfile(input);
  if (result.ok) return result.profile;

  const lines = result.issues.map((issue) => `  ${issue.path}: ${issue.message}`).join('\n');
  throw new Error(`профиль прибора описан неверно:\n${lines}`);
};
