#!/bin/bash
DIR="$( cd "$( dirname "${BASH_SOURCE[0]}" )" && pwd )"
cd "$DIR"

echo "Building optimized Translation App..."
npm run build

echo "Starting Web Server on Local Network..."
echo "=============================================================="
echo "Tell users to look for the 'Network' IP address below!"
echo "e.g. (https://192.168.x.x:4173/)"
echo "=============================================================="
npm run preview -- --host
