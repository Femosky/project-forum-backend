import { PrismaClient } from '@prisma/client';
import { customAlphabet } from 'nanoid';
import { ErrorResponse } from '../models/interfaces/errorType';

export class IdShortener {
    private static prisma = new PrismaClient();
    private static readonly ALPHABET = '0123456789abcdefghijklmnopqrstuvwxyz';
    private static readonly LENGTH = 8;
    private static readonly MAX_ATTEMPT = 10;

    public static async generatePostShortId(): Promise<string | ErrorResponse> {
        let nanoid = customAlphabet(this.ALPHABET, this.LENGTH);
        let attempts = 0;

        do {
            const shortId = nanoid();
            attempts++;

            // Check if it exists in database
            try {
                const existing = await this.prisma.post.findUnique({
                    where: { short_id: shortId },
                });
                if (!existing) {
                    return shortId; // Found unique ID
                }
            } catch (error) {
                return {
                    error: 'Failed to generate unique short id: Error checking if id exists',
                    details: error,
                } as ErrorResponse;
            }
        } while (attempts < this.MAX_ATTEMPT);

        return { error: 'Failed to generate unique short id: Ran out of attempts' } as ErrorResponse;
    }

    public static async generateCommentShortId(): Promise<string | ErrorResponse> {
        let nanoid = customAlphabet(this.ALPHABET, this.LENGTH);
        let attempts = 0;

        do {
            const shortId = nanoid();
            attempts++;

            // Check if it exists in database
            try {
                const existing = await this.prisma.comment.findUnique({
                    where: { short_id: shortId },
                });
                if (!existing) {
                    return shortId; // Found unique ID
                }
            } catch (error) {
                return {
                    error: 'Failed to generate unique short id: Error checking if id exists',
                    details: error,
                } as ErrorResponse;
            }
        } while (attempts < this.MAX_ATTEMPT);

        return { error: 'Failed to generate unique short id: Ran out of attempts' } as ErrorResponse;
    }
}
