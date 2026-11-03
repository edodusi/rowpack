#!/usr/bin/env bash
# Remove everything distributed/infra created: both Web Functions (with their
# revisions and endpoints), the classic function, the code bucket, the role
# and the log groups. Usage: AWS_PROFILE=<profile> ./distributed/teardown.sh
set -euo pipefail
cd "$(dirname "$0")/infra"
export CDK_DEFAULT_REGION="${AWS_REGION:-eu-west-1}"
npx cdk destroy --force RowpackDistributed
rm -f ../outputs.json
echo "RowpackDistributed removed from ${CDK_DEFAULT_REGION}."
