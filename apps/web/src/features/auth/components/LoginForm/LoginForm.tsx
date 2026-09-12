import { useReducer } from 'react';
import Alert from '@mui/material/Alert';
import Button from '@mui/material/Button';
import Paper from '@mui/material/Paper';
import TextField from '@mui/material/TextField';
import Typography from '@mui/material/Typography';
import { api } from '../../../../shared/api/endpoints.js';
import { ApiError } from '../../../../shared/api/http.js';
import { useSessionStore } from '../../../../shared/auth/session-store.js';
import styles from './LoginForm.module.scss';

interface FormState {
  readonly email: string;
  readonly password: string;
  readonly error: string | null;
  readonly pending: boolean;
}

type FormAction =
  | { kind: 'field'; field: 'email' | 'password'; value: string }
  | { kind: 'submit' }
  | { kind: 'failed'; error: string };

const initial: FormState = {
  email: 'engineer@fieldstream.local',
  password: '',
  error: null,
  pending: false,
};

const reduce = (state: FormState, action: FormAction): FormState => {
  switch (action.kind) {
    case 'field':
      return { ...state, [action.field]: action.value, error: null };
    case 'submit':
      return { ...state, pending: true, error: null };
    case 'failed':
      return { ...state, pending: false, error: action.error };
  }
};

/** Текст отказа человеческим языком: пароль и недоступный сервер это разные беды. */
const explain = (error: unknown): string => {
  if (error instanceof ApiError && error.isUnauthorized) return 'Неверная почта или пароль';
  if (error instanceof ApiError && error.isUnavailable) {
    return 'Сервер недоступен, попробуйте ещё раз';
  }
  if (error instanceof ApiError && error.status === 429) {
    return 'Слишком много попыток, подождите немного';
  }

  return error instanceof Error ? error.message : 'Войти не удалось';
};

export const LoginForm = (): React.JSX.Element => {
  const [state, dispatch] = useReducer(reduce, initial);

  const submit = async (event: React.SyntheticEvent): Promise<void> => {
    event.preventDefault();
    dispatch({ kind: 'submit' });

    try {
      const session = await api.login(state.email, state.password);
      useSessionStore.getState().setSession(session);
    } catch (error) {
      dispatch({ kind: 'failed', error: explain(error) });
    }
  };

  return (
    <Paper
      component="form"
      className={styles['login']}
      elevation={0}
      onSubmit={(event: React.SyntheticEvent) => {
        void submit(event);
      }}
    >
      <Typography variant="h6" className={styles['login__title']}>
        Вход в Fieldstream
      </Typography>

      <TextField
        label="Почта"
        type="email"
        value={state.email}
        autoComplete="username"
        required
        onChange={(event) => {
          dispatch({ kind: 'field', field: 'email', value: event.target.value });
        }}
      />

      <TextField
        label="Пароль"
        type="password"
        value={state.password}
        autoComplete="current-password"
        required
        onChange={(event) => {
          dispatch({ kind: 'field', field: 'password', value: event.target.value });
        }}
      />

      {state.error === null ? null : (
        <Alert severity="error" role="alert">
          {state.error}
        </Alert>
      )}

      <Button type="submit" variant="contained" disabled={state.pending}>
        {state.pending ? 'Входим' : 'Войти'}
      </Button>

      <Typography variant="caption" color="text.secondary">
        Учётные записи стенда: viewer, engineer, admin на fieldstream.local
      </Typography>
    </Paper>
  );
};
