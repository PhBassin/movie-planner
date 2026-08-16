import express, { Request, Response } from 'express';
import { getInMemoryMailbox, clearInMemoryMailbox } from '../services/mailer.js';

/**
 * `/api/test/mailbox` — the E2E seam over the in-memory mailer transport
 * (ADR 0005: tests never touch real SMTP). Mounted only in the test
 * environment (see `app.ts`); a production build has no such route and the
 * in-memory mailbox does not even exist.
 */
const router = express.Router();

// GET /api/test/mailbox?to=<email> - all captured messages to an address
router.get('/', (req: Request, res: Response) => {
    const to = typeof req.query.to === 'string' ? req.query.to.toLowerCase() : null;
    const mailbox = getInMemoryMailbox();
    const messages = to === null
        ? mailbox
        : mailbox.filter((m) => m.to.toLowerCase() === to);
    res.json({ success: true, data: { messages } });
});

// POST /api/test/mailbox/clear - empty the mailbox between tests
router.post('/clear', (_req: Request, res: Response) => {
    clearInMemoryMailbox();
    res.json({ success: true, data: { cleared: true } });
});

export default router;
