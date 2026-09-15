import { describe, expect, it } from 'vitest';
import {
  MODULES,
  ROLE_MODULES,
  getEffectivePermissions,
  hasPermission,
} from '../../src/auth/permissions.js';

describe('действующие права', () => {
  it('роль задаёт основу: наблюдатель смотрит, инженер правит, администратор может всё', () => {
    expect(getEffectivePermissions('viewer')).toEqual([
      'overview',
      'devices',
      'alarms',
      'pipeline',
      'lab',
    ]);
    expect(getEffectivePermissions('engineer')).toContain('alarm-rules.edit');
    expect(getEffectivePermissions('viewer')).not.toContain('alarm-rules.edit');
  });

  it('смотреть на конвейер и стенд может любой, вмешиваться только инженер', () => {
    for (const control of ['pipeline.control', 'lab.inject', 'scenarios.run'] as const) {
      expect(getEffectivePermissions('viewer')).not.toContain(control);
      expect(getEffectivePermissions('engineer')).toContain(control);
    }
    expect(getEffectivePermissions('admin')).toEqual([...MODULES]);
  });

  it('личное разрешение добавляет доступ, не трогая роль', () => {
    expect(getEffectivePermissions('viewer', ['alarms.ack'])).toContain('alarms.ack');
    expect(ROLE_MODULES.viewer).not.toContain('alarms.ack');
  });

  it('запрет сильнее разрешения: доступ отбирается, даже когда он есть по роли', () => {
    expect(getEffectivePermissions('admin', [], ['commands.send'])).not.toContain('commands.send');
    expect(getEffectivePermissions('engineer', ['users.manage'], ['users.manage'])).not.toContain(
      'users.manage',
    );
  });

  it('порядок прав не зависит от порядка разрешений: ответы сравнимы между собой', () => {
    expect(getEffectivePermissions('viewer', ['replay.run', 'alarms.ack'])).toEqual(
      getEffectivePermissions('viewer', ['alarms.ack', 'replay.run']),
    );
  });

  it('проверка доступа отвечает на тот же вопрос, что и guard', () => {
    const permissions = getEffectivePermissions('engineer');

    expect(hasPermission(permissions, 'commands.send')).toBe(true);
    expect(hasPermission(permissions, 'users.manage')).toBe(false);
  });
});
