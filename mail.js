// Outgoing email. Set SMTP_URL (for example smtps://user:pass@smtp.example.com:465) and MAIL_FROM.
// Without SMTP_URL nothing is sent: the message is printed to the server log instead, which is
// what you want while developing.
const nodemailer = require('nodemailer');

const SMTP_URL = process.env.SMTP_URL || '';
const FROM = process.env.MAIL_FROM || 'Fincen <no-reply@localhost>';
const transport = SMTP_URL ? nodemailer.createTransport(SMTP_URL) : null;

const enabled = !!transport;

async function send(to, subject, text) {
  if (!transport) {
    console.log(`[mail not configured] To: ${to}\nSubject: ${subject}\n\n${text}\n`);
    return false;
  }
  await transport.sendMail({ from: FROM, to, subject, text });
  return true;
}

module.exports = { send, enabled };
