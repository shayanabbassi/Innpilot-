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
# The local stack passes "-f compose.yml -f compose.local.yml"; a real host uses compose.yml alone.
COMPOSE="docker compose ${COMPOSE_FILES:--f compose.yml}"

if [ "${SKIP_PULL:-}" != "1" ]; then
  echo "==> Pulling $API_IMAGE and $WEB_IMAGE"
  $COMPOSE pull api web
fi

echo "==> Encrypted backup of the database before migrating"
$COMPOSE --profile release run --rm backup

echo "==> Applying migrations"
$COMPOSE --profile release run --rm migrate

echo "==> Starting the new version"
$COMPOSE up -d --wait api web proxy backups

echo "==> Released $API_IMAGE and $WEB_IMAGE"
