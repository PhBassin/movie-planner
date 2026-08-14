import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import nodemailer from 'nodemailer';
import {
  createMailer,
  getInMemoryMailbox,
  resetMailerForTests,
  type Mailer,
} from './mailer.js';

vi.mock('nodemailer', () => ({
  default: {
    createTransport: vi.fn(() => ({ sendMail: vi.fn().mockResolvedValue({}) })),
  },
}));

describe('Mailer', () => {
  const envBefore = { ...process.env };

  beforeEach(() => {
    resetMailerForTests();
    vi.clearAllMocks();
  });

  afterEach(() => {
    process.env = { ...envBefore };
    resetMailerForTests();
  });

  describe('in-memory transport (no SMTP_HOST)', () => {
    it('captures messages in an inspectable mailbox instead of sending', async () => {
      delete process.env.SMTP_HOST;
      const mailer = createMailer();

      await mailer.send({
        to: 'jane@example.com',
        subject: 'Confirm your email',
        text: 'Hello Jane',
      });

      const mailbox = getInMemoryMailbox();
      expect(mailbox).toHaveLength(1);
      expect(mailbox[0]).toMatchObject({
        to: 'jane@example.com',
        subject: 'Confirm your email',
        text: 'Hello Jane',
      });
      expect(mailbox[0].from).toContain('no-reply@movie-planner.local');
      expect(nodemailer.createTransport).not.toHaveBeenCalled();
    });

    it('shares one process-wide mailbox across mailer instances', async () => {
      delete process.env.SMTP_HOST;

      await createMailer().send({ to: 'a@example.com', subject: 'One', text: 'one' });
      await createMailer().send({ to: 'b@example.com', subject: 'Two', text: 'two' });

      expect(getInMemoryMailbox().map((m) => m.to)).toEqual([
        'a@example.com',
        'b@example.com',
      ]);
    });

    it('honours SMTP_FROM_NAME / SMTP_FROM_ADDRESS overrides', async () => {
      delete process.env.SMTP_HOST;
      process.env.SMTP_FROM_NAME = 'Cinéma';
      process.env.SMTP_FROM_ADDRESS = 'hello@cine.example';

      await createMailer().send({ to: 'a@example.com', subject: 's', text: 't' });

      expect(getInMemoryMailbox()[0].from).toBe('Cinéma <hello@cine.example>');
    });
  });

  describe('SMTP transport (SMTP_HOST set)', () => {
    it('sends through nodemailer with the configured host/port/credentials', async () => {
      process.env.SMTP_HOST = 'smtp.example.com';
      process.env.SMTP_PORT = '2525';
      process.env.SMTP_USER = 'user';
      process.env.SMTP_PASS = 'pass';

      const sendMail = vi.fn().mockResolvedValue({});
      vi.mocked(nodemailer.createTransport).mockReturnValue({ sendMail } as any);
      const mailer: Mailer = createMailer();

      await mailer.send({
        to: 'jane@example.com',
        subject: 'Confirm your email',
        text: 'https://example.com/verify?token=abc',
        html: '<a href="https://example.com/verify?token=abc">Confirm</a>',
      });

      expect(nodemailer.createTransport).toHaveBeenCalledWith(
        expect.objectContaining({
          host: 'smtp.example.com',
          port: 2525,
          auth: { user: 'user', pass: 'pass' },
        }),
      );
      expect(sendMail).toHaveBeenCalledWith(
        expect.objectContaining({
          to: 'jane@example.com',
          subject: 'Confirm your email',
          text: expect.stringContaining('token=abc'),
          html: expect.stringContaining('token=abc'),
        }),
      );
      // SMTP path: the mailbox exists (lazily) but stays empty.
      expect(getInMemoryMailbox()).toHaveLength(0);
    });

    it('omits auth when no credentials are configured (local relay)', async () => {
      process.env.SMTP_HOST = 'localhost';
      delete process.env.SMTP_USER;
      delete process.env.SMTP_PASS;

      createMailer();

      expect(nodemailer.createTransport).toHaveBeenCalledWith(
        expect.not.objectContaining({ auth: expect.anything() }),
      );
    });
  });

  describe('mailbox accessor', () => {
    it('lazily creates the mailbox on first access (empty before any send)', async () => {
      delete process.env.SMTP_HOST;
      resetMailerForTests();

      expect(getInMemoryMailbox()).toEqual([]);
    });
  });
});
