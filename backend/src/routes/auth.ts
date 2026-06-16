import { Router, Request, Response } from 'express';
import jwt from 'jsonwebtoken';

const router = Router();

router.post('/login', (req: Request, res: Response) => {
  const { username, password } = req.body;

  const appUser = process.env.APP_USER || 'admin';
  const appPassword = process.env.APP_PASSWORD || 'secret';
  const jwtSecret = process.env.JWT_SECRET || 'fallback-secret';

  if (username !== appUser || password !== appPassword) {
    return res.status(401).json({ error: 'Credențiale incorecte' });
  }

  const token = jwt.sign({ sub: username }, jwtSecret, { expiresIn: '30d' });
  res.json({ token });
});

export default router;
