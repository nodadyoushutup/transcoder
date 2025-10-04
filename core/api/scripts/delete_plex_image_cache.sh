#!/bin/bash
# clear_cache.sh
# Deletes everything inside ../data/plex_image_cache but keeps the directory itself

TARGET="../data/plex_image_cache"

# Check if directory exists
if [ ! -d "$TARGET" ]; then
  echo "Directory $TARGET does not exist."
  exit 1
fi

echo "Deleting contents of $TARGET ..."
# Print each item as it's deleted
find "$TARGET" -mindepth 1 -print -delete

echo "Done. $TARGET is now empty."
