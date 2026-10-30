-- The first set of default icons is gone, and the launch communities get icons that fit. Only where they have none.
UPDATE "Community" SET "image_url" = NULL WHERE "image_url" LIKE '/community-icons/%';

UPDATE "Community" c SET "image_url" = '/community-icon/' || icons.icon || '.svg'
FROM (VALUES
    ('elections2027', 'vote-red'),
    ('bbnaija', 'tv-fuchsia'),
    ('supereagles', 'football-blue'),
    ('premierleague', 'trophy-violet'),
    ('afrobeats', 'music-pink'),
    ('japa', 'plane-blue'),
    ('lagosrent', 'house-amber'),
    ('naijatech', 'chip-indigo'),
    ('techcareers', 'briefcase-slate'),
    ('moneymatters', 'wallet-amber'),
    ('smallbusiness', 'shop-violet'),
    ('naijafood', 'food-red'),
    ('studyabroad', 'graduation-indigo'),
    ('relationships', 'heart-pink')
) AS icons(name, icon)
WHERE c."name" = icons.name AND c."image_url" IS NULL;
