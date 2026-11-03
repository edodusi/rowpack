#!/usr/bin/env bash
# Remove what distributed/infra created. With no arguments, both stacks:
#   RowpackDistributed  the three compile backends used by bench.js
#   RowpackServe        the bundle-on-first-visit site (CloudFront, Web Function, S3)
# Usage: AWS_PROFILE=<profile> ./distributed/teardown.sh [RowpackDistributed] [RowpackServe]
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
stacks=("$@")
[ ${#stacks[@]} -eq 0 ] && stacks=(RowpackServe RowpackDistributed)
cd "$here/infra"
for s in "${stacks[@]}"; do
  ROWPACK_REGION="${ROWPACK_REGION:-eu-west-1}" npx cdk destroy --force "$s"
done
rm -f "$here/outputs.json" "$here/serve-outputs.json"
echo "removed: ${stacks[*]}"
