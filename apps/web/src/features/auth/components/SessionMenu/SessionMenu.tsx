import { useState } from 'react';
import Button from '@mui/material/Button';
import Divider from '@mui/material/Divider';
import Menu from '@mui/material/Menu';
import MenuItem from '@mui/material/MenuItem';
import Typography from '@mui/material/Typography';
import { useQueryClient } from '@tanstack/react-query';
import type { Role } from '@fieldstream/contracts';
import { api } from '../../../../shared/api/endpoints.js';
import { useSessionStore } from '../../../../shared/auth/session-store.js';
import styles from './SessionMenu.module.scss';

const ROLE_LABEL: Readonly<Record<Role, string>> = {
  viewer: 'только чтение',
  engineer: 'инженер',
  admin: 'администратор',
};

/**
 * Кто вошёл и как выйти. Роль видна рядом с почтой, потому что от прав зависит половина кнопок.
 * Выход чистит куку обновления на сервере.
 */
export const SessionMenu = (): React.JSX.Element | null => {
  const user = useSessionStore((state) => state.user);
  const client = useQueryClient();
  const [anchor, setAnchor] = useState<HTMLElement | null>(null);

  if (user === null) return null;

  const leave = async (): Promise<void> => {
    setAnchor(null);
    // Отказ сервера не повод оставлять вкладку с открытой сессией: память чистим в любом случае
    await api.logout().catch(() => undefined);
    useSessionStore.getState().clear();
    client.clear();
  };

  return (
    <>
      <Button
        size="small"
        color="inherit"
        className={styles['session__button']}
        onClick={(event) => {
          setAnchor(event.currentTarget);
        }}
        aria-haspopup="menu"
        aria-expanded={anchor !== null}
      >
        {user.displayName}
      </Button>

      <Menu
        anchorEl={anchor}
        open={anchor !== null}
        onClose={() => {
          setAnchor(null);
        }}
      >
        <li className={styles['session__who']}>
          <Typography variant="body2">{user.email}</Typography>
          <span className={styles['session__role']}>{ROLE_LABEL[user.role]}</span>
        </li>
        <Divider />
        <MenuItem
          onClick={() => {
            void leave();
          }}
        >
          Выйти
        </MenuItem>
      </Menu>
    </>
  );
};
