"""Regenerates the v2 baseline migration from schema.prisma, then adds what Prisma can't express:
generated tsvector columns. Usage: python3 scripts/baseline-migration.py (run from the Backend folder)."""
import subprocess

path = 'prisma/migrations/20261023000000_v2_baseline/migration.sql'
sql = subprocess.run(
    ['npx', 'prisma', 'migrate', 'diff', '--from-empty', '--to-schema-datamodel', 'prisma/schema.prisma', '--script'],
    check=True, capture_output=True, text=True,
).stdout
sql = sql.replace('-- CreateSchema\nCREATE SCHEMA IF NOT EXISTS "public";\n\n', '')

generated = {
    'Community': '''"search_vector" tsvector GENERATED ALWAYS AS (
        setweight(to_tsvector('english', coalesce("name", '') || ' ' || coalesce("display_name", '')), 'A') ||
        setweight(to_tsvector('english', coalesce("description", '')), 'B')
    ) STORED,''',
    'Post': '''"search_vector" tsvector GENERATED ALWAYS AS (
        setweight(to_tsvector('english', coalesce("title", '')), 'A') ||
        setweight(to_tsvector('english', coalesce("body", '')), 'B')
    ) STORED,''',
}
for table, column in generated.items():
    head, tail = sql.split(f'CREATE TABLE "{table}" (', 1)
    assert '"search_vector" tsvector,' in tail
    sql = head + f'CREATE TABLE "{table}" (' + tail.replace('"search_vector" tsvector,', column, 1)

open(path, 'w').write(sql)
print(f'wrote {path}')
