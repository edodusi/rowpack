#!/usr/bin/env bash
# Make the next visit to rowpack-serve a first visit again.
#   default       delete the bundles and the build lock, and every cached object
#                 file: the next visitor compiles all modules on Lambda
#   --keep-cache  delete only the bundles and the lock: the next visitor
#                 rebuilds, but reuses every object file from S3
# Usage: AWS_PROFILE=<profile> ./distributed/serve-reset.sh [--keep-cache]
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
region="${ROWPACK_REGION:-eu-west-1}"
out() { node -e "console.log(require('$here/serve-outputs.json').RowpackServe['$1'])"; }
bucket="$(out SiteBucket)"
distribution_arn="$(out DistributionArn)"

prefixes=(builds/ locks/)
[ "${1:-}" = "--keep-cache" ] || prefixes+=(objects/)
for p in "${prefixes[@]}"; do
  aws s3 rm "s3://$bucket/$p" --recursive --region "$region" --only-show-errors
  echo "emptied $p"
done
aws cloudfront create-invalidation --distribution-id "${distribution_arn##*/}" --paths "/*" --query 'Invalidation.Id' --output text > /dev/null
echo "CloudFront invalidation started (takes a few seconds). Next visit: $(out Url)"
