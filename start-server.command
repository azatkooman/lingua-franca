#!/bin/bash
DIR="$( cd "$( dirname "${BASH_SOURCE[0]}" )" && pwd )"
cd "$DIR"

echo "Starting Local PeerJS Signaling Server (Port 9000)..."
echo "Please leave this window open during the event."
npm run server
