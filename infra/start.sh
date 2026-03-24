#!/bin/bash
# Start local development environment and ensure it's ready for testing.
# Usage: bash infra/start.sh

set -e
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$SCRIPT_DIR"

echo "=== LoanMarketPlace Local Environment ==="

# 1. Start containers
echo ""
echo "Starting Docker containers..."
docker compose up -d

# 2. Wait for ark to be reachable
echo ""
echo "Waiting for Arkade server..."
for i in $(seq 1 30); do
  if curl -s http://localhost:7070/v1/info > /dev/null 2>&1; then
    break
  fi
  sleep 2
done

# 3. Check if wallet needs initialization or just unlocking
WALLET_STATUS=$(docker exec ark arkd wallet status 2>&1)

if echo "$WALLET_STATUS" | grep -q "initialized: true"; then
  # Wallet exists — just unlock
  if echo "$WALLET_STATUS" | grep -q "unlocked: false"; then
    echo "Unlocking wallet..."
    docker exec ark arkd wallet unlock --password secret
  else
    echo "Wallet already unlocked."
  fi
else
  # First time — create, unlock, and fund
  echo ""
  echo "First-time setup: creating wallet..."
  docker exec ark arkd wallet create --password secret > /dev/null
  docker exec ark arkd wallet unlock --password secret

  echo "Funding Arkade server..."
  ARK_ADDR=$(docker exec ark arkd wallet address)
  for i in 1 2 3 4 5; do
    curl -s -X POST http://localhost:3000/faucet \
      -H "Content-Type: application/json" \
      -d "{\"address\":\"$ARK_ADDR\"}" > /dev/null
  done
  echo "Server funded with 5 BTC."
fi

# 4. Verify
echo ""
echo "Checking services..."
ARK_INFO=$(curl -s http://localhost:7070/v1/info 2>&1)
if echo "$ARK_INFO" | grep -q '"network"'; then
  NETWORK=$(echo "$ARK_INFO" | grep -o '"network":"[^"]*"' | cut -d'"' -f4)
  VERSION=$(echo "$ARK_INFO" | grep -o '"version":"[^"]*"' | cut -d'"' -f4)
  echo "  Arkade:     http://localhost:7070 ($NETWORK, $VERSION)"
else
  echo "  Arkade:     NOT READY — check 'docker compose logs ark'"
  exit 1
fi

BLOCK=$(curl -s http://localhost:3000/blocks/tip/height 2>&1)
echo "  Bitcoin:    http://localhost:18443 (regtest, block $BLOCK)"
echo "  Faucet:     http://localhost:3000"
echo ""
echo "Ready. Run tests with:"
echo "  cd spikes && npx tsx regtest-test.ts"
