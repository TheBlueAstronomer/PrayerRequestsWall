#!/bin/bash

# Deployment Script
# This script is intended to be run on the production server.

set -e # Exit immediately if a command exits with a non-zero status.

echo "Deployment started..."

# 1. Navigate to the project directory
# Adjust this path if your project is located elsewhere
cd ~/PrayerRequestsWall || exit

# 2. Pull the latest changes from the master branch
echo "Resetting any local changes..."
git reset --hard
echo "Pulling latest changes..."
git pull origin master

# 3. Install dependencies
echo "Installing dependencies..."
npm install

# 4. Build the application
echo "Building the application..."
npm run build

# 5. Restart the application using PM2
echo "Restarting application..."
pm2 restart prayer-wall

echo "Deployment completed successfully!"
