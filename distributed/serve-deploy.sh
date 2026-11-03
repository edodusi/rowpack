#!/usr/bin/env bash
# Deploy rowpack-serve, then let CloudFront (and only this distribution) sign
# requests to the IamAuth Web Function endpoint.
# Usage: AWS_PROFILE=<profile> ./distributed/serve-deploy.sh
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
region="${ROWPACK_REGION:-eu-west-1}"

node "$here/package-functions.js"
(cd "$here/infra" && ROWPACK_REGION="$region" npx cdk deploy RowpackServe --require-approval "${CDK_APPROVAL:-broadening}" --outputs-file "$here/serve-outputs.json")

out() { node -e "console.log(require('$here/serve-outputs.json').RowpackServe['$1'])"; }
fn_arn="$(out WebFunctionArn)"
endpoint_arn="$(out EndpointArn)"
distribution_arn="$(out DistributionArn)"

policy=$(cat <<JSON
{"Version":"2012-10-17","Statement":[{"Sid":"AllowCloudFrontOAC","Effect":"Allow",
"Principal":{"Service":"cloudfront.amazonaws.com"},"Action":"lambda:InvokeWebFunctionEndpoint",
"Resource":"$endpoint_arn","Condition":{"StringEquals":{"aws:SourceArn":"$distribution_arn"}}}]}
JSON
)
aws lambda-web put-resource-policy --region "$region" --resource-arn "$fn_arn" --policy "$policy" > /dev/null
# new code means a new build id: drop the cached page so the next visitor builds it
aws cloudfront create-invalidation --distribution-id "${distribution_arn##*/}" --paths "/" "/index.html" > /dev/null
echo "rowpack-serve is at $(out Url)"
