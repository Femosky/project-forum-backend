import * as bcrypt from 'bcrypt';
import jwt from 'jsonwebtoken';
import prisma from '../prismaConnection';
import ms from 'ms';
import { User } from '@prisma/client';

const SALT_ROUNDS = 10;

export type TokenPair = {
    auth_token_id: string;
    access_token: string;
    refresh_token: string;
};

export type DecodedJWTToken = {
    authTokenId: string;
};

export type DecodedTokenWithUser = {
    authTokenId?: string;
    user?: User;
    error?: AccessTokenErrors;
};

export enum AccessTokenErrors {
    INVALID_SECRET = 'Invalid secret.',
    INVALID_OR_EXPIRED_ACCESS_TOKEN = 'Invalid or expired access token.',
    ACCESS_TOKEN_EXPIRED = 'Access token expired.',
    INVALID_AUTH_TOKEN = 'Invalid auth token.',
    AUTH_TOKEN_EXPIRED = 'Auth token expired.',
    INVALID_REFRESH_TOKEN = 'Invalid refresh token.',
    REFRESH_TOKEN_NOT_MATCHING = 'Refresh token does not match.',
}

export class PasswordService {
    static ACCESS_TOKEN_NAME = 'access_token';
    static REFRESH_TOKEN_NAME = 'refresh_token';
    static SESSION_COOKIE_NAME = 'session_id';

    static ACCESS_TOKEN_EXPIRATION: ms.StringValue = '15m'; // 15 minutes in seconds
    static REFRESH_TOKEN_EXPIRATION: ms.StringValue = '1y'; // 1 year in seconds

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

    // Verify jwt token
    static async verifyJWTToken(token: string): Promise<DecodedJWTToken | null> {
        const secret = this.getJWTSecret();
        if (!secret) return null;

        try {
            // jwt.verify throws (e.g. JsonWebTokenError: jwt expired, invalid signature) — it does not return null
            const decodedToken = jwt.verify(token, secret) as DecodedJWTToken;
            return decodedToken ?? null;
        } catch {
            console.log('HIT PASSWORD SERVICE VERIFY JWT TOKEN?');
            return null;
        }
    }

    // verify access/short-lived token and return token id
    static async verifyAccessToken(accessToken: string, refreshToken: string): Promise<DecodedTokenWithUser> {
        const secret = this.getJWTSecret();
        if (!secret) return { error: AccessTokenErrors.INVALID_SECRET } as DecodedTokenWithUser;

        const decodedRefreshToken = await this.verifyJWTToken(refreshToken);
        if (!decodedRefreshToken) return { error: AccessTokenErrors.INVALID_REFRESH_TOKEN } as DecodedTokenWithUser;
        const decodedAccessToken = await this.verifyJWTToken(accessToken);
        if (!decodedAccessToken)
            return { error: AccessTokenErrors.INVALID_OR_EXPIRED_ACCESS_TOKEN } as DecodedTokenWithUser;

        const authToken = await prisma.authToken.findUnique({
            where: { id: decodedAccessToken.authTokenId },
            include: { user: true },
        });

        if (!authToken) return { error: AccessTokenErrors.INVALID_AUTH_TOKEN } as DecodedTokenWithUser;

        if (!authToken.valid)
            return {
                authTokenId: authToken.id,
                user: authToken.user,
                error: AccessTokenErrors.AUTH_TOKEN_EXPIRED,
            } as DecodedTokenWithUser;

        if (authToken.refresh_token !== refreshToken)
            return {
                authTokenId: authToken.id,
                user: authToken.user,
                error: AccessTokenErrors.REFRESH_TOKEN_NOT_MATCHING,
            } as DecodedTokenWithUser;

        return { authTokenId: authToken.id, user: authToken.user } as DecodedTokenWithUser;
    }

    // verify refresh/long-lived token and return token id
    static async verifyRefreshToken(refreshToken: string): Promise<DecodedJWTToken | null> {
        const secret = this.getJWTSecret();
        if (!secret) {
            return null;
        }

        try {
            const decoded = await this.verifyJWTToken(refreshToken);
            if (!decoded) {
                return null;
            }

            const authToken = await prisma.authToken.findUnique({
                where: { id: decoded.authTokenId },
            });

            if (!authToken || !authToken.valid) return null;

            return decoded;
        } catch (error) {
            return null;
        }
    }

    // Generate access

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
