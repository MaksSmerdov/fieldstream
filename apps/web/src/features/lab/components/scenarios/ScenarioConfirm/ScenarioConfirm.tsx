import { useId } from 'react';
import Button from '@mui/material/Button';
import Dialog from '@mui/material/Dialog';
import DialogActions from '@mui/material/DialogActions';
import DialogContent from '@mui/material/DialogContent';
import DialogContentText from '@mui/material/DialogContentText';
import DialogTitle from '@mui/material/DialogTitle';
import type { ScenarioSummary } from '@fieldstream/contracts';
import { limitText } from '../../../scenario-words.js';

interface Props {
  readonly scenario: ScenarioSummary | null;
  readonly open: boolean;
  readonly onCancel: () => void;
  readonly onConfirm: (name: string) => void;
}

/** Подтверждение запуска: сценарий вносит на стенд настоящие поломки и идёт минутами. */
export const ScenarioConfirm = ({
  scenario,
  open,
  onCancel,
  onConfirm,
}: Props): React.JSX.Element => {
  const titleId = useId();
  const textId = useId();

  return (
    <Dialog
      open={open && scenario !== null}
      onClose={onCancel}
      aria-labelledby={titleId}
      aria-describedby={textId}
    >
      <DialogTitle id={titleId}>
        {scenario === null ? 'Запуск сценария' : `Запустить «${scenario.title}»?`}
      </DialogTitle>

      <DialogContent>
        <DialogContentText id={textId}>
          {scenario === null
            ? ''
            : `Сценарий вносит настоящие поломки на стенд и идёт ${limitText(scenario.timeoutSec)}. Пока он идёт, другой сценарий не запустить, а экраны стенда покажут поломки как настоящие.`}
        </DialogContentText>
      </DialogContent>

      <DialogActions>
        <Button onClick={onCancel} autoFocus>
          Отмена
        </Button>
        <Button
          variant="contained"
          color="error"
          onClick={() => {
            if (scenario !== null) onConfirm(scenario.name);
          }}
        >
          Запустить
        </Button>
      </DialogActions>
    </Dialog>
  );
};
