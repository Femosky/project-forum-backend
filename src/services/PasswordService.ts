import * as bcrypt from 'bcrypt';
import jwt from 'jsonwebtoken';
const SALT_ROUNDS = 10;

export type TokenPair = {
    auth_token_id: string | null | undefined;
    access_token: string;
    refresh_token: string;
};

export type DecodedToken = {
    authTokenId: string;
};

export class PasswordService {
    static ACCESS_TOKEN_EXPIRATION: number = 60 * 15; // 15 minutes in seconds
    static REFRESH_TOKEN_EXPIRATION: number = 60 * 60 * 24 * 365; // 1 year in seconds

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

        return jwt.sign({ authTokenId }, secret, { expiresIn: this.ACCESS_TOKEN_EXPIRATION });
    }

    static async generateTokens(authTokenId: string): Promise<TokenPair | null> {
        const secret = this.getJWTSecret();
        if (!secret) {
            return null;
        }

        const access_token = jwt.sign({ authTokenId }, secret, { expiresIn: this.ACCESS_TOKEN_EXPIRATION });
        const refresh_token = jwt.sign({ authTokenId }, secret, { expiresIn: this.REFRESH_TOKEN_EXPIRATION });
        return { auth_token_id: authTokenId, access_token, refresh_token } as TokenPair;
    }

    // verify access/short-lived token and return token id
    static async verifyAccessToken(accessToken: string): Promise<DecodedToken | null> {
        const secret = this.getJWTSecret();
        if (!secret) {
            return null;
        }

        return jwt.verify(accessToken, secret) as DecodedToken;
    }

    // verify refresh/long-lived token and return token id
    static async verifyRefreshToken(refreshToken: string): Promise<DecodedToken | null> {
        const secret = this.getJWTSecret();
        if (!secret) {
            return null;
        }

        try {
            return jwt.verify(refreshToken, secret) as DecodedToken;
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
