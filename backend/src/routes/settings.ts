import { Router, Request, Response } from 'express';
import { getSlackWebhookUrl, setSlackWebhookUrl, testSlackWebhook } from '../services/notificationService';
import { getSetting } from '../db/database';

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
  });
});

// Salvează webhook-ul Slack (string gol = dezactivează notificările din DB).
router.put('/', (req: Request, res: Response) => {
  const { slackWebhookUrl } = req.body || {};
  if (typeof slackWebhookUrl !== 'string') {
    return res.status(400).json({ error: 'slackWebhookUrl trebuie să fie un string.' });
  }
  const url = slackWebhookUrl.trim();
  if (url && !/^https:\/\/hooks\.slack\.com\//.test(url)) {
    return res.status(400).json({ error: 'URL invalid. Trebuie să fie un Slack Incoming Webhook (https://hooks.slack.com/...).' });
  }
  setSlackWebhookUrl(url);
  res.json({ success: true, slackWebhookConfigured: !!getSlackWebhookUrl() });
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
