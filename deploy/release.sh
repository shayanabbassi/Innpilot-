#!/bin/sh
# Release on a host running deploy/compose.yml (P6-6). Run from the directory holding compose.yml, app.env and
# release.env:
#   API_IMAGE=ghcr.io/<owner>/innpilot-api:<tag> WEB_IMAGE=ghcr.io/<owner>/innpilot-web:<tag> \
#     SITE_ADDRESS=<host> ./release.sh
# Steps: pull the new images, back up the database, apply migrations (forward-only), then start the new version
# and wait until it reports healthy. Any failure stops the release; until the last step the old version keeps
# serving.
# Rollback: run this script again with the previous image tags. A migration is never undone in place: if one must
# be reversed, restore the backup taken here into a new database (docs/backup-and-restore.md).
set -eu
: "${API_IMAGE:?Set API_IMAGE}"
: "${WEB_IMAGE:?Set WEB_IMAGE}"
: "${SITE_ADDRESS:?Set SITE_ADDRESS}"
# A managed-database host uses compose.yml alone; a single server (staging, P7-1) passes
# "-f compose.yml -f compose.single.yml", and the local stack adds "-f compose.local.yml" to that.
COMPOSE="docker compose ${COMPOSE_FILES:--f compose.yml}"

if [ "${SKIP_PULL:-}" != "1" ]; then
  echo "==> Pulling $API_IMAGE and $WEB_IMAGE"
  $COMPOSE pull api web
fi

# A single server runs its own database, so the release also keeps the application role in place (created on the
# first release, its password and limits re-asserted after). A managed database is provisioned once by hand.
if $COMPOSE --profile release config --services | grep -qx provision; then
  echo "==> Restricted application role"
  $COMPOSE --profile release run --rm provision
fi

echo "==> Encrypted backup of the database before migrating"
$COMPOSE --profile release run --rm backup

echo "==> Applying migrations"
$COMPOSE --profile release run --rm migrate

echo "==> Starting the new version"
$COMPOSE up -d --wait api web proxy
# The backup scheduler serves no requests and has no health check; newer Compose refuses to --wait on it.
$COMPOSE up -d backups

echo "==> Released $API_IMAGE and $WEB_IMAGE"
