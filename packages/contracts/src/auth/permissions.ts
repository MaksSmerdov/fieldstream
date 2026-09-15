import { z } from 'zod';

export const roleSchema = z.enum(['viewer', 'engineer', 'admin']);
export type Role = z.infer<typeof roleSchema>;

/**
 * Единица доступа. Право в guard, ключ подписки живого канала и условие маршрута на фронте
 * это одно и то же имя.
 */
export const MODULES = [
  'overview',
  'devices',
  'alarms',
  'alarms.ack',
  'alarm-rules.edit',
  'commands.send',
  'pipeline',
  'pipeline.control',
  'lab',
  'lab.inject',
  'scenarios.run',
  'replay',
  'replay.run',
  'users.manage',
] as const;

export const moduleIdSchema = z.enum(MODULES);
export type ModuleId = z.infer<typeof moduleIdSchema>;

export const permissionEffectSchema = z.enum(['grant', 'deny']);
export type PermissionEffect = z.infer<typeof permissionEffectSchema>;

const VIEWER: readonly ModuleId[] = ['overview', 'devices', 'alarms', 'pipeline', 'lab', 'replay'];
const ENGINEER: readonly ModuleId[] = [
  ...VIEWER,
  'alarms.ack',
  'alarm-rules.edit',
  'commands.send',
  'pipeline.control',
  'lab.inject',
  'scenarios.run',
  'replay.run',
];

/** Что даёт сама роль. Личные права добавляются и отнимаются поверх этого набора. */
export const ROLE_MODULES: Readonly<Record<Role, readonly ModuleId[]>> = Object.freeze({
  viewer: VIEWER,
  engineer: ENGINEER,
  admin: MODULES,
});

/** Действующие права: роль плюс личные разрешения минус личные запреты. Запрет сильнее разрешения. */
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
