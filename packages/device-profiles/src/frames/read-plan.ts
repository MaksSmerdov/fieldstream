import { WORDS_BY_DATA_TYPE } from '@fieldstream/contracts';
import type {
  DeviceProfile,
  ParamSpec,
  PollCycle,
  ReadBlock,
  RegisterType,
} from '@fieldstream/contracts';

/** Режим сборки плана. Словарь тот же, что уходит в событие цикла опроса. */
export type PlanMode = PollCycle['planMode'];

/** Параметр вместе с секцией и диапазоном регистров, который он занимает. */
export interface PlanEntry {
  readonly sectionKey: string;
  readonly param: ParamSpec;
  readonly registerType: RegisterType;
  readonly start: number;
  readonly end: number;
  readonly words: 1 | 2;
}

/** Блок чтения: один запрос Modbus и параметры, которые он закрывает. */
export interface PlanBlock {
  readonly id: string;
  readonly registerType: RegisterType;
  readonly startAddress: number;
  readonly registerCount: number;
  readonly paramKeys: readonly string[];
  readonly source: 'declared' | 'merged' | 'naive';
}

/** План опроса прибора: что именно уйдёт на линию за один цикл. */
export interface ReadPlan {
  readonly profileKey: string;
  readonly profileVersion: number;
  readonly mode: PlanMode;
  readonly blocks: readonly PlanBlock[];
  /** Число запросов за цикл. Это и есть та цифра, ради которой план собирается. */
  readonly requestCount: number;
  readonly registerCount: number;
  /** Регистры внутри блоков, не нужные ни одному параметру. */
  readonly wastedRegisters: number;
}

export interface ReadPlanOptions {
  readonly mode?: PlanMode;
  /** Урезанный лимит запроса: у части шлюзов буфер меньше протокольных 125 регистров. */
  readonly maxBlockRegisters?: number;
  readonly maxGapRegisters?: number;
  /** Собрать план заново, не глядя на объявленные блоки. */
  readonly ignoreDeclaredBlocks?: boolean;
}

interface BlockDraft {
  registerType: RegisterType;
  start: number;
  end: number;
  keys: string[];
}

const REGISTER_TYPE_ORDER: readonly RegisterType[] = ['holding', 'input'];

/** Протокольный потолок одного запроса на чтение. */
export const MODBUS_MAX_BLOCK_REGISTERS = 125;

const compareEntries = (left: PlanEntry, right: PlanEntry): number =>
  REGISTER_TYPE_ORDER.indexOf(left.registerType) -
    REGISTER_TYPE_ORDER.indexOf(right.registerType) ||
  left.start - right.start ||
  left.param.key.localeCompare(right.param.key);

const compareBlocks = (left: PlanBlock, right: PlanBlock): number =>
  REGISTER_TYPE_ORDER.indexOf(left.registerType) -
    REGISTER_TYPE_ORDER.indexOf(right.registerType) ||
  left.startAddress - right.startAddress ||
  left.id.localeCompare(right.id);

/** Плоский список параметров профиля, отсортированный по типу регистра и адресу. */
export const listPlanEntries = (profile: DeviceProfile): PlanEntry[] => {
  const entries: PlanEntry[] = [];

  for (const section of profile.sections) {
    for (const param of section.params) {
      const words = WORDS_BY_DATA_TYPE[param.dataType];
      entries.push({
        sectionKey: section.key,
        param,
        registerType: param.registerType,
        start: param.address,
        end: param.address + words - 1,
        words,
      });
    }
  }

  return entries.sort(compareEntries);
};

/** Помещается ли параметр в блок целиком: 32-битную величину рвать нельзя. */
export const entryFitsBlock = (
  entry: PlanEntry,
  block: Pick<ReadBlock, 'registerType' | 'startAddress' | 'registerCount'>,
): boolean =>
  entry.registerType === block.registerType &&
  entry.start >= block.startAddress &&
  entry.end <= block.startAddress + block.registerCount - 1;

/** Проверка лимита для одного параметра: она общая для всех режимов сборки плана. */
const assertEntryFitsLimit = (entry: PlanEntry, maxBlock: number): void => {
  if (entry.words > maxBlock) {
    throw new Error(
      `параметр "${entry.param.key}" (секция ${entry.sectionKey}) занимает ${String(entry.words)} регистра ` +
        `при лимите блока ${String(maxBlock)}: 32-битную величину нельзя разорвать между запросами`,
    );
  }
};

/** Жадная склейка: разрыв больше maxGap или переполнение лимита начинают новый блок. */
const mergeEntries = (
  entries: readonly PlanEntry[],
  maxGap: number,
  maxBlock: number,
): PlanBlock[] => {
  const drafts: BlockDraft[] = [];

  for (const entry of entries) {
    assertEntryFitsLimit(entry, maxBlock);

    const current = drafts[drafts.length - 1];
    if (current !== undefined && current.registerType === entry.registerType) {
      const gap = entry.start - current.end - 1;
      const end = Math.max(current.end, entry.end);
      if (gap <= maxGap && end - current.start + 1 <= maxBlock) {
        current.end = end;
        current.keys.push(entry.param.key);
        continue;
      }
    }

    drafts.push({
      registerType: entry.registerType,
      start: entry.start,
      end: entry.end,
      keys: [entry.param.key],
    });
  }

  return drafts.map((draft) => ({
    id: `merged:${draft.registerType}:${String(draft.start)}`,
    registerType: draft.registerType,
    startAddress: draft.start,
    registerCount: draft.end - draft.start + 1,
    paramKeys: draft.keys,
    source: 'merged' as const,
  }));
};

/**
 * По запросу на параметр. Нужен для сравнения на экране и как эталон при разборе.
 * Лимит блока проверяется так же строго, как в склейке: эталон не имеет права его нарушать.
 */
const naiveBlocks = (entries: readonly PlanEntry[], maxBlock: number): PlanBlock[] =>
  entries.map((entry) => {
    assertEntryFitsLimit(entry, maxBlock);

    return {
      id: `naive:${entry.param.key}`,
      registerType: entry.registerType,
      startAddress: entry.start,
      registerCount: entry.words,
      paramKeys: [entry.param.key],
      source: 'naive' as const,
    };
  });

/**
 * Объявленные блоки плюс автосборка для всего, что в них не попало.
 * Блок длиннее лимита это ошибка описания, параметр закрывает первый подошедший блок,
 * а блок без единого параметра запросом не уходит: лишние регистры читать незачем.
 */
const declaredBlocks = (
  declared: readonly ReadBlock[],
  entries: readonly PlanEntry[],
  maxGap: number,
  maxBlock: number,
): PlanBlock[] => {
  const kept: PlanBlock[] = [];
  const taken = new Set<string>();

  for (const block of declared) {
    if (block.registerCount > maxBlock) {
      throw new Error(
        `объявленный блок "${block.id}" занимает ${String(block.registerCount)} регистров ` +
          `при лимите блока ${String(maxBlock)}: столько за один запрос не прочитать`,
      );
    }

    const paramKeys = entries
      .filter((entry) => !taken.has(entry.param.key) && entryFitsBlock(entry, block))
      .map((entry) => entry.param.key);

    if (paramKeys.length === 0) continue;

    for (const key of paramKeys) taken.add(key);
    kept.push({
      id: block.id,
      registerType: block.registerType,
      startAddress: block.startAddress,
      registerCount: block.registerCount,
      paramKeys,
      source: 'declared' as const,
    });
  }

  const uncovered = entries.filter((entry) => !taken.has(entry.param.key));

  return [...kept, ...mergeEntries(uncovered, maxGap, maxBlock)];
};

/** Адреса, реально нужные хотя бы одному параметру. */
const usedAddresses = (entries: readonly PlanEntry[]): Set<string> => {
  const used = new Set<string>();

  for (const entry of entries) {
    for (let address = entry.start; address <= entry.end; address += 1) {
      used.add(`${entry.registerType}:${String(address)}`);
    }
  }

  return used;
};

const wastedInBlock = (block: PlanBlock, used: ReadonlySet<string>): number => {
  let wasted = 0;

  for (let offset = 0; offset < block.registerCount; offset += 1) {
    if (!used.has(`${block.registerType}:${String(block.startAddress + offset)}`)) wasted += 1;
  }

  return wasted;
};

/**
 * Превращает описание прибора в минимальный набор запросов Modbus.
 * Склейка идёт только вплотную: при maxGapRegisters = 0 автоблок никогда не читает
 * регистр, который не нужен ни одному параметру.
 */
export const buildDeviceReadPlan = (
  profile: DeviceProfile,
  options: ReadPlanOptions = {},
): ReadPlan => {
  const entries = listPlanEntries(profile);
  const mode = options.mode ?? 'merged';
  const maxBlock = Math.min(
    options.maxBlockRegisters ?? profile.maxBlockRegisters,
    MODBUS_MAX_BLOCK_REGISTERS,
  );
  const maxGap = options.maxGapRegisters ?? profile.maxGapRegisters;
  const declared = profile.readPlan?.blocks ?? [];
  const useDeclared = declared.length > 0 && !(options.ignoreDeclaredBlocks ?? false);

  const built = (): PlanBlock[] => {
    if (mode === 'naive') return naiveBlocks(entries, maxBlock);
    if (useDeclared) return declaredBlocks(declared, entries, maxGap, maxBlock);
    return mergeEntries(entries, maxGap, maxBlock);
  };

  const ordered = built().sort(compareBlocks);
  const used = usedAddresses(entries);

  return {
    profileKey: profile.profileKey,
    profileVersion: profile.version,
    mode,
    blocks: ordered,
    requestCount: ordered.length,
    registerCount: ordered.reduce((sum, block) => sum + block.registerCount, 0),
    wastedRegisters: ordered.reduce((sum, block) => sum + wastedInBlock(block, used), 0),
  };
};

/** Слова параметра внутри блока. Пусто, если параметр лежит в блоке не целиком. */
export const paramWordsInBlock = (
  block: PlanBlock,
  words: readonly number[],
  param: ParamSpec,
): number[] => {
  const size = WORDS_BY_DATA_TYPE[param.dataType];
  if (param.registerType !== block.registerType) return [];

  const offset = param.address - block.startAddress;
  if (offset < 0 || offset + size > block.registerCount) return [];

  const slice = words.slice(offset, offset + size);
  return slice.length === size ? slice : [];
};
