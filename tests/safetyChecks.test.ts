import sharp from 'sharp';
import { describe, expect, it } from 'vitest';
import { judgeImage, scoreImage } from '../src/modules/safety/imageCheck';
import { judgeText, normalise } from '../src/modules/safety/textCheck';
import { createCommunity, createPost, signUp } from './helpers';
import prisma from '../src/prismaConnection';

// The site's own content checks, with no outside service: explicit terms in text, and the picture classifier

describe('explicit-term check', () => {
    it('undoes the usual disguises', () => {
        expect(normalise('P0RN')).toBe('porn');
        expect(normalise('p.o.r.n links')).toBe('porn links');
        expect(normalise('x x x')).toBe('xxx');
        expect(normalise('Ónlyfáns')).toBe('onlyfans');
        // Numbers that are numbers stay numbers
        expect(normalise('Rent is 1,500,000 for 2 years')).toBe('rent is 1 500 000 for 2 years');
    });

    it('holds porn and selling sex for the admins', () => {
        for (const text of ['check my onlyfans', 'free p0rn here', 'send nudes', 'pooorn videos', 'Runs girls available in Lekki', 'xxx links in bio', 'leaked n.u.d.e.s']) {
            expect(judgeText(text), text).toMatchObject({ action: 'hold_for_admins', reason: expect.stringContaining('Explicit') });
        }
    });

    it('lets sex as a topic through', () => {
        for (const text of [
            'Where can I get sex education materials for my son?',
            'Sexual health clinics in Abuja that are discreet?',
            'Is it normal to bleed after sex? Asking for my wife',
            'Condoms are expensive now',
            'Our kids school fees went up again',
            'The minor details matter in this contract',
            'Teens and phones: how much screen time?',
            'My kid is 15 years old and wants a phone',
            'Escorted to the airport by the police',
        ]) {
            expect(judgeText(text), text).toEqual({ action: 'publish' });
        }
    });

    it('holds anything pairing explicit terms with children, or pointing only at minors, with a warning', () => {
        for (const text of ['teen nudes', 'underage onlyfans', 'nudes of a 15yo', 'loli pics', 'jailbait', 'school girl porn']) {
            expect(judgeText(text), text).toMatchObject({ action: 'hold_for_admins', reason: expect.stringContaining('Do not approve') });
        }
    });

    it('holds an explicit post for the admins with no outside service', async () => {
        const author = await signUp('author');
        await createCommunity(author.agent, 'lounge');
        const post = await createPost(author.agent, 'lounge', { title: 'Subscribe to my onlyfans', body: 'link in bio' });
        expect(await prisma.post.findUniqueOrThrow({ where: { id: post.id } })).toMatchObject({ status: 'pending', held_for_admins: true });
    });
});

describe('picture check', () => {
    it('decides by purpose: clear refused, borderline to review, revealing labelled', () => {
        const scores = (porn: number, sexy = 0) => ({ drawing: 0, hentai: 0, neutral: 1 - porn - sexy, porn, sexy });
        expect(judgeImage(scores(0.9), 'post_image')).toMatchObject({ action: 'refuse' });
        expect(judgeImage(scores(0.6), 'post_image')).toMatchObject({ action: 'hold_for_admins' });
        expect(judgeImage(scores(0.1, 0.7), 'post_image')).toMatchObject({ action: 'label_mature' });
        expect(judgeImage(scores(0.05, 0.1), 'post_image')).toEqual({ action: 'publish' });
        // No review step for icons and ads: borderline is refused, and ads refuse revealing pictures too
        expect(judgeImage(scores(0.6), 'community_icon')).toMatchObject({ action: 'refuse' });
        expect(judgeImage(scores(0.1, 0.7), 'ad_image')).toMatchObject({ action: 'refuse' });
        expect(judgeImage(scores(0.1, 0.7), 'community_banner')).toEqual({ action: 'publish' });
        // A link preview never refuses an upload; it holds the post
        expect(judgeImage(scores(0.9), 'link_preview')).toMatchObject({ action: 'hold_for_admins' });
        // When the model can't run, the picture goes through
        expect(judgeImage(null, 'post_image')).toEqual({ action: 'publish' });
    });

    it('runs the model in the API and scores everyday pictures as safe', async () => {
        const solid = await sharp({ create: { width: 640, height: 480, channels: 3, background: '#3a7bd5' } }).png().toBuffer();
        const card = await sharp({ create: { width: 800, height: 400, channels: 3, background: '#ffffff' } })
            .composite([{ input: Buffer.from('<svg width="800" height="400"><text x="40" y="220" font-size="80" font-family="sans-serif">Rent in Yaba</text></svg>') }])
            .png()
            .toBuffer();
        for (const picture of [solid, card]) {
            const scores = await scoreImage(picture);
            expect(scores).not.toBeNull();
            const total = Object.values(scores!).reduce((sum, value) => sum + value, 0);
            expect(total).toBeCloseTo(1, 2);
            expect(scores!.porn + scores!.hentai).toBeLessThan(0.5);
            expect(judgeImage(scores, 'post_image').action).toBe('publish');
        }
    }, 30_000);
});
