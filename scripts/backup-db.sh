#!/bin/bash
# Backup the vertebrae database before destructive operations

VTB_DIR="$HOME/.vtb"
BACKUP_DIR="$HOME/.vtb.backups"

# Create backup directory if it doesn't exist
mkdir -p "$BACKUP_DIR"

# Create timestamped backup
if [ -d "$VTB_DIR/data" ]; then
    TIMESTAMP=$(date +%Y%m%d_%H%M%S)
    BACKUP_PATH="$BACKUP_DIR/backup_${TIMESTAMP}"
    cp -r "$VTB_DIR/data" "$BACKUP_PATH"
    echo "Database backed up to: $BACKUP_PATH"
else
    echo "No database to backup"
fi
