import { env } from '../config/env';
import logger from './logger';
import { SITE_ACCOUNT_NAME } from '../shared/site';

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

// The logo at the top of every HTML email. Live text, so it stays readable when images are blocked or in dark mode.
export const emailHeader = () =>
    `<p style="margin:0 0 20px"><img src="${escapeHtml(env.WEB_URL)}/yarner-email.png" width="16" height="24" alt="" style="vertical-align:middle;margin-right:6px"><span style="vertical-align:middle;font-family:sans-serif;font-size:18px;font-weight:600;letter-spacing:-.02em">${SITE_ACCOUNT_NAME.toLowerCase()}</span></p>`;

// A plain email with one call-to-action link
export function linkEmail(to: string, subject: string, intro: string, linkLabel: string, url: string, outro?: string): Email {
    const text = [intro, '', `${linkLabel}: ${url}`, ...(outro ? ['', outro] : [])].join('\n');
    const html = `${emailHeader()}<p>${escapeHtml(intro)}</p><p><a href="${escapeHtml(url)}">${escapeHtml(linkLabel)}</a></p>${
        outro ? `<p>${escapeHtml(outro)}</p>` : ''
    }`;
    return { to, subject, text, html };
}
