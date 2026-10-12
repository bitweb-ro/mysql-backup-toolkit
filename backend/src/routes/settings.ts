import { Router, Request, Response } from 'express';
import { getSlackWebhookUrl, setSlackWebhookUrl, testSlackWebhook } from '../services/notificationService';
import { getSetting } from '../db/database';
import { getDiskAlertMinFreeGb, setDiskAlertMinFreeGb } from '../services/diskService';
import {
  getDefaultStorageConfig, setDefaultStorageConfig, maskStorageConfig, parseStorageConfigInput, testStorage,
} from '../services/storageService';
import { StorageConfig } from '../types';

const router = Router();

// Returnează setările platformei. slackWebhookSource indică de unde provine
// webhook-ul activ (db / env / none), util pentru a explica fallback-ul în UI.
router.get('/', (_req: Request, res: Response) => {
  const fromDb = getSetting('slack_webhook_url');
  const active = getSlackWebhookUrl();
  res.json({
    slackWebhookUrl: fromDb || '',
    slackWebhookConfigured: !!active,
    slackWebhookSource: fromDb ? 'db' : (active ? 'env' : 'none'),
    diskAlertMinFreeGb: getDiskAlertMinFreeGb(),
    storageDefault: maskStorageConfig(getDefaultStorageConfig()),
  });
});

// Salvează setările trimise. Câmpurile lipsă rămân neschimbate.
// slackWebhookUrl: string gol = dezactivează notificările din DB.
// diskAlertMinFreeGb: număr de GB; null sau 0 = dezactivează alerta de spațiu.
// storageDefault: destinația implicită a backup-urilor (StorageConfig); secretele mascate se păstrează.
router.put('/', (req: Request, res: Response) => {
  const { slackWebhookUrl, diskAlertMinFreeGb, storageDefault } = req.body || {};
  if (slackWebhookUrl === undefined && diskAlertMinFreeGb === undefined && storageDefault === undefined) {
    return res.status(400).json({ error: 'Nicio setare trimisă.' });
  }

  let storage: StorageConfig | undefined;
  if (storageDefault !== undefined) {
    const parsed = parseStorageConfigInput(storageDefault, getDefaultStorageConfig());
    if ('error' in parsed) return res.status(400).json({ error: parsed.error });
    storage = parsed.config;
  }

  let url: string | undefined;
  if (slackWebhookUrl !== undefined) {
    if (typeof slackWebhookUrl !== 'string') {
      return res.status(400).json({ error: 'slackWebhookUrl trebuie să fie un string.' });
    }
    url = slackWebhookUrl.trim();
    if (url && !/^https:\/\/hooks\.slack\.com\//.test(url)) {
      return res.status(400).json({ error: 'URL invalid. Trebuie să fie un Slack Incoming Webhook (https://hooks.slack.com/...).' });
    }
  }

  if (diskAlertMinFreeGb !== undefined && diskAlertMinFreeGb !== null &&
      (typeof diskAlertMinFreeGb !== 'number' || !Number.isFinite(diskAlertMinFreeGb) || diskAlertMinFreeGb < 0)) {
    return res.status(400).json({ error: 'Limita de spațiu trebuie să fie un număr de GB ≥ 0 (0 sau gol = dezactivat).' });
  }

  if (url !== undefined) setSlackWebhookUrl(url);
  if (diskAlertMinFreeGb !== undefined) setDiskAlertMinFreeGb(diskAlertMinFreeGb);
  if (storage) setDefaultStorageConfig(storage);
  res.json({
    success: true,
    slackWebhookConfigured: !!getSlackWebhookUrl(),
    diskAlertMinFreeGb: getDiskAlertMinFreeGb(),
    storageDefault: maskStorageConfig(getDefaultStorageConfig()),
  });
});

// Testează destinația din formular (nesalvată); secretele mascate se iau din configurația salvată.
router.post('/storage/test', async (req: Request, res: Response) => {
  const parsed = parseStorageConfigInput(req.body?.config, getDefaultStorageConfig());
  if ('error' in parsed) return res.status(400).json({ error: parsed.error });
  try {
    res.json({ success: true, message: await testStorage(parsed.config) });
  } catch (err) {
    res.status(400).json({ error: err instanceof Error ? err.message : 'Test eșuat.' });
  }
});

// Trimite un mesaj de test către webhook-ul configurat.
router.post('/slack/test', async (_req: Request, res: Response) => {
  try {
    await testSlackWebhook();
    res.json({ success: true });
  } catch (err) {
    res.status(400).json({ error: err instanceof Error ? err.message : 'Test eșuat.' });
  }
});

export default router;
