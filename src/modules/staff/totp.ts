import { createCipheriv, createDecipheriv, createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { env } from '../../config/env';

// Two-factor sign-in with an authenticator app (Google Authenticator, 1Password, Authy...): TOTP, RFC 6238, the
// usual 6 digits every 30 seconds with SHA-1. Secrets are stored encrypted (AES-256-GCM) with a key derived from
// JWT_SECRET, so a database dump alone can't be used to make codes.

const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
const STEP_SECONDS = 30;
const DIGITS = 6;

export function base32Encode(buffer: Buffer) {
    let bits = 0;
    let value = 0;
    let output = '';
    for (const byte of buffer) {
        value = (value << 8) | byte;
        bits += 8;
        while (bits >= 5) {
            output += ALPHABET[(value >>> (bits - 5)) & 31];
            bits -= 5;
        }
    }
    if (bits > 0) output += ALPHABET[(value << (5 - bits)) & 31];
    return output;
}

export function base32Decode(text: string) {
    let bits = 0;
    let value = 0;
    const bytes: number[] = [];
    for (const char of text.replace(/[\s=]/g, '').toUpperCase()) {
        const index = ALPHABET.indexOf(char);
        if (index < 0) throw new Error('Not base32');
        value = (value << 5) | index;
        bits += 5;
        if (bits >= 8) {
            bytes.push((value >>> (bits - 8)) & 255);
            bits -= 8;
        }
    }
    return Buffer.from(bytes);
}

export const newTotpSecret = () => base32Encode(randomBytes(20));

// The code for a moment (counter = 30-second steps since 1970)
export function totpCode(secret: string, at = Date.now()) {
    const counter = Buffer.alloc(8);
    counter.writeBigUInt64BE(BigInt(Math.floor(at / 1000 / STEP_SECONDS)));
    const hmac = createHmac('sha1', base32Decode(secret)).update(counter).digest();
    const offset = hmac[hmac.length - 1] & 15;
    const number = (hmac.readUInt32BE(offset) & 0x7fffffff) % 10 ** DIGITS;
    return number.toString().padStart(DIGITS, '0');
}

// Accepts the current code or one step either side (clocks drift)
export function verifyTotp(secret: string, code: string, at = Date.now()) {
    const clean = code.replace(/\s/g, '');
    if (!/^\d{6}$/.test(clean)) return false;
    return [-1, 0, 1].some((step) => timingSafeEqual(Buffer.from(totpCode(secret, at + step * STEP_SECONDS * 1000)), Buffer.from(clean)));
}

export function otpauthUrl(secret: string, email: string, issuer: string) {
    const label = encodeURIComponent(`${issuer}:${email}`);
    return `otpauth://totp/${label}?secret=${secret}&issuer=${encodeURIComponent(issuer)}&algorithm=SHA1&digits=${DIGITS}&period=${STEP_SECONDS}`;
}

const key = () => createHash('sha256').update(`staff-totp:${env.JWT_SECRET}`).digest();

export function encryptSecret(secret: string) {
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', key(), iv);
    const data = Buffer.concat([cipher.update(secret, 'utf8'), cipher.final()]);
    return [iv, cipher.getAuthTag(), data].map((part) => part.toString('base64url')).join('.');
}

export function decryptSecret(stored: string) {
    const [iv, tag, data] = stored.split('.').map((part) => Buffer.from(part, 'base64url'));
    const decipher = createDecipheriv('aes-256-gcm', key(), iv);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(data), decipher.final()]).toString('utf8');
}

// Ten single-use recovery codes like "k3vq-8xmr", for when the phone is lost. Only their hashes are kept.
export function newRecoveryCodes() {
    return Array.from({ length: 10 }, () => {
        const raw = base32Encode(randomBytes(5)).toLowerCase();
        return `${raw.slice(0, 4)}-${raw.slice(4, 8)}`;
    });
}

export const hashRecoveryCode = (code: string) => createHash('sha256').update(code.trim().toLowerCase().replace(/\s/g, '')).digest('hex');
