import express, { Router } from 'express';
import { z } from 'zod';
import { forbidden, parse } from '../../lib/http';
import { AuthRequest, requireAuth, viewerOf } from '../../middlewares/auth';
import { communityRef } from '../../shared/validation';
import { canModerate, findCommunity, viewerContext } from '../communities/access';
import { MAX_IMAGE_BYTES, processUpload } from './service';
import { assertPicturesAllowed } from '../safety/policy';

// POST /v1/images?purpose=community_icon|community_banner&community=: the picture itself is the request body
// (Content-Type image/jpeg, png, webp or gif). For that community's moderators. purpose=post_image: a picture for a
// post, for any member past the new-account limits. Ad pictures go through the admin
// panel instead (POST /v1/admin/images).

const router = Router();

const uploadQuery = z.discriminatedUnion('purpose', [
    z.object({ purpose: z.enum(['community_icon', 'community_banner']), community: communityRef }),
    // A picture for a new post; it's attached when the post is created
    z.object({ purpose: z.literal('post_image') }),
]);

export const imageBody = express.raw({ type: ['image/*', 'application/octet-stream'], limit: MAX_IMAGE_BYTES + 1024 });
export const bodyBuffer = (body: unknown) => (Buffer.isBuffer(body) ? body : Buffer.alloc(0));

router.post('/', requireAuth, imageBody, async (request: AuthRequest, response) => {
    const { user } = viewerOf(request);
    const query = parse(uploadQuery, request.query);
    if (query.purpose === 'post_image') {
        // Same rule as links: brand-new accounts wait a day (or until they have some reputation), which keeps scam
        // flyers out
        assertPicturesAllowed(user);
    } else {
        const community = await findCommunity(query.community);
        if (!canModerate(await viewerContext(request.viewer), community.id)) throw forbidden('Only moderators can change this.', 'not_moderator');
    }
    response.status(201).json({ image: await processUpload(bodyBuffer(request.body), query.purpose, user.id) });
});

export default router;
