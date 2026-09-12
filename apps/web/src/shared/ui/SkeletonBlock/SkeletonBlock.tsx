import Skeleton from '@mui/material/Skeleton';
import styles from './SkeletonBlock.module.scss';

interface Props {
  readonly rows?: number;
  readonly height?: number;
  readonly label?: string;
}

/**
 * Загрузка показывается блоками той же высоты, что и будущие данные: спиннер на всю страницу
 * дёргает раскладку, а на живом экране с обновлениями это заметно каждые несколько секунд.
 */
export const SkeletonBlock = ({
  rows = 3,
  height = 40,
  label = 'Загрузка',
}: Props): React.JSX.Element => (
  <div className={styles['skeleton']} role="status" aria-label={label}>
    {Array.from({ length: rows }, (_, index) => (
      <Skeleton key={index} variant="rounded" height={height} animation="wave" />
    ))}
  </div>
);
