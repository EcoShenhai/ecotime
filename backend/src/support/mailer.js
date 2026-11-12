// SMTP2GO through the shared EcoCloud SMTP user (same as EcoMeet and EcoOffice). Values never logged.
import nodemailer from 'nodemailer';

export function createMailer(cfg) {
  if (!cfg.smtp.host || !cfg.smtp.user || !cfg.smtp.password) return { enabled: false, send: async () => false, verify: async () => false };
  const transport = nodemailer.createTransport({
    host: cfg.smtp.host, port: cfg.smtp.port, secure: cfg.smtp.secure,
    auth: { user: cfg.smtp.user, pass: cfg.smtp.password },
    connectionTimeout: 10000, greetingTimeout: 10000, socketTimeout: 15000,
  });
  return {
    enabled: true,
    async send({ to, subject, text, replyTo }) {
      await transport.sendMail({ from: { name: cfg.smtp.fromName, address: cfg.smtp.fromEmail }, to, subject, text, ...(replyTo ? { replyTo } : {}) });
      return true;
    },
    verify: () => transport.verify(),
  };
}
