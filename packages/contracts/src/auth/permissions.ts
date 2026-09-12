import { z } from 'zod';

export const roleSchema = z.enum(['viewer', 'engineer', 'admin']);
export type Role = z.infer<typeof roleSchema>;

/**
 * Единица доступа. Одно и то же имя служит тремя вещами сразу: правом в guard на сервере,
 * ключом подписки живого канала и условием маршрута на фронте, поэтому разойтись им негде.
 */
export const MODULES = [
  'overview',
  'devices',
  'alarms',
  'alarms.ack',
  'alarm-rules.edit',
  'commands.send',
  'pipeline',
  'replay.run',
  'users.manage',
] as const;

export const moduleIdSchema = z.enum(MODULES);
export type ModuleId = z.infer<typeof moduleIdSchema>;

export const permissionEffectSchema = z.enum(['grant', 'deny']);
export type PermissionEffect = z.infer<typeof permissionEffectSchema>;

const VIEWER: readonly ModuleId[] = ['overview', 'devices', 'alarms', 'pipeline'];
const ENGINEER: readonly ModuleId[] = [
  ...VIEWER,
  'alarms.ack',
  'alarm-rules.edit',
  'commands.send',
  'replay.run',
];

/** Что даёт сама роль. Личные права добавляются и отнимаются поверх этого набора. */
export const ROLE_MODULES: Readonly<Record<Role, readonly ModuleId[]>> = Object.freeze({
  viewer: VIEWER,
  engineer: ENGINEER,
  admin: MODULES,
});

/**
 * Действующие права: роль плюс личные разрешения минус личные запреты. Запрет сильнее
 * разрешения, поэтому отобрать доступ можно всегда, не трогая роль.
 */
export const getEffectivePermissions = (
  role: Role,
  grants: readonly ModuleId[] = [],
  denies: readonly ModuleId[] = [],
): ModuleId[] => {
  const effective = new Set<ModuleId>([...ROLE_MODULES[role], ...grants]);
  for (const denied of denies) effective.delete(denied);

  return MODULES.filter((module) => effective.has(module));
};

/** Есть ли доступ к модулю. Один и тот же вопрос задают guard, подписка и маршрут. */
export const hasPermission = (permissions: readonly ModuleId[], module: ModuleId): boolean =>
  permissions.includes(module);
