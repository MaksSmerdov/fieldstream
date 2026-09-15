import { replayRequestSchema } from '@fieldstream/contracts';
import type {
  AlarmRuleView,
  DeviceMode,
  ReplayPatch,
  ReplayPatchField,
  ReplayRequest,
} from '@fieldstream/contracts';
import { spanText } from '../../shared/time/human-time.js';
import { MODE_LABEL } from '../device/mode-view.js';

export type WindowPreset = '15m' | '1h' | '6h' | '24h';
export type WindowKey = WindowPreset | 'custom';

export const WINDOW_PRESETS: readonly WindowPreset[] = ['15m', '1h', '6h', '24h'];

export const WINDOW_MS: Readonly<Record<WindowPreset, number>> = {
  '15m': 900_000,
  '1h': 3_600_000,
  '6h': 21_600_000,
  '24h': 86_400_000,
};

export const WINDOW_LABEL: Readonly<Record<WindowKey, string>> = {
  '15m': '15 мин',
  '1h': '1 ч',
  '6h': '6 ч',
  '24h': '24 ч',
  custom: 'своё',
};

/** Допуск шлюза на расхождение часов для конца окна. */
const FUTURE_SLACK_MS = 60_000;

export type EnabledChoice = 'keep' | 'on' | 'off';

/** Черновик правки: поля ввода строками, снятие границы отдельным признаком. */
export interface PatchDraft {
  readonly id: number;
  readonly metricKey: string;
  readonly mode: DeviceMode;
  readonly minValue: string;
  readonly maxValue: string;
  readonly clearMin: boolean;
  readonly clearMax: boolean;
  readonly hysteresis: string;
  readonly debounceCycles: string;
  readonly enabled: EnabledChoice;
}

export type PatchEdit = Partial<Omit<PatchDraft, 'id'>>;

export interface ReplayFormState {
  readonly devices: readonly string[];
  readonly windowKey: WindowKey;
  readonly customFrom: string;
  readonly customTo: string;
  readonly patches: readonly PatchDraft[];
  readonly nextId: number;
  /** Была попытка отправить: с этого момента проблемы формы видны. */
  readonly submitted: boolean;
}

export type ReplayFormAction =
  | { readonly type: 'toggleDevice'; readonly code: string }
  | { readonly type: 'setDevices'; readonly codes: readonly string[] }
  | { readonly type: 'setWindow'; readonly key: WindowKey; readonly nowMs: number }
  | { readonly type: 'setCustom'; readonly edge: 'from' | 'to'; readonly value: string }
  | { readonly type: 'addPatch' }
  | { readonly type: 'removePatch'; readonly id: number }
  | { readonly type: 'editPatch'; readonly id: number; readonly edit: PatchEdit }
  | { readonly type: 'applyExample'; readonly chambers: readonly string[] }
  | { readonly type: 'submit' };

export const MAX_PATCHES = 20;

export const EXAMPLE_LABEL = 'Граница испарителя в оттайке +8';

export const EXAMPLE_HINT =
  'Змеевик испарителя в оттайке штатно греется до +10 °C, поэтому граница стоит на +12. С границей +8 перепрогон покажет срабатывание на каждой штатной оттайке, а с прежней ни одного.';

const emptyDraft = (id: number): PatchDraft => ({
  id,
  metricKey: '',
  mode: 'cooling',
  minValue: '',
  maxValue: '',
  clearMin: false,
  clearMax: false,
  hysteresis: '',
  debounceCycles: '',
  enabled: 'keep',
});

export const INITIAL_FORM: ReplayFormState = {
  devices: [],
  windowKey: '1h',
  customFrom: '',
  customTo: '',
  patches: [emptyDraft(1)],
  nextId: 2,
  submitted: false,
};

const pad = (value: number): string => String(value).padStart(2, '0');

/** Момент в виде поля datetime-local по часам вкладки. */
export const localInputValue = (ms: number): string => {
  const date = new Date(ms);

  return (
    `${String(date.getFullYear())}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}` +
    `T${pad(date.getHours())}:${pad(date.getMinutes())}`
  );
};

/** Изменения формы перепрогона. */
export const replayFormReducer = (
  state: ReplayFormState,
  action: ReplayFormAction,
): ReplayFormState => {
  switch (action.type) {
    case 'toggleDevice':
      return {
        ...state,
        devices: state.devices.includes(action.code)
          ? state.devices.filter((code) => code !== action.code)
          : [...state.devices, action.code],
      };
    case 'setDevices':
      return { ...state, devices: [...action.codes] };
    case 'setWindow': {
      if (action.key !== 'custom' || state.customFrom !== '') {
        return { ...state, windowKey: action.key };
      }
      const lengthMs = state.windowKey === 'custom' ? WINDOW_MS['1h'] : WINDOW_MS[state.windowKey];
      return {
        ...state,
        windowKey: 'custom',
        customFrom: localInputValue(action.nowMs - lengthMs),
        customTo: localInputValue(action.nowMs),
      };
    }
    case 'setCustom':
      return action.edge === 'from'
        ? { ...state, customFrom: action.value }
        : { ...state, customTo: action.value };
    case 'addPatch':
      return state.patches.length >= MAX_PATCHES
        ? state
        : {
            ...state,
            patches: [...state.patches, emptyDraft(state.nextId)],
            nextId: state.nextId + 1,
          };
    case 'removePatch':
      return { ...state, patches: state.patches.filter((draft) => draft.id !== action.id) };
    case 'editPatch':
      return {
        ...state,
        patches: state.patches.map((draft) =>
          draft.id === action.id ? { ...draft, ...action.edit } : draft,
        ),
      };
    case 'applyExample': {
      const hasChamber = state.devices.some((code) => action.chambers.includes(code));
      return {
        ...state,
        devices: hasChamber ? state.devices : [...action.chambers],
        patches: [
          {
            ...emptyDraft(state.nextId),
            metricKey: 'evap_temp_c',
            mode: 'defrost',
            maxValue: '8',
          },
        ],
        nextId: state.nextId + 1,
      };
    }
    case 'submit':
      return state.submitted ? state : { ...state, submitted: true };
  }
};

/** Уставки выбранных приборов, по которым форма подсказывает и проверяет правки. */
export interface RuleCatalog {
  readonly byDevice: ReadonlyMap<string, readonly AlarmRuleView[]>;
  /** Уставки всех выбранных приборов пришли. */
  readonly loaded: boolean;
  readonly failed: boolean;
}

export interface FormContext {
  readonly nowMs: number;
  readonly retentionMs: number;
  readonly rules: RuleCatalog;
  readonly labelOf: (metricKey: string) => string;
}

export interface FormOutcome {
  readonly request: ReplayRequest | null;
  readonly problems: readonly string[];
}

const ruleOf = (
  rules: RuleCatalog,
  code: string,
  metricKey: string,
  mode: DeviceMode,
): AlarmRuleView | undefined =>
  rules.byDevice.get(code)?.find((rule) => rule.metricKey === metricKey && rule.mode === mode);

/** Параметры и режимы, для которых у выбранных приборов есть уставки. */
export const ruleOptions = (
  rules: RuleCatalog,
  codes: readonly string[],
): ReadonlyMap<string, readonly DeviceMode[]> => {
  const options = new Map<string, Set<DeviceMode>>();
  for (const code of codes) {
    for (const rule of rules.byDevice.get(code) ?? []) {
      const modes = options.get(rule.metricKey) ?? new Set<DeviceMode>();
      modes.add(rule.mode);
      options.set(rule.metricKey, modes);
    }
  }

  const order = Object.keys(MODE_LABEL);
  return new Map(
    [...options.entries()]
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([metricKey, modes]) => [
        metricKey,
        [...modes].sort((left, right) => order.indexOf(left) - order.indexOf(right)),
      ]),
  );
};

/** Значение поля уставки словами для подсказки. */
const hintValue = (value: number | boolean | null): string => {
  if (value === null) return 'не задана';
  if (typeof value === 'boolean') return value ? 'включена' : 'выключена';

  return String(value);
};

/** Подсказка текущего значения поля у выбранных приборов. */
export const currentHint = (
  rules: RuleCatalog,
  codes: readonly string[],
  draft: Pick<PatchDraft, 'metricKey' | 'mode'>,
  field: ReplayPatchField,
): string => {
  if (draft.metricKey === '' || codes.length === 0) return '';
  if (rules.failed) return 'текущее значение не загрузилось';
  if (!rules.loaded) return 'загружаем текущее значение';

  const values = codes.flatMap((code) => {
    const rule = ruleOf(rules, code, draft.metricKey, draft.mode);
    return rule === undefined ? [] : [rule[field]];
  });
  if (values.length === 0) return 'у выбранных приборов такой уставки нет';

  const distinct = [...new Set(values)];
  if (distinct.length === 1) return `сейчас ${hintValue(distinct[0] ?? null)}`;
  const numbers = distinct.filter((value): value is number => typeof value === 'number');
  if (numbers.length === distinct.length) {
    return `сейчас от ${String(Math.min(...numbers))} до ${String(Math.max(...numbers))}`;
  }

  return 'у приборов по-разному';
};

/** Число из поля ввода: пустое поле это «не задано», мусор это ошибка. */
const numberOf = (text: string): number | 'empty' | 'bad' => {
  const trimmed = text.trim().replace(',', '.');
  if (trimmed.length === 0) return 'empty';
  const value = Number(trimmed);

  return Number.isFinite(value) ? value : 'bad';
};

/** Окно запроса: пресет отсчитывается от серверного времени, своё берётся из полей. */
const windowOf = (
  state: ReplayFormState,
  context: FormContext,
): { readonly from: string; readonly to: string } | string => {
  const retention = spanText(context.retentionMs);

  if (state.windowKey !== 'custom') {
    if (WINDOW_MS[state.windowKey] > context.retentionMs) {
      return `Окно длиннее срока хранения сырых кадров (${retention}).`;
    }
    const toMs = Math.floor(context.nowMs / 1000) * 1000;
    return {
      from: new Date(toMs - WINDOW_MS[state.windowKey]).toISOString(),
      to: new Date(toMs).toISOString(),
    };
  }

  const fromMs = Date.parse(state.customFrom);
  const toMs = Date.parse(state.customTo);
  if (Number.isNaN(fromMs) || Number.isNaN(toMs)) return 'Укажите начало и конец окна.';
  if (toMs <= fromMs) return 'Конец окна должен быть позже начала.';
  if (fromMs < context.nowMs - context.retentionMs) {
    return `Начало окна старше ${retention}: такие сырые кадры брокер уже удалил.`;
  }
  if (toMs > context.nowMs + FUTURE_SLACK_MS) return 'Конец окна не может быть в будущем.';

  return { from: new Date(fromMs).toISOString(), to: new Date(toMs).toISOString() };
};

interface PatchCheck {
  readonly patch: ReplayPatch | null;
  readonly problems: readonly string[];
}

/** Черновик в правку контракта; пустое поле не попадает, снятая граница едет как null. */
const patchOf = (draft: PatchDraft, name: string): PatchCheck => {
  const problems: string[] = [];
  const fields: {
    minValue?: number | null;
    maxValue?: number | null;
    hysteresis?: number;
    debounceCycles?: number;
    enabled?: boolean;
  } = {};

  const bound = (text: string, clear: boolean, word: string): number | null | undefined => {
    if (clear) return null;
    const value = numberOf(text);
    if (value === 'bad') problems.push(`${name}: ${word} граница не число.`);

    return typeof value === 'number' ? value : undefined;
  };

  const minValue = bound(draft.minValue, draft.clearMin, 'нижняя');
  if (minValue !== undefined) fields.minValue = minValue;
  const maxValue = bound(draft.maxValue, draft.clearMax, 'верхняя');
  if (maxValue !== undefined) fields.maxValue = maxValue;

  const hysteresis = numberOf(draft.hysteresis);
  if (
    hysteresis === 'bad' ||
    (typeof hysteresis === 'number' && (hysteresis < 0 || hysteresis > 1000))
  ) {
    problems.push(`${name}: гистерезис должен быть числом от 0 до 1000.`);
  } else if (typeof hysteresis === 'number') {
    fields.hysteresis = hysteresis;
  }

  const cycles = numberOf(draft.debounceCycles);
  if (
    cycles === 'bad' ||
    (typeof cycles === 'number' && (!Number.isInteger(cycles) || cycles < 1 || cycles > 60))
  ) {
    problems.push(`${name}: выдержка должна быть целым числом циклов от 1 до 60.`);
  } else if (typeof cycles === 'number') {
    fields.debounceCycles = cycles;
  }

  if (draft.enabled !== 'keep') fields.enabled = draft.enabled === 'on';

  if (problems.length > 0) return { patch: null, problems };
  if (Object.keys(fields).length === 0) {
    return { patch: null, problems: [`${name}: измените хотя бы одно поле.`] };
  }
  if (fields.minValue === null && fields.maxValue === null) {
    return { patch: null, problems: [`${name}: нужна хотя бы одна граница.`] };
  }
  if (
    typeof fields.minValue === 'number' &&
    typeof fields.maxValue === 'number' &&
    fields.minValue >= fields.maxValue
  ) {
    return { patch: null, problems: [`${name}: нижняя граница должна быть меньше верхней.`] };
  }

  return { patch: { metricKey: draft.metricKey, mode: draft.mode, ...fields }, problems: [] };
};

/** Правка против текущих уставок приборов: её ли шлюз отвергнет. */
const ruleProblem = (
  patch: ReplayPatch,
  name: string,
  codes: readonly string[],
  rules: RuleCatalog,
): string | null => {
  const affected = codes.flatMap((code) => {
    const rule = ruleOf(rules, code, patch.metricKey, patch.mode);
    return rule === undefined ? [] : [{ code, rule }];
  });
  if (affected.length === 0) return `${name}: у выбранных приборов такой уставки нет.`;

  let changes = false;
  let changesDisabled = false;
  let anyEnabled = false;
  for (const { code, rule } of affected) {
    const merged = {
      minValue: patch.minValue === undefined ? rule.minValue : patch.minValue,
      maxValue: patch.maxValue === undefined ? rule.maxValue : patch.maxValue,
      hysteresis: patch.hysteresis ?? rule.hysteresis,
      debounceCycles: patch.debounceCycles ?? rule.debounceCycles,
      enabled: patch.enabled ?? rule.enabled,
    };
    if (merged.minValue === null && merged.maxValue === null) {
      return `${name}: у прибора ${code} не останется ни одной границы.`;
    }
    if (
      merged.minValue !== null &&
      merged.maxValue !== null &&
      merged.minValue >= merged.maxValue
    ) {
      return `${name}: у прибора ${code} нижняя граница ${String(merged.minValue)} окажется не ниже верхней ${String(merged.maxValue)}.`;
    }
    if (rule.enabled) anyEnabled = true;
    const differs = (Object.keys(merged) as (keyof typeof merged)[]).some(
      (key) => merged[key] !== rule[key],
    );
    if (differs && (rule.enabled || merged.enabled)) changes = true;
    else if (differs) changesDisabled = true;
  }

  if (changes) return null;
  if (!changesDisabled) return `${name}: значения совпадают с текущими, правка ничего не меняет.`;

  return anyEnabled
    ? `${name}: у включённых уставок значения совпадают с текущими, а у выключенных правка на срабатывания не влияет.`
    : `${name}: уставка выключена у всех выбранных приборов и на срабатывания не влияет, включите её в правке.`;
};

/**
 * Запрос из формы и всё, что шлюз в нём отвергнет, человеческими словами. Последней идёт
 * проверка схемой контракта: экран не должен разрешать то, что шлюз не примет.
 */
export const evaluateForm = (state: ReplayFormState, context: FormContext): FormOutcome => {
  const problems: string[] = [];

  if (state.devices.length === 0) problems.push('Выберите хотя бы один прибор.');

  const window = windowOf(state, context);
  if (typeof window === 'string') problems.push(window);

  if (state.patches.length === 0) problems.push('Добавьте хотя бы одну правку.');

  const patches: ReplayPatch[] = [];
  const keys = new Set<string>();
  for (const [index, draft] of state.patches.entries()) {
    if (draft.metricKey === '') {
      problems.push(`Правка ${String(index + 1)}: выберите параметр.`);
      continue;
    }
    const name = `Правка «${context.labelOf(draft.metricKey)}, ${MODE_LABEL[draft.mode]}»`;
    const key = `${draft.metricKey}|${draft.mode}`;
    if (keys.has(key)) {
      problems.push(`${name}: эта уставка уже правится выше.`);
      continue;
    }
    keys.add(key);

    const check = patchOf(draft, name);
    problems.push(...check.problems);
    if (check.patch === null) continue;

    if (context.rules.loaded) {
      const problem = ruleProblem(check.patch, name, state.devices, context.rules);
      if (problem !== null) problems.push(problem);
    }
    patches.push(check.patch);
  }

  if (problems.length > 0 || typeof window === 'string') {
    return { request: null, problems: [...new Set(problems)] };
  }

  const request: ReplayRequest = {
    from: window.from,
    to: window.to,
    deviceCodes: [...state.devices],
    patches,
  };
  const parsed = replayRequestSchema.safeParse(request);
  if (!parsed.success) {
    return {
      request: null,
      problems: [
        ...new Set(
          parsed.error.issues.map(
            (issue) => `${issue.message.charAt(0).toUpperCase()}${issue.message.slice(1)}.`,
          ),
        ),
      ],
    };
  }

  return { request: parsed.data, problems: [] };
};
