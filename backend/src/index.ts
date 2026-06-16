import dotenv from 'dotenv';
import path from 'path';
dotenv.config({ path: path.resolve(__dirname, '../../.env') });
import express from 'express';
import cors from 'cors';
import { getDb } from './db/database';
import authRouter from './routes/auth';
import connectionsRouter from './routes/connections';
import backupsRouter from './routes/backups';
import dashboardRouter from './routes/dashboard';
import schedulesRouter from './routes/schedules';
import { authMiddleware } from './middleware/auth';
import { initScheduler } from './services/schedulerService';

const app = express();
const PORT = process.env.PORT || 3001;

app.use(cors());
app.use(express.json());

getDb();
initScheduler();

app.use('/api/auth', authRouter);

app.use('/api', authMiddleware);
app.use('/api/dashboard', dashboardRouter);
app.use('/api/connections', connectionsRouter);
app.use('/api/connections/:connectionId/backups', backupsRouter);
app.use('/api/schedules', schedulesRouter);

if (process.env.NODE_ENV === 'production') {
  const buildPath = path.join(__dirname, '../../frontend/dist');
  app.use(express.static(buildPath));
  app.get('*', (_req, res) => {
    res.sendFile(path.join(buildPath, 'index.html'));
  });
}

app.listen(PORT, () => {
  console.log(`MySQL Backup Manager running on port ${PORT}`);
  console.log(`Backup storage: ${path.join(process.cwd(), '..', 'backup_servers')}`);
});

export default app;
