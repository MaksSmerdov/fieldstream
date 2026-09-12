import { Component } from 'react';
import type { ErrorInfo, ReactNode } from 'react';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import Typography from '@mui/material/Typography';

interface Props {
  readonly children: ReactNode;
}

interface State {
  readonly error: Error | null;
}

/**
 * Последняя защита экрана. Ошибка рендера не должна оставлять белый лист: видно, что случилось,
 * и есть кнопка, которой человек может продолжить работу.
 */
export class ErrorBoundary extends Component<Props, State> {
  public override state: State = { error: null };

  public static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  public override componentDidCatch(error: Error, info: ErrorInfo): void {
    // eslint-disable-next-line no-console -- иначе про ошибку рендера не узнает никто
    console.error('ошибка отрисовки', error, info.componentStack);
  }

  public override render(): ReactNode {
    const { error } = this.state;
    if (error === null) return this.props.children;

    return (
      <Box sx={{ p: 4, display: 'grid', gap: 2, justifyItems: 'start' }}>
        <Typography variant="h6">Экран не отрисовался</Typography>
        <Typography variant="body2" color="text.secondary">
          {error.message}
        </Typography>
        <Button
          variant="contained"
          onClick={() => {
            this.setState({ error: null });
          }}
        >
          Попробовать снова
        </Button>
      </Box>
    );
  }
}
