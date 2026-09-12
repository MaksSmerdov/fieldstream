import Typography from '@mui/material/Typography';
import { useParams } from 'react-router-dom';

/** Экран прибора: значения, график, уставки и карта регистров. */
export const DevicePage = (): React.JSX.Element => {
  const { code } = useParams();

  return <Typography variant="h5">Прибор {code}</Typography>;
};
