-- Discovery, stats and speed: trending snapshots, replies in the hot rank, comment search, did-you-mean words,
-- last-active times, unique visitors and daily stats snapshots.

-- Hot rank counts replies: net votes plus half the visible comment count, log-scaled, plus time. Same formula as
-- hotRank() in src/lib/ranking.ts (a test keeps the two in step). Post.created_at is UTC without a time zone.
CREATE OR REPLACE FUNCTION forum_hot_rank(score integer, comments integer, created_at timestamp)
RETURNS double precision
LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$
    SELECT round((
        sign(score + 0.5 * comments) * log(greatest(abs(score + 0.5 * comments), 1))
        + (extract(epoch FROM created_at) - 1134028003) / 45000
    )::numeric, 7)::double precision
$$;

UPDATE "Post" SET "hot_rank" = forum_hot_rank("score", "comment_count", "created_at");

-- Comment search
ALTER TABLE "Comment" ADD COLUMN "search_vector" tsvector GENERATED ALWAYS AS (
    to_tsvector('english', coalesce("body", ''))
) STORED;
CREATE INDEX "Comment_search_vector_idx" ON "Comment" USING GIN ("search_vector");

-- Words seen in titles and community names, for "Did you mean ...?" (refreshed with the trending snapshot)
CREATE TABLE "SearchWord" (
    "word" TEXT NOT NULL,
    "docs" INTEGER NOT NULL,
    CONSTRAINT "SearchWord_pkey" PRIMARY KEY ("word")
);
CREATE INDEX "SearchWord_word_trgm_idx" ON "SearchWord" USING GIN ("word" gin_trgm_ops);

-- Last time a signed-in account did anything (written at most every 15 minutes per account)
ALTER TABLE "User" ADD COLUMN "last_active_at" TIMESTAMP(3);
CREATE INDEX "User_last_active_at_idx" ON "User"("last_active_at");

-- Trending snapshots, replaced as a whole every 10 minutes
CREATE TABLE "TrendingPost" (
    "rank" INTEGER NOT NULL,
    "post_id" UUID NOT NULL,
    "score" DOUBLE PRECISION NOT NULL,
    "voters" INTEGER NOT NULL,
    "repliers" INTEGER NOT NULL,
    "computed_at" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "TrendingPost_pkey" PRIMARY KEY ("rank")
);
CREATE INDEX "TrendingPost_post_id_idx" ON "TrendingPost"("post_id");
ALTER TABLE "TrendingPost" ADD CONSTRAINT "TrendingPost_post_id_fkey" FOREIGN KEY ("post_id") REFERENCES "Post"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "TrendingCommunity" (
    "rank" INTEGER NOT NULL,
    "community_id" UUID NOT NULL,
    "score" DOUBLE PRECISION NOT NULL,
    "new_members" INTEGER NOT NULL,
    "posts" INTEGER NOT NULL,
    "comments" INTEGER NOT NULL,
    "computed_at" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "TrendingCommunity_pkey" PRIMARY KEY ("rank")
);
CREATE INDEX "TrendingCommunity_community_id_idx" ON "TrendingCommunity"("community_id");
ALTER TABLE "TrendingCommunity" ADD CONSTRAINT "TrendingCommunity_community_id_fkey" FOREIGN KEY ("community_id") REFERENCES "Community"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "TrendingTopic" (
    "rank" INTEGER NOT NULL,
    "kind" TEXT NOT NULL,
    "term" TEXT NOT NULL,
    "community_id" UUID,
    "posts" INTEGER NOT NULL,
    "authors" INTEGER NOT NULL,
    "score" DOUBLE PRECISION NOT NULL,
    "computed_at" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "TrendingTopic_pkey" PRIMARY KEY ("rank")
);
CREATE INDEX "TrendingTopic_community_id_idx" ON "TrendingTopic"("community_id");
ALTER TABLE "TrendingTopic" ADD CONSTRAINT "TrendingTopic_community_id_fkey" FOREIGN KEY ("community_id") REFERENCES "Community"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Site metrics. Days run on Lagos time, like AdDailyStat.
-- A random salt per day: visitor ids are sha256(salt, IP, user agent), so they can't be linked across days, and
-- old salts are deleted so nobody can recompute them. Raw IPs are never stored.
CREATE TABLE "DailySalt" (
    "date" DATE NOT NULL,
    "salt" TEXT NOT NULL,
    CONSTRAINT "DailySalt_pkey" PRIMARY KEY ("date")
);

CREATE TABLE "DailyVisitor" (
    "date" DATE NOT NULL,
    "visitor" TEXT NOT NULL,
    "country" TEXT,
    "signed_in" BOOLEAN NOT NULL DEFAULT false,
    CONSTRAINT "DailyVisitor_pkey" PRIMARY KEY ("date", "visitor")
);

CREATE TABLE "CommunityDailyVisitor" (
    "date" DATE NOT NULL,
    "community_id" UUID NOT NULL,
    "visitor" TEXT NOT NULL,
    CONSTRAINT "CommunityDailyVisitor_pkey" PRIMARY KEY ("date", "community_id", "visitor")
);
ALTER TABLE "CommunityDailyVisitor" ADD CONSTRAINT "CommunityDailyVisitor_community_id_fkey" FOREIGN KEY ("community_id") REFERENCES "Community"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "DailyActiveUser" (
    "date" DATE NOT NULL,
    "user_id" UUID NOT NULL,
    CONSTRAINT "DailyActiveUser_pkey" PRIMARY KEY ("date", "user_id")
);
ALTER TABLE "DailyActiveUser" ADD CONSTRAINT "DailyActiveUser_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "DailyTraffic" (
    "date" DATE NOT NULL,
    "page_views" INTEGER NOT NULL DEFAULT 0,
    CONSTRAINT "DailyTraffic_pkey" PRIMARY KEY ("date")
);

CREATE TABLE "CommunityDailyTraffic" (
    "date" DATE NOT NULL,
    "community_id" UUID NOT NULL,
    "page_views" INTEGER NOT NULL DEFAULT 0,
    CONSTRAINT "CommunityDailyTraffic_pkey" PRIMARY KEY ("date", "community_id")
);
ALTER TABLE "CommunityDailyTraffic" ADD CONSTRAINT "CommunityDailyTraffic_community_id_fkey" FOREIGN KEY ("community_id") REFERENCES "Community"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Nightly snapshots for Admin -> Stats
CREATE TABLE "DailyStat" (
    "date" DATE NOT NULL,
    "total_users" INTEGER NOT NULL,
    "new_signups" INTEGER NOT NULL,
    "dau" INTEGER NOT NULL,
    "wau" INTEGER NOT NULL,
    "mau" INTEGER NOT NULL,
    "unique_visitors" INTEGER NOT NULL,
    "page_views" INTEGER NOT NULL,
    "posts" INTEGER NOT NULL,
    "comments" INTEGER NOT NULL,
    "votes" INTEGER NOT NULL,
    "ad_impressions" INTEGER NOT NULL,
    "ad_clicks" INTEGER NOT NULL,
    "countries" JSONB,
    "computed_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "DailyStat_pkey" PRIMARY KEY ("date")
);

CREATE TABLE "CommunityDailyStat" (
    "date" DATE NOT NULL,
    "community_id" UUID NOT NULL,
    "members" INTEGER NOT NULL,
    "new_members" INTEGER NOT NULL,
    "posts" INTEGER NOT NULL,
    "comments" INTEGER NOT NULL,
    "votes" INTEGER NOT NULL,
    "unique_visitors" INTEGER NOT NULL,
    "page_views" INTEGER NOT NULL,
    CONSTRAINT "CommunityDailyStat_pkey" PRIMARY KEY ("date", "community_id")
);
CREATE INDEX "CommunityDailyStat_community_id_date_idx" ON "CommunityDailyStat"("community_id", "date");
ALTER TABLE "CommunityDailyStat" ADD CONSTRAINT "CommunityDailyStat_community_id_fkey" FOREIGN KEY ("community_id") REFERENCES "Community"("id") ON DELETE CASCADE ON UPDATE CASCADE;
