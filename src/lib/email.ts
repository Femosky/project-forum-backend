import { env } from '../config/env';
import logger from './logger';

export type Email = { to: string; subject: string; text: string; html?: string; headers?: Record<string, string> };

// Emails "sent" without a Resend key, newest last. Lets tests and local dev read verification links.
export const devOutbox: Email[] = [];

// Sends through Resend's HTTP API (free tier: 3k emails/month). Called from the email job, so failures retry.
export async function sendEmail(email: Email) {
    if (!env.RESEND_API_KEY) {
        devOutbox.push(email);
        if (devOutbox.length > 50) devOutbox.shift();
        logger.info({ to: email.to, subject: email.subject }, 'Email not sent (no RESEND_API_KEY); kept in dev outbox');
        if (!env.IS_PRODUCTION) logger.debug({ text: email.text }, 'Email body');
        return;
    }

    const response = await fetch('https://api.resend.com/emails', {
        method: 'POST',
        headers: { Authorization: `Bearer ${env.RESEND_API_KEY}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ from: env.EMAIL_FROM, to: [email.to], subject: email.subject, text: email.text, html: email.html, headers: email.headers }),
        signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) {
        throw new Error(`Resend responded ${response.status}: ${await response.text()}`);
    }
}

const escapeHtml = (value: string) =>
    value.replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]!);

// A plain email with one call-to-action link
export function linkEmail(to: string, subject: string, intro: string, linkLabel: string, url: string, outro?: string): Email {
    const text = [intro, '', `${linkLabel}: ${url}`, ...(outro ? ['', outro] : [])].join('\n');
    const html = `<p>${escapeHtml(intro)}</p><p><a href="${escapeHtml(url)}">${escapeHtml(linkLabel)}</a></p>${
        outro ? `<p>${escapeHtml(outro)}</p>` : ''
    }`;
    return { to, subject, text, html };
}
