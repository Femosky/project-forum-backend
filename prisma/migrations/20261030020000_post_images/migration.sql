-- Picture posts: the uploaded picture (our storage) with its size and smaller copies
ALTER TABLE "Post" ADD COLUMN "image" JSONB;
