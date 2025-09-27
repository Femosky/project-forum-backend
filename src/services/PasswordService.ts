import * as bcrypt from 'bcrypt';
import jwt from 'jsonwebtoken';
const SALT_ROUNDS = 10;

export type TokenPair = {
    short_lived_token: string;
    long_lived_token: string;
};

export type DecodedToken = {
    authTokenId: string;
};

export const SHORT_LIVED_TOKEN_EXPIRATION = '1h';
export const LONG_LIVED_TOKEN_EXPIRATION = '1y';

export class PasswordService {
    static async hashPassword(password: string): Promise<string> {
        return await bcrypt.hash(password, SALT_ROUNDS);
    }

    static async verifyPassword(password: string, hash: string): Promise<boolean> {
        return await bcrypt.compare(password, hash);
    }

    static getJWTSecret(): string | null {
        return process.env.JWT_SECRET || null;
    }

    static async generateAccessToken(authTokenId: string): Promise<string | null> {
        const secret = this.getJWTSecret();
        if (!secret) {
            return null;
        }

        return jwt.sign({ authTokenId }, secret, { expiresIn: SHORT_LIVED_TOKEN_EXPIRATION });
    }

    static async generateTokens(authTokenId: string): Promise<TokenPair | null> {
        const secret = this.getJWTSecret();
        if (!secret) {
            return null;
        }

        const short_lived_token = jwt.sign({ authTokenId }, secret, { expiresIn: SHORT_LIVED_TOKEN_EXPIRATION });
        const long_lived_token = jwt.sign({ authTokenId }, secret, { expiresIn: LONG_LIVED_TOKEN_EXPIRATION });
        return { short_lived_token, long_lived_token } as TokenPair;
    }

    // verify short lived token and return token id
    static async verifyShortLivedToken(shortLivedToken: string): Promise<DecodedToken | null> {
        const secret = this.getJWTSecret();
        if (!secret) {
            return null;
        }

        return jwt.verify(shortLivedToken, secret) as DecodedToken;
    }

    // verify refresh token and return token id
    static async verifyRefreshToken(refreshToken: string): Promise<DecodedToken | null> {
        const secret = this.getJWTSecret();
        if (!secret) {
            return null;
        }

        try {
            return (await jwt.verify(refreshToken, secret)) as DecodedToken;
        } catch (error) {
            return null;
        }
    }

    // Decode JWT without verification to get expiry
    static decodeToken(token: string): any {
        try {
            // Decode without verification (safe for getting expiry)
            const decoded = jwt.decode(token);
            return decoded;
        } catch (error) {
            return null;
        }
    }

    // Get token expiry date
    static getTokenExpiry(token: string): Date | null {
        const decoded = this.decodeToken(token);
        if (!decoded || !decoded.exp) {
            return null;
        }

        // JWT exp is in seconds, convert to Date
        return new Date(decoded.exp * 1000);
    }

    // Check if token is expired
    static isTokenExpired(token: string): boolean {
        const expiry = this.getTokenExpiry(token);
        if (!expiry) return true;

        return new Date() > expiry;
    }

    // Get time until expiry
    static getTimeUntilExpiry(token: string): number | null {
        const expiry = this.getTokenExpiry(token);
        if (!expiry) return null;

        return expiry.getTime() - new Date().getTime();
    }
}
