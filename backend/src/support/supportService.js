// Support kit (E10): app code ECOMAPS, prefix EMP-; the ticket is emailed to the support mailbox. EcoBus publishing
// joins with the shared EcoBus client (§12.1). The contact address is the person's EcoID email, given by the client.
import { ticketRef } from '../utils/ids.js';
import { logger } from '../utils/logger.js';

export function createSupport({ sequelize, cfg, mailer }) {
  async function create({ globalEcoId, email, subject, body }) {
    const ref = ticketRef(cfg.ticketPrefix); const mailSubject = `[${cfg.appCode}] #${ref} ${subject}`;
    await sequelize.query(`INSERT INTO support_tickets (ticket_ref, global_eco_id, subject, body, channel) VALUES (:r, :g, :s, :b, 'EMAIL')`, { replacements: { r: ref, g: globalEcoId, s: subject, b: body } });
    let emailed = false;
    try { emailed = await mailer.send({ to: cfg.supportEmail, subject: mailSubject, replyTo: email || undefined, text: `${body}\n\n--\nTicket: ${ref}\nApp: ${cfg.appCode}\nGlobal EcoID: ${globalEcoId}\nContact email: ${email || '-'}` }); }
    catch (err) { logger.warn('support email failed', { ticketRef: ref, err: err.code || err.message }); }
    if (emailed) await sequelize.query(`UPDATE support_tickets SET email_delivered = true WHERE ticket_ref = :r`, { replacements: { r: ref } });
    return { ticketRef: ref, emailDelivered: emailed, mailto: `mailto:${cfg.supportEmail}?subject=${encodeURIComponent(mailSubject)}` };
  }
  async function inbox(globalEcoId) {
    const [rows] = await sequelize.query(`SELECT ticket_ref AS "ticketRef", subject, created_at AS "createdAt", email_delivered AS "emailDelivered" FROM support_tickets WHERE global_eco_id = :g ORDER BY created_at DESC LIMIT 100`, { replacements: { g: globalEcoId } });
    return rows;
  }
  return { create, inbox };
}
